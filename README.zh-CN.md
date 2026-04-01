# promptloom

为 LLM 应用编织生产级提示词 —— 缓存边界、工具注入、Token 预算，一步到位。

从 [Claude Code](https://claude.ai/code) 的 7 层提示词架构逆向工程而来 —— 这正是 Anthropic 内部用来组装其 51 万行 CLI 工具系统提示词的模式。

## 为什么需要它

每个 LLM 应用都在拼接提示词。大多数用字符串拼接。Claude Code 用的是**编译器** —— 静态/动态分区、缓存边界标记、逐工具提示词注入、Token 预算追踪。

**promptloom** 把这些经过生产验证的模式提炼成零依赖库。

| 痛点 | promptloom 的解法 |
|------|-------------------|
| 改一段提示词就破坏整个缓存 → 白花钱 | **缓存边界**把静态（可缓存）和动态内容分开 |
| 工具描述散落各处，难以管理 | **工具注册表**，每个工具带自己的 prompt，会话级缓存 |
| 不知道提示词花了多少 Token | 每次 `compile()` 自动输出 **Token 估算** |
| 动态上下文被无谓地重复计算 | **两级缓存**：静态段算一次，动态段每轮重算 |

## 安装

```bash
bun add promptloom
```

## 快速上手

```ts
import { PromptCompiler } from 'promptloom'

const pc = new PromptCompiler({ enableGlobalCache: true })

// ── 静态段（计算一次，会话期间缓存）──
pc.static('identity', '你是一个代码审查机器人。')
pc.static('rules', '只评论 Bug，不评论代码风格。')

// ── 缓存边界 ──
// 上面的内容全局可缓存（在 Anthropic API 上省钱）
// 下面的内容是会话级的
pc.boundary()

// ── 动态段（每次 compile() 重新计算）──
pc.dynamic('context', async () => {
  const diff = await getCurrentDiff()
  return `审查这段 diff:\n${diff}`
})

// ── 工具（带内嵌提示词）──
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
})

// ── 编译 ──
const result = await pc.compile()

result.blocks   // CacheBlock[] — 带缓存范围标注
result.tools    // CompiledTool[] — 解析后的工具 schema
result.tokens   // { systemPrompt: 150, tools: 200, total: 350 }
result.text     // 完整提示词文本
```

## 配合 Anthropic API 使用

```ts
import Anthropic from '@anthropic-ai/sdk'
import { PromptCompiler, toAnthropicBlocks } from 'promptloom'

const pc = new PromptCompiler({ enableGlobalCache: true })
// ... 添加 sections 和 tools ...

const result = await pc.compile()
const client = new Anthropic()

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system: toAnthropicBlocks(result.blocks), // 带缓存标注的 blocks
  tools: result.tools,                       // 编译好的工具 schema
  messages: [{ role: 'user', content: '审查这个 PR' }],
})
```

## 核心概念

### Section：静态 vs 动态

灵感来自 Claude Code 的 `systemPromptSection()` 和 `DANGEROUS_uncachedSystemPromptSection()`：

```ts
// 静态：计算一次，整个会话期间缓存
pc.static('rules', () => loadRulesFromFile())

// 动态：每次 compile() 都重新计算
// 慎用 —— 会破坏提示词缓存命中率
pc.dynamic('mcp_servers', async () => {
  const servers = await discoverMCPServers()
  return formatServerInstructions(servers)
})
```

静态段解析一次后缓存在内存中（对应 Claude Code 的 `systemPromptSectionCache`）。动态段总是重算 —— Claude Code 管它们叫 "DANGEROUS"，因为它们会破坏缓存命中率。

### 缓存边界

边界标记把提示词分成两个区域：

```
┌─────────────────────────────┐
│  静态段 1                    │
│  静态段 2                    │  ← cacheScope: 'global'
│  静态段 3                    │    （跨组织可缓存）
├─────────────────────────────┤  ← pc.boundary()
│  动态段 1                    │
│  动态段 2                    │  ← cacheScope: null
│                             │    （会话级）
└─────────────────────────────┘
```

直接映射到 Anthropic API system prompt 文本块的 `cache_control` 字段。边界之前的内容可以在你应用的所有用户间缓存。边界之后的对每个会话独立。

### 工具提示词注入

Claude Code 里每个工具都有自己的 `prompt.ts` —— 一份写给 LLM 看的"使用手册"。promptloom 复制了这个模式：

```ts
pc.tool({
  name: 'Bash',
  // 这段 prompt 就是发给 API 的工具 description
  // 每个会话解析一次后缓存（避免会话中途漂移）
  prompt: async () => {
    const sandbox = await detectSandbox()
    return `执行 Shell 命令。\n${sandbox ? '在沙箱中运行。' : ''}`
  },
  inputSchema: { /* ... */ },
})
```

工具 prompt 支持静态字符串和异步函数。解析后的描述用稳定的缓存键（包含 inputSchema 的哈希）缓存，避免不必要的重算。

### Token 预算追踪

用于长时间运行的 Agent 循环，监控 Token 消耗：

```ts
import { createBudgetTracker, checkBudget } from 'promptloom'

const tracker = createBudgetTracker()

// 在你的 Agent 循环中：
const decision = checkBudget(tracker, currentTokens, { budget: 100_000 })

if (decision.action === 'continue') {
  // 注入 decision.nudgeMessage 让模型继续工作
} else {
  // decision.reason: 'budget_reached' | 'diminishing_returns'
}
```

预算追踪器能检测**收益递减** —— 如果模型连续 3 次以上只产出极少量输出，会自动停止，而不是白白浪费 Token。

## API 参考

### `PromptCompiler`

| 方法 | 描述 |
|------|------|
| `static(name, content)` | 添加静态段（字符串或同步/异步函数）|
| `dynamic(name, compute)` | 添加动态段（每次 `compile()` 重算）|
| `boundary()` | 插入缓存边界标记 |
| `tool(def)` | 注册带内嵌 prompt 的工具 |
| `compile()` | 编译一切 → `CompileResult` |
| `clearCache()` | 清除所有段 + 工具缓存 |
| `clearSectionCache()` | 只清除段缓存 |
| `clearToolCache()` | 只清除工具缓存 |
| `sectionCount` | 已注册的段数量 |
| `toolCount` | 已注册的工具数量 |
| `listSections()` | 列出所有段及其类型 |
| `listTools()` | 列出已注册的工具名 |

### `CompileResult`

| 字段 | 类型 | 描述 |
|------|------|------|
| `blocks` | `CacheBlock[]` | 带 `cacheScope` 标注的提示词块 |
| `tools` | `CompiledTool[]` | API-ready 的工具 schema（描述已解析）|
| `tokens` | `TokenEstimate` | `{ systemPrompt, tools, total }` |
| `text` | `string` | 完整提示词（所有块拼接后的文本）|

### 独立工具函数

```ts
import {
  // 缓存边界
  splitAtBoundary,     // 在边界处分割文本 → CacheBlock[]
  toAnthropicBlocks,   // CacheBlock[] → Anthropic API 格式

  // Token 估算
  estimateTokens,           // 粗略估算（字节数 / 4）
  estimateTokensForFileType, // 文件类型感知（JSON = 字节数 / 2）

  // 预算追踪
  createBudgetTracker,  // 创建追踪器
  checkBudget,          // 检查预算 → 继续或停止

  // 底层工具
  section,              // 创建静态 Section
  dynamicSection,       // 创建动态 Section
  defineTool,           // 创建 ToolDef（fail-closed 默认值）
  SectionCache,         // 段缓存类
  ToolCache,            // 工具缓存类
  resolveSections,      // 解析段（使用缓存）
  compileTool,          // 编译单个工具
  compileTools,         // 编译所有工具
} from 'promptloom'
```

## CLI

```bash
# 运行内置 demo（可视化 7 层组装过程）
bun run bin/cli.ts demo
```

输出：

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

42 个工具中每一个都带有自己的 `prompt.ts` —— 一份面向 LLM 的使用说明，注入到工具的 description 字段中，并在会话级缓存。

promptloom 把这些原语交给你。

## 许可

MIT
