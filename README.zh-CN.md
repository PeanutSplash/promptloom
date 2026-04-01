<div align="center">

# promptloom

**为 LLM 应用编织生产级提示词 —— 多区域缓存、工具注入、Token 预算，一步到位。**

从 [Claude Code](https://claude.ai/code) 的 7 层提示词架构逆向工程而来 —— 这正是 Anthropic 内部用来组装其 51 万行 CLI 工具系统提示词的模式。

[![npm version](https://img.shields.io/npm/v/promptloom?color=f97316)](https://www.npmjs.com/package/promptloom)
[![license](https://img.shields.io/npm/l/promptloom?color=22c55e)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![zero deps](https://img.shields.io/badge/dependencies-0-10b981)](./package.json)

[快速上手](#快速上手) | [文档](#核心概念) | [API 参考](#api-参考) | [English](./README.md) | [LLM 文档](https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt)

</div>

---

## 为什么需要它

每个 LLM 应用都在拼接提示词。大多数用字符串拼接。Claude Code 用的是**编译器** —— 多区域缓存范围、条件段、逐工具提示词注入、延迟工具加载、Token 预算追踪。

**promptloom** 把这些经过生产验证的模式提炼成零依赖库。

### 核心特性

- **多区域缓存** —— 每个 zone 有独立的缓存范围（`global`、`org`、`null`），改一个区不会破坏其他区的缓存
- **工具注册表** —— 会话级缓存 + 稳定排序 + 延迟加载，轻松管理 40+ 工具
- **条件段** —— `when` 谓词按模型、环境、用户类型门控
- **Token 估算与预算** —— 每次 `compile()` 自动估算，Agent 循环支持边际收益递减检测
- **5 种 Provider 格式** —— `toAnthropic()` / `toOpenAI()` / `toOpenAIResponses()` / `toBedrock()` / `toGemini()` 以及所有 OpenAI 兼容供应商（Groq、Together、DeepSeek、Mistral、Fireworks...）

## 安装

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

> **环境要求：** TypeScript ^6.0（peer dependency）。零运行时依赖。

## 快速上手

### For Agents

把下面的链接发给你的 AI 助手，即可开始开发：

```bash
curl -s https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt
```

或直接在 AI 对话中粘贴链接：

```
https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt
```

### For Humans

```ts
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()

// Zone 1: 归属头（不缓存）
pc.zone(null)
pc.static('attribution', 'x-billing-org: org-123')

// Zone 2: 静态规则（全局可缓存）
pc.zone('global')
pc.static('identity', '你是一个代码审查机器人。')
pc.static('rules', '只评论 Bug，不评论代码风格。')

// Zone 3: 动态上下文（会话级，不缓存）
pc.zone(null)
pc.dynamic('diff', async () => {
  const diff = await getCurrentDiff()
  return `审查这段 diff:\n${diff}`
})

// 条件段 —— 仅在 Opus 模型时包含
pc.static('thinking', '对复杂审查使用扩展思考。', {
  when: (ctx) => ctx.model?.includes('opus') ?? false,
})

// 工具（内联 + 延迟）
pc.tool({
  name: 'post_comment',
  prompt: '在代码的指定行发布审查评论。',
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
  prompt: '搜索网页获取上下文。',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  deferred: true, // 不进系统提示词，按需加载
})

// 编译
const result = await pc.compile({ model: 'claude-opus-4-6' })

result.blocks        // CacheBlock[] — 每个 zone 一个块，带缓存范围标注
result.tools         // CompiledTool[] — 仅内联工具
result.deferredTools // CompiledTool[] — 延迟工具
result.tokens        // { systemPrompt, tools, deferredTools, total }
result.text          // 完整提示词文本
```

## 配合各 API 使用

<details>
<summary><b>Anthropic</b></summary>

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()
// ... 添加 zone、section、tool ...

const result = await pc.compile({ model: 'claude-sonnet-4-6' })
const { system, tools } = toAnthropic(result)

const response = await new Anthropic().messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system,   // TextBlockParam[]，带 cache_control
  tools,    // 包含延迟工具（带 defer_loading: true）
  messages: [{ role: 'user', content: '审查这个 PR' }],
})
```

</details>

<details>
<summary><b>OpenAI</b></summary>

```ts
import OpenAI from 'openai'
import { PromptCompiler, toOpenAI } from 'promptloom'

const pc = new PromptCompiler()
// ... 添加 zone、section、tool ...

const result = await pc.compile()
const { system, tools } = toOpenAI(result)

const response = await new OpenAI().chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: '审查这个 PR' },
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
// ... 添加 zone、section、tool ...

const result = await pc.compile()
const { instructions, tools } = toOpenAIResponses(result)

const response = await new OpenAI().responses.create({
  model: 'gpt-4o',
  instructions,
  input: '审查这个 PR',
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

// 用于 @aws-sdk/client-bedrock-runtime ConverseCommand
```

</details>

<details>
<summary><b>Google Gemini / Vertex AI</b></summary>

```ts
import { GoogleGenAI } from '@google/genai'
import { PromptCompiler, toGemini } from 'promptloom'

const pc = new PromptCompiler()
// ... 添加 zone、section、tool ...

const result = await pc.compile()
const { systemInstruction, tools } = toGemini(result)

const response = await new GoogleGenAI({ apiKey: '...' }).models.generateContent({
  model: 'gemini-2.5-pro',
  contents: [{ role: 'user', parts: [{ text: '审查这个 PR' }] }],
  config: { systemInstruction, tools },
})
```

Vertex AI 使用相同格式，只需更换客户端初始化方式。

</details>

<details>
<summary><b>OpenAI 兼容供应商（Groq、Together、DeepSeek、Mistral、Fireworks）</b></summary>

`toOpenAI()` 适用于所有 OpenAI 兼容 API —— 只需更换 `baseURL`：

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

## 核心概念

### Zone：多块缓存范围

Claude Code 用一个 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 把提示词分成 2 块。promptloom 将其泛化为 **N 个 zone** —— 每个 zone 编译成独立的 `CacheBlock`，拥有自己的缓存范围。

```ts
pc.zone(null)      // Zone 1: 不缓存（归属头）
pc.static('header', 'x-billing: org-123')

pc.zone('global')  // Zone 2: 全局可缓存（身份、规则）
pc.static('identity', '你是 Claude Code。')
pc.static('rules', '遵守安全协议。')

pc.zone('org')     // Zone 3: 组织级可缓存
pc.static('org_rules', '公司专属规范。')

pc.zone(null)      // Zone 4: 会话级（动态上下文）
pc.dynamic('git', async () => `分支: ${await getBranch()}`)
```

编译结果为 4 个 `CacheBlock`：

```
┌─────────────────────────────┐
│  x-billing: org-123         │  Block 1  scope=null    （不缓存）
├─────────────────────────────┤
│  你是 Claude Code。          │  Block 2  scope=global  （跨组织缓存）
│  遵守安全协议。              │
├─────────────────────────────┤
│  公司专属规范。              │  Block 3  scope=org     （组织级缓存）
├─────────────────────────────┤
│  分支: main                  │  Block 4  scope=null    （会话级）
└─────────────────────────────┘
```

### 条件段

按模型、环境、用户类型门控段：

```ts
// 仅 Opus 模型
pc.static('thinking_guide', '对复杂任务使用扩展思考。', {
  when: (ctx) => ctx.model?.includes('opus') ?? false,
})

// 仅连接了 MCP 服务器时
pc.dynamic('mcp', async () => fetchMCPInstructions(), {
  when: (ctx) => (ctx.mcpServers as string[])?.length > 0,
})

// 仅内部用户
pc.static('internal_tools', '你可以访问内部 API。', {
  when: (ctx) => ctx.userType === 'internal',
})

const result = await pc.compile({
  model: 'claude-opus-4-6',
  mcpServers: ['figma', 'slack'],
  userType: 'internal',
})
```

### 工具管理

#### 工具提示词注入

每个工具带有面向 LLM 的"使用手册"，每个会话解析一次后缓存：

```ts
pc.tool({
  name: 'Bash',
  prompt: async () => {
    const sandbox = await detectSandbox()
    return `执行 Shell 命令。\n${sandbox ? '在沙箱中运行。' : ''}`
  },
  inputSchema: { /* ... */ },
  order: 1, // 显式排序，保证缓存稳定性
})
```

#### 延迟工具

当工具很多时（Claude Code 有 42+），大部分每轮并不需要：

```ts
pc.tool({
  name: 'web_search',
  prompt: '搜索网页获取信息。',
  inputSchema: { /* ... */ },
  deferred: true, // 不进系统提示词，通过 tool search 按需加载
})

const result = await pc.compile()
result.tools         // 仅内联工具
result.deferredTools // 延迟工具（带 defer_loading: true）
```

### Token 预算

#### 估算

每次 `compile()` 调用都包含 token 估算：

```ts
const result = await pc.compile()
result.tokens.systemPrompt  // ~350 tokens
result.tokens.tools         // ~200 tokens（仅内联）
result.tokens.deferredTools // ~100 tokens（不计入 total）
result.tokens.total         // ~550 tokens（systemPrompt + tools）
```

#### Agent 循环预算追踪

```ts
import { createBudgetTracker, checkBudget } from 'promptloom'

const tracker = createBudgetTracker()
const decision = checkBudget(tracker, currentTokens, { budget: 100_000 })

if (decision.action === 'continue') {
  // 注入 decision.nudgeMessage 让模型继续工作
} else {
  // decision.reason: 'budget_reached' | 'diminishing_returns'
}
```

#### 自然语言预算解析

```ts
import { parseTokenBudget } from 'promptloom'

parseTokenBudget('+500k')           // 500_000
parseTokenBudget('spend 2M tokens') // 2_000_000
parseTokenBudget('+1.5b')           // 1_500_000_000
parseTokenBudget('hello world')     // null
```

## API 参考

### `PromptCompiler`

| 方法 | 描述 |
|------|------|
| `zone(scope)` | 开始新的缓存区域（`'global'`、`'org'` 或 `null`）|
| `boundary()` | `zone(null)` 的简写（需 `enableGlobalCache: true`）|
| `static(name, content, options?)` | 添加静态段。`options.when` 用于条件包含 |
| `dynamic(name, compute, options?)` | 添加动态段（每次 `compile()` 重算）|
| `tool(def)` | 注册工具。`deferred: true` 按需加载，`order` 控制排序 |
| `compile(context?)` | 编译一切 -> `CompileResult`。上下文传给 `when` 谓词 |
| `clearCache()` | 清除所有段 + 工具缓存 |
| `clearSectionCache()` | 只清除段缓存 |
| `clearToolCache()` | 只清除工具缓存 |
| `sectionCount` | 已注册的段数量（不含 zone 标记）|
| `toolCount` | 已注册的工具数量（内联 + 延迟）|
| `listSections()` | 列出所有段及其类型（`static`、`dynamic`、`zone`）|
| `listTools()` | 列出已注册的工具名 |

### `CompileResult`

| 字段 | 类型 | 描述 |
|------|------|------|
| `blocks` | `CacheBlock[]` | 每个 zone 一个块，带 `cacheScope` 标注 |
| `tools` | `CompiledTool[]` | 内联工具 schema（描述已解析）|
| `deferredTools` | `CompiledTool[]` | 延迟工具 schema（带 `defer_loading: true`）|
| `tokens` | `TokenEstimate` | `{ systemPrompt, tools, deferredTools, total }` |
| `text` | `string` | 完整提示词（所有块拼接后的文本）|

### Provider 格式化

| 格式化器 | 输出 | 覆盖的供应商 |
|----------|------|-------------|
| `toAnthropic(result)` | `{ system, tools }` | Anthropic (1P) |
| `toOpenAI(result)` | `{ system, tools }` | OpenAI、Azure、Groq、Together、DeepSeek、Mistral、Fireworks、Cohere v2 |
| `toOpenAIResponses(result)` | `{ instructions, tools }` | OpenAI Responses API |
| `toBedrock(result)` | `{ system, toolConfig }` | AWS Bedrock（Claude、Llama、Mistral、Cohere —— Converse API）|
| `toGemini(result)` | `{ systemInstruction, tools }` | Google Gemini、Google Vertex AI |

### 独立工具函数

```ts
import {
  // Token 估算
  estimateTokens,              // 粗略估算（字节数 / 4）
  estimateTokensForFileType,   // 文件类型感知（JSON = 字节数 / 2）

  // 预算
  createBudgetTracker,         // 创建追踪器
  checkBudget,                 // 检查预算 -> 继续或停止
  parseTokenBudget,            // 解析 "+500k" -> 500_000

  // 底层工具（用于自定义编译器）
  splitAtBoundary,             // 在哨兵处分割文本 -> CacheBlock[]
  section,                     // 创建静态 Section
  dynamicSection,              // 创建动态 Section
  defineTool,                  // 创建 ToolDef（fail-closed 默认值）
  SectionCache,                // 段缓存类
  ToolCache,                   // 工具缓存类
  resolveSections,             // 解析段（使用缓存）
  compileTool,                 // 编译单个工具
  compileTools,                // 编译所有工具
} from 'promptloom'
```

## 背景：Claude Code 的提示词架构

本库提取自 Claude Code 的源码（2026 年 3 月通过未剥离的 source map 泄露）。核心洞察：**Anthropic 把提示词当编译器输出来优化，而不是手写文本。**

他们的系统提示词由 7+ 层组装：

1. **身份** — AI 是谁
2. **系统** — 工具执行上下文、hooks、压缩机制
3. **任务执行** — 代码风格、安全、协作规则
4. **行为准则** — 风险感知执行、可逆性考量
5. **工具使用** — 工具偏好指引、并行执行
6. **语气风格** — 简洁性、格式化规则
7. **动态上下文** — Git 状态、CLAUDE.md 文件、用户记忆、MCP 服务器指令

第 1-6 层是**静态的**（全局可缓存）。第 7 层及以后是**动态的**（会话级）。它们之间的边界是一个字面量哨兵字符串，API 层据此标注缓存范围。

## 贡献

欢迎贡献！请随时开 issue 或提交 pull request。

```bash
git clone https://github.com/PeanutSplash/promptloom.git
cd promptloom
bun install
bun test          # 运行测试
bun run dev       # 运行 CLI 演示
bunx tsc --noEmit # 类型检查
```

## 许可

[MIT](./LICENSE)

---

<div align="center">

**[GitHub](https://github.com/PeanutSplash/promptloom)** | **[npm](https://www.npmjs.com/package/promptloom)** | **[LLM 文档](https://raw.githubusercontent.com/PeanutSplash/promptloom/main/llms.txt)**

</div>
