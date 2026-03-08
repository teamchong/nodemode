# Container Integration Design

## The Core Problem

```
DO/R2    = canonical filesystem (persistent, source of truth)
Container = real Linux environment (ephemeral disk, resets on sleep)
```

When a Container runs `npm install`, it writes thousands of files to local disk.
When the Container sleeps, all of that is gone. Next boot = fresh disk.

**The question: how do these two worlds stay in sync?**

## Cloudflare Building Blocks (March 2026)

| Capability | Details |
|-----------|---------|
| `@cloudflare/containers` | `Container` class with `onStart()`, `onStop()`, `sleepAfter`, `startAndWaitForPorts()` |
| `instance.fetch()` | DO → Container HTTP via `http://container.internal/...` |
| R2 FUSE mount | Mount R2 bucket as filesystem inside Container (Nov 2025). Does NOT work with `wrangler dev`. |
| SIGTERM + 15 min | Container gets warning before shutdown, time to persist state |
| Container disk | Ephemeral SSD. Fast. Resets on every sleep/wake cycle. |
| Container `sleepAfter` | Configurable idle timeout (e.g. `"10m"`). Charges stop when sleeping. |
| Container `envVars` | Pass secrets/config from DO to Container at start time |

## Rejected Approaches

### "R2 FUSE for everything"
`npm install` writes ~30,000 small files. R2 FUSE = network round-trip per file op.
Would take minutes for what takes seconds on local disk. Object storage is not POSIX.

### "Stage all files to Container on boot, sync back on stop"
500MB workspace = 500MB transfer per boot. Cold start goes from 2-3s to 30-60s.
If Container crashes (no SIGTERM), all work since last sync is lost.

### "Container has its own state, DO/R2 is just for API"
Two sources of truth. WebSocket clients editing via DO/R2 don't see Container changes.
Container doesn't see files written via REST API. Consistency nightmare.

## Chosen Design: R2 FUSE as Shared Layer + Local Symlinks for Build Dirs

### Architecture

```
                                     ┌──────────────────────────────┐
                                     │        Container             │
                                     │                              │
  REST/WS clients                    │  /mnt/workspace/   (R2 FUSE) │
       │                             │    ├── src/                  │
       ▼                             │    ├── package.json          │
  ┌─────────┐   routes    ┌─────────┐│    └── tsconfig.json        │
  │ Worker   │ ──────────►│ DO      ││                              │
  │ (gateway)│            │Workspace││  /workspace/        (unified)│
  └─────────┘            │         ││    ├── src/ → /mnt/workspace │
                          │ SQLite: ││    ├── node_modules/ (local) │
                          │  index  ││    ├── dist/         (local) │
                          │  procs  ││    └── .npm/         (local) │
                          │  sync   ││                              │
                          │  term   ││  container-agent on :8080    │
                          └────┬────┘│    ├── POST /exec            │
                               │     │    ├── POST /sync            │
                          fetch()    │    ├── GET  /healthz         │
                               │     │    └── GET  /fs/read?path=   │
                               ▼     └──────────────────────────────┘
                          ┌──────────────────────────────┐
                          │        R2 (FS_BUCKET)         │
                          │  {workspace_id}/src/index.ts  │
                          │  {workspace_id}/package.json  │
                          │  {workspace_id}/.snapshots/   │
                          └──────────────────────────────┘
```

### File Tiers

Not all files need the same consistency model.

| Tier | Examples | Where it lives | Why |
|------|----------|----------------|-----|
| **Shared source** | `src/`, `package.json`, `.env`, config files | R2 via FUSE mount | Both DO API clients and Container see same files instantly. Writes from either side go to R2. |
| **Build artifacts** | `node_modules/`, `dist/`, `.next/`, `build/` | Container local disk | Thousands of small files. Must be fast. Can be rebuilt. Snapshot to R2 on sleep for fast restore. |
| **Scratch** | `/tmp/`, intermediate compiler output | Container local disk | Never persisted. Pure scratch space. |

### Sync Protocol

#### Phase 1: Container Boot

