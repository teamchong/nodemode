// Shared test helpers for nodemode workspace HTTP API
//
// All conformance and shim tests call the same HTTP endpoints.
// This module eliminates ~200 lines of duplicated helpers.

import { SELF } from "cloudflare:test";

export function createHelpers(workspace: string) {
  const base = `http://localhost/workspace/${workspace}`;

  return {
    async init(owner: string, name: string) {
      return SELF.fetch(`${base}/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, name }),
      });
    },

    async exec(command: string, opts?: { env?: Record<string, string> }) {
      const res = await SELF.fetch(`${base}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, ...opts }),
      });
      return res.json() as Promise<{ exitCode: number; stdout: string; stderr: string }>;
    },

    async writeFile(path: string, content: string) {
      return SELF.fetch(`${base}/fs/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
    },

    async readFile(path: string) {
      const res = await SELF.fetch(`${base}/fs/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      return res.json() as Promise<{ content: string }>;
    },

    async statRaw(path: string) {
      return SELF.fetch(`${base}/fs/stat?path=${encodeURIComponent(path)}`);
    },

    async stat(path: string) {
      return SELF.fetch(`${base}/fs/stat?path=${encodeURIComponent(path)}`)
        .then((r) => r.json() as Promise<{ size: number; isDirectory: boolean; mtime: number; mode: number }>);
    },

    async readdir(path: string) {
      return SELF.fetch(`${base}/fs/readdir?path=${encodeURIComponent(path)}`)
        .then((r) => r.json() as Promise<Array<{ name: string; isDirectory: boolean }>>);
    },

    async exists(path: string) {
      return SELF.fetch(`${base}/fs/exists?path=${encodeURIComponent(path)}`)
        .then((r) => r.json() as Promise<{ exists: boolean }>)
        .then((d) => d.exists);
    },

    async unlink(path: string) {
      return SELF.fetch(`${base}/fs/unlink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    },

    async rename(oldPath: string, newPath: string) {
      return SELF.fetch(`${base}/fs/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath, newPath }),
      });
    },

    async mkdir(path: string) {
      return SELF.fetch(`${base}/fs/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, recursive: true }),
      });
    },

    async listProcesses() {
      const res = await SELF.fetch(`${base}/process/list`);
      return res.json() as Promise<Array<{ pid: number; command: string; status: string; exitCode: number | null }>>;
    },

    async getProcess(pid: number) {
      const res = await SELF.fetch(`${base}/process/get?pid=${pid}`);
      return res.json() as Promise<{ pid: number; command: string; stdout: string; stderr: string }>;
    },

    async execRaw(command: string) {
      return SELF.fetch(`${base}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
    },
  };
}
