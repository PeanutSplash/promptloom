import { describe, test, expect } from 'bun:test'
import { PromptCompiler } from './compiler.ts'
import { estimateTokens, createBudgetTracker, checkBudget, parseTokenBudget } from './tokens.ts'
import { splitAtBoundary, CACHE_BOUNDARY } from './boundary.ts'
import { toAnthropic, toOpenAI, toBedrock, toAnthropicBlocks } from './providers.ts'
import { section, dynamicSection, SectionCache, resolveSections } from './section.ts'
import { defineTool, ToolCache, compileTool } from './tool.ts'

// ─── PromptCompiler: Basic (backward compat) ────────────────────

describe('PromptCompiler: basics', () => {
  test('static sections compile to single block', async () => {
    const pc = new PromptCompiler()
    pc.static('intro', 'Hello world')
    pc.static('rules', 'Be helpful')

    const result = await pc.compile()
    expect(result.text).toContain('Hello world')
    expect(result.text).toContain('Be helpful')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.cacheScope).toBe('org')
  })

  test('boundary splits blocks (enableGlobalCache)', async () => {
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
    expect(result.blocks).toHaveLength(1)
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
    expect(r2.text).toContain('count=1')
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
    pc.static('content', 'A'.repeat(400))

    const result = await pc.compile()
    expect(result.tokens.systemPrompt).toBe(100)
    expect(result.tokens.total).toBe(100)
  })
})

// ─── Multi-Zone ──────────────────────────────────────────────────

describe('PromptCompiler: multi-zone', () => {
  test('zone() creates separate blocks with explicit scopes', async () => {
    const pc = new PromptCompiler()

    pc.zone(null)
    pc.static('header', 'attribution info')

    pc.zone('global')
    pc.static('identity', 'You are an assistant.')
    pc.static('rules', 'Be helpful.')

    pc.zone(null)
    pc.dynamic('env', () => 'Platform: darwin')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[0]!.cacheScope).toBeNull()
    expect(result.blocks[0]!.text).toContain('attribution')
    expect(result.blocks[1]!.cacheScope).toBe('global')
    expect(result.blocks[1]!.text).toContain('assistant')
    expect(result.blocks[1]!.text).toContain('helpful')
    expect(result.blocks[2]!.cacheScope).toBeNull()
    expect(result.blocks[2]!.text).toContain('darwin')
  })

  test('4-block Claude Code pattern', async () => {
    const pc = new PromptCompiler()

    pc.zone(null)
    pc.static('attribution', 'x-billing: org-123')

    pc.zone(null)
    pc.static('cli_prefix', 'CLI v1.0')

    pc.zone('global')
    pc.static('identity', 'You are Claude Code.')
    pc.static('rules', 'Follow safety rules.')

    pc.zone(null)
    pc.dynamic('git', () => 'branch: main')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(4)
    expect(result.blocks[0]!.cacheScope).toBeNull()
    expect(result.blocks[1]!.cacheScope).toBeNull()
    expect(result.blocks[2]!.cacheScope).toBe('global')
    expect(result.blocks[3]!.cacheScope).toBeNull()
  })

  test('empty zones are skipped', async () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    // no sections in this zone
    pc.zone(null)
    pc.static('content', 'hello')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.text).toBe('hello')
  })

  test('zones with all-null sections are skipped', async () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('empty', () => null)
    pc.zone(null)
    pc.static('content', 'hello')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(1)
  })

  test('sections before any zone() use initial scope', async () => {
    const pc = new PromptCompiler({ defaultCacheScope: 'org' })
    pc.static('early', 'I come first')
    pc.zone('global')
    pc.static('later', 'I come second')

    const result = await pc.compile()
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0]!.cacheScope).toBe('org')
    expect(result.blocks[1]!.cacheScope).toBe('global')
  })
})

// ─── Conditional Sections ────────────────────────────────────────

