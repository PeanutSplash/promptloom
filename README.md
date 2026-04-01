<div align="center">

# promptloom

**Weave production-grade LLM prompts with cache boundaries, tool injection, and token budgeting.**

Reverse-engineered from [Claude Code](https://claude.ai/code)'s 7-layer prompt architecture — the same patterns Anthropic uses internally to assemble system prompts for their 500K+ line CLI tool.

[![npm version](https://img.shields.io/npm/v/promptloom?color=f97316)](https://www.npmjs.com/package/promptloom)
[![license](https://img.shields.io/npm/l/promptloom?color=22c55e)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![zero deps](https://img.shields.io/badge/dependencies-0-10b981)](./package.json)

[Quick Start](#quick-start) | [Documentation](#core-concepts) | [API Reference](#api-reference) | [LLM Docs](https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt)

</div>

---

## Why

Every LLM app stitches prompts together from pieces. Most do it with string concatenation. Claude Code does it with a **compiler** — multi-zone cache scoping, conditional sections, per-tool prompt injection, deferred tool loading, and token budget tracking.

**promptloom** extracts these battle-tested patterns into a zero-dependency library.

### Highlights

- **Multi-zone cache scoping** — each zone gets its own cache scope (`global`, `org`, or `null`), so changing one section won't break the cache for others
- **Tool registry** — session-level prompt caching with stable ordering and deferred loading for 40+ tool setups
- **Conditional sections** — `when` predicates gate inclusion per model, environment, or user type
- **Token estimation & budgeting** — built into every `compile()` call, with diminishing returns detection for agent loops
- **5 provider formatters** — `toAnthropic()` / `toOpenAI()` / `toOpenAIResponses()` / `toBedrock()` / `toGemini()` plus any OpenAI-compatible provider (Groq, Together, DeepSeek, Mistral, Fireworks...)

## Install

```bash
# npm
npm install promptloom

# bun
bun add promptloom

# pnpm
pnpm add promptloom

# yarn
yarn add promptloom
```

> **Requirements:** TypeScript ^6.0 (peer dependency). Zero runtime dependencies.

## Quick Start

### For Agents

Feed this to your AI assistant and start building:

```bash
curl -s https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt
```

Or paste the URL directly in your AI chat:

```
https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt
```

### For Humans

```ts
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()

// Zone 1: Attribution header (no cache)
pc.zone(null)
pc.static('attribution', 'x-billing-org: org-123')

// Zone 2: Static rules (globally cacheable)
pc.zone('global')
pc.static('identity', 'You are a code review bot.')
pc.static('rules', 'Only comment on bugs, not style.')

// Zone 3: Dynamic context (session-specific)
pc.zone(null)
pc.dynamic('diff', async () => {
  const diff = await getCurrentDiff()
  return `Review this diff:\n${diff}`
})

// Conditional section — only included for Opus models
pc.static('thinking', 'Use extended thinking for complex reviews.', {
  when: (ctx) => ctx.model?.includes('opus') ?? false,
})

// Tools (inline + deferred)
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
  order: 1,
})

pc.tool({
  name: 'web_search',
  prompt: 'Search the web for context.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  deferred: true, // excluded from prompt, loaded on demand
})

// Compile
const result = await pc.compile({ model: 'claude-opus-4-6' })

result.blocks        // CacheBlock[] — one per zone, with scope annotations
result.tools         // CompiledTool[] — inline tools only
result.deferredTools // CompiledTool[] — deferred tools
result.tokens        // { systemPrompt, tools, deferredTools, total }
result.text          // Full prompt as a single string
```

## Use with APIs

<details>
<summary><b>Anthropic</b></summary>

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()
// ... add zones, sections, and tools ...

const result = await pc.compile({ model: 'claude-sonnet-4-6' })
const { system, tools } = toAnthropic(result)

const response = await new Anthropic().messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system,   // TextBlockParam[] with cache_control
  tools,    // includes deferred tools with defer_loading: true
  messages: [{ role: 'user', content: 'Review this PR' }],
})
```

</details>

<details>
<summary><b>OpenAI</b></summary>

```ts
import OpenAI from 'openai'
import { PromptCompiler, toOpenAI } from 'promptloom'

const pc = new PromptCompiler()
// ... add zones, sections, and tools ...

const result = await pc.compile()
const { system, tools } = toOpenAI(result)

const response = await new OpenAI().chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'Review this PR' },
  ],
  tools,
})
```

</details>

<details>
<summary><b>OpenAI Responses API</b></summary>

```ts
import OpenAI from 'openai'
import { PromptCompiler, toOpenAIResponses } from 'promptloom'

const pc = new PromptCompiler()
// ... add zones, sections, and tools ...

const result = await pc.compile()
const { instructions, tools } = toOpenAIResponses(result)

const response = await new OpenAI().responses.create({
  model: 'gpt-4o',
  instructions,
  input: 'Review this PR',
  tools,
})
```

</details>

<details>
<summary><b>AWS Bedrock</b></summary>

```ts
import { PromptCompiler, toBedrock } from 'promptloom'

const result = await pc.compile()
const { system, toolConfig } = toBedrock(result)

// Use with @aws-sdk/client-bedrock-runtime ConverseCommand
```

</details>

<details>
<summary><b>Google Gemini / Vertex AI</b></summary>

```ts
import { GoogleGenAI } from '@google/genai'
import { PromptCompiler, toGemini } from 'promptloom'

const pc = new PromptCompiler()
// ... add zones, sections, and tools ...

