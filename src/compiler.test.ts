import { describe, test, expect } from 'bun:test'
import { PromptCompiler } from './compiler.ts'
import { estimateTokens, createBudgetTracker, checkBudget } from './tokens.ts'
import { splitAtBoundary, CACHE_BOUNDARY, toAnthropicBlocks } from './boundary.ts'
import { section, dynamicSection, SectionCache, resolveSections } from './section.ts'
import { defineTool, ToolCache, compileTool } from './tool.ts'

// ─── PromptCompiler ──────────────────────────────────────────────

describe('PromptCompiler', () => {
  test('basic compile with static sections', async () => {
    const pc = new PromptCompiler()
    pc.static('intro', 'Hello world')
    pc.static('rules', 'Be helpful')

    const result = await pc.compile()
    expect(result.text).toContain('Hello world')
    expect(result.text).toContain('Be helpful')
    expect(result.blocks).toHaveLength(1) // no boundary → single block
    expect(result.blocks[0]!.cacheScope).toBe('org') // default fallback
  })

  test('boundary splits blocks', async () => {
    const pc = new PromptCompiler({ enableGlobalCache: true })
    pc.static('before', 'Static content')
    pc.boundary()
    pc.dynamic('after', () => 'Dynamic content')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0]!.cacheScope).toBe('global')
    expect(result.blocks[0]!.text).toContain('Static content')
    expect(result.blocks[1]!.cacheScope).toBeNull()
    expect(result.blocks[1]!.text).toContain('Dynamic content')
  })

  test('boundary is no-op when enableGlobalCache is false', async () => {
    const pc = new PromptCompiler({ enableGlobalCache: false })
    pc.static('before', 'A')
    pc.boundary()
    pc.static('after', 'B')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(1) // no boundary marker emitted
    expect(result.text).toContain('A')
    expect(result.text).toContain('B')
  })

  test('dynamic sections are recomputed', async () => {
    let counter = 0
    const pc = new PromptCompiler()
    pc.dynamic('count', () => `count=${++counter}`)

    const r1 = await pc.compile()
    const r2 = await pc.compile()
    expect(r1.text).toContain('count=1')
    expect(r2.text).toContain('count=2')
  })

  test('static sections are cached', async () => {
    let counter = 0
    const pc = new PromptCompiler()
    pc.static('count', () => `count=${++counter}`)

    const r1 = await pc.compile()
    const r2 = await pc.compile()
    expect(r1.text).toContain('count=1')
    expect(r2.text).toContain('count=1') // same — cached
  })

  test('null sections are filtered out', async () => {
    const pc = new PromptCompiler()
    pc.static('yes', 'visible')
    pc.static('no', () => null)
    pc.static('also_yes', 'also visible')

    const result = await pc.compile()
    expect(result.text).toContain('visible')
    expect(result.text).toContain('also visible')
    expect(result.text).not.toContain('null')
  })

  test('tools are compiled with cached prompts', async () => {
    let calls = 0
    const pc = new PromptCompiler()
    pc.tool({
      name: 'test_tool',
      prompt: () => { calls++; return 'Test description' },
      inputSchema: { type: 'object', properties: {} },
    })

    const r1 = await pc.compile()
    const r2 = await pc.compile()
    expect(r1.tools).toHaveLength(1)
    expect(r1.tools[0]!.name).toBe('test_tool')
    expect(r1.tools[0]!.description).toBe('Test description')
    expect(calls).toBe(1) // prompt computed once, cached
  })

  test('clearCache resets everything', async () => {
    let counter = 0
    const pc = new PromptCompiler()
    pc.static('count', () => `count=${++counter}`)

    await pc.compile()
    pc.clearCache()
    const r2 = await pc.compile()
    expect(r2.text).toContain('count=2')
  })

  test('token estimates are reasonable', async () => {
    const pc = new PromptCompiler()
    pc.static('content', 'A'.repeat(400)) // ~100 tokens at 4 bytes/token

    const result = await pc.compile()
    expect(result.tokens.systemPrompt).toBe(100)
    expect(result.tokens.total).toBe(100)
  })

  test('sectionCount and toolCount', () => {
    const pc = new PromptCompiler()
    pc.static('a', 'A')
    pc.boundary()
    pc.dynamic('b', () => 'B')
    pc.tool({ name: 't', prompt: 'T', inputSchema: {} })

    expect(pc.sectionCount).toBe(2) // boundary not counted
    expect(pc.toolCount).toBe(1)
  })

  test('listSections returns correct types', () => {
    const pc = new PromptCompiler()
    pc.static('a', 'A')
    pc.boundary()
    pc.dynamic('b', () => 'B')

    const list = pc.listSections()
    expect(list).toEqual([
      { name: 'a', type: 'static' },
      { name: '__boundary__', type: 'boundary' },
      { name: 'b', type: 'dynamic' },
    ])
  })
})

