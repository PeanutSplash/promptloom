/**
 * promptloom — Multi-provider output formatting
 *
 * Claude Code supports multiple API providers:
 * - Anthropic (1P): cache_control with scope on text blocks
 * - AWS Bedrock: cache_control without scope
 * - Google Vertex: cache_control without scope
 * - OpenAI: single string system prompt, no caching API
 *
 * This module formats CompileResult for each provider.
 */

import type { CacheBlock, CompiledTool, CompileResult } from './types.ts'

// ─── Anthropic ───────────────────────────────────────────────────

export interface AnthropicCacheControl {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  cache_control?: AnthropicCacheControl
  defer_loading?: true
}

/**
 * Format compile result for Anthropic Messages API.
 *
 * Mirrors Claude Code's `buildSystemPromptBlocks()`.
 * Blocks with a non-null cacheScope get `cache_control: { type: 'ephemeral' }`.
 */
export function toAnthropic(result: CompileResult): {
  system: AnthropicTextBlock[]
  tools: AnthropicTool[]
} {
  return {
    system: result.blocks.map((block) => ({
      type: 'text' as const,
      text: block.text,
      ...(block.cacheScope !== null
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    })),
    tools: [...result.tools, ...result.deferredTools].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      ...(tool.cache_control ? { cache_control: tool.cache_control } : {}),
      ...(tool.defer_loading ? { defer_loading: true as const } : {}),
    })),
  }
}

// ─── OpenAI ──────────────────────────────────────────────────────

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Format compile result for OpenAI Chat Completions API.
 *
 * OpenAI uses a single string for system prompt (no block-level caching).
 * Tools are wrapped in the `{ type: 'function', function: {...} }` format.
 */
export function toOpenAI(result: CompileResult): {
  system: string
  tools: OpenAITool[]
} {
  return {
    system: result.text,
    tools: result.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })),
  }
}

// ─── AWS Bedrock ─────────────────────────────────────────────────

export type BedrockSystemBlock =
  | { text: string }
  | { cachePoint: { type: 'default' } }

export interface BedrockTool {
  toolSpec: {
    name: string
    description: string
    inputSchema: { jsonSchema: Record<string, unknown> }
  }
}

/**
 * Format compile result for AWS Bedrock Converse API.
 *
 * Bedrock uses `cachePoint: { type: 'default' }` instead of Anthropic's
 * `cache_control: { type: 'ephemeral' }`. Tools use `toolSpec` wrapper.
 */
export function toBedrock(result: CompileResult): {
  system: BedrockSystemBlock[]
  toolConfig: { tools: BedrockTool[] }
} {
  return {
    system: result.blocks.flatMap((block): BedrockSystemBlock[] => [
      { text: block.text },
      ...(block.cacheScope !== null
        ? [{ cachePoint: { type: 'default' as const } }]
        : []),
    ]),
    toolConfig: {
      tools: result.tools.map((tool) => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { jsonSchema: tool.input_schema },
        },
      })),
    },
  }
}

// ─── Convenience: toAnthropicBlocks (backward compat) ────────────

/**
 * Convert cache blocks to Anthropic API text block format.
 *
 * @deprecated Use `toAnthropic(result).system` instead for full formatting.
 * Kept for backward compatibility.
 */
export function toAnthropicBlocks(
  blocks: CacheBlock[],
  enableCaching = true,
): AnthropicTextBlock[] {
  return blocks.map((block) => ({
    type: 'text' as const,
    text: block.text,
    ...(enableCaching && block.cacheScope !== null
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }))
}
