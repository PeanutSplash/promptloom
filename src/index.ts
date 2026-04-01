/**
 * promptloom — Prompt Compiler
 *
 * Weave production-grade LLM prompts with cache boundaries,
 * tool injection, and token budgeting.
 *
 * Reverse-engineered from Claude Code's 7-layer prompt architecture.
 *
 * @example
 * ```ts
 * import { PromptCompiler } from 'promptloom'
 *
 * const pc = new PromptCompiler({ enableGlobalCache: true })
 *
 * // Static sections (cached for the session)
 * pc.static('identity', 'You are a helpful coding assistant.')
 * pc.static('rules', 'Follow clean code principles.')
 *
 * // Cache boundary — everything above is globally cacheable
 * pc.boundary()
 *
 * // Dynamic sections (recomputed every compile())
 * pc.dynamic('context', async () => `Branch: ${await getBranch()}`)
 *
 * // Tools with embedded prompts
 * pc.tool({
 *   name: 'read_file',
 *   prompt: 'Read a file. Always use absolute paths.',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { path: { type: 'string' } },
 *     required: ['path'],
 *   },
 * })
 *
 * const result = await pc.compile()
 * // result.blocks  → CacheBlock[] with scope annotations
 * // result.tools   → CompiledTool[] with resolved prompts
 * // result.tokens  → { systemPrompt, tools, total }
 * ```
 */

// Core
export { PromptCompiler } from './compiler.ts'

// Section helpers
export { section, dynamicSection, SectionCache, resolveSections } from './section.ts'

// Cache boundary
export { CACHE_BOUNDARY, splitAtBoundary, toAnthropicBlocks } from './boundary.ts'

// Tool helpers
export { defineTool, ToolCache, compileTool, compileTools } from './tool.ts'

// Token utilities
export {
  estimateTokens,
  estimateTokensForFileType,
  createBudgetTracker,
  checkBudget,
} from './tokens.ts'

// Types
export type {
  Section,
  ComputeFn,
  CacheScope,
  CacheBlock,
  ToolDef,
  CompiledTool,
  JsonSchema,
  TokenEstimate,
  TokenBudgetConfig,
  CompilerOptions,
  CompileResult,
} from './types.ts'
export type { BudgetTracker, BudgetDecision } from './tokens.ts'
export type { SplitOptions } from './boundary.ts'
