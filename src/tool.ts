/**
 * promptloom — Tool prompt management
 *
 * In Claude Code, every tool has its own `prompt.ts` — a "user manual"
 * written for the LLM. Tool prompts are:
 * - Computed once per session and cached (avoids mid-session drift)
 * - Injected into the tool's `description` field in the API request
 * - Can be static strings or async functions
 *
 * This module provides the tool registry and compilation logic.
 */

import type { CompiledTool, JsonSchema, ToolDef, CacheScope } from './types.ts'

/**
 * Cache for resolved tool prompts.
 *
 * Mirrors Claude Code's `getToolSchemaCache()`:
 * "Prevents mid-session GrowthBook flips from churning serialized tools array.
 *  One generation per session unless cache is cleared."
 */
export class ToolCache {
  private cache = new Map<string, CompiledTool>()

  get(key: string): CompiledTool | undefined {
    return this.cache.get(key)
  }

  set(key: string, tool: CompiledTool): void {
    this.cache.set(key, tool)
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  clear(): void {
    this.cache.clear()
  }
}

/**
 * Generate a stable cache key for a tool.
 *
 * Includes the inputSchema hash so tools with dynamic schemas
 * get separate cache entries.
 */
function toolCacheKey(def: ToolDef): string {
  return def.inputSchema
    ? `${def.name}:${JSON.stringify(def.inputSchema)}`
    : def.name
}

/**
 * Resolve a tool's prompt (string or async function) to a string.
 */
async function resolveToolPrompt(prompt: ToolDef['prompt']): Promise<string> {
  return typeof prompt === 'function' ? await prompt() : prompt
}

/**
 * Compile a single tool definition into API-ready format.
 *
 * Uses session-level cache: first call computes, subsequent calls return cached.
 */
export async function compileTool(
  def: ToolDef,
  cache: ToolCache,
  cacheScope?: CacheScope,
): Promise<CompiledTool> {
  const key = toolCacheKey(def)
  const cached = cache.get(key)
  if (cached) return cached

  const description = await resolveToolPrompt(def.prompt)

  const compiled: CompiledTool = {
    name: def.name,
    description,
    input_schema: def.inputSchema,
    ...(cacheScope !== undefined && cacheScope !== null
      ? { cache_control: { type: 'ephemeral' as const, scope: cacheScope } }
      : {}),
  }

  cache.set(key, compiled)
  return compiled
}

/**
 * Compile all tool definitions, resolving prompts in parallel.
 */
export async function compileTools(
  defs: ToolDef[],
  cache: ToolCache,
  cacheScope?: CacheScope,
): Promise<CompiledTool[]> {
  return Promise.all(defs.map((def) => compileTool(def, cache, cacheScope)))
}

// ─── Tool Builder Helpers ────────────────────────────────────────

/**
 * Fail-closed defaults for tool safety flags.
 *
 * Mirrors Claude Code's TOOL_DEFAULTS:
 * "If a tool author forgets to declare safety, assume it's unsafe."
 */
const TOOL_DEFAULTS = {
  concurrencySafe: false,
  readOnly: false,
  deferred: false,
} as const

/**
 * Create a tool definition with safe defaults.
 */
export function defineTool(def: ToolDef): ToolDef {
  return { ...TOOL_DEFAULTS, ...def }
}
