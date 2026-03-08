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

  it("handles container stop when not running", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/container/stop`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("stopped");
  });

  // -- Shell operator tests --

  it("executes piped commands (echo | grep)", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello world | grep hello" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  it("executes piped commands (cat file | head)", async () => {
    // Write a multi-line file first
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "lines.txt",
          content: "line1\nline2\nline3\nline4\nline5\n",
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "cat lines.txt | head -n 2" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).not.toContain("line3");
  });

  it("executes chained commands with &&", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo first && echo second" }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
  });

  it("stops chain on && when first command fails", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "cat nonexistent.txt && echo should-not-appear",
        }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("should-not-appear");
  });

  it("executes ; chain regardless of exit code", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "echo first; echo second",
        }),
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
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

  // -- Builtin command tests --

  it("executes true and false commands", async () => {
    const trueRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "true" }),
      },
    );
    const trueResult = (await trueRes.json()) as { exitCode: number };
    expect(trueResult.exitCode).toBe(0);

    const falseRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "false" }),
      },
    );
    const falseResult = (await falseRes.json()) as { exitCode: number };
    expect(falseResult.exitCode).toBe(1);
  });

  it("executes head command", async () => {
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "numbers.txt",
          content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n",
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "head -n 3 numbers.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1");
    expect(result.stdout).toContain("3");
    expect(result.stdout).not.toContain("4");
  });

  it("executes tail command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "tail -n 2 numbers.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("12");
  });

  it("executes wc command", async () => {
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "wc-test.txt",
          content: "hello world\nfoo bar\n",
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "wc wc-test.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2"); // 2 lines
    expect(result.stdout).toContain("4"); // 4 words
    expect(result.stdout).toContain("wc-test.txt");
  });

  it("executes which command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "which echo" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/usr/bin/echo");

    // Unknown command
    const res2 = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "which nonexistent" }),
      },
    );
    const result2 = (await res2.json()) as { exitCode: number; stderr: string };
    expect(result2.exitCode).toBe(1);
    expect(result2.stderr).toContain("not found");
  });

  it("executes basename and dirname", async () => {
    const bnRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "basename /foo/bar/baz.txt" }),
      },
    );
    const bnResult = (await bnRes.json()) as { exitCode: number; stdout: string };
    expect(bnResult.exitCode).toBe(0);
    expect(bnResult.stdout).toBe("baz.txt\n");

    const dnRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "dirname /foo/bar/baz.txt" }),
      },
    );
    const dnResult = (await dnRes.json()) as { exitCode: number; stdout: string };
    expect(dnResult.exitCode).toBe(0);
    expect(dnResult.stdout).toBe("/foo/bar\n");
  });

  it("executes whoami and date", async () => {
    const whoRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "whoami" }),
      },
    );
    const whoResult = (await whoRes.json()) as { exitCode: number; stdout: string };
    expect(whoResult.exitCode).toBe(0);
    expect(whoResult.stdout).toContain("nodemode");

    const dateRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "date" }),
      },
    );
    const dateResult = (await dateRes.json()) as { exitCode: number; stdout: string };
    expect(dateResult.exitCode).toBe(0);
    // ISO date format
    expect(dateResult.stdout).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("executes printf and sleep", async () => {
    const printfRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "printf hello" }),
      },
    );
    const printfResult = (await printfRes.json()) as { exitCode: number; stdout: string };
    expect(printfResult.exitCode).toBe(0);
    expect(printfResult.stdout).toBe("hello");

    const sleepRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "sleep 1" }),
      },
    );
    const sleepResult = (await sleepRes.json()) as { exitCode: number };
    expect(sleepResult.exitCode).toBe(0);
  });

  it("executes test command", async () => {
    // test -f on existing file
    const testFile = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -f greeting.txt" }),
      },
    );
    expect(((await testFile.json()) as { exitCode: number }).exitCode).toBe(0);

    // test -f on nonexistent
    const testNo = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -f nope.txt" }),
      },
    );
    expect(((await testNo.json()) as { exitCode: number }).exitCode).toBe(1);

    // test -d on directory
    const testDir = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -d src" }),
      },
    );
    expect(((await testDir.json()) as { exitCode: number }).exitCode).toBe(0);

    // test -e on existing
    const testExists = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -e greeting.txt" }),
      },
    );
    expect(((await testExists.json()) as { exitCode: number }).exitCode).toBe(0);

    // test -z on empty string
    const testZ = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -z" }),
      },
    );
    expect(((await testZ.json()) as { exitCode: number }).exitCode).toBe(0);

    // test -n on non-empty string
    const testN = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -n hello" }),
      },
    );
    expect(((await testN.json()) as { exitCode: number }).exitCode).toBe(0);
  });

  it("executes touch, cp, and mv via exec", async () => {
    // touch new file
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "touch newfile.txt" }),
      },
    );
    const exists = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=newfile.txt`,
    );
    expect(((await exists.json()) as { exists: boolean }).exists).toBe(true);

    // cp
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "original.txt", content: "original content" }),
      },
    );
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "cp original.txt copied.txt" }),
      },
    );
    const readCopy = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "copied.txt" }),
      },
    );
    expect(((await readCopy.json()) as { content: string }).content).toBe("original content");

    // mv
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "mv copied.txt moved.txt" }),
      },
    );
    const movedExists = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=moved.txt`,
    );
    expect(((await movedExists.json()) as { exists: boolean }).exists).toBe(true);
    const copiedGone = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=copied.txt`,
    );
    expect(((await copiedGone.json()) as { exists: boolean }).exists).toBe(false);
  });

  it("executes rm command", async () => {
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "to-delete.txt", content: "bye" }),
      },
    );

    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "rm to-delete.txt" }),
      },
    );

    const exists = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/exists?path=to-delete.txt`,
    );
    expect(((await exists.json()) as { exists: boolean }).exists).toBe(false);
  });

  it("executes mkdir via exec", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "mkdir -p deep/nested/dir" }),
      },
    );
    const result = (await res.json()) as { exitCode: number };
    expect(result.exitCode).toBe(0);

    const testDir = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "test -d deep/nested/dir" }),
      },
    );
    expect(((await testDir.json()) as { exitCode: number }).exitCode).toBe(0);
  });

  it("executes ls -l with long format", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "ls -l" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rwxr-xr-x");
    expect(result.stdout).toContain("nodemode");
  });

  it("executes grep -i for case insensitive", async () => {
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "case.txt",
          content: "Hello\nhello\nHELLO\nworld\n",
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "grep -i hello case.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello");
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("HELLO");
    expect(result.stdout).not.toContain("world");
  });

  // -- Pipe and chain edge cases --

  it("pipes echo | wc", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello world | wc" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    // "hello world\n" = 1 line, 2 words
    expect(result.stdout).toContain("1");
    expect(result.stdout).toContain("2");
  });

  it("pipes echo | tail", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo a b c | cat" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a b c");
  });

  it("executes || operator (runs second on failure)", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "cat nonexistent.txt || echo fallback",
        }),
      },
    );
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fallback");
  });

  it("executes || operator (skips second on success)", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "echo success || echo should-not-run",
        }),
      },
    );
    const result = (await res.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("success");
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("handles quoted strings in commands", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: 'echo "hello world"' }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("handles single-quoted strings", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo 'hello world'" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  // -- Validation tests --

  it("rejects path traversal attempts", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../../../etc/passwd" }),
      },
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("traversal");
  });

  it("rejects null bytes in path", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test\0file.txt" }),
      },
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("null");
  });

  it("rejects empty command", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid workspace ID", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/!invalid@id/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hi" }),
      },
    );
    expect(res.status).toBe(400);
  });

  // -- Error handling tests --

  it("returns 404 for unknown routes", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/nonexistent`,
    );
    expect(res.status).toBe(404);
  });

  it("returns error for stat on nonexistent file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/stat?path=no-such-file.txt`,
    );
    expect(res.status).toBe(404);
  });

  it("returns error for reading nonexistent file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "definitely-not-here.txt" }),
      },
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("ENOENT");
  });

  it("cat returns error for nonexistent file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "cat nope-not-here.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("rm returns error for nonexistent file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "rm ghost-file.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("head returns error for nonexistent file", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "head ghost.txt" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("cp returns error for missing operand", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "cp only-one-arg" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing operand");
  });

  it("ls returns error for nonexistent directory", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "ls /no-such-dir" }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  // -- Process tracking --

  it("gets a specific process by pid", async () => {
    // Run a command first
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo find-me" }),
      },
    );

    // List processes and get the latest pid
    const listRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/process/list`,
    );
    const processes = (await listRes.json()) as Array<{
      pid: number;
      command: string;
    }>;
    const found = processes.find((p) => p.command === "echo find-me");
    expect(found).toBeDefined();

    // Get by pid
    const getRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/process/get?pid=${found!.pid}`,
    );
    expect(getRes.status).toBe(200);
    const proc = (await getRes.json()) as {
      pid: number;
      command: string;
      status: string;
      stdout: string;
    };
    expect(proc.command).toBe("echo find-me");
    expect(proc.status).toBe("done");
    expect(proc.stdout).toBe("find-me\n");
  });

  it("returns 404 for nonexistent process", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/process/get?pid=999999`,
    );
    expect(res.status).toBe(404);
  });

  // -- Workspace init edge case --

  it("returns already_initialized on second init", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/init`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test2", name: "second" }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("already_initialized");
  });

  it("rejects init with missing fields", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/fresh-workspace/init`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "test" }),
      },
    );
    expect(res.status).toBe(400);
  });

  // -- CORS --

  it("handles CORS preflight", async () => {
    const res = await SELF.fetch("http://localhost/workspace/test/exec", {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  // -- Streaming read --

  it("reads file in streaming mode", async () => {
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "stream-test.txt",
          content: "streaming content here",
        }),
      },
    );

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "stream-test.txt", stream: true }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const text = await res.text();
    expect(text).toBe("streaming content here");
  });

  // -- Env command --

  it("executes env command with env vars", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "env",
          env: { FOO: "bar", NODE_ENV: "test" },
        }),
      },
    );
    const result = (await res.json()) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("NODE_ENV=test");
  });
});
