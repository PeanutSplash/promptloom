/**
 * promptloom — The Prompt Compiler
 *
 * Implements Claude Code's 7-layer prompt assembly pattern:
 *
 *  1. Static sections (identity, rules, tool usage guides...)
 *  2. Cache boundary ← splits globally-cacheable from session-specific
 *  3. Dynamic sections (git status, memory, MCP instructions...)
 *  4. Tool schemas with embedded prompts
 *  5. Section-level caching (static computed once, dynamic every turn)
 *  6. Token estimation and budget tracking
 *  7. Cache scope annotations for the Anthropic API
 *
 * Usage:
 *
 *   const pc = new PromptCompiler()
 *
 *   pc.static('identity', 'You are a helpful coding assistant.')
 *   pc.static('rules', () => loadRules())
 *   pc.boundary()                            // cache split point
 *   pc.dynamic('git', async () => gitStatus())
 *   pc.dynamic('memory', async () => loadMemory())
 *
 *   pc.tool({ name: 'bash', prompt: '...', inputSchema: {...} })
 *
 *   const result = await pc.compile()
 *   // result.blocks  → CacheBlock[] (with cache scope annotations)
 *   // result.tools   → CompiledTool[] (with resolved prompts)
 *   // result.tokens  → { systemPrompt, tools, total }
 *   // result.text    → full prompt as a single string
 */

import type {
  CacheBlock,
  CacheScope,
  CompileResult,
  CompilerOptions,
  ComputeFn,
  Section,
  TokenEstimate,
  ToolDef,
} from './types.ts'
import { SectionCache, resolveSections } from './section.ts'
import { CACHE_BOUNDARY, splitAtBoundary } from './boundary.ts'
import { ToolCache, compileTools } from './tool.ts'
import { estimateTokens } from './tokens.ts'

/** Sentinel value representing a cache boundary in the section list */
const BOUNDARY_SECTION_NAME = '__boundary__'

export class PromptCompiler {
  private sections: Section[] = []
  private tools: ToolDef[] = []
  private sectionCache: SectionCache
  private toolCache: ToolCache
  private options: Required<CompilerOptions>

  constructor(options: CompilerOptions = {}) {
    this.options = {
      defaultCacheScope: options.defaultCacheScope ?? 'org',
      dynamicCacheScope: options.dynamicCacheScope ?? null,
      bytesPerToken: options.bytesPerToken ?? 4,
      enableGlobalCache: options.enableGlobalCache ?? false,
    }
    this.sectionCache = new SectionCache()
    this.toolCache = new ToolCache()
  }

  // ─── Section API ─────────────────────────────────────────────

  /**
   * Add a static section. Computed once and cached for the session.
   *
   * Equivalent to Claude Code's `systemPromptSection()`.
   */
  static(name: string, content: string | ComputeFn): this {
    const compute = typeof content === 'string' ? () => content : content
    this.sections.push({ name, compute, cacheBreak: false })
    return this
  }

  /**
   * Add a dynamic section. Recomputed every compile() call.
   *
   * Equivalent to Claude Code's `DANGEROUS_uncachedSystemPromptSection()`.
   * The "dangerous" naming in Claude Code reflects that these sections
   * break prompt cache stability — use sparingly.
   */
  dynamic(name: string, compute: ComputeFn): this {
    this.sections.push({ name, compute, cacheBreak: true })
    return this
  }

  /**
   * Insert a cache boundary. Everything before this is globally cacheable.
   *
   * Equivalent to Claude Code's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
   * Only effective when `enableGlobalCache` is true.
   */
  boundary(): this {
    this.sections.push({
      name: BOUNDARY_SECTION_NAME,
      compute: () => (this.options.enableGlobalCache ? CACHE_BOUNDARY : null),
      cacheBreak: false,
    })
    return this
  }

  // ─── Tool API ────────────────────────────────────────────────

  /**
   * Register a tool with an embedded prompt.
   *
   * The tool's prompt is resolved once per session (cached),
   * mirroring Claude Code's tool schema cache.
   */
  tool(def: ToolDef): this {
    this.tools.push(def)
    return this
  }

  // ─── Compile ─────────────────────────────────────────────────

  /**
   * Compile the prompt: resolve all sections, split at boundary,
   * compile tools, and estimate tokens.
   */
  async compile(): Promise<CompileResult> {
    // 1. Resolve all sections (static from cache, dynamic freshly computed)
    const resolved = await resolveSections(this.sections, this.sectionCache)

    // 2. Join into a single string (nulls filtered out, joined with double newline)
    const fullText = resolved
      .filter((s): s is string => s !== null)
      .join('\n\n')

    // 3. Split at cache boundary into annotated blocks
    const blocks = splitAtBoundary(fullText, {
      staticScope: this.options.enableGlobalCache ? 'global' : this.options.defaultCacheScope,
      dynamicScope: this.options.dynamicCacheScope,
      fallbackScope: this.options.defaultCacheScope,
    })

    // 4. Compile tools (prompts resolved and cached)
    const compiledTools = await compileTools(this.tools, this.toolCache)

    // 5. Estimate tokens
    const systemPromptTokens = blocks.reduce(
      (sum, b) => sum + estimateTokens(b.text, this.options.bytesPerToken),
      0,
    )
    const toolTokens = compiledTools.reduce(
      (sum, t) =>
        sum +
        estimateTokens(t.description, this.options.bytesPerToken) +
        estimateTokens(JSON.stringify(t.input_schema), 2), // schemas are dense like JSON
      0,
    )
    const tokens: TokenEstimate = {
      systemPrompt: systemPromptTokens,
      tools: toolTokens,
      total: systemPromptTokens + toolTokens,
    }

    // 6. Build the plain text version (no boundary markers)
    const text = blocks.map((b) => b.text).join('\n\n')

    return { blocks, tools: compiledTools, tokens, text }
  }

  // ─── Cache Management ────────────────────────────────────────

  /**
   * Clear all caches. Call on `/clear` or `/compact`.
   *
   * Mirrors Claude Code's `clearSystemPromptSections()`.
   */
  clearCache(): void {
    this.sectionCache.clear()
    this.toolCache.clear()
  }

  /** Clear only section cache (tools stay cached) */
  clearSectionCache(): void {
    this.sectionCache.clear()
  }

  /** Clear only tool cache (forces prompt re-resolution) */
  clearToolCache(): void {
    this.toolCache.clear()
  }

  // ─── Inspection ──────────────────────────────────────────────

  /** Get the number of registered sections */
  get sectionCount(): number {
    return this.sections.filter((s) => s.name !== BOUNDARY_SECTION_NAME).length
  }

  /** Get the number of registered tools */
  get toolCount(): number {
    return this.tools.length
  }

  /** List registered section names with their types */
  listSections(): Array<{ name: string; type: 'static' | 'dynamic' | 'boundary' }> {
    return this.sections.map((s) => ({
      name: s.name,
      type:
        s.name === BOUNDARY_SECTION_NAME
          ? 'boundary' as const
          : s.cacheBreak
            ? 'dynamic' as const
            : 'static' as const,
    }))
  }

  /** List registered tool names */
  listTools(): string[] {
    return this.tools.map((t) => t.name)
  }
}
