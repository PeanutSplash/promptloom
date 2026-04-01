# promptc — Prompt Compiler

Production-grade prompt assembly with cache boundaries, tool injection, and token budgeting. Inspired by Claude Code's 7-layer prompt architecture.

## Commands

```bash
bun test          # Run tests
bun run dev       # Run CLI demo
bunx tsc --noEmit # Type check
```

## Architecture

- `src/compiler.ts` — Main `PromptCompiler` class (builder pattern API)
- `src/section.ts` — Section types: static (cached) vs dynamic (recomputed)
- `src/boundary.ts` — Cache boundary splitting for Anthropic API prompt caching
- `src/tool.ts` — Tool prompt management with session-level caching
- `src/tokens.ts` — Token estimation and budget tracking
- `src/types.ts` — Core type definitions
- `bin/cli.ts` — CLI demo and visualization

## Key Patterns (from Claude Code)

- **Static sections**: computed once, cached for session (`systemPromptSection()`)
- **Dynamic sections**: recomputed every turn (`DANGEROUS_uncachedSystemPromptSection()`)
- **Cache boundary**: splits globally-cacheable from session-specific content
- **Tool prompt caching**: each tool's LLM description resolved once per session
- **Token budget**: tracks usage with diminishing returns detection