describe('PromptCompiler: conditional sections', () => {
  test('when predicate includes section', async () => {
    const pc = new PromptCompiler()
    pc.static('always', 'always here')
    pc.static('opus_only', 'extended thinking', {
      when: (ctx) => ctx.model?.includes('opus') ?? false,
    })

    const r1 = await pc.compile({ model: 'claude-opus-4-6' })
    expect(r1.text).toContain('extended thinking')

    const r2 = await pc.compile({ model: 'claude-sonnet-4-6' })
    expect(r2.text).not.toContain('extended thinking')
  })

  test('when predicate on dynamic section', async () => {
    const pc = new PromptCompiler()
    pc.dynamic('mcp', () => 'MCP server instructions', {
      when: (ctx) => (ctx.mcpServers as string[])?.length > 0,
    })

    const r1 = await pc.compile({ mcpServers: ['figma'] })
    expect(r1.text).toContain('MCP server')

    const r2 = await pc.compile({ mcpServers: [] })
    expect(r2.text).toBe('')
  })

  test('when with no context defaults to empty object', async () => {
    const pc = new PromptCompiler()
    pc.static('guarded', 'secret', {
      when: (ctx) => ctx.admin === true,
    })

    const result = await pc.compile() // no context passed
    expect(result.text).toBe('')
  })

  test('conditional section in zone preserves zone scope', async () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('always', 'base rules')
    pc.static('bedrock_only', 'bedrock-specific rules', {
      when: (ctx) => ctx.provider === 'bedrock',
    })

    const r1 = await pc.compile({ provider: 'bedrock' })
    expect(r1.blocks[0]!.text).toContain('bedrock-specific')
    expect(r1.blocks[0]!.cacheScope).toBe('global')

    const r2 = await pc.compile({ provider: 'anthropic' })
    expect(r2.blocks[0]!.text).not.toContain('bedrock-specific')
  })
})

// ─── Deferred Tools ──────────────────────────────────────────────

describe('PromptCompiler: deferred tools', () => {
  test('deferred tools are separated from inline tools', async () => {
    const pc = new PromptCompiler()
    pc.tool({ name: 'bash', prompt: 'Run commands', inputSchema: {} })
    pc.tool({ name: 'web_search', prompt: 'Search web', inputSchema: {}, deferred: true })
    pc.tool({ name: 'read', prompt: 'Read files', inputSchema: {} })

    const result = await pc.compile()
    expect(result.tools).toHaveLength(2)
    expect(result.tools.map(t => t.name)).toEqual(['bash', 'read'])
    expect(result.deferredTools).toHaveLength(1)
    expect(result.deferredTools[0]!.name).toBe('web_search')
    expect(result.deferredTools[0]!.defer_loading).toBe(true)
  })

  test('deferred tools not counted in total tokens', async () => {
    const pc = new PromptCompiler()
    pc.tool({ name: 'inline', prompt: 'A'.repeat(400), inputSchema: {} })
    pc.tool({ name: 'deferred', prompt: 'B'.repeat(400), inputSchema: {}, deferred: true })

    const result = await pc.compile()
    const inlineTokens = result.tokens.tools
    const deferredTokens = result.tokens.deferredTools
    expect(deferredTokens).toBeGreaterThan(0)
    expect(result.tokens.total).toBe(result.tokens.systemPrompt + inlineTokens)
    // deferred NOT in total
    expect(result.tokens.total).not.toBe(result.tokens.systemPrompt + inlineTokens + deferredTokens)
  })
})

// ─── Tool Ordering ───────────────────────────────────────────────

