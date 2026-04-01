# promptloom

为 LLM 应用编织生产级提示词 —— 多区域缓存、条件段、工具注入、延迟加载、Token 预算，一步到位。

从 [Claude Code](https://claude.ai/code) 的 7 层提示词架构逆向工程而来 —— 这正是 Anthropic 内部用来组装其 51 万行 CLI 工具系统提示词的模式。

## 为什么需要它

每个 LLM 应用都在拼接提示词。大多数用字符串拼接。Claude Code 用的是**编译器** —— 多区域缓存范围、条件段、逐工具提示词注入、延迟工具加载、Token 预算追踪。

**promptloom** 把这些经过生产验证的模式提炼成零依赖库。

| 痛点 | promptloom 的解法 |
|------|-------------------|
| 改一段提示词就破坏整个缓存 → 白花钱 | **多区域缓存** —— 每个 zone 有独立的缓存范围（`global`、`org`、`null`）|
| 工具描述散落各处，难以管理 | **工具注册表**，会话级缓存 + 稳定排序 |
| 工具太多撑爆系统提示词 | **延迟工具** —— 标记为 deferred 的工具不进提示词，按需加载 |
| 某些段只和特定模型/环境相关 | **条件段** —— `when` 谓词按编译上下文决定是否包含 |
| 不知道提示词花了多少 Token | 每次 `compile()` 自动输出 **Token 估算** |
| 不同 API 提供商格式不同 | **多 Provider 输出** —— `toAnthropic()`、`toOpenAI()`、`toBedrock()` |

## 安装

```bash
bun add promptloom
```

## 快速上手

```ts
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()

// ── Zone 1: 归属头（不缓存）──
pc.zone(null)
pc.static('attribution', 'x-billing-org: org-123')

// ── Zone 2: 静态规则（全局可缓存）──
pc.zone('global')
pc.static('identity', '你是一个代码审查机器人。')
pc.static('rules', '只评论 Bug，不评论代码风格。')

// ── Zone 3: 动态上下文（会话级，不缓存）──
pc.zone(null)
pc.dynamic('diff', async () => {
  const diff = await getCurrentDiff()
  return `审查这段 diff:\n${diff}`
})

// 条件段 —— 仅在 Opus 模型时包含
pc.static('thinking', '对复杂审查使用扩展思考。', {
  when: (ctx) => ctx.model?.includes('opus') ?? false,
})

// ── 工具（内联 + 延迟）──
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
  order: 1, // 显式排序，保证缓存稳定性
})

pc.tool({
  name: 'web_search',
  prompt: '搜索网页获取上下文。',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  deferred: true, // 不进系统提示词，按需加载
})

// ── 编译（传入上下文用于条件段求值）──
const result = await pc.compile({ model: 'claude-opus-4-6' })

result.blocks        // CacheBlock[] — 每个 zone 一个块，带缓存范围标注
result.tools         // CompiledTool[] — 仅内联工具
result.deferredTools // CompiledTool[] — 延迟工具（带 defer_loading: true）
result.tokens        // { systemPrompt, tools, deferredTools, total }
result.text          // 完整提示词文本
```

## 配合各 API 使用

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PromptCompiler, toAnthropic } from 'promptloom'

const pc = new PromptCompiler()
// ... 添加 zone、section、tool ...

const result = await pc.compile({ model: 'claude-sonnet-4-6' })
const { system, tools } = toAnthropic(result) // 带缓存标注的 blocks + 工具 schema

const response = await new Anthropic().messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system,   // TextBlockParam[]，带 cache_control
  tools,    // 包含延迟工具（带 defer_loading: true）
  messages: [{ role: 'user', content: '审查这个 PR' }],
})
```

### OpenAI

```ts
import OpenAI from 'openai'
import { PromptCompiler, toOpenAI } from 'promptloom'

const pc = new PromptCompiler()
// ... 添加 zone、section、tool ...

const result = await pc.compile()
const { system, tools } = toOpenAI(result) // 单字符串 + function 格式工具

const response = await new OpenAI().chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: '审查这个 PR' },
  ],
  tools,
})
```

### AWS Bedrock

```ts
import { PromptCompiler, toBedrock } from 'promptloom'

const result = await pc.compile()
const { system, toolConfig } = toBedrock(result) // cachePoint + toolSpec 格式

// 用于 @aws-sdk/client-bedrock-runtime ConverseCommand
```

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

`boundary()` 方法保留了向后兼容 —— 在 `enableGlobalCache` 为 true 时等同于 `zone(null)`。

### 条件段

Claude Code 里通过 `feature('FLAG')`、`process.env.USER_TYPE`、模型能力来门控段。promptloom 用 `when` 谓词：

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

// 谓词在编译时求值
const result = await pc.compile({
  model: 'claude-opus-4-6',
  mcpServers: ['figma', 'slack'],
  userType: 'internal',
})
```