const result = await pc.compile()
const { systemInstruction, tools } = toGemini(result)

const response = await new GoogleGenAI({ apiKey: '...' }).models.generateContent({
  model: 'gemini-2.5-pro',
  contents: [{ role: 'user', parts: [{ text: 'Review this PR' }] }],
  config: { systemInstruction, tools },
})
```

</details>

<details>
<summary><b>OpenAI-Compatible Providers (Groq, Together, DeepSeek, Mistral, Fireworks)</b></summary>

`toOpenAI()` works with any OpenAI-compatible API — just swap the `baseURL`:

```ts
import OpenAI from 'openai'
import { PromptCompiler, toOpenAI } from 'promptloom'

const result = await pc.compile()
const { system, tools } = toOpenAI(result)

// Groq
const groq = new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: '...' })

// Together AI
const together = new OpenAI({ baseURL: 'https://api.together.xyz/v1', apiKey: '...' })

// DeepSeek
const deepseek = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: '...' })

// Mistral
const mistral = new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: '...' })

// Fireworks AI
const fireworks = new OpenAI({ baseURL: 'https://api.fireworks.ai/inference/v1', apiKey: '...' })
```

</details>

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

Compiles to 4 `CacheBlock`s:

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

### Conditional Sections

Gate sections on model, environment, or user type:

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

const result = await pc.compile({
  model: 'claude-opus-4-6',
  mcpServers: ['figma', 'slack'],
  userType: 'internal',
})
```

### Tool Management

#### Tool Prompt Injection

Every tool carries its own LLM-facing description, resolved once per session and cached:

```ts
pc.tool({
  name: 'Bash',
  prompt: async () => {
    const sandbox = await detectSandbox()
    return `Execute shell commands.\n${sandbox ? 'Running in sandbox.' : ''}`
  },
  inputSchema: { /* ... */ },
  order: 1, // explicit ordering for cache stability
})
```

#### Deferred Tools

When you have many tools (Claude Code has 42+), most aren't needed every turn:

```ts
pc.tool({
  name: 'web_search',
  prompt: 'Search the web for information.',
  inputSchema: { /* ... */ },
  deferred: true, // not in system prompt, loaded via tool search
})

const result = await pc.compile()
result.tools         // inline tools only
result.deferredTools // deferred tools (with defer_loading: true)
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

#### Budget Tracking for Agent Loops

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

#### Natural Language Budget Parsing

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
| `compile(context?)` | Compile everything -> `CompileResult`. Context is passed to `when` predicates |
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

| Formatter | Output | Providers |
|-----------|--------|-----------|
| `toAnthropic(result)` | `{ system, tools }` | Anthropic (1P) |
| `toOpenAI(result)` | `{ system, tools }` | OpenAI, Azure, Groq, Together, DeepSeek, Mistral, Fireworks, Cohere v2 |
| `toOpenAIResponses(result)` | `{ instructions, tools }` | OpenAI Responses API |
| `toBedrock(result)` | `{ system, toolConfig }` | AWS Bedrock (Claude, Llama, Mistral, Cohere — Converse API) |
| `toGemini(result)` | `{ systemInstruction, tools }` | Google Gemini, Google Vertex AI |

### Standalone Utilities

```ts
import {
  // Token estimation
  estimateTokens,              // Rough estimate (bytes / 4)
  estimateTokensForFileType,   // File-type-aware (JSON = bytes / 2)

  // Budget
  createBudgetTracker,         // Create a new tracker
  checkBudget,                 // Check budget -> continue or stop
  parseTokenBudget,            // Parse "+500k" -> 500_000

  // Low-level (for custom compilers)
  splitAtBoundary,             // Split text at sentinel -> CacheBlock[]
  section,                     // Create a static Section object
  dynamicSection,              // Create a dynamic Section object
  defineTool,                  // Create a ToolDef with fail-closed defaults
  SectionCache,                // Section cache class
  ToolCache,                   // Tool cache class
  resolveSections,             // Resolve sections against cache
  compileTool,                 // Compile a single tool
  compileTools,                // Compile all tools
} from 'promptloom'
```

## Background: Claude Code's Prompt Architecture

This library extracts patterns from Claude Code's source (leaked via unstripped source maps in March 2026). The key insight: **Anthropic treats prompts as compiler output, not handwritten text.**

Their system prompt is assembled from 7+ layers:

1. **Identity** — who the AI is
2. **System** — tool execution context, hooks, compression
3. **Doing Tasks** — code style, security, collaboration rules
4. **Actions** — risk-aware execution, reversibility
5. **Using Tools** — tool preference guidance, parallel execution
6. **Tone & Style** — conciseness, formatting rules
7. **Dynamic context** — git status, CLAUDE.md files, user memory, MCP server instructions

Layers 1-6 are **static** (globally cacheable). Layer 7+ is **dynamic** (session-specific). The boundary between them is a literal sentinel string that the API layer uses to annotate cache scopes.

## Contributing

Contributions are welcome! Please feel free to open an issue or submit a pull request.

```bash
git clone https://github.com/PeanutSplash/promptloom.git
cd promptloom
bun install
bun test          # Run tests
bun run dev       # Run CLI demo
bunx tsc --noEmit # Type check
```

## License

[MIT](./LICENSE)

---

<div align="center">

**[GitHub](https://github.com/PeanutSplash/promptloom)** | **[npm](https://www.npmjs.com/package/promptloom)** | **[LLM Docs](https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt)**

</div>
