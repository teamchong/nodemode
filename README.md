# nodemode

> **Experimental** — research prototype exploring whether Node.js module shims can make existing npm packages work on Cloudflare Workers. Not production-ready.

An experiment in shimming `node:fs` and `node:child_process` for Cloudflare Workers, inspired by how [vinext](https://github.com/cloudflare/vinext) shims `next/*` imports.

The idea: if wrangler aliases `node:fs` to an R2+SQLite-backed implementation, libraries that `import fs from "node:fs"` might just work — without a Container, at $0 cost.

## How it works

```jsonc
// wrangler.jsonc — alias Node.js modules to nodemode shims
{
  "alias": {
    "fs": "nodemode/shims/fs",
    "child_process": "nodemode/shims/child_process"
  }
}
```

```ts
// worker/index.ts
import { Workspace, createHandler } from "nodemode";
export { Workspace };
export default { fetch: createHandler() };
```

Then libraries that use `node:fs` or `node:child_process` resolve to nodemode's shims:

```ts
import { readFile, writeFile } from "node:fs/promises";  // → R2 storage + SQLite cache
import { exec } from "node:child_process";                // → DO built-in emulators
```

## What the shims provide

### `node:fs` → R2 + DO SQLite

| fs method | Backing | Latency |
|-----------|---------|---------|
| `readFile` / `promises.readFile` | SQLite cache (<64KB) → R2 fallback | <1ms cached, 10-50ms R2 |
| `writeFile` / `promises.writeFile` | R2 put + SQLite index + cache | ~10ms |
| `stat` / `statSync` | SQLite lookup | <1ms |
| `readdir` / `readdirSync` | SQLite prefix query | <1ms |
| `mkdir` / `mkdirSync` | SQLite directory marker | <1ms |
| `existsSync` | SQLite lookup | <1ms |
| `unlink`, `rename`, `copyFile`, `rm`, `rmdir` | R2 + SQLite | ~10ms |
| `appendFile`, `chmod`, `access`, `lstat` | R2 + SQLite | varies |

### `node:child_process` → DO ProcessManager

| Method | What happens |
|--------|-------------|
| `exec(cmd, cb)` | Runs through ProcessManager — builtins in DO, rest to Container |
| `spawn(cmd, args)` | Returns ChildProcess-like with stdout/stderr event emitters |
| `execFile(file, args)` | Same as exec with args joined |

24 commands run entirely in the DO at $0:
`echo`, `cat`, `ls`, `grep`, `head`, `tail`, `wc`, `mkdir`, `rm`, `cp`, `mv`, `touch`, `test`, `which`, `pwd`, `env`, `whoami`, `date`, `basename`, `dirname`, `printf`, `sleep`, `true`, `false`

Shell features: pipes (`|`), chains (`&&`, `||`, `;`), quoted strings.

## Conformance tests

262 tests verify the approach against patterns from popular tools (all run on builtins, no Container):

| Tool | What it needs | Tests |
|------|--------------|-------|
| **opencode** (AI agent) | fs read/write, exec, refactoring, configs, monorepo | 61 |
| **simple-git** | .git/ fs, refs, tags, remotes, merge conflicts, large files | 36 |
| **zx** (Google) | pipes, chains, exit codes, conditionals, batch ops | 35 |
| **create-next-app / create-vite / degit** | mkdir, write templates, npm install | 19 |
| **lint-staged / nodemon / esbuild** | fs.watch, spawn linters, read imports, write bundles | 17 |
| **Unit + shim tests** | all fs ops, 24 builtins, shell parsing, shim API surface | 93 |

## Architecture

```
Library does: import { readFile } from "node:fs"
                         │
                         ▼  (wrangler alias)
              nodemode/shims/fs.ts
                         │
                         ▼
              FsEngine (R2 + DO SQLite)
              ├── SQLite cache hit (<1ms)
              └── R2 fallback (10-50ms)

Library does: import { exec } from "node:child_process"
                         │
                         ▼  (wrangler alias)
              nodemode/shims/child_process.ts
                         │
                         ▼
              ProcessManager
              ├── Built-in? → execute in DO ($0, <1ms)
              └── Not built-in? → route to Container (~$0.02/hr)
```

### Container (last resort)

Commands not in the 24 built-ins (npm, node, git, tsc, python, etc.) route to a Cloudflare Container:

- Boots on demand, sleeps after 10 min idle
- R2 FUSE mount for source files
- Snapshots `node_modules`/`dist` to R2 on shutdown, restores on boot
- Health-checked every 30s by DO alarm

## Client SDK

For interacting with nodemode over HTTP from any JavaScript environment:

```ts
import { NodeMode } from "nodemode/client";

const nm = new NodeMode("https://my-worker.workers.dev", "my-workspace");
await nm.writeFile("index.ts", "console.log('hello');");
const result = await nm.exec("cat index.ts | grep hello");
```

## Quick Start

```bash
mkdir my-workspace && cd my-workspace
npx nodemode init
npm install
npx wrangler dev   # local dev
npx wrangler deploy # production
```

## Running Tests

```bash
npx vitest run              # all tests (unit + conformance)
npx vitest run test/        # unit tests only
npx vitest run --dir research  # conformance tests only
```

## Known Gaps

| Area | Status | Notes |
|------|--------|-------|
| fs shim | ~80% | Async API works. `readFileSync`/`writeFileSync` throw (async-only in DO). Missing: `watch`, `createReadStream`, symlinks |
| child_process shim | ~60% | `exec`, `spawn`, `execFile` work. Missing: `fork`, stdin piping, real-time streaming |
| Shell parsing | ~50% | Pipes, chains, quoted strings. Missing: redirects (`>`, `<`), `$VAR` expansion, subshells |
| Auth / security | ~20% | Input validation, payload limits. Missing: authentication, rate limiting |

## License

MIT
