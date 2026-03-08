# Edgebox Code Reuse Analysis

## Key files in edgebox for nodemode

### High Priority — Direct Reuse

| File | Size | What | nodemode adaptation |
|------|------|------|---------------------|
| `polyfills/modules/child_process.js` | 3KB | ChildProcess EventEmitter, stdin/stdout/stderr | Swap WAMR host calls for DO RPC / Container fetch |
| `wasi_process.zig` | 12KB | JSON command allowlist with subcommand filtering | Port to TS (~50 lines) |
| `polyfills/modules/events.js` | 2KB | EventEmitter (on, emit, once, removeListener) | Direct reuse |
| `polyfills/modules/path.js` | — | path.join, resolve, parse, basename, dirname | Direct reuse (pure JS) |
| `polyfills/modules/os.js` | — | platform, arch, tmpdir, homedir | Direct reuse (static values) |
| `polyfills/modules/util.js` | — | format, promisify, inspect | Direct reuse (pure JS) |

### Medium Priority — Concept Reuse

| File | What | Adaptation |
|------|------|------------|
| `polyfills/fs.zig` | Full fs API surface (86KB) | Use as API spec — implement against R2 + SQLite |
| `polyfills/require.zig` | CommonJS module resolution | Port to TS — resolve against R2 keys |
| `edgebox_wamr.zig` | Module caching (daemon mode) | Cache compiled modules in R2 |
| `wasi_tty.zig` | TTY detection, ANSI codes | Use for interactive terminal mode |

### Lower Priority — Reference Only

| File | What | Notes |
|------|------|-------|
| `polyfills/crypto.zig` | TLS 1.3, HMAC, SHA256 | WebCrypto already available |
| `polyfills/net.zig` | Network shims | Service bindings handle networking |
| `freeze/` | Comptime bytecode-to-C | Workers do pre-compilation already |

## Permission System (port target)

edgebox's `.edgebox.json`:
```json
{
  "allowCommands": ["git", "npm", "node"],
  "denyCommands": ["sudo", "su", "rm"],
  "commands": {
    "git": ["clone", "status", "add", "commit"],
    "npm": true,
    "node": true
  }
}
```

nodemode equivalent — same format, enforced in ProcessManager before execution.

## Key Insight

edgebox maps: `Node.js APIs → WASI syscalls → host functions → OS`
nodemode maps: `Node.js APIs → R2/DO SQLite → Cloudflare primitives`

The API surface is identical. We're swapping the backend, not the interface.
