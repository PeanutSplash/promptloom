/**
 * promptloom — Core type definitions
 *
 * The type system for a prompt compiler:
 * - Sections with conditional inclusion
 * - Multi-zone cache scoping
 * - Tools with deferred loading
 * - Token budgeting
 * - Multi-provider output
 */

// ─── Compile Context ─────────────────────────────────────────────

/**
 * Context passed to compile() for conditional section evaluation.
 *
 * In Claude Code, sections are gated on feature flags, model capabilities,
 * and user type. CompileContext is the generic equivalent.
 */
export interface CompileContext {
  /** Current model name (e.g., 'claude-opus-4-6') */
  model?: string
  /** API provider (e.g., 'anthropic', 'bedrock', 'vertex', 'openai') */
  provider?: string
  /** Allow arbitrary user-defined context */
  [key: string]: unknown
}

// ─── Section Types ───────────────────────────────────────────────

/** A compute function that returns a section's content, or null to skip */
export type ComputeFn = () => string | null | Promise<string | null>

/** Predicate for conditional section inclusion */
export type WhenPredicate = (ctx: CompileContext) => boolean

/** Cache scope for prompt blocks, matching Anthropic API semantics */
export type CacheScope = 'global' | 'org' | null

/**
 * Options for section creation.
 */
export interface SectionOptions {
  /**
   * Conditional predicate. Section is only included when this returns true.
   *
   * In Claude Code, this maps to `feature('FLAG')` and `process.env.USER_TYPE` checks
   * that gate sections like TOKEN_BUDGET, KAIROS, VERIFICATION_AGENT.
   */
  when?: WhenPredicate
}

/**
 * A prompt section — the atomic unit of prompt assembly.
 *
 * Sections can be:
 * - Static: content is computed once and cached for the session
 * - Dynamic (cacheBreak: true): recomputed every time compile() is called
 * - Conditional: only included when `when(context)` returns true
 */
export interface Section {
  /** Unique identifier for this section */
  name: string
  /** Function that computes the section content */
  compute: ComputeFn
  /** If true, this section is recomputed every compile() call */
  cacheBreak: boolean
  /** If provided, section is only included when predicate returns true */
  when?: WhenPredicate
}

// ─── Zone Types ──────────────────────────────────────────────────

/**
 * A zone marker in the entry list.
 *
 * Zones create cache block boundaries. All sections between two zone markers
 * are compiled into a single CacheBlock with the zone's scope.
 *
 * In Claude Code, this is implemented via `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
 * (a single boundary producing 2 zones). promptloom generalizes to N zones.
 */
export interface ZoneMarker {
  readonly __type: 'zone'
  scope: CacheScope
}

/** An entry in the compiler's internal list */
export type Entry = Section | ZoneMarker

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
  /**
   * If true, the tool schema is deferred (not loaded until model requests it).
   *
   * In Claude Code, deferred tools get `defer_loading: true` in their schema
   * and are discovered via ToolSearchTool on demand. This reduces system prompt
   * token cost when you have many tools.
   */
  deferred?: boolean
  /**
   * Explicit ordering for cache stability.
   * Lower numbers come first. Tools without order use insertion order.
   *
   * In Claude Code, tool order is kept stable to maximize prompt cache hits —
   * reordering tools changes the serialized bytes, breaking the cache.
   */
  order?: number
}

/**
 * A compiled tool schema ready for the API.
 */
export interface CompiledTool {
  name: string
  description: string
  input_schema: JsonSchema
  cache_control?: { type: 'ephemeral'; scope?: CacheScope }
  /** When true, the model must explicitly request this tool via tool search */
  defer_loading?: true
}

// ─── Token Types ─────────────────────────────────────────────────

export interface TokenEstimate {
  /** Total estimated tokens for system prompt */
  systemPrompt: number
  /** Total estimated tokens for inline (non-deferred) tool schemas */
  tools: number
  /** Total estimated tokens for deferred tool schemas */
  deferredTools: number
  /** Combined total (systemPrompt + tools, deferred excluded) */
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
  /** Default cache scope for the initial zone (default: 'org') */
  defaultCacheScope?: CacheScope
  /** Cache scope used by boundary() for the dynamic zone (default: null) */
  dynamicCacheScope?: CacheScope
  /** Bytes per token for rough estimation (default: 4) */
  bytesPerToken?: number
  /**
   * When true, the initial zone scope is upgraded to 'global'.
   * Only effective for 1P Anthropic API usage.
   */
  enableGlobalCache?: boolean
}

export interface CompileResult {
  /** Prompt blocks with cache annotations, one per zone */
  blocks: CacheBlock[]
  /** Inline tool schemas (non-deferred) with resolved prompts */
  tools: CompiledTool[]
  /** Deferred tool schemas (loaded on demand) */
  deferredTools: CompiledTool[]
  /** Token estimates */
  tokens: TokenEstimate
  /** The full system prompt as a single string (blocks joined) */
  text: string
}

// ─── Provider Types ──────────────────────────────────────────────

export type ProviderFormat =
  | 'anthropic'
  | 'openai'
  | 'openai-responses'
  | 'bedrock'
  | 'gemini'
