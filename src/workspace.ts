// Workspace — Durable Object with SQLite for per-workspace state
//
// Each workspace gets its own DO instance. The DO's embedded SQLite
// database stores the filesystem index, process state, and metadata.
// File content lives in R2.
//
// This is the central coordinator — equivalent to a "machine" that
// has a filesystem, can run commands, and streams I/O via WebSocket.
//
// Container integration:
//   Non-builtin commands (npm, node, etc.) are routed to a paired
//   Cloudflare Container via instance.fetch(). The Container sees
//   source files via R2 FUSE mount. Build artifacts live on local disk
//   and are snapshot/restored as tar.zst to R2.
//
//   DO is the sole writer to the SQLite index. Container sends index
//   invalidation requests when it writes files via R2 FUSE.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { FsEngine } from "./fs-engine";
import { ProcessManager } from "./process-manager";
import type { ContainerStatus, ContainerExecResult } from "./container";
import { validatePath, validateCommand, validatePayloadSize, ValidationError } from "./validate";

const MAX_TERMINAL_BUFFER_ROWS = 5000;
const CONTAINER_HEALTH_INTERVAL_MS = 30_000;
const CONTAINER_EXEC_TIMEOUT_MS = 300_000;

export class Workspace extends DurableObject<Env> {
  private sql: SqlStorage;
  private fs: FsEngine;
  private processes: ProcessManager;
  private workspaceId: string;
  private containerStatus: ContainerStatus = "stopped";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();

    this.workspaceId = ctx.id.toString();
    this.fs = new FsEngine(env.FS_BUCKET, this.sql, this.workspaceId);
    this.processes = new ProcessManager(
      this.sql,
      this.fs,
      "/",
      (command, options) => this.execInContainer(command, options),
    );

    // Restore container status from live state after hibernation wake
    if (ctx.container?.running) {
      this.containerStatus = "running";
    }
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        r2_key TEXT NOT NULL,
        size INTEGER NOT NULL,
        mode INTEGER NOT NULL DEFAULT 420,
        mtime INTEGER NOT NULL,
        is_dir INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS file_cache (
        path TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        cached_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processes (
        pid INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS workspace_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '/',
        env TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terminal_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'stdin')),
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = request.headers.get("x-action") || url.pathname;

    // WebSocket upgrade for stdio streaming
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // Validate payload size for requests with body
    if (request.method === "POST" || request.method === "PUT") {
      validatePayloadSize(request.headers.get("content-length"));
    }

    try {
      switch (action) {
        case "/init":
          return this.handleInit(request);
        case "/exec":
          return this.handleExec(request);
        case "/fs/read":
          return this.handleFsRead(request);
        case "/fs/write":
          return this.handleFsWrite(request);
        case "/fs/stat":
          return this.handleFsStat(request);
        case "/fs/readdir":
          return this.handleFsReaddir(request);
        case "/fs/mkdir":
          return this.handleFsMkdir(request);
        case "/fs/unlink":
          return this.handleFsUnlink(request);
        case "/fs/rename":
          return this.handleFsRename(request);
        case "/fs/exists":
          return this.handleFsExists(request);
        case "/process/list":
          return json(this.processes.listProcesses());
        case "/process/get":
          return this.handleProcessGet(request);
        case "/container/status":
          return json({ status: this.containerStatus });
        case "/container/stop":
          return this.handleContainerStop();
        case "/index-invalidate":
          return this.handleIndexInvalidate(request);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        return json({ error: err.message }, 400);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
  }

  // -- Init --

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      owner: string;
      name: string;
    };

    if (!body.owner || !body.name) {
      return json({ error: "owner and name are required" }, 400);
    }

    const existing = this.sql
      .exec("SELECT 1 FROM workspace_meta WHERE id = 1")
      .toArray();
    if (existing.length > 0) {
      return json({ status: "already_initialized" });
    }