### 工具提示词注入

每个工具带有面向 LLM 的"使用手册"，每个会话解析一次后缓存：

```ts
pc.tool({
  name: 'Bash',
  prompt: async () => {
    const sandbox = await detectSandbox()
    return `执行 Shell 命令。\n${sandbox ? '在沙箱中运行。' : ''}`
  },
  inputSchema: { /* ... */ },
  order: 1,          // 显式排序，保证缓存稳定性
})
```

### 延迟工具

当工具很多时（Claude Code 有 42+），大部分每轮并不需要。延迟工具被排除在系统提示词之外，按需发现：

```ts
pc.tool({
  name: 'web_search',
  prompt: '搜索网页获取信息。',
  inputSchema: { /* ... */ },
  deferred: true,  // 不进系统提示词，通过 tool search 按需加载
})

const result = await pc.compile()
result.tools         // 仅内联工具
result.deferredTools // 延迟工具（带 defer_loading: true）
result.tokens.total  // 不计算延迟工具的 token
```

### 工具排序稳定性

重排工具会改变序列化字节，破坏提示词缓存。用 `order` 保证确定性排序：

```ts
pc.tool({ name: 'bash', prompt: '...', inputSchema: {}, order: 1 })
pc.tool({ name: 'read', prompt: '...', inputSchema: {}, order: 2 })
pc.tool({ name: 'edit', prompt: '...', inputSchema: {}, order: 3 })
// 没有 `order` 的工具排在最后，按插入顺序
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

#### 预算追踪

用于长时间运行的 Agent 循环：

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

#### 从自然语言解析预算

像 Claude Code 一样解析用户指定的预算：

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
| `compile(context?)` | 编译一切 → `CompileResult`。上下文传给 `when` 谓词 |
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

```ts
import { toAnthropic, toOpenAI, toBedrock } from 'promptloom'

toAnthropic(result)  // { system: TextBlockParam[], tools: AnthropicTool[] }
toOpenAI(result)     // { system: string, tools: { type: 'function', function }[] }
toBedrock(result)    // { system: BedrockSystemBlock[], toolConfig: { tools } }
```

### 独立工具函数

```ts
import {
  // Token 估算
  estimateTokens,           // 粗略估算（字节数 / 4）
  estimateTokensForFileType, // 文件类型感知（JSON = 字节数 / 2）

  // 预算
  createBudgetTracker,       // 创建追踪器
  checkBudget,               // 检查预算 → 继续或停止
  parseTokenBudget,          // 解析 "+500k" → 500_000

  // 底层工具（用于自定义编译器）
  splitAtBoundary,           // 在哨兵处分割文本 → CacheBlock[]
  section,                   // 创建静态 Section
  dynamicSection,            // 创建动态 Section
  defineTool,                // 创建 ToolDef（fail-closed 默认值）
  SectionCache,              // 段缓存类
  ToolCache,                 // 工具缓存类
  resolveSections,           // 解析段（使用缓存）
  compileTool,               // 编译单个工具
  compileTools,              // 编译所有工具
} from 'promptloom'
```

## 背景：Claude Code 的提示词架构

本库提取自 Claude Code 的源码（2025 年 3 月通过未剥离的 source map 泄露）。核心洞察：**Anthropic 把提示词当编译器输出来优化，而不是手写文本。**

他们的系统提示词由 7+ 层组装：

1. **身份** — AI 是谁
2. **系统** — 工具执行上下文、hooks、压缩机制
3. **任务执行** — 代码风格、安全、协作规则
4. **行为准则** — 风险感知执行、可逆性考量
5. **工具使用** — 工具偏好指引、并行执行
6. **语气风格** — 简洁性、格式化规则
7. **动态上下文** — Git 状态、CLAUDE.md 文件、用户记忆、MCP 服务器指令

第 1-6 层是**静态的**（全局可缓存）。第 7 层及以后是**动态的**（会话级）。它们之间的边界是一个字面量哨兵字符串，API 层据此标注缓存范围。

段通过特性标志（`feature('TOKEN_BUDGET')`）、用户类型（`process.env.USER_TYPE === 'ant'`）和模型能力条件包含。42+ 个工具中每一个都带有自己的 `prompt.ts`，超过上下文阈值的工具会被延迟（通过 `ToolSearchTool` 按需加载）。

promptloom 把这些原语全部交给你。

## 许可

MIT