// ─── Token Estimation ────────────────────────────────────────────

describe('estimateTokens', () => {
  test('default 4 bytes per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  test('custom bytes per token', () => {
    expect(estimateTokens('ab', 2)).toBe(1)
  })
})

// ─── Budget Tracking ─────────────────────────────────────────────

describe('checkBudget', () => {
  test('continues when below threshold', () => {
    const tracker = createBudgetTracker()
    const result = checkBudget(tracker, 5000, { budget: 10000 })
    expect(result.action).toBe('continue')
    expect(result.pct).toBe(50)
  })

  test('stops when at threshold', () => {
    const tracker = createBudgetTracker()
    const result = checkBudget(tracker, 9500, { budget: 10000 })
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.reason).toBe('budget_reached')
    }
  })

  test('detects diminishing returns', () => {
    const tracker = createBudgetTracker()
    // Simulate 3 continuations with tiny deltas
    tracker.continuationCount = 3
    tracker.lastDeltaTokens = 100
    tracker.lastGlobalTurnTokens = 5000
    const result = checkBudget(tracker, 5100, { budget: 10000 })
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.reason).toBe('diminishing_returns')
    }
  })

  test('stops with no budget', () => {
    const tracker = createBudgetTracker()
    const result = checkBudget(tracker, 1000, { budget: 0 })
    expect(result.action).toBe('stop')
  })
})

// ─── Cache Boundary ──────────────────────────────────────────────

describe('splitAtBoundary', () => {
  test('splits at boundary marker', () => {
    const text = `before${CACHE_BOUNDARY}after`
    const blocks = splitAtBoundary(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toBe('before')
    expect(blocks[0]!.cacheScope).toBe('global')
    expect(blocks[1]!.text).toBe('after')
    expect(blocks[1]!.cacheScope).toBeNull()
  })

  test('no boundary returns single block', () => {
    const blocks = splitAtBoundary('just text')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.cacheScope).toBe('org')
  })

  test('empty string returns empty array', () => {
    const blocks = splitAtBoundary('')
    expect(blocks).toHaveLength(0)
  })

  test('custom scopes', () => {
    const text = `A${CACHE_BOUNDARY}B`
    const blocks = splitAtBoundary(text, {
      staticScope: 'org',
      dynamicScope: 'org',
    })
    expect(blocks[0]!.cacheScope).toBe('org')
    expect(blocks[1]!.cacheScope).toBe('org')
  })
})

describe('toAnthropicBlocks', () => {
  test('adds cache_control for cached blocks', () => {
    const blocks = toAnthropicBlocks([
      { text: 'cached', cacheScope: 'global' },
      { text: 'not cached', cacheScope: null },
    ])
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1]!.cache_control).toBeUndefined()
  })

  test('no cache_control when caching disabled', () => {
    const blocks = toAnthropicBlocks(
      [{ text: 'text', cacheScope: 'global' }],
      false,
    )
    expect(blocks[0]!.cache_control).toBeUndefined()
  })
})

// ─── Section Cache ───────────────────────────────────────────────

describe('SectionCache', () => {
  test('basic get/set/has/clear', () => {
    const cache = new SectionCache()
    expect(cache.has('key')).toBe(false)
    cache.set('key', 'value')
    expect(cache.has('key')).toBe(true)
    expect(cache.get('key')).toBe('value')
    cache.clear()
    expect(cache.has('key')).toBe(false)
  })
})

describe('resolveSections', () => {
  test('resolves static and dynamic sections', async () => {
    const cache = new SectionCache()
    const sections = [
      section('static', () => 'S'),
      dynamicSection('dynamic', () => 'D'),
    ]

    const result = await resolveSections(sections, cache)
    expect(result).toEqual(['S', 'D'])
    expect(cache.has('static')).toBe(true)
    expect(cache.has('dynamic')).toBe(false) // dynamic not cached
  })
})

// ─── Tool ────────────────────────────────────────────────────────

describe('defineTool', () => {
  test('applies fail-closed defaults', () => {
    const tool = defineTool({
      name: 'test',
      prompt: 'test',
      inputSchema: {},
    })
    expect(tool.concurrencySafe).toBe(false)
    expect(tool.readOnly).toBe(false)
    expect(tool.deferred).toBe(false)
  })
})

describe('compileTool', () => {
  test('caches tool prompt', async () => {
    let calls = 0
    const cache = new ToolCache()
    const def = {
      name: 'test',
      prompt: () => { calls++; return 'description' },
      inputSchema: { type: 'object' as const },
    }

    const t1 = await compileTool(def, cache)
    const t2 = await compileTool(def, cache)
    expect(t1.description).toBe('description')
    expect(t2.description).toBe('description')
    expect(calls).toBe(1)
  })
})
