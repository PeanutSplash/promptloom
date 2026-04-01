/**
 * promptloom — Multi-provider output formatting
 *
 * Formats CompileResult for each LLM API provider:
 *
 * - **Anthropic (1P)**: cache_control with scope on text blocks
 *   @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 *
 * - **AWS Bedrock**: cachePoint-based caching, toolSpec wrapper
 *   @see https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html
 *
 * - **OpenAI Chat Completions**: single string system prompt, auto prefix caching
 *   Also compatible with: Azure OpenAI, Mistral, Groq, Together, DeepSeek, Fireworks, Cohere v2
 *   @see https://platform.openai.com/docs/api-reference/chat/create
 *
 * - **OpenAI Responses**: instructions field + input array (new API, March 2025)
 *   @see https://platform.openai.com/docs/api-reference/responses/create
 *
 * - **Google Gemini / Vertex AI**: systemInstruction with parts array, explicit context caching
 *   @see https://ai.google.dev/api/generate-content
 *   @see https://ai.google.dev/gemini-api/docs/caching
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

// ─── Google Gemini / Vertex AI ──────────────────────────────────
// @see https://ai.google.dev/api/generate-content
// @see https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference

export interface GeminiPart {
  text: string
}

export interface GeminiContent {
  role?: string
  parts: GeminiPart[]
}

/**
 * Gemini tool declaration.
 * @see https://ai.google.dev/api/caching#FunctionDeclaration
 */
export interface GeminiTool {
  functionDeclarations: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }[]
}

/**
 * Format compile result for Google Gemini / Vertex AI API.
 *
 * Gemini uses a separate `systemInstruction` field (not in messages array)
 * with a `parts` array. Tools are wrapped in `functionDeclarations`.
 *
 * The returned format works for both:
 * - Google AI Studio (Gemini API direct): `@google/generative-ai`
 * - Google Cloud Vertex AI: `@google-cloud/vertexai`
 *
 * @see https://ai.google.dev/api/generate-content#v1beta.GenerateContentRequest
 */
export function toGemini(result: CompileResult): {
  systemInstruction: GeminiContent
  tools: GeminiTool[]
} {
  return {
    systemInstruction: {
      parts: result.blocks.map((block) => ({ text: block.text })),
    },
    tools: result.tools.length > 0
      ? [
          {
            functionDeclarations: result.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            })),
          },
        ]
      : [],
  }
}

// ─── OpenAI Responses API ───────────────────────────────────────
// @see https://platform.openai.com/docs/api-reference/responses/create
// @see https://platform.openai.com/docs/guides/migrate-to-responses

export interface OpenAIResponsesTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

/**
 * Format compile result for OpenAI Responses API.
 *
 * The Responses API (March 2025) uses a top-level `instructions` field
 * instead of a system message in the messages array. Tools are flattened
 * (no nested `function` wrapper).
 *
 * Also supports `developer` role messages via the `input` array,
 * but `instructions` is the simpler path for system prompts.
 *
 * @see https://platform.openai.com/docs/api-reference/responses/create
 */
export function toOpenAIResponses(result: CompileResult): {
  instructions: string
  tools: OpenAIResponsesTool[]
} {
  return {
    instructions: result.text,
    tools: result.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    })),
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
