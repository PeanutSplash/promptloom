# promptloom

Weave production-grade LLM prompts with cache boundaries, tool injection, and token budgeting.

Reverse-engineered from [Claude Code](https://claude.ai/code)'s 7-layer prompt architecture — the same patterns Anthropic uses internally to assemble system prompts for their 500K+ line CLI tool.

## Why

Every LLM app stitches prompts together from pieces. Most do it with string concatenation. Claude Code does it with a **compiler** — multi-zone cache scoping, conditional sections, per-tool prompt injection, deferred tool loading, and token budget tracking.

**promptloom** extracts these battle-tested patterns into a zero-dependency library.

| Problem | How promptloom solves it |
|---------|------------------------|
| Changing one section breaks prompt cache → wasted money | **Multi-zone scoping** — each zone gets its own cache scope (`global`, `org`, or `null`) |
| Tool descriptions scattered everywhere | **Tool registry** with session-level prompt caching and stable ordering |
| Too many tools bloat the system prompt | **Deferred tools** — marked tools are excluded from the prompt, loaded on demand |
| Sections only relevant to some models/environments | **Conditional sections** — `when` predicates gate inclusion per compile context |
| No idea how many tokens the prompt costs | **Token estimation** built into every `compile()` call |
| Different API providers need different formats | **Multi-provider output** — `toAnthropic()`, `toOpenAI()`, `toBedrock()` |

## Install

```bash
bun add promptloom
```

## Quick Start

```ts
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()

// ── Zone 1: Attribution header (no cache) ──
pc.zone(null)
pc.static('attribution', 'x-billing-org: org-123')

// ── Zone 2: Static rules (globally cacheable) ──
pc.zone('global')
pc.static('identity', 'You are a code review bot.')
pc.static('rules', 'Only comment on bugs, not style.')

// ── Zone 3: Dynamic context (session-specific, no cache) ──
pc.zone(null)
pc.dynamic('diff', async () => {
  const diff = await getCurrentDiff()
  return `Review this diff:\n${diff}`
})

// Conditional section — only included for Opus models
pc.static('thinking', 'Use extended thinking for complex reviews.', {
  when: (ctx) => ctx.model?.includes('opus') ?? false,
})

// ── Tools (inline + deferred) ──
pc.tool({
  name: 'post_comment',
  prompt: 'Post a review comment on a specific line of code.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      line: { type: 'number' },
      body: { type: 'string' },
    },
    required: ['file', 'line', 'body'],
  },
  order: 1, // explicit ordering for cache stability
})

pc.tool({
  name: 'web_search',
  prompt: 'Search the web for context.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  deferred: true, // excluded from prompt, loaded on demand
})

// ── Compile (with context for conditional sections) ──
const result = await pc.compile({ model: 'claude-opus-4-6' })

result.blocks        // CacheBlock[] — one per zone, with scope annotations
result.tools         // CompiledTool[] — inline tools only
result.deferredTools // CompiledTool[] — deferred tools (with defer_loading: true)
result.tokens        // { systemPrompt, tools, deferredTools, total }
result.text          // Full prompt as a single string
```

## Use with APIs

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()
// ... add zones, sections, and tools ...

const result = await pc.compile({ model: 'claude-sonnet-4-6' })
const { system, tools } = toAnthropic(result) // cache-annotated blocks + tool schemas

const response = await new Anthropic().messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system,   // TextBlockParam[] with cache_control
  tools,    // includes deferred tools with defer_loading: true
  messages: [{ role: 'user', content: 'Review this PR' }],
})
```

### OpenAI

```ts
import OpenAI from 'openai'
import { PromptCompiler, toOpenAI } from 'promptloom'

const pc = new PromptCompiler()
// ... add zones, sections, and tools ...

const result = await pc.compile()
const { system, tools } = toOpenAI(result) // single string + function tools

const response = await new OpenAI().chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'Review this PR' },
  ],
  tools,
})
```

### AWS Bedrock

```ts
import { PromptCompiler, toBedrock } from 'promptloom'

const result = await pc.compile()
const { system, toolConfig } = toBedrock(result) // cachePoint + toolSpec format

// Use with @aws-sdk/client-bedrock-runtime ConverseCommand
```

## Core Concepts

### Zones: Multi-Block Cache Scoping

Claude Code uses a single `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to split the prompt into 2 blocks. promptloom generalizes this to **N zones** — each zone compiles into a separate `CacheBlock` with its own cache scope.

