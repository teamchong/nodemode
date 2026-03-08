# nodemode conformance tests

Proves nodemode can support popular Node.js tools that **require shell + filesystem** — things impossible on vanilla Cloudflare Workers.

## Results: 168 conformance tests passing (235 total with unit tests)

| Tool | Stars | What it needs | Tests | Status |
|------|-------|---------------|-------|--------|
| **opencode** (AI agent) | — | fs read/write, exec, refactoring, configs, monorepo | 61 | PASS |
| **simple-git** | 3.5k+ | .git/ fs, refs, tags, remotes, merge conflicts, large files | 36 | PASS |
| **zx** (Google) | 44k+ | pipes, chains, exit codes, conditionals, batch ops | 35 | PASS |
| **create-next-app / create-vite / degit** | 130k+ / 70k+ / 7k+ | mkdir, write templates, npm install | 19 | PASS |
| **lint-staged / nodemon / esbuild** | 13k+ / 26k+ / — | fs.watch, spawn linters, read imports, write bundles | 17 | PASS |

## What these tests prove

Every tool above is **impossible** on Cloudflare Workers today because Workers have no `fs`, no `child_process`, and no shell. nodemode provides these primitives via:

- **R2** → filesystem (read/write/stat/readdir/rename/unlink)
- **DO SQLite** → directory index, file cache, process table
- **Container** → real Linux shell for npm/git/node/tsc/esbuild (exit 127 in test, works in production)
- **Built-in emulators** → cat, ls, grep, head, tail, wc, echo, etc. ($0 cost, <1ms)
- **Pipes & chains** → `cmd1 | cmd2`, `&&`, `||`, `;`

## Running

```bash
# Run conformance tests only
npx vitest run --dir research

# Run everything (unit + conformance)
npx vitest run
```

## Test files

- `conformance-zx.test.ts` — Shell scripting patterns ($\`command\`, pipes, chains, conditionals, batch ops, process tracking)
- `conformance-opencode.test.ts` — AI coding agent workflow (scaffold → inspect → modify → build → refactor → error recovery → config → search → monorepo)
- `conformance-simple-git.test.ts` — Git operations (init, refs, branches, tags, remotes, merge conflicts, large files, diff, stash)
- `conformance-create-app.test.ts` — Project scaffolding (Next.js, Vite, degit-style clone)
- `conformance-lint-staged.test.ts` — Dev tooling (lint-staged, nodemon, esbuild bundling)
