# nodemode

> Node.js runtime on Cloudflare Workers — R2 filesystem, DO process execution, in-DO JavaScript engine. No containers required for AI agent workflows.

An experiment in running Node.js workloads entirely on Cloudflare's edge, without containers. Libraries that `import fs from "node:fs"` or `import { exec } from "node:child_process"` resolve to nodemode's shims backed by R2 + SQLite + V8.

Built for AI coding agents (opencode, Codex, Claude Code) that need file I/O, code search, and script execution — all at $0, all on the edge.

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

## Three-tier execution

```
Tier 1: Shell builtins     → execute in DO ($0, <1ms)
Tier 2: JS/TS execution    → JsRunner in DO ($0, ~ms)
Tier 3: Native binaries    → Container (last resort, ~$0.02/hr)
```

### Tier 1: 24 shell builtins

`echo`, `cat`, `ls`, `grep`, `head`, `tail`, `wc`, `mkdir`, `rm`, `cp`, `mv`, `touch`, `test`, `which`, `pwd`, `env`, `whoami`, `date`, `basename`, `dirname`, `printf`, `sleep`, `true`, `false`

Shell features: pipes (`|`), chains (`&&`, `||`, `;`), quoted strings, `$VAR` expansion.

grep supports `-r` (recursive), `-n` (line numbers), `-l` (filenames only), `-i` (case insensitive), `-v` (invert), `-c` (count) — recursive grep uses SQLite index for file discovery + parallel R2 reads.

### Tier 2: JsRunner (in-DO JavaScript engine)

Commands like `node script.js`, `./script.js`, `npx tool` execute JavaScript/TypeScript directly in the DO's V8 isolate — no container needed.

- **Module system**: `require()`, `import/export`, circular deps, JSON imports
- **Type stripping**: TypeScript runs directly (annotations stripped, no tsc needed)
- **Node.js builtins**: `fs`, `path`, `crypto`, `http`, `net`, `stream`, `worker_threads`
- **Real `http.request()`**: backed by `fetch()` — ClientRequest collects body, calls fetch, wraps Response
- **Real `worker_threads`**: `Worker` creates isolated JsRunner with own module cache, bidirectional `postMessage`
- **`child_process.exec()`**: scripts can shell out via ProcessManager

### Tier 3: Container (last resort)

Commands not handled by Tier 1/2 (gcc, python, cargo, etc.) route to a Cloudflare Container:

- Boots on demand, sleeps after 10 min idle
- R2 FUSE mount for source files
- Snapshots `node_modules`/`dist` to R2 on shutdown, restores on boot
- Health-checked every 30s by DO alarm

## Three-tier file cache

```
Hot:   zerobuf WASM Memory  (sub-μs, zero-copy Uint8Array views)
Warm:  SQLite file_cache    (sub-ms, persists across DO evictions)
Cold:  R2                   (~10-50ms, durable)
```

Reads check hot → warm → cold, promoting upward on miss. The hot tier uses [zerobuf](https://www.npmjs.com/package/zerobuf) to store file content in WebAssembly linear memory — reads return `Uint8Array` views directly into WASM memory with no copies.

### `node:fs` → R2 + SQLite + WASM Memory

| fs method | Backing | Latency |
|-----------|---------|---------|
| `readFile` / `promises.readFile` | WASM cache → SQLite cache → R2 | sub-μs cached, 10-50ms R2 |
| `writeFile` / `promises.writeFile` | R2 put + SQLite index + caches | ~10ms |
| `stat` / `statSync` | SQLite lookup | <1ms |
| `readdir` / `readdirSync` | SQLite prefix query | <1ms |
| `mkdir` / `mkdirSync` | SQLite directory marker | <1ms |
| `existsSync` | SQLite lookup | <1ms |
| `unlink`, `rename`, `copyFile`, `rm`, `rmdir` | R2 + SQLite | ~10ms |
| `appendFile`, `chmod`, `access`, `lstat` | R2 + SQLite | varies |

### `node:child_process` → DO ProcessManager

| Method | What happens |
|--------|-------------|
| `exec(cmd, cb)` | Runs through ProcessManager — builtins in DO, JS via JsRunner, rest to Container |
| `spawn(cmd, args)` | Returns ChildProcess-like with stdout/stderr event emitters |
| `execFile(file, args)` | Same as exec with args joined |

## Architecture

```
Library does: import { readFile } from "node:fs"
                         │
                         ▼  (wrangler alias)
              nodemode/shims/fs.ts
                         │
                         ▼
              FsEngine (three-tier cache)
              ├── zerobuf WASM Memory (sub-μs, zero-copy)
              ├── SQLite cache hit (<1ms)
              └── R2 fallback (10-50ms)

Library does: import { exec } from "node:child_process"
                         │
                         ▼  (wrangler alias)
              nodemode/shims/child_process.ts
                         │
                         ▼
              ProcessManager (three-tier execution)
              ├── Built-in? → execute in DO ($0, <1ms)
              ├── JS/TS?    → JsRunner in DO ($0, ~ms)
              └── Native?   → route to Container (~$0.02/hr)
```

## Client SDK

For interacting with nodemode over HTTP from any JavaScript environment:

```ts
import { NodeMode } from "nodemode/client";

const nm = new NodeMode("https://my-worker.workers.dev", "my-workspace");
await nm.writeFile("index.ts", "console.log('hello');");
const result = await nm.exec("cat index.ts | grep hello");
```

## Conformance tests

387 tests verify the approach against patterns from popular tools:

| Tool | What it needs | Tests |
|------|--------------|-------|
| **opencode** (AI agent) | fs read/write, grep -r, exec, refactoring, worker_threads, http, configs | 113 |
| **Unit + shim tests** | all fs ops, 24 builtins, shell parsing, shim API, JsRunner, caches | 140 |
| **simple-git** | .git/ fs, refs, tags, remotes, merge conflicts, large files | 36 |
| **zx** (Google) | pipes, chains, exit codes, conditionals, batch ops | 35 |
| **create-next-app / create-vite / degit** | mkdir, write templates, npm install | 19 |
| **lint-staged / nodemon / esbuild** | fs.watch, spawn linters, read imports, write bundles | 17 |

All run on builtins + JsRunner, no Container.

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
| fs shim | ~85% | Async API works. Missing: `watch`, `createReadStream`, symlinks |
| child_process shim | ~70% | `exec`, `spawn`, `execFile` work. JsRunner handles JS/TS. Missing: real stdin piping, TTY |
| Shell parsing | ~50% | Pipes, chains, quoted strings. Missing: redirects (`>`, `<`), subshells |
| git | not started | Plan: isomorphic-git (pure JS, pluggable fs/http backends) |
| npm install | not started | Plan: fetch registry API + extract tarballs in JS |
| Auth / security | ~30% | Input validation, payload limits, path traversal protection. Missing: authentication, rate limiting |

## License

MIT
