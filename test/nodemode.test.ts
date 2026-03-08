import {
  env,
  createExecutionContext,
  SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("nodemode", () => {
  const workspaceId = "test-workspace";

  it("returns landing page on root", async () => {
    const res = await SELF.fetch("http://localhost/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("nodemode");
  });

  it("initializes a workspace", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/init`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test", name: "my-workspace" }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("initialized");
  });

  it("writes and reads a file", async () => {
    // Write
    const writeRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "hello.txt",
          content: "Hello, nodemode!",
        }),
      },
    );
    expect(writeRes.status).toBe(200);

    // Read
    const readRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello.txt" }),
      },
    );
    expect(readRes.status).toBe(200);
    const data = (await readRes.json()) as { content: string };
    expect(data.content).toBe("Hello, nodemode!");
  });

  it("stats a file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/stat?path=hello.txt`,
    );
    expect(res.status).toBe(200);
    const stat = (await res.json()) as {
      size: number;
      isDirectory: boolean;
    };
    expect(stat.size).toBe(16);
    expect(stat.isDirectory).toBe(false);
  });

  it("checks file existence", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=hello.txt`,
    );
    const data = (await res.json()) as { exists: boolean };
    expect(data.exists).toBe(true);

    const res2 = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=nope.txt`,
    );
    const data2 = (await res2.json()) as { exists: boolean };
    expect(data2.exists).toBe(false);
  });

  it("creates directories", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/mkdir`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "src/lib", recursive: true }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("lists directory contents", async () => {
    // Write a file inside src/
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "src/index.ts",
          content: 'console.log("hello");',
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/readdir?path=src`,
    );
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Array<{
      name: string;
      isDirectory: boolean;
    }>;
    const names = entries.map((e) => e.name);
    expect(names).toContain("index.ts");
    expect(names).toContain("lib");
  });

  it("executes echo command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello world" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("executes cat command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "cat hello.txt" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello, nodemode!");
  });

  it("executes ls command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "ls" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");
    expect(result.stdout).toContain("src");
  });

  it("executes pwd command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/\n");
  });

  it("executes grep command", async () => {
    // Write a multi-line file
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "data.txt",
          content: "apple\nbanana\ncherry\napricot\n",
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "grep ap data.txt" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("apple");
    expect(result.stdout).toContain("apricot");
    expect(result.stdout).not.toContain("banana");
  });

  it("reports command not found for unknown commands", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "npm install" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stderr: string;
    };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("renames a file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/rename`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldPath: "hello.txt",
          newPath: "greeting.txt",
        }),
      },
    );
    expect(res.status).toBe(200);

    // Old path gone
    const gone = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=hello.txt`,
    );
    expect(((await gone.json()) as { exists: boolean }).exists).toBe(false);

    // New path exists
    const exists = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=greeting.txt`,
    );
    expect(((await exists.json()) as { exists: boolean }).exists).toBe(true);
  });

  it("deletes a file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/unlink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "data.txt" }),
      },
    );
    expect(res.status).toBe(200);

    const exists = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=data.txt`,
    );
    expect(((await exists.json()) as { exists: boolean }).exists).toBe(false);
  });

  it("lists processes", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/process/list`,
    );
    expect(res.status).toBe(200);
    const processes = (await res.json()) as Array<{
      pid: number;
      command: string;
    }>;
    expect(processes.length).toBeGreaterThan(0);
  });

  it("lists workspaces via API", async () => {
    const res = await SELF.fetch("http://localhost/api/workspaces");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { workspaces: string[] };
    expect(Array.isArray(data.workspaces)).toBe(true);
  });

  // -- Container integration tests (no real container in vitest) --

  it("returns container status", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/container/status`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("stopped");
  });

  it("non-builtin command falls back gracefully without container", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "node --version" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stderr: string;
    };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
    expect(result.stderr).toContain("node");
  });

  it("handles index invalidation with valid paths", async () => {
    // Write a file first so it exists in R2
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "sync-test.txt", content: "synced" }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/index-invalidate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["sync-test.txt"] }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { refreshed: number };
    expect(data.refreshed).toBe(1);
  });

  it("handles index invalidation with non-existent paths", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/index-invalidate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["no-such-file.txt"] }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { refreshed: number };
    expect(data.refreshed).toBe(0);
  });

  it("rejects index invalidation with invalid body", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/index-invalidate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: "not-an-array" }),
      },
    );
    expect(res.status).toBe(400);
  });
});