describe('PromptCompiler: tool ordering', () => {
  test('tools with order field are sorted', async () => {
    const pc = new PromptCompiler()
    pc.tool({ name: 'c', prompt: 'C', inputSchema: {}, order: 3 })
    pc.tool({ name: 'a', prompt: 'A', inputSchema: {}, order: 1 })
    pc.tool({ name: 'b', prompt: 'B', inputSchema: {}, order: 2 })

    const result = await pc.compile()
    expect(result.tools.map(t => t.name)).toEqual(['a', 'b', 'c'])
  })

  test('tools without order preserve insertion order', async () => {
    const pc = new PromptCompiler()
    pc.tool({ name: 'first', prompt: 'F', inputSchema: {} })
    pc.tool({ name: 'second', prompt: 'S', inputSchema: {} })

    const result = await pc.compile()
    expect(result.tools.map(t => t.name)).toEqual(['first', 'second'])
  })

  test('ordered tools come before unordered', async () => {
    const pc = new PromptCompiler()
    pc.tool({ name: 'unordered', prompt: 'U', inputSchema: {} })
    pc.tool({ name: 'ordered', prompt: 'O', inputSchema: {}, order: 1 })

    const result = await pc.compile()
    expect(result.tools.map(t => t.name)).toEqual(['ordered', 'unordered'])
  })
})

// ─── Token Budget Parsing ────────────────────────────────────────

describe('parseTokenBudget', () => {
  test('shorthand at start', () => {
    expect(parseTokenBudget('+500k')).toBe(500_000)
    expect(parseTokenBudget('+2M')).toBe(2_000_000)
    expect(parseTokenBudget('+1.5b')).toBe(1_500_000_000)
  })

  test('shorthand at end', () => {
    expect(parseTokenBudget('do this task. +500k.')).toBe(500_000)
    expect(parseTokenBudget('refactor everything +2M!')).toBe(2_000_000)
  })

  test('verbose syntax', () => {
    expect(parseTokenBudget('use 500k tokens')).toBe(500_000)
    expect(parseTokenBudget('spend 2M tokens')).toBe(2_000_000)
    expect(parseTokenBudget('please spend 1.5b token on this')).toBe(1_500_000_000)
  })

  test('case insensitive', () => {
    expect(parseTokenBudget('+500K')).toBe(500_000)
    expect(parseTokenBudget('use 2m TOKENS')).toBe(2_000_000)
  })

  test('no match returns null', () => {
    expect(parseTokenBudget('hello world')).toBeNull()
    expect(parseTokenBudget('500 tokens')).toBeNull() // missing multiplier
    expect(parseTokenBudget('')).toBeNull()
  })
})

// ─── Provider Formatting ─────────────────────────────────────────

describe('toAnthropic', () => {
  test('formats blocks with cache_control', async () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('a', 'cached content')
    pc.zone(null)
    pc.static('b', 'uncached content')
    pc.tool({ name: 't', prompt: 'T', inputSchema: {} })

    const result = await pc.compile()
    const { system, tools } = toAnthropic(result)

    expect(system).toHaveLength(2)
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]!.cache_control).toBeUndefined()
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('t')
  })

  test('includes deferred tools with defer_loading', async () => {
    const pc = new PromptCompiler()
    pc.static('a', 'content')
    pc.tool({ name: 'inline', prompt: 'I', inputSchema: {} })
    pc.tool({ name: 'lazy', prompt: 'L', inputSchema: {}, deferred: true })

    const result = await pc.compile()
    const { tools } = toAnthropic(result)
    expect(tools).toHaveLength(2)
    expect(tools[1]!.defer_loading).toBe(true)
  })
})

describe('toOpenAI', () => {
  test('formats as single string + function tools', async () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('a', 'hello')
    pc.zone(null)
    pc.static('b', 'world')
    pc.tool({ name: 't', prompt: 'T', inputSchema: { type: 'object' } })

    const result = await pc.compile()
    const { system, tools } = toOpenAI(result)

    expect(typeof system).toBe('string')
    expect(system).toContain('hello')
    expect(system).toContain('world')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('t')
    expect(tools[0]!.function.parameters).toEqual({ type: 'object' })
  })
})

describe('toBedrock', () => {
  test('formats with cachePoint and toolSpec', async () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('a', 'cached')
    pc.zone(null)
    pc.static('b', 'not cached')
    pc.tool({ name: 't', prompt: 'T', inputSchema: { type: 'object' } })

    const result = await pc.compile()
    const { system, toolConfig } = toBedrock(result)

    expect(system).toHaveLength(2)
    expect(system[0]!.cachePoint).toEqual({ type: 'default' })
    expect(system[1]!.cachePoint).toBeUndefined()
    expect(toolConfig.tools).toHaveLength(1)
    expect(toolConfig.tools[0]!.toolSpec.name).toBe('t')
    expect(toolConfig.tools[0]!.toolSpec.inputSchema.json).toEqual({ type: 'object' })
  })
})

