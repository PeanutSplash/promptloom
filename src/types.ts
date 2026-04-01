/**
 * promptc — Core type definitions
 *
 * Inspired by Claude Code's prompt architecture:
 * - Sections are the building blocks of a system prompt
 * - Cache boundaries split static (globally cacheable) from dynamic content
 * - Tools carry their own prompt descriptions
 * - Token budgets drive compression decisions
 */

// ─── Section Types ───────────────────────────────────────────────

/** A compute function that returns a section's content, or null to skip */
export type ComputeFn = () => string | null | Promise<string | null>

/** Cache scope for prompt blocks, matching Anthropic API semantics */
export type CacheScope = 'global' | 'org' | null

/**
 * A prompt section — the atomic unit of prompt assembly.
 *
 * Sections can be:
 * - Static: content is computed once and cached for the session
 * - Dynamic (cacheBreak: true): recomputed every time compile() is called
 */
export interface Section {
  /** Unique identifier for this section */
  name: string
  /** Function that computes the section content */
  compute: ComputeFn
  /** If true, this section is recomputed every compile() call */
  cacheBreak: boolean
  /** Priority for ordering (lower = earlier). Default: insertion order */
  priority?: number
}

// ─── Cache Block Types ───────────────────────────────────────────

/**
 * A compiled prompt block with cache scope annotation.
 *
 * When sent to the Anthropic API, blocks with a non-null cacheScope
 * get a `cache_control` field, enabling prompt caching.
 */
export interface CacheBlock {
  /** The text content of this block */
  text: string
  /** Cache scope: 'global' (cross-org), 'org' (org-level), or null (no cache) */
  cacheScope: CacheScope
}

// ─── Tool Types ──────────────────────────────────────────────────

/** JSON Schema for tool input parameters */
export type JsonSchema = Record<string, unknown>

/**
 * A tool definition with an embedded prompt.
 *
 * In Claude Code, each tool carries its own "user manual" for the LLM.
 * The prompt is injected into the tool's description field in the API request.
 */
export interface ToolDef {
  /** Tool name (e.g., 'bash', 'read_file') */
  name: string
  /**
   * Tool prompt — the LLM-facing description.
   * Can be a static string or an async function for dynamic prompts.
   */
  prompt: string | (() => string | Promise<string>)
  /** JSON Schema defining the tool's input parameters */
  inputSchema: JsonSchema
  /** If true, safe to call concurrently with other tools */
  concurrencySafe?: boolean
  /** If true, this tool only reads and never writes */
  readOnly?: boolean
  /** If true, the tool schema is deferred (not loaded until needed) */
  deferred?: boolean
}

/**
 * A compiled tool schema ready for the API.
 */
export interface CompiledTool {
  name: string
  description: string
  input_schema: JsonSchema
  cache_control?: { type: 'ephemeral'; scope?: CacheScope }
}

// ─── Token Types ─────────────────────────────────────────────────

export interface TokenEstimate {
  /** Total estimated tokens for system prompt */
  systemPrompt: number
  /** Total estimated tokens for all tool schemas */
  tools: number
  /** Combined total */
  total: number
}

export interface TokenBudgetConfig {
  /** Total token budget for the conversation turn */
  budget: number
  /** Stop at this fraction of budget (default: 0.9) */
  completionThreshold?: number
  /** Minimum delta to avoid diminishing returns detection (default: 500) */
  diminishingThreshold?: number
}

// ─── Compiler Options ────────────────────────────────────────────

export interface CompilerOptions {
  /** Default cache scope for sections before the boundary (default: 'org') */
  defaultCacheScope?: CacheScope
  /** Cache scope for sections after the boundary (default: null) */
  dynamicCacheScope?: CacheScope
  /** Bytes per token for rough estimation (default: 4) */
  bytesPerToken?: number
  /** Whether to enable the global cache boundary feature */
  enableGlobalCache?: boolean
}

export interface CompileResult {
  /** Prompt blocks with cache annotations */
  blocks: CacheBlock[]
  /** Compiled tool schemas */
  tools: CompiledTool[]
  /** Token estimates */
  tokens: TokenEstimate
  /** The full system prompt as a single string (blocks joined) */
  text: string
}