    this.sql.exec(
      "INSERT INTO workspace_meta (id, owner, name, created_at) VALUES (1, ?, ?, ?)",
      body.owner,
      body.name,
      new Date().toISOString(),
    );

    return json({ status: "initialized" });
  }

  // -- Exec --

  private async handleExec(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      command: string;
      cwd?: string;
      env?: Record<string, string>;
    };

    validateCommand(body.command);
    if (body.cwd) validatePath(body.cwd);

    const result = await this.processes.exec(body.command, {
      cwd: body.cwd,
      env: body.env,
    });

    return json(result);
  }

  // -- Filesystem handlers --

  private async handleFsRead(request: Request): Promise<Response> {
    const { path, stream } = (await request.json()) as {
      path: string;
      stream?: boolean;
    };
    validatePath(path);

    // Streaming mode for large files — returns raw body
    if (stream) {
      const body = await this.fs.readFileStream(path);
      if (!body) {
        return json({ error: `ENOENT: no such file '${path}'` }, 404);
      }
      return new Response(body, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    const content = await this.fs.readFileText(path);
    if (content === null) {
      return json({ error: `ENOENT: no such file '${path}'` }, 404);
    }
    return json({ content });
  }

  private async handleFsWrite(request: Request): Promise<Response> {
    const { path, content, mode } = (await request.json()) as {
      path: string;
      content: string;
      mode?: number;
    };
    validatePath(path);
    await this.fs.writeFile(path, content, mode);
    return json({ ok: true });
  }

  private handleFsStat(request: Request): Response {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") || "/";
    validatePath(path);
    const stat = this.fs.stat(path);
    if (!stat) {
      return json({ error: `ENOENT: no such file '${path}'` }, 404);
    }
    return json(stat);
  }

  private handleFsReaddir(request: Request): Response {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") || "/";
    validatePath(path);
    const entries = this.fs.readdir(path);
    return json(entries);
  }

  private async handleFsMkdir(request: Request): Promise<Response> {
    const { path, recursive } = (await request.json()) as {
      path: string;
      recursive?: boolean;
    };
    validatePath(path);
    this.fs.mkdir(path, recursive);
    return json({ ok: true });
  }

  private async handleFsUnlink(request: Request): Promise<Response> {
    const { path } = (await request.json()) as { path: string };
    validatePath(path);
    await this.fs.unlink(path);
    return json({ ok: true });
  }

  private async handleFsRename(request: Request): Promise<Response> {
    const { oldPath, newPath } = (await request.json()) as {
      oldPath: string;
      newPath: string;
    };
    validatePath(oldPath);
    validatePath(newPath);
    await this.fs.rename(oldPath, newPath);
    return json({ ok: true });
  }

  private handleFsExists(request: Request): Response {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") || "/";
    validatePath(path);
    return json({ exists: this.fs.exists(path) });
  }

  private handleProcessGet(request: Request): Response {
    const url = new URL(request.url);
    const pid = parseInt(url.searchParams.get("pid") || "0", 10);
    const proc = this.processes.getProcess(pid);
    if (!proc) return json({ error: "Process not found" }, 404);
    return json(proc);
  }

  // -- Container lifecycle --

  private async handleContainerStop(): Promise<Response> {
    const container = this.ctx.container;
    if (!container || !container.running) {
      this.containerStatus = "stopped";
      return json({ status: "stopped" });
    }

    try {
      // Send SIGTERM — container-agent will snapshot and exit
      container.signal(15); // SIGTERM
      this.containerStatus = "sleeping";
      return json({ status: "stopping" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
  }

  // -- Container execution --

  private async execInContainer(
    command: string,
    options: { cwd?: string; env?: Record<string, string> },
  ): Promise<ContainerExecResult> {
    const container = this.ctx.container;
    if (!container) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: `command not found: ${command.split(/\s+/)[0]}\nContainer not available in this environment. Built-in commands only.`,
      };
    }

    // Ensure container is running
    if (this.containerStatus !== "running") {
      this.containerStatus = "starting";
      try {
        // Pass workspace ID and R2 credentials for snapshot upload/restore
        const containerEnv: Record<string, string> = {
          WORKSPACE_ID: this.workspaceId,
        };
        // R2 credentials are optional — snapshots disabled without them
        if (this.env.R2_ENDPOINT) containerEnv.R2_ENDPOINT = this.env.R2_ENDPOINT;
        if (this.env.R2_ACCESS_KEY) containerEnv.R2_ACCESS_KEY = this.env.R2_ACCESS_KEY;
        if (this.env.R2_SECRET_KEY) containerEnv.R2_SECRET_KEY = this.env.R2_SECRET_KEY;

        container.start({
          enableInternet: true,
          env: containerEnv,
        });
        await container.monitor();
        this.containerStatus = "running";

        // Set inactivity timeout (10 min idle → container sleeps)
        await container.setInactivityTimeout(10 * 60 * 1000);

        // Start health check alarm
        await this.ctx.storage.setAlarm(Date.now() + CONTAINER_HEALTH_INTERVAL_MS);
      } catch (err) {
        this.containerStatus = "crashed";
        const msg = err instanceof Error ? err.message : String(err);
        return { exitCode: 1, stdout: "", stderr: `Container failed to start: ${msg}` };
      }
    }

    // Execute command via container-agent with timeout
    const fetcher = container.getTcpPort(8080);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONTAINER_EXEC_TIMEOUT_MS);

      const response = await fetcher.fetch("http://container/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command,
          cwd: options.cwd || "/workspace",
          env: options.env,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text();
        return { exitCode: 1, stdout: "", stderr: `Container error (${response.status}): ${text}` };
      }

      return (await response.json()) as ContainerExecResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { exitCode: 124, stdout: "", stderr: `Command timed out after ${CONTAINER_EXEC_TIMEOUT_MS / 1000}s` };
      }
      return { exitCode: 1, stdout: "", stderr: `Container exec failed: ${msg}` };
    }
  }

  // -- Index invalidation (called by container-agent) --

  private async handleIndexInvalidate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      paths: string[];
    };

    if (!Array.isArray(body.paths)) {
      return json({ error: "paths must be an array" }, 400);
    }

    let refreshed = 0;
    for (const path of body.paths) {
      try {
        validatePath(path);
        // Refresh index entry from R2
        const r2Key = `${this.workspaceId}/${path}`;
        const head = await this.env.FS_BUCKET.head(r2Key);
        if (head) {
          // Update or insert index entry
          this.sql.exec(
            `INSERT OR REPLACE INTO files (path, r2_key, size, mtime, is_dir)
             VALUES (?, ?, ?, ?, 0)`,
            path,
            r2Key,
            head.size,
            Date.now(),
          );
          // Invalidate file cache
          this.sql.exec("DELETE FROM file_cache WHERE path = ?", path);
          refreshed++;
        } else {
          // File deleted from R2 — remove from index
          this.sql.exec("DELETE FROM files WHERE path = ?", path);
          this.sql.exec("DELETE FROM file_cache WHERE path = ?", path);
        }
      } catch {
        // Skip invalid paths
      }
    }

    // Broadcast to WebSocket clients
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(JSON.stringify({
        type: "index-updated",
        paths: body.paths,
        refreshed,
      }));
    }

    return json({ refreshed });
  }

  // -- Alarm: container health check + index reconciliation --

  async alarm(): Promise<void> {
    if (this.containerStatus !== "running") return;

    const container = this.ctx.container;
    if (!container || !container.running) {
      this.containerStatus = "stopped";
      return;
    }

    try {
      const fetcher = container.getTcpPort(8080);
      const response = await fetcher.fetch("http://container/healthz");
      if (!response.ok) {
        this.containerStatus = "crashed";
        return;
      }
    } catch {
      this.containerStatus = "crashed";
      return;
    }

    // Periodic index reconciliation: list R2 prefix, compare with SQLite
    await this.reconcileIndex();

    // Schedule next health check
    await this.ctx.storage.setAlarm(Date.now() + CONTAINER_HEALTH_INTERVAL_MS);
  }

  private async reconcileIndex(): Promise<void> {
    const prefix = `${this.workspaceId}/`;
    const listed = await this.env.FS_BUCKET.list({ prefix, limit: 1000 });

    const r2Paths = new Set<string>();
    for (const obj of listed.objects) {
      const path = obj.key.slice(prefix.length);
      if (!path) continue;
      r2Paths.add(path);

      // Check if index entry is stale
      const rows = this.sql
        .exec("SELECT size, mtime FROM files WHERE path = ?", path)
        .toArray();

      if (rows.length === 0 || (rows[0].size as number) !== obj.size) {
        this.sql.exec(
          `INSERT OR REPLACE INTO files (path, r2_key, size, mtime, is_dir)
           VALUES (?, ?, ?, ?, 0)`,
          path,
          obj.key,
          obj.size,
          Date.now(),
        );
        // Invalidate stale cache
        this.sql.exec("DELETE FROM file_cache WHERE path = ?", path);
      }
    }

    // Remove index entries for files no longer in R2
    const indexed = this.sql
      .exec("SELECT path FROM files WHERE is_dir = 0")
      .toArray();
    for (const row of indexed) {
      const path = row.path as string;
      if (!r2Paths.has(path)) {
        this.sql.exec("DELETE FROM files WHERE path = ?", path);
        this.sql.exec("DELETE FROM file_cache WHERE path = ?", path);
      }
    }
  }

  // -- WebSocket for stdio streaming --

  private handleWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Send buffered terminal output (most recent entries)
    const buffer = this.sql
      .exec(
        "SELECT stream, data FROM terminal_buffer ORDER BY id DESC LIMIT 1000",
      )
      .toArray()
      .reverse(); // Reverse to send in chronological order

    for (const row of buffer) {
      server.send(
        JSON.stringify({ stream: row.stream, data: row.data }),
      );
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let msg: { type: string; command?: string; cwd?: string };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (msg.type === "exec" && msg.command) {
      try {
        validateCommand(msg.command);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "error", error: errMsg }));
        return;
      }

      const result = await this.processes.exec(msg.command, {
        cwd: msg.cwd,
      });

      // Buffer output for hibernation persistence
      if (result.stdout) {
        this.sql.exec(
          "INSERT INTO terminal_buffer (stream, data, timestamp) VALUES ('stdout', ?, ?)",
          result.stdout,
          Date.now(),
        );
      }
      if (result.stderr) {
        this.sql.exec(
          "INSERT INTO terminal_buffer (stream, data, timestamp) VALUES ('stderr', ?, ?)",
          result.stderr,
          Date.now(),
        );
      }

      // Trim terminal buffer if it exceeds max rows
      this.trimTerminalBuffer();

      ws.send(
        JSON.stringify({
          type: "result",
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );

      // Broadcast to other connected clients
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws) {
          if (result.stdout) {
            other.send(
              JSON.stringify({ stream: "stdout", data: result.stdout }),
            );
          }
          if (result.stderr) {
            other.send(
              JSON.stringify({ stream: "stderr", data: result.stderr }),
            );
          }
        }
      }
    }
  }

  webSocketClose(): void {
    // Cleanup handled by hibernation API
  }

  // -- Internal helpers --

  private trimTerminalBuffer(): void {
    const count = this.sql
      .exec("SELECT COUNT(*) as cnt FROM terminal_buffer")
      .toArray()[0].cnt as number;
    if (count > MAX_TERMINAL_BUFFER_ROWS) {
      this.sql.exec(
        `DELETE FROM terminal_buffer WHERE id IN (
           SELECT id FROM terminal_buffer ORDER BY id ASC LIMIT ?
         )`,
        count - MAX_TERMINAL_BUFFER_ROWS,
      );
    }
  }
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
