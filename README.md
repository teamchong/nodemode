# nodemode

Map Node.js primitives to Cloudflare Workers + R2 + Durable Objects + Containers.

Run tools that need `fs`, `child_process`, and shell — things impossible on vanilla Workers — on Cloudflare's edge.

## Conformance: 235 tests passing

Proves nodemode can support popular Node.js tools that require shell + filesystem:

| Tool | Stars | What it needs | Tests | Status |
|------|-------|---------------|-------|--------|
| **opencode** (AI agent) | — | fs read/write, exec, refactoring, configs, monorepo | 61 | PASS |
| **simple-git** | 3.5k+ | .git/ fs, refs, tags, remotes, merge conflicts, large files | 36 | PASS |
| **zx** (Google) | 44k+ | pipes, chains, exit codes, conditionals, batch ops | 35 | PASS |
| **create-next-app / create-vite / degit** | 130k+ / 70k+ / 7k+ | mkdir, write templates, npm install | 19 | PASS |
| **lint-staged / nodemon / esbuild** | 13k+ / 26k+ / — | fs.watch, spawn linters, read imports, write bundles | 17 | PASS |
| **Unit tests** | — | All fs ops, 24 builtins, shell parsing, validation, container | 67 | PASS |

## Mapping

| Node.js | Cloudflare |
|---------|------------|
| `fs` | R2 (file content) + DO SQLite (directory index & cache) |
| `child_process` | 24 built-in command emulators + Containers for heavy workloads |
| `stdio` | WebSocket with DO SQLite terminal buffer |
| `process` | DO instance state (env, cwd, argv) |

## Quick Start

```ts
// wrangler.toml
import { Workspace, createHandler } from "nodemode";

export { Workspace };
export default { fetch: createHandler() };
```

```ts
// Client SDK (browser, Node.js, Workers)
import { NodeMode } from "nodemode/client";

const nm = new NodeMode("https://my-worker.workers.dev", "my-workspace");
await nm.init({ owner: "me", name: "my-project" });
await nm.writeFile("index.ts", "console.log('hello');");
const result = await nm.exec("cat index.ts");
// { exitCode: 0, stdout: "console.log('hello');", stderr: "" }
```

## Module Shims — The vinext Approach

