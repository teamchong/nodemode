import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createHelpers } from "./helpers";

describe("nodemode", () => {
  const workspaceId = "test-workspace";
  const {
    init,
    exec,
    execRaw,
    writeFile,
    readFile,
    stat,
    statRaw,
    readdir,
    exists,
    unlink,
    rename,
    mkdir,
    listProcesses,
    getProcess,
  } = createHelpers(workspaceId);

  it("returns landing page on root", async () => {
    const res = await SELF.fetch("http://localhost/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("nodemode");
  });

  it("initializes a workspace", async () => {
    const res = await init("test", "my-workspace");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("initialized");
  });

  it("writes and reads a file", async () => {
    const writeRes = await writeFile("hello.txt", "Hello, nodemode!");
    expect(writeRes.status).toBe(200);

    const data = await readFile("hello.txt");
    expect(data.content).toBe("Hello, nodemode!");
  });

  it("stats a file", async () => {
    const s = await stat("hello.txt");
    expect(s.size).toBe(16);
    expect(s.isDirectory).toBe(false);
  });

  it("checks file existence", async () => {
    expect(await exists("hello.txt")).toBe(true);
    expect(await exists("nope.txt")).toBe(false);
  });

  it("creates directories", async () => {
    const res = await mkdir("src/lib");
    expect(res.status).toBe(200);
  });

  it("lists directory contents", async () => {
    await writeFile("src/index.ts", 'console.log("hello");');

    const entries = await readdir("src");
    const names = entries.map((e) => e.name);
    expect(names).toContain("index.ts");
    expect(names).toContain("lib");
  });

  it("executes echo command", async () => {
    const result = await exec("echo hello world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("executes cat command", async () => {
    const result = await exec("cat hello.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello, nodemode!");
  });

  it("executes ls command", async () => {
    const result = await exec("ls");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");
    expect(result.stdout).toContain("src");
  });

  it("executes pwd command", async () => {
    const result = await exec("pwd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/\n");
  });

  it("executes grep command", async () => {
    await writeFile("data.txt", "apple\nbanana\ncherry\napricot\n");

    const result = await exec("grep ap data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("apple");
    expect(result.stdout).toContain("apricot");
    expect(result.stdout).not.toContain("banana");
  });

  it("reports command not found for unknown commands", async () => {
    const result = await exec("npm install");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("renames a file", async () => {
    const res = await rename("hello.txt", "greeting.txt");
    expect(res.status).toBe(200);

    expect(await exists("hello.txt")).toBe(false);
    expect(await exists("greeting.txt")).toBe(true);
  });

  it("deletes a file", async () => {
    const res = await unlink("data.txt");
    expect(res.status).toBe(200);

    expect(await exists("data.txt")).toBe(false);
  });

  it("lists processes", async () => {
    const processes = await listProcesses();
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
    const result = await exec("node --version");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
    expect(result.stderr).toContain("node");
  });

  it("handles index invalidation with valid paths", async () => {
    await writeFile("sync-test.txt", "synced");

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
    const result = await exec("echo hello world | grep hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  it("executes piped commands (cat file | head)", async () => {
    await writeFile("lines.txt", "line1\nline2\nline3\nline4\nline5\n");

    const result = await exec("cat lines.txt | head -n 2");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).not.toContain("line3");
  });

  it("executes chained commands with &&", async () => {
    const result = await exec("echo first && echo second");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
  });

  it("stops chain on && when first command fails", async () => {
    const result = await exec("cat nonexistent.txt && echo should-not-appear");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("should-not-appear");
  });

  it("executes ; chain regardless of exit code", async () => {
    const result = await exec("echo first; echo second");
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
    const trueResult = await exec("true");
    expect(trueResult.exitCode).toBe(0);

    const falseResult = await exec("false");
    expect(falseResult.exitCode).toBe(1);
  });

  it("executes head command", async () => {
    await writeFile(
      "numbers.txt",
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n",
    );

    const result = await exec("head -n 3 numbers.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1");
    expect(result.stdout).toContain("3");
    expect(result.stdout).not.toContain("4");
  });

  it("executes tail command", async () => {
    const result = await exec("tail -n 2 numbers.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("12");
  });

  it("executes wc command", async () => {
    await writeFile("wc-test.txt", "hello world\nfoo bar\n");

    const result = await exec("wc wc-test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2"); // 2 lines
    expect(result.stdout).toContain("4"); // 4 words
    expect(result.stdout).toContain("wc-test.txt");
  });

  it("executes which command", async () => {
    const result = await exec("which echo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/usr/bin/echo");

    // Unknown command
    const result2 = await exec("which nonexistent");
    expect(result2.exitCode).toBe(1);
    expect(result2.stderr).toContain("not found");
  });

  it("executes basename and dirname", async () => {
    const bnResult = await exec("basename /foo/bar/baz.txt");
    expect(bnResult.exitCode).toBe(0);
    expect(bnResult.stdout).toBe("baz.txt\n");

    const dnResult = await exec("dirname /foo/bar/baz.txt");
    expect(dnResult.exitCode).toBe(0);
    expect(dnResult.stdout).toBe("/foo/bar\n");
  });

  it("executes whoami and date", async () => {
    const whoResult = await exec("whoami");
    expect(whoResult.exitCode).toBe(0);
    expect(whoResult.stdout).toContain("nodemode");

    const dateResult = await exec("date");
    expect(dateResult.exitCode).toBe(0);
    // ISO date format
    expect(dateResult.stdout).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("executes printf and sleep", async () => {
    const printfResult = await exec("printf hello");
    expect(printfResult.exitCode).toBe(0);
    expect(printfResult.stdout).toBe("hello");

    const sleepResult = await exec("sleep 1");
    expect(sleepResult.exitCode).toBe(0);
  });

  it("executes test command", async () => {
    // test -f on existing file
    expect((await exec("test -f greeting.txt")).exitCode).toBe(0);

    // test -f on nonexistent
    expect((await exec("test -f nope.txt")).exitCode).toBe(1);

    // test -d on directory
    expect((await exec("test -d src")).exitCode).toBe(0);

    // test -e on existing
    expect((await exec("test -e greeting.txt")).exitCode).toBe(0);

    // test -z on empty string
    expect((await exec("test -z")).exitCode).toBe(0);

    // test -n on non-empty string
    expect((await exec("test -n hello")).exitCode).toBe(0);
  });

  it("executes touch, cp, and mv via exec", async () => {
    // touch new file
    await exec("touch newfile.txt");
    expect(await exists("newfile.txt")).toBe(true);

    // cp
    await writeFile("original.txt", "original content");
    await exec("cp original.txt copied.txt");
    expect((await readFile("copied.txt")).content).toBe("original content");

    // mv
    await exec("mv copied.txt moved.txt");
    expect(await exists("moved.txt")).toBe(true);
    expect(await exists("copied.txt")).toBe(false);
  });

  it("executes rm command", async () => {
    await writeFile("to-delete.txt", "bye");
    await exec("rm to-delete.txt");
    expect(await exists("to-delete.txt")).toBe(false);
  });

  it("executes mkdir via exec", async () => {
    const result = await exec("mkdir -p deep/nested/dir");
    expect(result.exitCode).toBe(0);

    expect((await exec("test -d deep/nested/dir")).exitCode).toBe(0);
  });

  it("executes ls -l with long format", async () => {
    const result = await exec("ls -l");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rwxr-xr-x");
    expect(result.stdout).toContain("nodemode");
  });

  it("executes grep -i for case insensitive", async () => {
    await writeFile("case.txt", "Hello\nhello\nHELLO\nworld\n");

    const result = await exec("grep -i hello case.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello");
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("HELLO");
    expect(result.stdout).not.toContain("world");
  });

  // -- Pipe and chain edge cases --

  it("pipes echo | wc", async () => {
    const result = await exec("echo hello world | wc");
    expect(result.exitCode).toBe(0);
    // "hello world\n" = 1 line, 2 words
    expect(result.stdout).toContain("1");
    expect(result.stdout).toContain("2");
  });

  it("pipes echo | tail", async () => {
    const result = await exec("echo a b c | cat");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a b c");
  });

  it("executes || operator (runs second on failure)", async () => {
    const result = await exec("cat nonexistent.txt || echo fallback");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fallback");
  });

  it("executes || operator (skips second on success)", async () => {
    const result = await exec("echo success || echo should-not-run");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("success");
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("handles quoted strings in commands", async () => {
    const result = await exec('echo "hello world"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("handles single-quoted strings", async () => {
    const result = await exec("echo 'hello world'");
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
    const res = await statRaw("no-such-file.txt");
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
    const result = await exec("cat nope-not-here.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("rm returns error for nonexistent file", async () => {
    const result = await exec("rm ghost-file.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("head returns error for nonexistent file", async () => {
    const result = await exec("head ghost.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("cp returns error for missing operand", async () => {
    const result = await exec("cp only-one-arg");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing operand");
  });

  it("ls returns error for nonexistent directory", async () => {
    const result = await exec("ls /no-such-dir");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  // -- Process tracking --

  it("gets a specific process by pid", async () => {
    await exec("echo find-me");

    const processes = await listProcesses();
    const found = processes.find((p) => p.command === "echo find-me");
    expect(found).toBeDefined();

    const proc = await getProcess(found!.pid);
    expect(proc.command).toBe("echo find-me");
    expect((proc as any).status).toBe("done");
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
    const res = await init("test2", "second");
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
    await writeFile("stream-test.txt", "streaming content here");

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
    const result = await exec("env", { env: { FOO: "bar", NODE_ENV: "test" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("NODE_ENV=test");
  });
});
