#!/usr/bin/env bun
/**
 * promptloom CLI — Visualize prompt compilation
 *
 * Usage:
 *   promptloom demo              Run the built-in demo
 *   promptloom inspect <file>    Inspect a promptloom config file
 *   promptloom tokens <file>     Show token estimates
 */

import { PromptCompiler, toAnthropicBlocks } from '../src/index.ts'

// ─── Colors (ANSI) ──────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

// ─── Demo ────────────────────────────────────────────────────────

async function runDemo() {
  console.log(bold('\n  promptloom — Prompt Compiler Demo\n'))
  console.log(dim('  Simulating Claude Code\'s 7-layer prompt assembly pattern\n'))

  const pc = new PromptCompiler({ enableGlobalCache: true })

  // Layer 1-6: Static sections (before cache boundary)
  pc.static('identity', [
    '# Identity',
    'You are Claude Code, an AI coding assistant.',
    'You help users with software engineering tasks.',
  ].join('\n'))

  pc.static('system', [
    '# System',
    '- All text you output is displayed to the user.',
    '- Tools are executed in a user-selected permission mode.',
    '- Tool results may include data from external sources.',
  ].join('\n'))

  pc.static('doing_tasks', [
    '# Doing Tasks',
    '- Read existing code before suggesting modifications.',
    '- Do not create files unless absolutely necessary.',
    '- Be careful not to introduce security vulnerabilities.',
  ].join('\n'))

  pc.static('actions', [
    '# Executing Actions',
    '- Consider reversibility and blast radius of actions.',
    '- For destructive operations, ask for confirmation.',
    '- Never skip hooks (--no-verify) unless explicitly asked.',
  ].join('\n'))

  pc.static('tool_usage', [
    '# Using Your Tools',
    '- Use Read instead of cat/head/tail.',
    '- Use Edit instead of sed/awk.',
    '- Use Grep instead of grep/rg.',
  ].join('\n'))

  pc.static('style', [
    '# Tone & Style',
    '- Keep responses short and concise.',
    '- Only use emojis if explicitly requested.',
  ].join('\n'))

  // Cache boundary
  pc.boundary()

  // Layer 7+: Dynamic sections (after cache boundary)
  pc.dynamic('env', async () => [
    '# Environment',
    `- Working directory: ${process.cwd()}`,
    `- Platform: ${process.platform}`,
    `- Date: ${new Date().toISOString().split('T')[0]}`,
  ].join('\n'))

  pc.dynamic('git', async () => {
    try {
      const proc = Bun.spawn(['git', 'branch', '--show-current'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const branch = (await new Response(proc.stdout).text()).trim()
      return branch ? `# Git\nCurrent branch: ${branch}` : null
    } catch {
      return null
    }
  })

  pc.dynamic('memory', async () => [
    '# User Preferences',
    '- Preferred language: TypeScript',
    '- Style: functional, minimal comments',
  ].join('\n'))

  // Tools with embedded prompts
  pc.tool({
    name: 'Bash',
    prompt: [
      'Execute shell commands in the user\'s environment.',
      '',
      'Git Safety Protocol:',
      '- NEVER run destructive git commands unless explicitly requested',
      '- NEVER skip hooks (--no-verify)',
      '- Always create NEW commits rather than amending',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
  })

  pc.tool({
    name: 'Read',
    prompt: [
      'Read a file from the local filesystem.',
      '',
      'Usage:',
      '- The file_path parameter must be an absolute path',
      '- By default, reads up to 2000 lines',
      '- Can read images, PDFs, and Jupyter notebooks',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Start line number' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  })

  pc.tool({
    name: 'Edit',
    prompt: [
      'Perform exact string replacements in files.',
      '',
      'Rules:',
      '- You MUST read the file before editing (enforced)',
      '- The edit will FAIL if old_string is not unique',
      '- Preserve exact indentation',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  })

  // ─── Compile ─────────────────────────────────────────────────

  console.log(dim('  Compiling...\n'))
  const result = await pc.compile()

  // ─── Display Sections ────────────────────────────────────────

  console.log(bold('  Sections'))
  console.log(dim('  ─────────────────────────────────────────────'))
  for (const s of pc.listSections()) {
    const icon =
      s.type === 'static' ? green('STATIC ') :
      s.type === 'dynamic' ? yellow('DYNAMIC') :
      magenta('───────')
    const label = s.type === 'boundary' ? dim('cache boundary') : s.name
    console.log(`  ${icon}  ${label}`)
  }

  // ─── Display Blocks ──────────────────────────────────────────

  console.log(bold('\n  Cache Blocks'))
  console.log(dim('  ─────────────────────────────────────────────'))
  for (const [i, block] of result.blocks.entries()) {
    const scope =
      block.cacheScope === 'global' ? green('global') :
      block.cacheScope === 'org' ? cyan('org') :
      dim('none')
    const lines = block.text.split('\n').length
    const tokens = Math.round(block.text.length / 4)
    console.log(`  Block ${i + 1}  scope=${scope}  ${dim(`~${tokens} tokens, ${lines} lines`)}`)

    // Show first 3 lines as preview
    const preview = block.text.split('\n').slice(0, 3)
    for (const line of preview) {
      console.log(`    ${dim(line.slice(0, 72))}`)
    }
    if (block.text.split('\n').length > 3) {
      console.log(`    ${dim('...')}`)
    }
  }

  // ─── Display Tools ───────────────────────────────────────────

  console.log(bold('\n  Tools'))
  console.log(dim('  ─────────────────────────────────────────────'))
  for (const tool of result.tools) {
    const promptTokens = Math.round(tool.description.length / 4)
    const schemaTokens = Math.round(JSON.stringify(tool.input_schema).length / 2)
    console.log(`  ${blue(tool.name.padEnd(12))} prompt=${dim(`~${promptTokens}t`)}  schema=${dim(`~${schemaTokens}t`)}`)
  }

  // ─── Display Tokens ──────────────────────────────────────────

  console.log(bold('\n  Token Estimates'))
  console.log(dim('  ─────────────────────────────────────────────'))
  console.log(`  System prompt:  ${cyan(result.tokens.systemPrompt.toLocaleString())} tokens`)
  console.log(`  Tool schemas:   ${cyan(result.tokens.tools.toLocaleString())} tokens`)
  console.log(`  ${bold('Total:')}          ${bold(cyan(result.tokens.total.toLocaleString()))} tokens`)

  // ─── Display Anthropic API Format ────────────────────────────

  console.log(bold('\n  Anthropic API Blocks'))
  console.log(dim('  ─────────────────────────────────────────────'))
  const apiBlocks = toAnthropicBlocks(result.blocks)
  for (const [i, block] of apiBlocks.entries()) {
    const cached = block.cache_control ? green('cached') : dim('no-cache')
    console.log(`  [${i}] ${cached}  ${dim(`${block.text.length} chars`)}`)
  }

  console.log(dim('\n  Done.\n'))
}

// ─── Main ────────────────────────────────────────────────────────

const command = process.argv[2] ?? 'demo'

switch (command) {
  case 'demo':
    await runDemo()
    break
  case '--help':
  case '-h':
    console.log(`
${bold('promptloom')} — Prompt Compiler

${dim('Usage:')}
  promptloom demo      Run the built-in demo
  promptloom --help    Show this help

${dim('Library usage:')}
  import { PromptCompiler } from 'promptloom'
`)
    break
  default:
    console.log(red(`Unknown command: ${command}`))
    console.log(dim('Run `promptloom --help` for usage.'))
    process.exit(1)
}
