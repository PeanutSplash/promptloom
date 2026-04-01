/**
 * promptc — Token estimation utilities
 *
 * Mirrors Claude Code's token counting strategy:
 * - Rough estimation based on byte length (fast, no API call)
 * - File-type-aware estimation (JSON is denser → 2 bytes/token)
 * - Budget tracking with diminishing returns detection
 */

import type { TokenBudgetConfig } from './types.ts'

// ─── Rough Estimation ────────────────────────────────────────────

const DEFAULT_BYTES_PER_TOKEN = 4

/**
 * Estimate token count from a string using byte-length heuristic.
 *
 * Claude Code uses 4 bytes/token as default, 2 for dense formats like JSON.
 * This is intentionally approximate — accurate counting requires an API call.
 */
export function estimateTokens(
  content: string,
  bytesPerToken = DEFAULT_BYTES_PER_TOKEN,
): number {
  return Math.round(content.length / bytesPerToken)
}

/** Bytes-per-token by file extension. Dense formats use fewer bytes. */
const EXTENSION_DENSITY: Record<string, number> = {
  json: 2,
  jsonl: 2,
  yaml: 3,
  yml: 3,
  xml: 2,
  csv: 3,
  tsv: 3,
}

/**
 * Estimate tokens with file-type awareness.
 * JSON/XML are denser (more tokens per byte) than natural language.
 */
export function estimateTokensForFileType(
  content: string,
  extension: string,
): number {
  const bpt = EXTENSION_DENSITY[extension.toLowerCase()] ?? DEFAULT_BYTES_PER_TOKEN
  return estimateTokens(content, bpt)
}

// ─── Budget Tracking ─────────────────────────────────────────────

export interface BudgetTracker {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export type BudgetDecision =
  | { action: 'continue'; nudgeMessage: string; pct: number }
  | { action: 'stop'; reason: 'budget_reached' | 'diminishing_returns' | 'no_budget'; pct: number }

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

/**
 * Check token budget and decide whether to continue.
 *
 * Mirrors Claude Code's `checkTokenBudget()`:
 * - Continue if below completion threshold (default 90%)
 * - Detect diminishing returns (3+ continuations with tiny deltas)
 * - Return nudge messages to keep the model working
 */
export function checkBudget(
  tracker: BudgetTracker,
  currentTokens: number,
  config: TokenBudgetConfig,
): BudgetDecision {
  const { budget, completionThreshold = 0.9, diminishingThreshold = 500 } = config

  if (budget <= 0) {
    return { action: 'stop', reason: 'no_budget', pct: 0 }
  }

  const pct = Math.round((currentTokens / budget) * 100)
  const deltaSinceLastCheck = currentTokens - tracker.lastGlobalTurnTokens

  // Detect diminishing returns: 3+ continuations with tiny deltas
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < diminishingThreshold &&
    tracker.lastDeltaTokens < diminishingThreshold

  // Update tracker state
  tracker.lastDeltaTokens = deltaSinceLastCheck
  tracker.lastGlobalTurnTokens = currentTokens

  if (isDiminishing) {
    return { action: 'stop', reason: 'diminishing_returns', pct }
  }

  if (currentTokens >= budget * completionThreshold) {
    return { action: 'stop', reason: 'budget_reached', pct }
  }

  tracker.continuationCount++
  const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n)
  return {
    action: 'continue',
    pct,
    nudgeMessage: `Stopped at ${pct}% of token target (${fmt(currentTokens)} / ${fmt(budget)}). Keep working — do not summarize.`,
  }
}
