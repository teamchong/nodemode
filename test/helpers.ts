// Shared test helpers for nodemode workspace HTTP API
//
// All conformance and shim tests call the same HTTP endpoints.
// This module eliminates ~200 lines of duplicated helpers.

import { SELF } from "cloudflare:test";

function post(url: string, body: unknown) {
  return SELF.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get<T>(url: string): Promise<T> {
  return SELF.fetch(url).then((r) => r.json() as Promise<T>);
}

export function createHelpers(workspace: string) {
  const base = `http://localhost/workspace/${workspace}`;
  const q = (action: string, path: string) => `${base}/${action}?path=${encodeURIComponent(path)}`;

  return {
    init: (owner: string, name: string) => post(`${base}/init`, { owner, name }),
    execRaw: (command: string) => post(`${base}/exec`, { command }),
    writeFile: (path: string, content: string) => post(`${base}/fs/write`, { path, content }),
    unlink: (path: string) => post(`${base}/fs/unlink`, { path }),
    rename: (oldPath: string, newPath: string) => post(`${base}/fs/rename`, { oldPath, newPath }),
    mkdir: (path: string) => post(`${base}/fs/mkdir`, { path, recursive: true }),
    rmdir: (path: string, recursive = false) => post(`${base}/fs/rmdir`, { path, recursive }),
    chmod: (path: string, mode: number) => post(`${base}/fs/chmod`, { path, mode }),
    statRaw: (path: string) => SELF.fetch(q("fs/stat", path)),

    async exec(command: string, opts?: { env?: Record<string, string> }) {
      const res = await post(`${base}/exec`, { command, ...opts });
      return res.json() as Promise<{ exitCode: number; stdout: string; stderr: string }>;
    },
    async readFile(path: string) {
      const res = await post(`${base}/fs/read`, { path });
      return res.json() as Promise<{ content: string }>;
    },
    stat: (path: string) => get<{ size: number; isDirectory: boolean; mtime: number; mode: number }>(q("fs/stat", path)),
    readdir: (path: string) => get<Array<{ name: string; isDirectory: boolean }>>(q("fs/readdir", path)),
    exists: (path: string) => get<{ exists: boolean }>(q("fs/exists", path)).then((d) => d.exists),
    listProcesses: () => get<Array<{ pid: number; command: string; status: string; exitCode: number | null }>>(`${base}/process/list`),
    getProcess: (pid: number) => get<{ pid: number; command: string; stdout: string; stderr: string }>(`${base}/process/get?pid=${pid}`),
  };
}