```
DO receives exec request for non-builtin command
  │
  ├── Is Container running?
  │   YES → skip to Phase 2
  │   NO  → continue
  │
  ├── Call startAndWaitForPorts({ ports: [8080] })
  │   Container boots with:
  │     - R2 FUSE mount at /mnt/workspace (auto-provides source files)
  │     - envVars: { WORKSPACE_ID, R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY }
  │
  ├── container-agent starts inside Container:
  │   1. Mount R2 FUSE at /mnt/workspace/{workspace_id}/
  │   2. Symlink source dirs: /workspace/src → /mnt/workspace/src, etc.
  │   3. Create local dirs: /local/node_modules, /local/dist, /local/.npm
  │   4. Symlink build dirs: /workspace/node_modules → /local/node_modules
  │   5. Check R2 for snapshot: {workspace_id}/.snapshots/node_modules.tar.zst
  │      - If exists: extract to /local/node_modules/ (~2-5s for typical project)
  │      - If not: skip (user will npm install)
  │   6. Listen on :8080, report ready
  │
  └── DO records: container_status = "running", container_started_at = now
```

#### Phase 2: Command Execution (Container Running)

```
User sends: "npm install"
  │
  ├── DO classifies: not a builtin → route to Container
  │
  ├── DO calls: instance.fetch("http://container.internal/exec", {
  │     method: "POST",
  │     body: { command: "npm install", cwd: "/workspace" }
  │   })
  │
  ├── Container executes npm install:
  │   - Reads package.json from /workspace/ (symlink → R2 FUSE)
  │   - Writes node_modules/ to /workspace/node_modules (symlink → /local/ = fast)
  │   - Streams stdout/stderr as chunked HTTP response
  │
  ├── DO receives streaming response:
  │   - Buffers in terminal_buffer (SQLite)
  │   - Broadcasts to WebSocket clients
  │   - Updates process table
  │
  └── Source file changes (if any) go to R2 via FUSE symlink
```

#### Phase 3: Source File Sync (Bidirectional)

**Container writes source file** (e.g., `npm init` creates package.json):
```
npm init writes /workspace/package.json
  → symlink resolves to /mnt/workspace/package.json
  → R2 FUSE writes to R2
  → R2 updated, visible to DO API clients
```

**API client writes source file** (e.g., REST API or WebSocket):
```
POST /workspace/{id}/fs/write { path: "src/index.ts", content: "..." }
  → DO writes to R2 via FsEngine (existing code)
  → DO updates SQLite index (existing code)
  → Container sees change via R2 FUSE mount (automatic, no notification needed)
```

This is the key insight: **R2 FUSE makes bidirectional source sync automatic**.
No custom sync protocol needed for source files.

#### Phase 4: Container Sleep (SIGTERM)

```
Container receives SIGTERM (idle timeout or manual stop)
  │
  ├── container-agent SIGTERM handler:
  │   1. Tar /local/node_modules/ → node_modules.tar.zst
  │   2. Upload to R2: {workspace_id}/.snapshots/node_modules.tar.zst
  │   3. Tar /local/dist/ → dist.tar.zst (if non-empty)
  │   4. Upload to R2: {workspace_id}/.snapshots/dist.tar.zst
  │   5. Exit cleanly
  │
  ├── DO onStop() hook:
  │   1. Record: container_status = "sleeping"
  │   2. Record: last_snapshot_at = now
  │   3. Fall back to builtin-only mode for subsequent commands
  │
  └── Container disk is wiped (ephemeral)
      R2 still has: source files + snapshots
      SQLite still has: index + process history + terminal buffer
```

#### Phase 5: Container Crash (No SIGTERM)

```
Container crashes unexpectedly (OOM, host restart, etc.)
  │
  ├── DO onError() hook fires
  │   1. Record: container_status = "crashed"
  │   2. Source files: safe (in R2)
  │   3. node_modules: lost (was on local disk)
  │   4. User will need to npm install again on next boot
  │   5. This is acceptable — same as any dev laptop crash
  │
  └── Next exec request → DO starts fresh Container → Phase 1
```

### DO SQLite Index Consistency

When Container writes to R2 via FUSE, the DO SQLite index becomes stale.
Three strategies, phased by implementation order:

**Phase 1 — Lazy index refresh:**
```
When DO gets stat/readdir request AND Container is running:
  1. Check SQLite index (fast, <1ms)
  2. If entry exists, return it
  3. If entry missing, fall back to R2 HEAD/list (10-50ms)
  4. Update SQLite index on cache miss
```
Index is a performance cache, not source of truth. R2 is truth.