// ─── Backward Compat: toAnthropicBlocks ──────────────────────────

describe('toAnthropicBlocks (backward compat)', () => {
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
    if (result.action === 'stop') expect(result.reason).toBe('budget_reached')
  })

  test('detects diminishing returns', () => {
    const tracker = createBudgetTracker()
    tracker.continuationCount = 3
    tracker.lastDeltaTokens = 100
    tracker.lastGlobalTurnTokens = 5000
    const result = checkBudget(tracker, 5100, { budget: 10000 })
    expect(result.action).toBe('stop')
    if (result.action === 'stop') expect(result.reason).toBe('diminishing_returns')
  })

  test('stops with no budget', () => {
    const tracker = createBudgetTracker()
    const result = checkBudget(tracker, 1000, { budget: 0 })
    expect(result.action).toBe('stop')
  })
})

// ─── Cache Boundary (low-level utility) ──────────────────────────

describe('splitAtBoundary', () => {
  test('splits at boundary marker', () => {
    const text = `before${CACHE_BOUNDARY}after`
    const blocks = splitAtBoundary(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.cacheScope).toBe('global')
    expect(blocks[1]!.cacheScope).toBeNull()
  })

  test('no boundary returns single block', () => {
    const blocks = splitAtBoundary('just text')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.cacheScope).toBe('org')
  })

  test('empty string returns empty array', () => {
    expect(splitAtBoundary('')).toHaveLength(0)
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
    expect(cache.has('dynamic')).toBe(false)
  })

  test('respects when predicate', async () => {
    const cache = new SectionCache()
    const sections = [
      section('always', () => 'A'),
      section('gated', () => 'G', { when: (ctx) => ctx.flag === true }),
    ]

    const r1 = await resolveSections(sections, cache, { flag: true })
    expect(r1).toEqual(['A', 'G'])

    cache.clear()
    const r2 = await resolveSections(sections, cache, { flag: false })
    expect(r2).toEqual(['A'])
  })
})

// ─── Tool ────────────────────────────────────────────────────────

describe('defineTool', () => {
  test('applies fail-closed defaults', () => {
    const tool = defineTool({ name: 'test', prompt: 'test', inputSchema: {} })
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
    await compileTool(def, cache)
    await compileTool(def, cache)
    expect(calls).toBe(1)
  })

  test('deferred tool gets defer_loading', async () => {
    const cache = new ToolCache()
    const tool = await compileTool(
      { name: 'lazy', prompt: 'Lazy tool', inputSchema: {}, deferred: true },
      cache,
    )
    expect(tool.defer_loading).toBe(true)
  })
})

// ─── Inspection ──────────────────────────────────────────────────

describe('PromptCompiler: inspection', () => {
  test('sectionCount excludes zone markers', () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('a', 'A')
    pc.zone(null)
    pc.dynamic('b', () => 'B')
    expect(pc.sectionCount).toBe(2)
  })

  test('listSections includes zones', () => {
    const pc = new PromptCompiler()
    pc.zone('global')
    pc.static('a', 'A')
    pc.zone(null)
    pc.dynamic('b', () => 'B')

    expect(pc.listSections()).toEqual([
      { name: 'zone:global', type: 'zone' },
      { name: 'a', type: 'static' },
      { name: 'zone:none', type: 'zone' },
      { name: 'b', type: 'dynamic' },
    ])
  })

  test('toolCount includes deferred', () => {
    const pc = new PromptCompiler()
    pc.tool({ name: 'a', prompt: 'A', inputSchema: {} })
    pc.tool({ name: 'b', prompt: 'B', inputSchema: {}, deferred: true })
    expect(pc.toolCount).toBe(2)
  })
})
