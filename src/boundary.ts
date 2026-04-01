/**
 * promptc — Cache boundary splitting
 *
 * Implements Claude Code's cache boundary mechanism:
 * - A sentinel string divides the prompt into static (cacheable) and dynamic zones
 * - Content before the boundary gets `cacheScope: 'global'` (cross-org cache)
 * - Content after gets `cacheScope: null` (session-specific)
 *
 * This directly maps to Claude API's `cache_control` field on text blocks.
 */

import type { CacheBlock, CacheScope } from './types.ts'

/** The sentinel string used to mark the cache boundary */
export const CACHE_BOUNDARY = '__PROMPTC_CACHE_BOUNDARY__'

export interface SplitOptions {
  /** Cache scope for content before the boundary (default: 'global') */
  staticScope?: CacheScope
  /** Cache scope for content after the boundary (default: null) */
  dynamicScope?: CacheScope
  /** Fallback scope when no boundary is found (default: 'org') */
  fallbackScope?: CacheScope
}

/**
 * Split a prompt string at the cache boundary into annotated blocks.
 *
 * Mirrors Claude Code's `splitSysPromptPrefix()`:
 *
 * - If boundary found:
 *   [static content → staticScope] + [dynamic content → dynamicScope]
 *
 * - If no boundary:
 *   [entire content → fallbackScope]
 */
export function splitAtBoundary(
  prompt: string,
  options: SplitOptions = {},
): CacheBlock[] {
  const {
    staticScope = 'global',
    dynamicScope = null,
    fallbackScope = 'org',
  } = options

  const boundaryIndex = prompt.indexOf(CACHE_BOUNDARY)

  if (boundaryIndex === -1) {
    // No boundary — single block with fallback scope
    return prompt.trim()
      ? [{ text: prompt, cacheScope: fallbackScope }]
      : []
  }

  const before = prompt.slice(0, boundaryIndex).trim()
  const after = prompt.slice(boundaryIndex + CACHE_BOUNDARY.length).trim()

  const blocks: CacheBlock[] = []
  if (before) {
    blocks.push({ text: before, cacheScope: staticScope })
  }
  if (after) {
    blocks.push({ text: after, cacheScope: dynamicScope })
  }
  return blocks
}

/**
 * Convert cache blocks to Anthropic API text block format.
 *
 * Mirrors Claude Code's `buildSystemPromptBlocks()`.
 */
export function toAnthropicBlocks(
  blocks: CacheBlock[],
  enableCaching = true,
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  return blocks.map((block) => ({
    type: 'text' as const,
    text: block.text,
    ...(enableCaching && block.cacheScope !== null
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }))
}
