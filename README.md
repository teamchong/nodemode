# nodemode

> **Experimental** — This project is in early research/prototype stage. The filesystem layer works but Container integration, shell parsing, auth, and streaming are not yet implemented. See [Known Gaps](#known-gaps) below.

Map Node.js primitives to Cloudflare Workers + R2 + Durable Objects + Containers.

## Mapping

| Node.js | Cloudflare |
|---------|------------|
| `fs` | R2 (file content) + DO SQLite (directory index & cache) |
| `child_process` | DO built-in commands + Containers for heavy workloads |
| `stdio` | WebSocket with DO SQLite persistence |
| `process` | DO instance state |

## Quick Start

```bash
npx nodemode init my-workspace
cd my-workspace
npx wrangler dev
```

## Architecture

<img src="docs/public/architecture.svg" alt="nodemode architecture diagram" style="width: 100%; max-width: 900px;" />

Commands are tiered:
- **Built-in** (cat, ls, grep, echo, pwd, ...) — execute directly in DO, $0 cost, <1ms
- **Container** (npm, node, git, ...) — spawn Cloudflare Container, ~$0.02/hr

## Storage

- **R2** — unlimited file storage keyed by `{workspace_id}/{path}`
- **DO SQLite** — directory index, file cache (<64KB), process table, terminal buffer

## Deploy

```bash
npx nodemode deploy
```

Requires Cloudflare Workers Paid plan (for Durable Objects + R2).

## Known Gaps

| Area | Status | What's Missing |
|------|--------|----------------|
| Filesystem | ~80% | No streaming (large files OOM), no symlinks, no file descriptors, appendFile is O(n), rename doesn't handle directories, R2+SQLite writes not atomic |
| Container exec | 0% | No Dockerfile, no `getTcpPort()` protocol — non-builtin commands return "not found" |
| Shell parsing | ~10% | No pipes, no `&&`/`||`/`;`, no redirects (`>`, `>>`, `<`), no variable expansion, no background jobs |
| Auth / security | 0% | No authentication, CORS is `*`, no rate limiting, no path traversal validation |
| Process model | ~20% | Request/response only, no long-running processes, no signals, no stdin streaming, unbounded process table |
| Terminal buffer | ~50% | Works but grows unbounded, no rotation/max size |
| API design | ~60% | Mixed GET/POST for reads, no binary file support, no pagination, no ETag |
| Workspace lifecycle | ~30% | No deletion, no cloning, no resource limits, no idle cleanup |
| Client SDK | 0% | No TypeScript client library |

## Docs

See the [documentation site](docs/) built with Astro Starlight.

## License

MIT
