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
 * const pc = new PromptCompiler()
 *
 * pc.zone(null)                                      // no-cache header
 * pc.static('header', 'x-model: claude')
 *
 * pc.zone('global')                                  // globally cacheable
 * pc.static('identity', 'You are a coding assistant.')
 * pc.static('rules', 'Follow clean code principles.')
 *
 * pc.zone(null)                                      // session-specific
 * pc.dynamic('context', async () => `Branch: main`)
 * pc.static('opus_only', 'Use extended thinking.', {
 *   when: (ctx) => ctx.model?.includes('opus'),
 * })
 *
 * pc.tool({
 *   name: 'read_file',
 *   prompt: 'Read a file. Always use absolute paths.',
 *   inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
 * })
 *
 * pc.tool({
 *   name: 'web_search',
 *   prompt: 'Search the web.',
 *   inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
 *   deferred: true,    // loaded on demand, not in system prompt
 * })
 *
 * const result = await pc.compile({ model: 'claude-opus-4-6' })
 * ```
 */

// Core
export { PromptCompiler } from './compiler.ts'

// Section helpers
export { section, dynamicSection, SectionCache, resolveSections } from './section.ts'

// Cache boundary (low-level utility, kept for backward compat)
export { CACHE_BOUNDARY, splitAtBoundary } from './boundary.ts'

// Provider formatters
export { toAnthropic, toOpenAI, toBedrock, toAnthropicBlocks } from './providers.ts'

// Tool helpers
export { defineTool, ToolCache, compileTool, compileTools } from './tool.ts'

// Token utilities
export {
  estimateTokens,
  estimateTokensForFileType,
  createBudgetTracker,
  checkBudget,
  parseTokenBudget,
} from './tokens.ts'

// Types
export type {
  Section,
  ComputeFn,
  WhenPredicate,
  CacheScope,
  CacheBlock,
  CompileContext,
  SectionOptions,
  ZoneMarker,
  Entry,
  ToolDef,
  CompiledTool,
  JsonSchema,
  TokenEstimate,
  TokenBudgetConfig,
  CompilerOptions,
  CompileResult,
  ProviderFormat,
} from './types.ts'
export type { BudgetTracker, BudgetDecision } from './tokens.ts'
export type { SplitOptions } from './boundary.ts'
export type {
  AnthropicCacheControl,
  AnthropicTextBlock,
  AnthropicTool,
  OpenAITool,
  BedrockSystemBlock,
  BedrockTool,
} from './providers.ts'
