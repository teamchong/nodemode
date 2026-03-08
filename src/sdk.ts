// NodeMode SDK — HTTP client for interacting with a nodemode instance
//
// Works in browsers, Node.js, and Cloudflare Workers.
//
// Usage:
//   import { NodeMode } from "nodemode/client";
//   const nm = new NodeMode("https://my-worker.workers.dev", "my-workspace");
//   await nm.init({ owner: "me", name: "my-project" });
//   await nm.writeFile("index.ts", "console.log('hello');");
//   const result = await nm.exec("cat index.ts");

import type { FileStat, DirEntry } from "./fs-engine";
import type { SpawnResult, ProcessHandle } from "./process-manager";
import type { ContainerStatus } from "./container";

export class NodeMode {
  constructor(
    private baseUrl: string,
    private workspaceId: string,
    private fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private url(action: string, params?: Record<string, string>): string {
    const base = `${this.baseUrl}/workspace/${this.workspaceId}/${action}`;
    if (!params) return base;
    const qs = new URLSearchParams(params).toString();
    return `${base}?${qs}`;
  }

  private async post<T>(action: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(this.url(action), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`nodemode ${action} failed (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }

  private async get<T>(action: string, params?: Record<string, string>): Promise<T> {
    const res = await this.fetchFn(this.url(action, params));
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`nodemode ${action} failed (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }

  // -- Workspace --

  async init(opts: { owner: string; name: string }): Promise<{ status: string }> {
    return this.post("init", opts);
  }

  // -- Exec --

  async exec(command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<SpawnResult> {
    return this.post("exec", { command, ...opts });
  }

  // -- Filesystem --

  async readFile(path: string): Promise<string> {
    const data = await this.post<{ content: string }>("fs/read", { path });
    return data.content;
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetchFn(this.url("fs/read"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, stream: true }),
    });
    if (!res.ok) {
      throw new Error(`nodemode fs/read failed (${res.status})`);
    }
    return res.body!;
  }

  async writeFile(path: string, content: string, mode?: number): Promise<void> {
    await this.post("fs/write", { path, content, mode });
  }

  async stat(path: string): Promise<FileStat> {
    return this.get("fs/stat", { path });
  }

  async readdir(path: string = "/"): Promise<DirEntry[]> {
    return this.get("fs/readdir", { path });
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.post("fs/mkdir", { path, recursive });
  }

  async unlink(path: string): Promise<void> {
    await this.post("fs/unlink", { path });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.post("fs/rename", { oldPath, newPath });
  }

  async exists(path: string): Promise<boolean> {
    const data = await this.get<{ exists: boolean }>("fs/exists", { path });
    return data.exists;
  }

  // -- Process --

  async listProcesses(): Promise<ProcessHandle[]> {
    return this.get("process/list");
  }

  async getProcess(pid: number): Promise<ProcessHandle> {
    return this.get("process/get", { pid: String(pid) });
  }

  // -- Container --

  async containerStatus(): Promise<ContainerStatus> {
    const data = await this.get<{ status: ContainerStatus }>("container/status");
    return data.status;
  }

  async containerStop(): Promise<{ status: string }> {
    return this.post("container/stop", {});
  }

  // -- WebSocket --

  connectWebSocket(): WebSocket {
    const wsUrl = this.url("ws").replace(/^http/, "ws");
    return new WebSocket(wsUrl);
  }
}

// Static helper to list all workspaces
export async function listWorkspaces(
  baseUrl: string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string[]> {
  const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/api/workspaces`);
  if (!res.ok) throw new Error(`Failed to list workspaces (${res.status})`);
  const data = (await res.json()) as { workspaces: string[] };
  return data.workspaces;
}
