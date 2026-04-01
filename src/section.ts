/**
 * promptc — Section management
 *
 * Implements the two-tier section system from Claude Code:
 * - `section()`: cached within session, computed once
 * - `dynamicSection()`: recomputed every compile() call (cacheBreak: true)
 *
 * Sections also support an in-memory cache with optional TTL,
 * mirroring Claude Code's `systemPromptSectionCache`.
 */

import type { ComputeFn, Section } from './types.ts'

/**
 * Create a static section. Content is computed once and cached.
 *
 * Use for: identity prompts, rules, style guides — anything that
 * doesn't change between turns.
 */
export function section(name: string, compute: ComputeFn): Section {
  return { name, compute, cacheBreak: false }
}

/**
 * Create a dynamic section. Content is recomputed every compile() call.
 *
 * Claude Code calls this `DANGEROUS_uncachedSystemPromptSection` —
 * the naming reflects that dynamic sections break prompt cache stability.
 *
 * Use for: MCP server instructions, real-time status, anything that
 * changes between turns.
 */
export function dynamicSection(name: string, compute: ComputeFn): Section {
  return { name, compute, cacheBreak: true }
}

// ─── Section Cache ───────────────────────────────────────────────

/**
 * In-memory section cache.
 *
 * Mirrors `STATE.systemPromptSectionCache` from Claude Code.
 * Static sections are computed once per session and cached here.
 * Dynamic sections (cacheBreak: true) bypass the cache entirely.
 */
export class SectionCache {
  private cache = new Map<string, string | null>()

  get(name: string): string | null | undefined {
    return this.cache.get(name)
  }

  has(name: string): boolean {
    return this.cache.has(name)
  }

  set(name: string, value: string | null): void {
    this.cache.set(name, value)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

/**
 * Resolve an array of sections, using cache for static ones.
 *
 * Mirrors `resolveSystemPromptSections()` from Claude Code:
 * - Static sections: check cache first, compute if missing
 * - Dynamic sections: always recompute
 * - All sections resolved in parallel via Promise.all
 */
export async function resolveSections(
  sections: Section[],
  cache: SectionCache,
): Promise<(string | null)[]> {
  return Promise.all(
    sections.map(async (s) => {
      // Dynamic sections always recompute
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }

      const value = await s.compute()
      // Only cache static sections
      if (!s.cacheBreak) {
        cache.set(s.name, value)
      }
      return value
    }),
  )
}