```ts
pc.zone(null)      // Zone 1: no-cache (attribution headers)
pc.static('header', 'x-billing: org-123')

pc.zone('global')  // Zone 2: globally cacheable (identity, rules)
pc.static('identity', 'You are Claude Code.')
pc.static('rules', 'Follow safety protocols.')

pc.zone('org')     // Zone 3: org-level cacheable
pc.static('org_rules', 'Company-specific guidelines.')

pc.zone(null)      // Zone 4: session-specific (dynamic context)
pc.dynamic('git', async () => `Branch: ${await getBranch()}`)
```

This compiles to 4 `CacheBlock`s:

```
┌─────────────────────────────┐
│  x-billing: org-123         │  Block 1  scope=null    (no cache)
├─────────────────────────────┤
│  You are Claude Code.       │  Block 2  scope=global  (cross-org cache)
│  Follow safety protocols.   │
├─────────────────────────────┤
│  Company-specific guidelines│  Block 3  scope=org     (org-level cache)
├─────────────────────────────┤
│  Branch: main               │  Block 4  scope=null    (session-specific)
└─────────────────────────────┘
```

The `boundary()` method is kept for backward compatibility — it's equivalent to `zone(null)` when `enableGlobalCache` is true.

### Conditional Sections

In Claude Code, sections are gated on `feature('FLAG')`, `process.env.USER_TYPE`, and model capabilities. promptloom uses `when` predicates:

```ts
// Only for Opus models
pc.static('thinking_guide', 'Use extended thinking for complex tasks.', {
  when: (ctx) => ctx.model?.includes('opus') ?? false,
})

// Only when MCP servers are connected
pc.dynamic('mcp', async () => fetchMCPInstructions(), {
  when: (ctx) => (ctx.mcpServers as string[])?.length > 0,
})

// Only for internal users
pc.static('internal_tools', 'You have access to internal APIs.', {
  when: (ctx) => ctx.userType === 'internal',
})

// Predicates are evaluated at compile time
const result = await pc.compile({
  model: 'claude-opus-4-6',
  mcpServers: ['figma', 'slack'],
  userType: 'internal',
})
```

### Tool Prompt Injection

Every tool carries its own LLM-facing "user manual", resolved once per session and cached:

```ts
pc.tool({
  name: 'Bash',
  prompt: async () => {
    const sandbox = await detectSandbox()
    return `Execute shell commands.\n${sandbox ? 'Running in sandbox.' : ''}`
  },
  inputSchema: { /* ... */ },
  order: 1,          // explicit ordering for cache stability
})
```

### Deferred Tools

When you have many tools (Claude Code has 42+), most aren't needed every turn. Deferred tools are excluded from the system prompt and discovered on demand:

```ts
pc.tool({
  name: 'web_search',
  prompt: 'Search the web for information.',
  inputSchema: { /* ... */ },
  deferred: true,  // not in system prompt, loaded via tool search
})

const result = await pc.compile()
result.tools         // inline tools only
result.deferredTools // deferred tools (with defer_loading: true)
result.tokens.total  // does NOT count deferred tools
```

### Tool Ordering for Cache Stability

Reordering tools changes the serialized bytes, breaking prompt cache. Use `order` for deterministic sorting:

```ts
pc.tool({ name: 'bash', prompt: '...', inputSchema: {}, order: 1 })
pc.tool({ name: 'read', prompt: '...', inputSchema: {}, order: 2 })
pc.tool({ name: 'edit', prompt: '...', inputSchema: {}, order: 3 })
// Tools without `order` come last, in insertion order
```

### Token Budget

#### Estimation

Every `compile()` call includes token estimates:

```ts
const result = await pc.compile()
result.tokens.systemPrompt  // ~350 tokens
result.tokens.tools         // ~200 tokens (inline only)
result.tokens.deferredTools // ~100 tokens (not counted in total)
result.tokens.total         // ~550 tokens (systemPrompt + tools)
```

#### Budget Tracking

For long-running agent loops:

```ts
import { createBudgetTracker, checkBudget } from 'promptloom'

const tracker = createBudgetTracker()
const decision = checkBudget(tracker, currentTokens, { budget: 100_000 })

if (decision.action === 'continue') {
  // Inject decision.nudgeMessage to keep the model working
} else {
  // decision.reason: 'budget_reached' | 'diminishing_returns'
}
```

#### Budget Parsing from Natural Language