**Phase 2 — Container notifies DO on file change:**
```
container-agent runs inotify watcher on /mnt/workspace/
On file change:
  POST http://container.internal:9090/index-update  (DO reverse port)
    { path: "src/new-file.ts", size: 1234, mtime: 1709913600 }
  DO updates SQLite index in real-time
```
Better consistency. Requires reverse communication channel.

**Phase 3 — Periodic reconciliation:**
```
DO alarm every 30s while Container is running:
  R2 list({prefix: workspace_id}) → compare with SQLite index → reconcile
```
Catches all edge cases. Adds R2 list cost and 30s staleness window.

### Why Symlinks Instead of OverlayFS

Considered using Linux OverlayFS (upper=local, lower=R2 FUSE, merged=/workspace/).
Rejected because:

- Overlay copy-up means source file writes go to local upper layer, NOT to R2 FUSE
- Would need post-write hooks to push changed source files back to R2
- Symlinks are transparent, debuggable, and Node.js resolves them natively
- `.gitignore` patterns already exclude `node_modules/` and `dist/`

Symlinks give us exactly the right behavior: source file writes go through to R2,
build artifact writes stay on fast local disk.

## Container Components (Implemented)

### 1. Wrangler Configuration

Container is embedded on the Workspace DO via `ctx.container`:

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "WORKSPACE",
        "class_name": "Workspace",
        "container": {
          "image": "./container/Dockerfile",
          "max_instances": 10
        }
      }
    ]
  },
  "r2_buckets": [
    { "binding": "FS_BUCKET", "bucket_name": "nodemode-fs" }
  ]
}
```

### 2. Container Access (ctx.container on DO)

No separate Container class needed. The container is available as
`this.ctx.container` on the Workspace DO:

```typescript
// ctx.container API (from @cloudflare/workers-types)
interface Container {
  get running(): boolean;
  start(options?: ContainerStartupOptions): void;
  monitor(): Promise<void>;
  destroy(error?: any): Promise<void>;
  signal(signo: number): void;
  getTcpPort(port: number): Fetcher;
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
}
```

### 3. Workspace DO Orchestration

ProcessManager accepts a `containerExec` callback. Non-builtin commands
are routed to the container via `ctx.container.getTcpPort(8080).fetch()`:

```typescript
// In Workspace constructor
this.processes = new ProcessManager(
  this.sql, this.fs, "/",
  (command, options) => this.execInContainer(command, options),
);

// Container execution
async execInContainer(command, options): Promise<ContainerExecResult> {
  const container = this.ctx.container;
  if (!container) return { exitCode: 127, stdout: "", stderr: "..." };

  if (!container.running) {
    container.start({ enableInternet: true, env: { WORKSPACE_ID: this.workspaceId } });
    await container.monitor();
  }

  const fetcher = container.getTcpPort(8080);
  const response = await fetcher.fetch("http://container/exec", {
    method: "POST",
    body: JSON.stringify({ command, cwd: options.cwd || "/workspace" }),
  });
  return await response.json();
}
```

### 4. Health Check + Index Reconciliation via Alarm

```typescript
async alarm(): Promise<void> {
  // Check container health via /healthz
  // Reconcile SQLite index with R2 list (catches FUSE-written files)
  // Schedule next alarm in 30s
}
```

### 4. container-agent (runs inside Container)

```
container/
  ├── Dockerfile
  ├── package.json
  └── agent.ts          ← HTTP server + lifecycle management
```

The agent handles:
- `POST /exec` — spawn child process, stream output
- `POST /sync/snapshot` — manually trigger snapshot
- `GET /healthz` — health check
- `GET /fs/read?path=...` — read file from Container's view
- `GET /fs/tree` — list Container's filesystem tree
- SIGTERM handler: tar build dirs → upload to R2 → exit

### 5. Dockerfile

```dockerfile
FROM node:22-slim

