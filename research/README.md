# nodemode conformance tests

Proves nodemode can support popular Node.js tools that **require shell + filesystem** — things impossible on vanilla Cloudflare Workers.

## Results: 104 conformance tests passing

| Tool | Stars | What it needs | Tests | Status |
|------|-------|---------------|-------|--------|
| **zx** (Google) | 44k+ | `child_process.spawn`, pipes, exit codes, fs | 21 | PASS |
| **opencode** (AI agent) | — | fs read/write, exec (git/npm/tsc), project scaffold | 27 | PASS |
| **simple-git** | 3.5k+ | `spawn("git", ...)`, .git/ fs operations, refs | 20 | PASS |
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

- `conformance-zx.test.ts` — Shell scripting patterns ($\`command\`, pipes, chains, env vars)
- `conformance-opencode.test.ts` — AI coding agent workflow (scaffold → inspect → modify → build)
- `conformance-simple-git.test.ts` — Git operations (init, refs, branches, diff, stash)
- `conformance-create-app.test.ts` — Project scaffolding (Next.js, Vite, degit-style clone)
- `conformance-lint-staged.test.ts` — Dev tooling (lint-staged, nodemon, esbuild bundling)
