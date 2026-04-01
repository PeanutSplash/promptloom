# promptloom

Weave production-grade LLM prompts with cache boundaries, tool injection, and token budgeting.

Reverse-engineered from [Claude Code](https://claude.ai/code)'s 7-layer prompt architecture — the same patterns Anthropic uses internally to assemble system prompts for their 500K+ line CLI tool.

## Why

Every LLM app stitches prompts together from pieces. Most do it with string concatenation. Claude Code does it with a **compiler** — static/dynamic section separation, cache boundary markers, per-tool prompt injection, and token budget tracking.

**promptloom** extracts these battle-tested patterns into a zero-dependency library.

| Problem | How promptloom solves it |
|---------|------------------------|
| Changing one section breaks prompt cache → wasted money | **Cache boundary** splits static (cacheable) from dynamic content |
| Tool descriptions scattered everywhere | **Tool registry** with session-level prompt caching |
| No idea how many tokens the prompt costs | **Token estimation** built into every `compile()` call |
| Dynamic context recomputed unnecessarily | **Two-tier caching**: static sections compute once, dynamic sections recompute per turn |

## Install

```bash
bun add promptloom
```

## Quick Start

```ts
import { PromptCompiler } from 'promptloom'

const pc = new PromptCompiler({ enableGlobalCache: true })

// ── Static sections (computed once, cached for the session) ──
pc.static('identity', 'You are a code review bot.')
pc.static('rules', 'Only comment on bugs, not style.')

// ── Cache boundary ──
// Everything above is globally cacheable (saves money on Anthropic API).
// Everything below is session-specific.
pc.boundary()

// ── Dynamic sections (recomputed every compile() call) ──
pc.dynamic('context', async () => {
  const diff = await getCurrentDiff()
  return `Review this diff:\n${diff}`
})

// ── Tools with embedded prompts ──
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
})

// ── Compile ──
const result = await pc.compile()

result.blocks   // CacheBlock[] — with cache scope annotations
result.tools    // CompiledTool[] — with resolved prompt descriptions
result.tokens   // { systemPrompt: 150, tools: 200, total: 350 }
result.text     // Full prompt as a single string
```

## Use with the Anthropic API

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PromptCompiler, toAnthropicBlocks } from 'promptloom'

const pc = new PromptCompiler({ enableGlobalCache: true })
// ... add sections and tools ...

const result = await pc.compile()
const client = new Anthropic()

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system: toAnthropicBlocks(result.blocks), // cache-annotated blocks
  tools: result.tools,                       // compiled tool schemas
  messages: [{ role: 'user', content: 'Review this PR' }],
})
```

## Core Concepts

### Sections: Static vs Dynamic

Inspired by Claude Code's `systemPromptSection()` and `DANGEROUS_uncachedSystemPromptSection()`:

```ts
// Static: computed once, cached for the entire session
pc.static('rules', () => loadRulesFromFile())

// Dynamic: recomputed every compile() call
// Use sparingly — breaks prompt cache stability
pc.dynamic('mcp_servers', async () => {
  const servers = await discoverMCPServers()
  return formatServerInstructions(servers)
})
```

Static sections are resolved once and cached in memory (mirroring Claude Code's `systemPromptSectionCache`). Dynamic sections always recompute — Claude Code names them "DANGEROUS" for good reason: they break cache hit rates.

### Cache Boundary

The boundary marker splits the prompt into two zones:

```
┌─────────────────────────────┐
│  Static Section 1           │
│  Static Section 2           │  ← cacheScope: 'global'
│  Static Section 3           │    (cross-org cacheable)
├─────────────────────────────┤  ← pc.boundary()
│  Dynamic Section 1          │
│  Dynamic Section 2          │  ← cacheScope: null
│                             │    (session-specific)
└─────────────────────────────┘
```

This maps directly to Anthropic API's `cache_control` field on system prompt text blocks. Content before the boundary can be cached across all users of your app. Content after is unique per session.

### Tool Prompt Injection

In Claude Code, every tool has its own `prompt.ts` — an LLM-facing "user manual". promptloom mirrors this pattern:

```ts
pc.tool({
  name: 'Bash',
  // This prompt is the tool's "description" sent to the API.
  // It's resolved once per session and cached (avoids mid-session drift).
  prompt: async () => {
    const sandbox = await detectSandbox()
    return `Execute shell commands.\n${sandbox ? 'Running in sandbox.' : ''}`
  },
  inputSchema: { /* ... */ },
})
```

Tool prompts support both static strings and async functions. The resolved description is cached per session with a stable cache key (including the input schema hash), preventing unnecessary recomputation.

### Token Budget Tracking

For long-running agent loops that need to monitor token consumption:

```ts
import { createBudgetTracker, checkBudget } from 'promptloom'

