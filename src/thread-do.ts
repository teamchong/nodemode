// ThreadDO — Child Durable Object for parallel JS/TS execution.
//
// Spawned by Workspace DO when JsRunner creates a Worker (worker_threads).
// Each ThreadDO runs a separate JsRunner instance with its own:
//   - 30s CPU budget (separate DO = separate isolate)
//   - 128MB memory
//   - Own module cache
//
// Communication:
//   Parent sends: { code: string, workerData: unknown, env: Record<string,string> }
//   Child returns: { messages: unknown[], stdout: string, stderr: string, exitCode: number }
//
// Does NOT support recursive spawning (no nested Workers) to prevent
// unbounded DO chains.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { FsEngine } from "./fs-engine";
import { JsRunner } from "./js-runner";
import { ProcessManager } from "./process-manager";

export class ThreadDO extends DurableObject<Env> {
  /**
   * Execute a worker script with workerData.
   * Returns collected postMessage calls, stdout, stderr.
   */
  async execute(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      scriptPath: string;
      workerData?: unknown;
      env?: Record<string, string>;
      workspaceId: string;
    };

    const sql = this.ctx.storage.sql;
    sql.exec("PRAGMA case_sensitive_like = ON");
    sql.exec(`
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
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);

    const fs = new FsEngine(this.env.FS_BUCKET, sql, body.workspaceId);
    const pm = new ProcessManager(sql, fs, "/", undefined, this.env.UNSAFE_EVAL);
    // No THREAD_DO binding on child — prevents recursive fan-out
    const runner = new JsRunner(fs, pm, "/", this.env.UNSAFE_EVAL);

    // Collect messages posted by the worker
    const messages: unknown[] = [];
    const parentPort = {
      postMessage: (data: unknown) => {
        messages.push(JSON.parse(JSON.stringify(data)));
      },
      on: () => parentPort,
      once: () => parentPort,
      emit: () => false,
    };

    runner.setThreadContext({
      isMainThread: false,
      parentPort: parentPort as any,
      workerData: body.workerData !== undefined
        ? JSON.parse(JSON.stringify(body.workerData))
        : null,
    });

    const result = await runner.run(body.scriptPath, [], body.env ?? {});

    return new Response(JSON.stringify({
      messages,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.execute(request);
  }
}
