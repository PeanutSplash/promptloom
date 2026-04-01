/**
 * promptloom — The Prompt Compiler
 *
 * Implements Claude Code's prompt assembly pattern, generalized:
 *
 *  1. Multi-zone cache scoping (N blocks, not just 2)
 *  2. Conditional section inclusion (when predicates)
 *  3. Static/dynamic section caching
 *  4. Tool schemas with embedded prompts and deferred loading
 *  5. Stable tool ordering for cache hits
 *  6. Token estimation and budget tracking
 *
 * Usage:
 *
 *   const pc = new PromptCompiler()
 *
 *   // Zone 1: no-cache header
 *   pc.zone(null)
 *   pc.static('attribution', 'x-model: claude')
 *
 *   // Zone 2: globally cacheable
 *   pc.zone('global')
 *   pc.static('identity', 'You are a coding assistant.')
 *   pc.static('rules', () => loadRules())
 *
 *   // Zone 3: session-specific
 *   pc.zone(null)
 *   pc.dynamic('git', async () => gitStatus())
 *   pc.static('opus_only', 'Use extended thinking.', {
 *     when: (ctx) => ctx.model?.includes('opus'),
 *   })
 *
 *   // Tools
 *   pc.tool({ name: 'bash', prompt: '...', inputSchema: {...} })
 *   pc.tool({ name: 'rare_tool', prompt: '...', inputSchema: {...}, deferred: true })
 *
 *   const result = await pc.compile({ model: 'claude-opus-4-6' })
 */

import type {
  CacheBlock,
  CacheScope,
  CompileContext,
  CompileResult,
  CompilerOptions,
  ComputeFn,
  Entry,
  Section,
  SectionOptions,
  TokenEstimate,
  ToolDef,
  ZoneMarker,
} from './types.ts'
import { SectionCache, resolveSections } from './section.ts'
import { ToolCache, compileTools } from './tool.ts'
import { estimateTokens } from './tokens.ts'

export class PromptCompiler {
  private entries: Entry[] = []
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

  // ─── Zone API ────────────────────────────────────────────────

  /**
   * Start a new cache zone. All sections after this marker are compiled
   * into a single CacheBlock with the specified scope.
   *
   * Generalizes Claude Code's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to support
   * N zones instead of just 2.
   *
   * @example
   * pc.zone(null)      // no-cache zone (attribution, headers)
   * pc.zone('global')  // globally cacheable (identity, rules)
   * pc.zone('org')     // org-level cacheable
   * pc.zone(null)      // session-specific (dynamic context)
   */
  zone(scope: CacheScope): this {
    this.entries.push({ __type: 'zone', scope })
    return this
  }

  /**
   * Insert a cache boundary. Shorthand for starting a new zone with
   * `dynamicCacheScope` (default: null).
   *
   * Equivalent to Claude Code's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
   * Only effective when `enableGlobalCache` is true (otherwise a no-op
   * since there's no scope difference to split on).
   *
   * For explicit multi-zone control, use `zone()` instead.
   */
  boundary(): this {
    if (this.options.enableGlobalCache) {
      return this.zone(this.options.dynamicCacheScope)
    }
    // When global cache is disabled, boundary is a no-op
    // (all sections use defaultCacheScope anyway)
    return this
  }

  // ─── Section API ─────────────────────────────────────────────

  /**
   * Add a static section. Computed once and cached for the session.
   *
   * Equivalent to Claude Code's `systemPromptSection()`.
   *
   * @param options.when - Conditional predicate. Section is skipped when false.
   */
  static(name: string, content: string | ComputeFn, options?: SectionOptions): this {
    const compute = typeof content === 'string' ? () => content : content
    this.entries.push({ name, compute, cacheBreak: false, when: options?.when })
    return this
  }

  /**
   * Add a dynamic section. Recomputed every compile() call.
   *
   * Equivalent to Claude Code's `DANGEROUS_uncachedSystemPromptSection()`.
   *
   * @param options.when - Conditional predicate. Section is skipped when false.
   */
  dynamic(name: string, compute: ComputeFn, options?: SectionOptions): this {
    this.entries.push({ name, compute, cacheBreak: true, when: options?.when })
    return this
  }

  // ─── Tool API ────────────────────────────────────────────────

  /**
   * Register a tool with an embedded prompt.
   *
   * Tools with `deferred: true` are compiled separately and excluded
   * from the main tool list. They can be discovered on demand.
   *
   * Tools with `order` fields are sorted for stable serialization
   * (cache hit optimization).
   */
  tool(def: ToolDef): this {
    this.tools.push(def)
    return this
  }

