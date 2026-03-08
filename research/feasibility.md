# nodemode Feasibility Research

## Conclusion: Very Feasible

All required Cloudflare primitives are GA as of March 2026. The hardest work (R2-as-fs, DO-as-process) is already proven across gitmode, pymode, and edgebox.

## Cloudflare Primitives (March 2026)

| Primitive | Status | Key Specs |
|-----------|--------|-----------|
| Containers | GA (June 2025) | Real Linux, writable fs, `getTcpPort().fetch()` for DO↔Container |
| DO SQLite | GA | 10GB/DO (paid), strongly consistent, <1ms reads |
| R2 | GA | Streaming read/write, ~10-50ms latency, occasional 400ms cold spikes |
| nodejs_compat | GA | crypto, Buffer, streams, util, path, events — NOT fs, child_process, net |
| DO WebSocket | GA | Hibernation API, automatic reconnection |
| Service bindings | GA | Zero-cost Worker↔Worker RPC, WorkerEntrypoint class |
| Worker memory | 128MB per isolate (same for DOs) |

## Node.js → Cloudflare Mapping

| Node.js | Cloudflare | Proven By |
|---------|-----------|-----------|
| fs.readFile/writeFile | R2 get/put | gitmode (worktree materialization) |
| fs.readdir | R2 list + DO SQLite index | gitmode (listFiles) |
| fs.stat | DO SQLite metadata | gitmode (file_sizes table) |
| child_process.spawn (heavy) | Container | Cloudflare docs (getTcpPort) |
| child_process.spawn (light) | DO RPC | pymode (thread_spawn → child DO) |
| stdin/stdout | WebSocket + DO SQLite buffer | Standard DO WebSocket pattern |
| process.env | Worker env / Secrets | Native |
| os.tmpdir | DO SQLite | Trivial |
| crypto | Web Crypto API | Native (nodejs_compat) |
| net.Socket | Service bindings / DO WebSocket | Native |

## Reusable Code from Existing Repos

### gitmode
- R2 storage patterns (chunk bundling, SQLite index)
- Worktree materialization (incremental, batched)
- Package structure (exports, CLI, wrangler config)

### pymode
- DO fan-out as threads (spawn → child DO, pickle args, join result)
- Host imports pattern (WASM ↔ JS bridge)
- Asyncify pattern for blocking operations

### edgebox
- Node.js API surface (58 compat tests)
- Built-in command emulators (cat, ls, grep, echo)
- Permission system (JSON command allowlist)
- EventEmitter, ChildProcess class
- Shell command parsing

### querymode
- R2 spill backend for memory-bounded operations
- DO-based query execution pattern

## What's Hard

1. **R2 latency** — 10-50ms vs <1ms disk. Mitigate with DO SQLite cache for hot files.
2. **Directory semantics** — R2 is flat. Need SQLite directory index. Tedious but solvable.
3. **Claude CLI in DO** — 50MB JS + 128MB limit. Must run in Container, DO coordinates.
4. **Streaming I/O** — `cmd1 | cmd2` needs Container↔Container pipes. Complex but doable with WebSocket.

## What's Easy

- File read/write (gitmode proves R2 + DO works)
- Terminal output (WebSocket + SQLite buffer)
- LLM API calls (fetch() is native)
- Process isolation (each workspace is its own DO)
- Built-in command emulators (pure TypeScript)