Like [vinext](https://github.com/cloudflare/vinext) shims `next/*` imports for Workers, nodemode shims `node:fs` and `node:child_process`:

```jsonc
// wrangler.jsonc
{
  "alias": {
    "fs": "nodemode/shims/fs",
    "child_process": "nodemode/shims/child_process"
  }
}
```

Libraries that `import fs from "node:fs"` or `import { exec } from "node:child_process"` transparently get nodemode's R2+SQLite implementation — no Container, $0 cost.

| vinext | nodemode |
|--------|----------|
| Shims `next/link`, `next/router`, `next/image` | Shims `node:fs`, `node:child_process` |
| Next.js apps on Workers | Node.js tools on Workers |

## Architecture

Commands are tiered:
- **Built-in** (cat, ls, grep, head, tail, wc, echo, pwd, cp, mv, rm, mkdir, touch, test, which, basename, dirname, env, whoami, date, printf, sleep, true, false) — execute directly in DO, $0 cost, <1ms
- **Container** (npm, node, git, tsc, esbuild, ...) — spawn Cloudflare Container, ~$0.02/hr

### Shell Support

- **Pipes**: `cmd1 | cmd2 | cmd3` — stdout of each stage feeds stdin of next
- **Chains**: `&&` (stop on fail), `||` (run on fail), `;` (always run)
- **Conditionals**: `test -f file && cat file || echo "not found"`
- **Quoted strings**: single and double quotes preserved across pipes and chains

### Container Integration

Non-builtin commands run inside a Cloudflare Container attached to the Workspace DO via `ctx.container`:

- **Boots on demand** — starts on first non-builtin exec, runs `container/agent.mjs` on port 8080
- **R2 FUSE mount** — source files symlinked from `/mnt/workspace` into `/workspace`
- **Local build artifacts** — `node_modules`, `dist`, `.npm`, `.next`, `build` on container-local disk
- **Snapshot/restore** — SIGTERM triggers tar+zstd to R2, restored on next boot
- **Inactivity timeout** — 10-minute idle sleep via `setInactivityTimeout()`
- **Health checks** — DO alarm every 30s: `/healthz` ping + R2-to-SQLite index reconciliation
- **Index invalidation** — container POSTs `/index-invalidate` when files change via R2 FUSE

## Storage

| Layer | Purpose | Limits |
|-------|---------|--------|
| **R2** | File content (`{workspace_id}/{path}`) | Unlimited |
| **DO SQLite** | Directory index, file cache (<64KB), process table (last 1000, output truncated to 4KB), terminal buffer (last 5000 rows) | 1GB per DO |
| **Container disk** | Build artifacts with R2 snapshot backup | Ephemeral |

## API

All endpoints are under `/workspace/{id}/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/init` | POST | Initialize workspace (owner, name) |
| `/exec` | POST | Execute command (returns exitCode, stdout, stderr) |
| `/fs/read` | POST | Read file (JSON or streaming) |
| `/fs/write` | POST | Write file |
| `/fs/stat` | GET | File metadata (size, mode, mtime, isDirectory) |
| `/fs/readdir` | GET | List directory entries |
| `/fs/mkdir` | POST | Create directory (supports recursive) |
| `/fs/unlink` | POST | Delete file |
| `/fs/rename` | POST | Rename/move file or directory |
| `/fs/exists` | GET | Check if path exists |
| `/process/list` | GET | List recent processes (metadata only) |
| `/process/get` | GET | Get process details by pid (includes output) |
| `/container/status` | GET | Container lifecycle status |
| `/container/stop` | POST | Stop container (triggers snapshot) |
| `/index-invalidate` | POST | Refresh SQLite index from R2 (used by container) |

WebSocket upgrade on any path enables stdio streaming with terminal buffer replay.

Workspace listing: `GET /api/workspaces` (paginated R2 prefix scan).

## Validation

All inputs validated at system boundaries:
- **Paths**: max 4096 chars, max 256 depth, no null bytes, no traversal above root
- **Commands**: max 8192 chars, no null bytes, no empty
- **Workspace IDs**: alphanumeric + `.`, `-`, `_`, max 128 chars
- **Payloads**: max 100MB (Worker), max 10MB (container agent)
- **Regex**: invalid grep patterns fall back to literal string matching

## Running Tests

```bash
# All tests (unit + conformance)
npx vitest run

# Unit tests only
npx vitest run test/

# Conformance tests only
npx vitest run --dir research
```

## Known Gaps

| Area | Status | Notes |
|------|--------|-------|
| Filesystem | ~85% | Streaming reads work. Missing: symlinks, file descriptors, R2+SQLite atomicity |
| Shell parsing | ~50% | Pipes, chains, quoted strings work. Missing: redirects (`>`, `<`), variable expansion (`$VAR`), subshells, background jobs |
| Container exec | ~70% | Exec + snapshot/restore working. Missing: streaming output, stdin piping, long-running processes |
| Process model | ~40% | Process table with pruning (1000 rows). Missing: signals, stdin streaming, background processes |
| Auth / security | ~20% | Path traversal protection, input validation, payload limits. Missing: authentication, rate limiting, per-workspace CORS |
| Terminal buffer | ~70% | 5000-row buffer with trimming. Missing: per-stream limits, binary data |
| Client SDK | ~60% | HTTP client works. Missing: WebSocket helpers, retry/reconnect, auth headers |
| Workspace lifecycle | ~40% | Container lifecycle managed. Missing: workspace deletion, cloning, resource quotas |

## Deploy

```bash
npx wrangler deploy
```

Requires Cloudflare Workers Paid plan (Durable Objects + R2).

## License

MIT