const tracker = createBudgetTracker()

// In your agent loop:
const decision = checkBudget(tracker, currentTokens, { budget: 100_000 })

if (decision.action === 'continue') {
  // Inject decision.nudgeMessage to keep the model working
} else {
  // decision.reason: 'budget_reached' | 'diminishing_returns'
}
```

The budget tracker detects **diminishing returns** — if the model produces tiny outputs for 3+ consecutive continuations, it stops automatically instead of wasting tokens.

## API Reference

### `PromptCompiler`

| Method | Description |
|--------|-------------|
| `static(name, content)` | Add a static section (string or sync/async function) |
| `dynamic(name, compute)` | Add a dynamic section (recomputed every `compile()`) |
| `boundary()` | Insert cache boundary marker |
| `tool(def)` | Register a tool with embedded prompt |
| `compile()` | Compile everything → `CompileResult` |
| `clearCache()` | Clear all section + tool caches |
| `clearSectionCache()` | Clear only section cache |
| `clearToolCache()` | Clear only tool cache |
| `sectionCount` | Number of registered sections |
| `toolCount` | Number of registered tools |
| `listSections()` | List sections with their types |
| `listTools()` | List registered tool names |

### `CompileResult`

| Field | Type | Description |
|-------|------|-------------|
| `blocks` | `CacheBlock[]` | Prompt blocks with `cacheScope` annotations |
| `tools` | `CompiledTool[]` | API-ready tool schemas with resolved descriptions |
| `tokens` | `TokenEstimate` | `{ systemPrompt, tools, total }` |
| `text` | `string` | Full prompt as a single joined string |

### Standalone Utilities

```ts
import {
  // Cache boundary
  splitAtBoundary,     // Split text at boundary → CacheBlock[]
  toAnthropicBlocks,   // Convert CacheBlock[] → Anthropic API format

  // Token estimation
  estimateTokens,           // Rough estimate (bytes / 4)
  estimateTokensForFileType, // File-type-aware (JSON = bytes / 2)

  // Budget tracking
  createBudgetTracker,  // Create a new tracker
  checkBudget,          // Check budget → continue or stop

  // Low-level helpers
  section,              // Create a static Section object
  dynamicSection,       // Create a dynamic Section object
  defineTool,           // Create a ToolDef with fail-closed defaults
  SectionCache,         // Section cache class
  ToolCache,            // Tool cache class
  resolveSections,      // Resolve sections against cache
  compileTool,          // Compile a single tool
  compileTools,         // Compile all tools
} from 'promptloom'
```

## CLI

```bash
# Run the built-in demo (visualizes the 7-layer assembly)
bun run bin/cli.ts demo
```

Output:

```
  Sections
  ─────────────────────────────────────────────
  STATIC   identity
  STATIC   system
  STATIC   doing_tasks
  STATIC   actions
  STATIC   tool_usage
  STATIC   style
  ───────  cache boundary
  DYNAMIC  env
  DYNAMIC  git
  DYNAMIC  memory

  Cache Blocks
  ─────────────────────────────────────────────
  Block 1  scope=global  ~212 tokens, 27 lines
  Block 2  scope=none    ~56 tokens, 11 lines

  Tools
  ─────────────────────────────────────────────
  Bash         prompt=~55t  schema=~95t
  Read         prompt=~45t  schema=~128t
  Edit         prompt=~45t  schema=~88t

  Token Estimates
  ─────────────────────────────────────────────
  System prompt:  268 tokens
  Tool schemas:   456 tokens
  Total:          724 tokens
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

Each of their 42 tools carries its own `prompt.ts` — an LLM-facing instruction manual that's injected into the tool description and cached per session.

promptloom gives you these same primitives.

## License

MIT