# System tools
RUN apt-get update && apt-get install -y \
    git curl jq fuse3 zstd \
    && rm -rf /var/lib/apt/lists/*

# Install tigrisfs for R2 FUSE
RUN curl -L https://github.com/tigrisdata/tigrisfs/releases/latest/download/tigrisfs-linux-amd64 \
    -o /usr/local/bin/tigrisfs && chmod +x /usr/local/bin/tigrisfs

# Container agent
WORKDIR /opt/agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY agent.js ./

# Workspace directory
RUN mkdir -p /workspace /local /mnt/workspace

EXPOSE 8080
ENTRYPOINT ["node", "/opt/agent/agent.js"]
```

## Container Boot Sequence (container-agent)

```
1. Mount R2 FUSE
   tigrisfs mount \
     --bucket nodemode-fs \
     --prefix {WORKSPACE_ID}/ \
     --endpoint {R2_ENDPOINT} \
     /mnt/workspace

2. Symlink shared files
   ln -sf /mnt/workspace/* /workspace/
   (or bind mount /mnt/workspace → /workspace, then overlay local dirs)

3. Create local dirs
   mkdir -p /local/node_modules /local/dist /local/.npm

4. Symlink build dirs into workspace
   ln -sf /local/node_modules /workspace/node_modules
   ln -sf /local/dist /workspace/dist

5. Restore snapshot (if exists)
   Check R2: {WORKSPACE_ID}/.snapshots/node_modules.tar.zst
   If found: download and extract to /local/node_modules/
   Typical restore time: 2-5s for a medium project

6. Start HTTP server on :8080
   Ready to accept /exec requests from DO
```

## Cost Analysis

| Component | When active | Cost |
|-----------|-------------|------|
| Worker | Per request | ~$0.30/M requests |
| DO (Workspace) | Per request + WebSocket | ~$0.15/M requests |
| DO SQLite | Always (tiny) | Included |
| R2 storage | Always | $0.015/GB/month |
| R2 operations | Per file read/write | $0.36/M class A, $0.036/M class B |
| Container (basic) | While running | ~$0.02/hr (billed per 10ms active) |
| Container idle | sleepAfter timeout | $0 (sleeping) |

**Typical session cost (30 min dev session):**
- Container: ~$0.01 (basic instance, 30 min)
- R2: ~$0.001 (few hundred file ops)
- DO: ~$0.001
- **Total: ~$0.012 per session**

**Idle cost: $0** (Container sleeps, DO hibernates, R2 stores files)

## Future Work

### Pipes and shell operators (`cmd1 | cmd2`, `&&`, `||`, `>`, `>>`)
Container-side shell handles this natively — DO sends the full command string
to bash inside the Container. Shell parsing stays in bash, not in our code.

### Long-running processes (dev servers, watchers)
Container keeps running while process is alive. `sleepAfter` timer resets on
each request. WebSocket streams ongoing output from DO terminal buffer.

### Multiple Containers per workspace
Separate Containers for build vs dev server. Each gets its own DO binding
and lifecycle. Workspace DO coordinates between them.

### Container-to-Container communication
Service bindings between workspace Containers. All communication routed
through the Workspace DO as coordinator.

### GPU workloads
Cloudflare Containers support GPUs (preview). Enables ML model
training/inference inside workspace Containers.

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Container API | `ctx.container` (built-in DO property) | Native API, no separate Container DO class needed. start/monitor/getTcpPort pattern. |
| File sync | R2 FUSE mount + local symlinks | No custom sync protocol for source files. Build artifacts stay local for speed. |
| Overlay vs symlinks | Symlinks | Transparent, debuggable. Overlay copy-up breaks R2 write-through for source files. |
| Snapshot format | tar.zst to R2 | Good compression ratio, fast decompression, single R2 object instead of thousands |
| Index consistency | All three from day one | Lazy refresh + event-driven invalidation + periodic reconciliation via alarm. Each is independent and lightweight. |
| Index writer | DO is sole writer | Container never writes to SQLite. Sends invalidation requests. Inspired by querymode MasterDO pattern. |
| Container health | DO alarm every 30s | healthz ping + R2 list reconciliation. Catches crashed containers and stale indexes. |
| Non-builtin routing | ContainerExecFn callback | ProcessManager accepts a callback for container execution. Clean separation; testable without container. |
| Snapshot restore | On boot before listening | container-agent restores tar.zst from R2 before starting HTTP server. Fast restore (2-5s). |