  // ─── Compile ─────────────────────────────────────────────────

  /**
   * Compile the prompt: resolve sections per zone, compile tools,
   * separate deferred tools, and estimate tokens.
   *
   * @param context - Optional context for conditional section evaluation.
   *                  Sections with `when` predicates are evaluated against this.
   */
  async compile(context?: CompileContext): Promise<CompileResult> {
    // 1. Group entries into zones
    const zoneGroups = this.groupIntoZones()

    // 2. Resolve each zone's sections → CacheBlock[]
    const blocks: CacheBlock[] = []
    for (const group of zoneGroups) {
      const resolved = await resolveSections(group.sections, this.sectionCache, context)
      const text = resolved.filter((s): s is string => s !== null).join('\n\n')
      if (text) {
        blocks.push({ text, cacheScope: group.scope })
      }
    }

    // 3. Separate inline vs deferred tools
    const inlineToolDefs = this.tools.filter((t) => !t.deferred)
    const deferredToolDefs = this.tools.filter((t) => t.deferred)

    // 4. Compile tools (prompts resolved and cached, sorted by order)
    const compiledTools = await compileTools(inlineToolDefs, this.toolCache)
    const compiledDeferred = await compileTools(deferredToolDefs, this.toolCache)

    // 5. Estimate tokens
    const bpt = this.options.bytesPerToken
    const systemPromptTokens = blocks.reduce(
      (sum, b) => sum + estimateTokens(b.text, bpt),
      0,
    )
    const toolTokens = compiledTools.reduce(
      (sum, t) => sum + this.estimateToolTokens(t),
      0,
    )
    const deferredToolTokens = compiledDeferred.reduce(
      (sum, t) => sum + this.estimateToolTokens(t),
      0,
    )
    const tokens: TokenEstimate = {
      systemPrompt: systemPromptTokens,
      tools: toolTokens,
      deferredTools: deferredToolTokens,
      total: systemPromptTokens + toolTokens,
    }

    // 6. Build the plain text version
    const text = blocks.map((b) => b.text).join('\n\n')

    return {
      blocks,
      tools: compiledTools,
      deferredTools: compiledDeferred,
      tokens,
      text,
    }
  }

  // ─── Cache Management ────────────────────────────────────────

  /** Clear all caches. Call on `/clear` or `/compact`. */
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
    return this.entries.filter((e): e is Section => !('__type' in e)).length
  }

  /** Get the number of registered tools (inline + deferred) */
  get toolCount(): number {
    return this.tools.length
  }

  /** List registered section names with their types */
  listSections(): Array<{ name: string; type: 'static' | 'dynamic' | 'zone' }> {
    return this.entries.map((e) => {
      if ('__type' in e) {
        return { name: `zone:${e.scope ?? 'none'}`, type: 'zone' as const }
      }
      return {
        name: e.name,
        type: e.cacheBreak ? 'dynamic' as const : 'static' as const,
      }
    })
  }

  /** List registered tool names */
  listTools(): string[] {
    return this.tools.map((t) => t.name)
  }

  // ─── Internal ────────────────────────────────────────────────

  /**
   * Group entries into zones.
   *
   * Entries before any zone marker belong to the "initial zone" whose
   * scope is determined by `enableGlobalCache` and `defaultCacheScope`.
   */
  private groupIntoZones(): Array<{ scope: CacheScope; sections: Section[] }> {
    const initialScope = this.options.enableGlobalCache
      ? 'global'
      : this.options.defaultCacheScope

    const zones: Array<{ scope: CacheScope; sections: Section[] }> = []
    let currentZone: { scope: CacheScope; sections: Section[] } = {
      scope: initialScope,
      sections: [],
    }

    for (const entry of this.entries) {
      if ('__type' in entry) {
        // Zone marker: finalize current zone and start a new one
        if (currentZone.sections.length > 0) {
          zones.push(currentZone)
        }
        currentZone = { scope: entry.scope, sections: [] }
      } else {
        currentZone.sections.push(entry)
      }
    }

    // Don't forget the last zone
    if (currentZone.sections.length > 0) {
      zones.push(currentZone)
    }

    return zones
  }

  private estimateToolTokens(tool: { description: string; input_schema: Record<string, unknown> }): number {
    return (
      estimateTokens(tool.description, this.options.bytesPerToken) +
      estimateTokens(JSON.stringify(tool.input_schema), 2) // schemas are dense
    )
  }
}