Parse user-specified budgets like Claude Code does:

```ts
import { parseTokenBudget } from 'promptloom'

parseTokenBudget('+500k')           // 500_000
parseTokenBudget('spend 2M tokens') // 2_000_000
parseTokenBudget('+1.5b')           // 1_500_000_000
parseTokenBudget('hello world')     // null
```

## API Reference

### `PromptCompiler`

| Method | Description |
|--------|-------------|
| `zone(scope)` | Start a new cache zone (`'global'`, `'org'`, or `null`) |
| `boundary()` | Shorthand for `zone(null)` when `enableGlobalCache` is true |
| `static(name, content, options?)` | Add a static section. `options.when` for conditional inclusion |
| `dynamic(name, compute, options?)` | Add a dynamic section (recomputed every `compile()`) |
| `tool(def)` | Register a tool. Set `deferred: true` for on-demand loading, `order` for sort stability |
| `compile(context?)` | Compile everything → `CompileResult`. Context is passed to `when` predicates |
| `clearCache()` | Clear all section + tool caches |
| `clearSectionCache()` | Clear only section cache |
| `clearToolCache()` | Clear only tool cache |
| `sectionCount` | Number of registered sections (excludes zone markers) |
| `toolCount` | Number of registered tools (inline + deferred) |
| `listSections()` | List sections with their types (`static`, `dynamic`, `zone`) |
| `listTools()` | List registered tool names |

### `CompileResult`

| Field | Type | Description |
|-------|------|-------------|
| `blocks` | `CacheBlock[]` | One block per zone, with `cacheScope` annotations |
| `tools` | `CompiledTool[]` | Inline tool schemas with resolved descriptions |
| `deferredTools` | `CompiledTool[]` | Deferred tool schemas (with `defer_loading: true`) |
| `tokens` | `TokenEstimate` | `{ systemPrompt, tools, deferredTools, total }` |
| `text` | `string` | Full prompt as a single joined string |

### Provider Formatters

```ts
import { toAnthropic, toOpenAI, toBedrock } from 'promptloom'

toAnthropic(result)  // { system: TextBlockParam[], tools: AnthropicTool[] }
toOpenAI(result)     // { system: string, tools: { type: 'function', function }[] }
toBedrock(result)    // { system: BedrockTextBlock[], toolConfig: { tools } }
```

### Standalone Utilities

```ts
import {
  // Token estimation
  estimateTokens,           // Rough estimate (bytes / 4)
  estimateTokensForFileType, // File-type-aware (JSON = bytes / 2)

  // Budget
  createBudgetTracker,       // Create a new tracker
  checkBudget,               // Check budget → continue or stop
  parseTokenBudget,          // Parse "+500k" → 500_000

  // Low-level (for custom compilers)
  splitAtBoundary,           // Split text at sentinel → CacheBlock[]
  section,                   // Create a static Section object
  dynamicSection,            // Create a dynamic Section object
  defineTool,                // Create a ToolDef with fail-closed defaults
  SectionCache,              // Section cache class
  ToolCache,                 // Tool cache class
  resolveSections,           // Resolve sections against cache
  compileTool,               // Compile a single tool
  compileTools,              // Compile all tools
} from 'promptloom'
```

## Background: Claude Code's Prompt Architecture

This library extracts patterns from Claude Code's source (leaked via unstripped source maps in March 2025). The key insight: **Anthropic treats prompts as compiler output, not handwritten text.**

Their system prompt is assembled from 7+ layers:

1. **Identity** — who the AI is
2. **System** — tool execution context, hooks, compression
3. **Doing Tasks** — code style, security, collaboration rules
4. **Actions** — risk-aware execution, reversibility
5. **Using Tools** — tool preference guidance, parallel execution
6. **Tone & Style** — conciseness, formatting rules
7. **Dynamic context** — git status, CLAUDE.md files, user memory, MCP server instructions

Layers 1-6 are **static** (globally cacheable). Layer 7+ is **dynamic** (session-specific). The boundary between them is a literal sentinel string that the API layer uses to annotate cache scopes.

Sections are conditionally included based on feature flags (`feature('TOKEN_BUDGET')`), user type (`process.env.USER_TYPE === 'ant'`), and model capabilities. Each of their 42+ tools carries its own `prompt.ts`, and tools above a context threshold are deferred (loaded via `ToolSearchTool` on demand).

promptloom gives you all of these primitives.

## License

MIT
