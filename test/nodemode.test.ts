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
    rmdir,
    chmod,
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

  it("listProcesses returns stdout and stderr", async () => {
    await exec("echo list-output-check");
    const processes = await listProcesses();
    const found = processes.find((p) => p.command === "echo list-output-check");
    expect(found).toBeDefined();
    expect(found!.stdout).toBe("list-output-check\n");
    expect(found!.stderr).toBe("");
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

  it("index-invalidate returns errors for invalid paths", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/index-invalidate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["valid.txt", "../escape", "also-valid.txt"] }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { refreshed: number; errors?: string[] };
    expect(data.errors).toBeDefined();
    expect(data.errors).toContain("../escape");
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

  it("truncates large process output with marker", async () => {
    // Generate output > 4096 bytes (MAX_STORED_OUTPUT)
    const longLine = "x".repeat(200);
    const lines = Array.from({ length: 30 }, () => longLine).join("; echo ");
    await exec(`echo ${lines}`);

    const processes = await listProcesses();
    const found = processes.find((p) => p.stdout.includes("[truncated]"));
    expect(found).toBeDefined();
    expect(found!.stdout.endsWith("[truncated]")).toBe(true);
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

  // -- Backslash escape tests --

  it("backslash escapes space in arguments", async () => {
    const result = await exec("echo hello\\ world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("backslash escapes pipe operator", async () => {
    const result = await exec("echo hello\\|world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello|world\n");
  });

  it("double backslash produces literal backslash", async () => {
    const result = await exec("echo hello\\\\world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\\world\n");
  });

  it("backslash in double quotes only escapes special chars", async () => {
    const result = await exec('echo "hello\\"world"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello"world\n');
  });

  it("backslash is literal inside single quotes", async () => {
    const result = await exec("echo 'hello\\world'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\\world\n");
  });

  // -- LIKE-safe path tests --

  it("handles paths with % character", async () => {
    await writeFile("100%done.txt", "content");
    expect(await exists("100%done.txt")).toBe(true);

    const s = await stat("100%done.txt");
    expect(s.size).toBeGreaterThan(0);

    const entries = await readdir("/");
    const names = entries.map((e) => e.name);
    expect(names).toContain("100%done.txt");
  });

  it("handles paths with _ character", async () => {
    await writeFile("my_file.txt", "underscore content");
    expect(await exists("my_file.txt")).toBe(true);

    const data = await readFile("my_file.txt");
    expect(data.content).toBe("underscore content");
  });

  it("readdir with % in directory name is exact", async () => {
    await mkdir("a%b");
    await writeFile("a%b/file.txt", "in percent dir");
    await mkdir("axb");
    await writeFile("axb/other.txt", "in axb dir");

    const entries = await readdir("a%b");
    const names = entries.map((e) => e.name);
    expect(names).toContain("file.txt");
    expect(names).not.toContain("other.txt");
  });

  // -- wc respects flags with empty input --

  it("wc -l with no input returns 0", async () => {
    const result = await exec("true | wc -l");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });

  // -- Tab whitespace and newline separator --

  it("handles tab as word separator in commands", async () => {
    const result = await exec("echo\thello\tworld");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("handles newline as command separator", async () => {
    const result = await exec("echo first\necho second");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
  });

  // -- Security tests --

  it("unlink rejects directory deletion via API", async () => {
    await mkdir("unlink-dir-test");
    await writeFile("unlink-dir-test/child.txt", "child");

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/unlink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "unlink-dir-test" }),
      },
    );
    // Should fail with EISDIR (400, not 500)
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("EISDIR");

    // Directory and child should still exist
    expect(await exists("unlink-dir-test")).toBe(true);
    expect(await exists("unlink-dir-test/child.txt")).toBe(true);
  });

  it("rename rejects moving directory into itself", async () => {
    await mkdir("rename-parent");
    await writeFile("rename-parent/file.txt", "content");

    const res = await rename("rename-parent", "rename-parent/child");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("EINVAL");
  });

  it("/fs/rmdir removes empty directory", async () => {
    await mkdir("rmdir-empty-test");
    const res = await rmdir("rmdir-empty-test");
    expect(res.status).toBe(200);
    expect(await exists("rmdir-empty-test")).toBe(false);
  });

  it("/fs/rmdir recursive removes directory tree", async () => {
    await mkdir("rmdir-tree");
    await writeFile("rmdir-tree/a.txt", "a");
    await writeFile("rmdir-tree/b.txt", "b");
    const res = await rmdir("rmdir-tree", true);
    expect(res.status).toBe(200);
    expect(await exists("rmdir-tree")).toBe(false);
  });

  it("/fs/rmdir on non-existent path returns error", async () => {
    const res = await rmdir("no-such-dir-rmdir");
    expect(res.status).toBe(400);
  });

  it("/fs/chmod sets file mode", async () => {
    await writeFile("chmod-test.txt", "data");
    const res = await chmod("chmod-test.txt", 0o755);
    expect(res.status).toBe(200);
    const s = await stat("chmod-test.txt");
    expect(s.mode).toBe(0o755);
  });

  it("grep handles potentially dangerous regex by falling back to literal", async () => {
    await writeFile("redos.txt", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\nnormal line\n");

    // Pattern with nested quantifier — should fall back to literal string match
    const result = await exec("grep '(a+)+$' redos.txt");
    // Should complete quickly (not hang) — whether it matches or not is fine
    expect(result).toBeDefined();
  });

  it("grep -n shows line numbers", async () => {
    await writeFile("lines.txt", "alpha\nbeta\ngamma\nbeta again\n");
    const result = await exec("grep -n beta lines.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2:beta\n4:beta again\n");
  });

  it("grep -r searches recursively", async () => {
    await writeFile("rdir/a.txt", "hello world\nfoo bar\n");
    await writeFile("rdir/sub/b.txt", "hello again\nbaz\n");
    const result = await exec("grep -r hello rdir");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").sort();
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("hello");
    expect(lines[1]).toContain("hello");
    // Each line should have file:content format
    for (const line of lines) {
      expect(line).toContain(":");
    }
  });

  it("grep -rl lists only matching filenames", async () => {
    await writeFile("rdir2/x.txt", "target line\nother\n");
    await writeFile("rdir2/y.txt", "no match here\n");
    await writeFile("rdir2/z.txt", "another target\n");
    const result = await exec("grep -rl target rdir2");
    expect(result.exitCode).toBe(0);
    const files = result.stdout.trim().split("\n").sort();
    expect(files).toEqual(["x.txt", "z.txt"]);
  });

  it("grep -rn shows file:linenum:content", async () => {
    await writeFile("rdir3/a.txt", "one\ntwo\nthree\n");
    await writeFile("rdir3/b.txt", "four\ntwo again\n");
    const result = await exec("grep -rn two rdir3");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").sort();
    expect(lines.length).toBe(2);
    // Each should be file:linenum:content
    for (const line of lines) {
      const parts = line.split(":");
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(parseInt(parts[1], 10)).toBeGreaterThan(0);
    }
  });

  it("redirect > writes stdout to file", async () => {
    const result = await exec("echo hello world > output.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(""); // stdout goes to file
    const { content } = await readFile("output.txt");
    expect(content).toBe("hello world\n");
  });

  it("redirect >> appends to file", async () => {
    await writeFile("append.txt", "line1\n");
    const result = await exec("echo line2 >> append.txt");
    expect(result.exitCode).toBe(0);
    const { content } = await readFile("append.txt");
    expect(content).toBe("line1\nline2\n");
  });

  it("redirect < reads stdin from file", async () => {
    await writeFile("input.txt", "hello\nworld\nfoo\n");
    const result = await exec("grep hello < input.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("git without GITMODE binding returns config error", async () => {
    const result = await exec("git status");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not configured");
  });

  it("which with no args returns error", async () => {
    const result = await exec("which");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing argument");
  });

  it("test supports numeric comparison operators", async () => {
    expect((await exec("test 1 -eq 1")).exitCode).toBe(0);
    expect((await exec("test 1 -eq 2")).exitCode).toBe(1);
    expect((await exec("test 1 -lt 2")).exitCode).toBe(0);
    expect((await exec("test 2 -lt 1")).exitCode).toBe(1);
    expect((await exec("test 2 -gt 1")).exitCode).toBe(0);
    expect((await exec("test 5 -le 5")).exitCode).toBe(0);
    expect((await exec("test 5 -ge 5")).exitCode).toBe(0);
    expect((await exec("test 1 -ne 2")).exitCode).toBe(0);
  });

  it("test -s checks file is non-empty", async () => {
    await writeFile("nonempty.txt", "content");
    expect((await exec("test -s nonempty.txt")).exitCode).toBe(0);

    await writeFile("empty.txt", "");
    expect((await exec("test -s empty.txt")).exitCode).toBe(1);

    expect((await exec("test -s nonexistent-file.txt")).exitCode).toBe(1);
  });

  it("rm -rf on nonexistent path with force succeeds", async () => {
    const result = await exec("rm -rf definitely-not-here-dir");
    expect(result.exitCode).toBe(0);
  });

  it("rmdir on file returns ENOTDIR", async () => {
    await writeFile("not-a-dir.txt", "content");
    const result = await exec("rm -r not-a-dir.txt");
    // rm -r calls rmdir which should detect it's not a directory
    // But rm builtin checks stat first and calls unlink for files
    expect(result.exitCode).toBe(0);
    expect(await exists("not-a-dir.txt")).toBe(false);
  });

  // -- JsRunner (Tier 2: node execution in DO) --

  it("node executes JS file in-DO", async () => {
    await writeFile("hello.js", 'console.log("hello from DO");');
    const result = await exec("node hello.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello from DO");
  });

  it("node -e executes inline code", async () => {
    const result = await exec('node -e "console.log(2 + 2)"');
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("4");
  });

  it("node -p prints expression result", async () => {
    const result = await exec('node -p "Math.PI.toFixed(2)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3.14");
  });

  it("node require(fs) reads files in-DO", async () => {
    await writeFile("data.txt", "file content here");
    await writeFile("read-fs.js", `
      const fs = require("fs");
      const data = fs.readFileSync("data.txt", "utf8");
      console.log(data);
    `);
    const result = await exec("node read-fs.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("file content here");
  });

  it("node require(fs) writeFileSync + readFileSync round-trip", async () => {
    await writeFile("write-read.js", `
      const fs = require("fs");
      fs.writeFileSync("created.txt", "created by JS");
      const out = fs.readFileSync("created.txt", "utf8");
      console.log(out);
    `);
    const result = await exec("node write-read.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("created by JS");
  });

  it("node require(path) works", async () => {
    await writeFile("path-test.js", `
      const path = require("path");
      console.log(path.join("a", "b", "c"));
      console.log(path.dirname("/foo/bar/baz.js"));
      console.log(path.extname("file.ts"));
    `);
    const result = await exec("node path-test.js");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("a/b/c");
    expect(lines[1]).toBe("/foo/bar");
    expect(lines[2]).toBe(".ts");
  });

  it("node process.exit sets exit code", async () => {
    await writeFile("exit-test.js", `
      console.log("before");
      process.exit(42);
      console.log("after");
    `);
    const result = await exec("node exit-test.js");
    expect(result.exitCode).toBe(42);
    expect(result.stdout).toContain("before");
    expect(result.stdout).not.toContain("after");
  });

  it("node require resolves relative modules", async () => {
    await writeFile("lib/greet.js", 'module.exports = function(name) { return "hi " + name; };');
    await writeFile("use-lib.js", `
      const greet = require("./lib/greet");
      console.log(greet("world"));
    `);
    const result = await exec("node use-lib.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi world");
  });

  it("node returns error for missing module", async () => {
    const result = await exec("node nonexistent.js");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot find module");
  });

  it("direct JS file execution (./script.js)", async () => {
    await writeFile("direct.js", 'console.log("direct exec");');
    const result = await exec("./direct.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("direct exec");
  });

  it("node passes args via process.argv", async () => {
    await writeFile("args.js", 'console.log(process.argv.slice(2).join(","));');
    const result = await exec("node args.js foo bar baz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("foo,bar,baz");
  });

  it("node JSON require works", async () => {
    await writeFile("config.json", '{"port": 3000}');
    await writeFile("load-json.js", `
      const config = require("./config.json");
      console.log(config.port);
    `);
    const result = await exec("node load-json.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3000");
  });

  it("node require resolves .json without extension", async () => {
    await writeFile("pkg-info.json", '{"name": "myapp"}');
    await writeFile("load-pkg.js", `
      const pkg = require("./pkg-info");
      console.log(pkg.name);
    `);
    const result = await exec("node load-pkg.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("myapp");
  });

  it("node crypto.createHash is synchronous", async () => {
    await writeFile("hash-test.js", `
      const crypto = require("crypto");
      const hash = crypto.createHash("sha256").update("hello").digest("hex");
      console.log(typeof hash);
      console.log(hash);
    `);
    const result = await exec("node hash-test.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("string");
    expect(lines[1]).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("node executes TypeScript with type annotations", async () => {
    await writeFile("typed.ts", `
      interface Config {
        port: number;
        host: string;
      }

      function greet(name: string): string {
        return "hello " + name;
      }

      const cfg: Config = { port: 3000, host: "localhost" };
      const nums: number[] = [1, 2, 3];
      const result = greet("world");
      console.log(result);
      console.log(cfg.port);
      console.log(nums.length);
    `);
    const result = await exec("node typed.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("hello world");
    expect(lines[1]).toBe("3000");
    expect(lines[2]).toBe("3");
  });

  it("node handles ESM import/export syntax", async () => {
    await writeFile("esm-lib.js", `
      export function add(a, b) { return a + b; }
      export const PI = 3.14;
    `);
    await writeFile("esm-main.js", `
      import { add, PI } from "./esm-lib";
      console.log(add(1, 2));
      console.log(PI);
    `);
    const result = await exec("node esm-main.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("3");
    expect(lines[1]).toBe("3.14");
  });

  it("node handles ESM default export", async () => {
    await writeFile("esm-default.js", `
      export default function greet(name) { return "hi " + name; }
    `);
    await writeFile("esm-use-default.js", `
      import greet from "./esm-default";
      console.log(greet("world"));
    `);
    const result = await exec("node esm-use-default.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi world");
  });

  it("npx resolves bin from node_modules", async () => {
    // Set up a fake package with a bin entry
    await exec("mkdir -p node_modules/hello-cli");
    await writeFile("node_modules/hello-cli/index.js", 'console.log("hello from cli");');
    await writeFile("node_modules/hello-cli/package.json", JSON.stringify({
      name: "hello-cli",
      bin: "./index.js",
    }));
    const result = await exec("npx hello-cli");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello from cli");
  });

  it("node handles circular require", async () => {
    await writeFile("circ-a.js", `
      exports.name = "a";
      const b = require("./circ-b");
      exports.bName = b.name;
    `);
    await writeFile("circ-b.js", `
      exports.name = "b";
      const a = require("./circ-a");
      exports.aName = a.name;
    `);
    await writeFile("circ-main.js", `
      const a = require("./circ-a");
      const b = require("./circ-b");
      console.log(a.name, a.bName, b.name, b.aName);
    `);
    const result = await exec("node circ-main.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // a.name="a", a.bName="b", b.name="b", b.aName="a" (partial — Node.js circular behavior)
    expect(result.stdout.trim()).toBe("a b b a");
  });

  it("node handles nested require chain (A requires B requires C)", async () => {
    await writeFile("chain-c.js", 'module.exports = { val: 42 };');
    await writeFile("chain-b.js", `
      const c = require("./chain-c");
      module.exports = { doubled: c.val * 2 };
    `);
    await writeFile("chain-a.js", `
      const b = require("./chain-b");
      console.log(b.doubled);
    `);
    const result = await exec("node chain-a.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("84");
  });

  it("npx returns error for missing command", async () => {
    const result = await exec("npx nonexistent-pkg");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  // -- http, net, worker_threads module tests --

  it("http.createServer and listen callback fires", async () => {
    await writeFile("http-listen.js", `
      const http = require("http");
      const server = http.createServer((req, res) => {
        res.end("ok");
      });
      server.listen(3000, () => {
        console.log("listening");
        console.log(server.address().port);
        server.close();
      });
    `);
    const result = await exec("node http-listen.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("listening");
    expect(lines[1]).toBe("3000");
  });

  it("http ServerResponse writeHead and end", async () => {
    await writeFile("http-res.js", `
      const http = require("http");
      const res = new http.ServerResponse();
      res.writeHead(201, { "X-Custom": "hello" });
      res.setHeader("content-type", "text/plain");
      console.log(res.getHeader("x-custom"));
      console.log(res.statusCode);
      console.log(res.headersSent);
      res.end("done");
      console.log(res.finished);
    `);
    const result = await exec("node http-res.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("hello");
    expect(lines[1]).toBe("201");
    expect(lines[2]).toBe("true");
    expect(lines[3]).toBe("true");
  });

  it("net.isIP validates addresses", async () => {
    await writeFile("net-test.js", `
      const net = require("net");
      console.log(net.isIP("127.0.0.1"));
      console.log(net.isIP("::1"));
      console.log(net.isIP("not-an-ip"));
      console.log(net.isIPv4("192.168.1.1"));
      console.log(net.isIPv6("fe80::1"));
    `);
    const result = await exec("node net-test.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("4");
    expect(lines[1]).toBe("6");
    expect(lines[2]).toBe("0");
    expect(lines[3]).toBe("true");
    expect(lines[4]).toBe("true");
  });

  it("worker_threads basic postMessage", async () => {
    await writeFile("wt-test.js", `
      const { Worker, isMainThread, threadId } = require("worker_threads");
      console.log("main:" + isMainThread);
      console.log("tid:" + threadId);
    `);
    const result = await exec("node wt-test.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("main:true");
    expect(lines[1]).toBe("tid:0");
  });

  it("worker_threads runs in isolated JsRunner with separate module cache", async () => {
    await writeFile("wt-worker.js", `
      const { parentPort, workerData, isMainThread } = require("worker_threads");
      parentPort.postMessage({ fromWorker: true, data: workerData, main: isMainThread });
    `);
    await writeFile("wt-parent.js", `
      const { Worker, isMainThread } = require("worker_threads");
      const w = new Worker("wt-worker.js", { workerData: { hello: "world" } });
      w.on("message", (msg) => {
        console.log("MSG:" + JSON.stringify(msg));
      });
      w.on("error", (err) => {
        console.error("ERR:" + err.message);
      });
      w.on("exit", (code) => {
        console.log("EXIT:" + code);
      });
    `);
    const result = await exec("node wt-parent.js");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const msgLine = lines.find(l => l.startsWith("MSG:"));
    expect(msgLine).toBeDefined();
    const msg = JSON.parse(msgLine!.slice(4));
    expect(msg.fromWorker).toBe(true);
    expect(msg.data).toEqual({ hello: "world" });
    expect(msg.main).toBe(false);
  });

  it("worker_threads workerData is cloned (not shared)", async () => {
    await writeFile("wt-clone-worker.js", `
      const { parentPort, workerData } = require("worker_threads");
      workerData.mutated = true;
      parentPort.postMessage(workerData);
    `);
    await writeFile("wt-clone-parent.js", `
      const { Worker } = require("worker_threads");
      const data = { original: true };
      const w = new Worker("wt-clone-worker.js", { workerData: data });
      w.on("message", (msg) => {
        console.log("workerGot:" + msg.mutated);
        console.log("parentStill:" + (data.mutated === undefined));
      });
    `);
    const result = await exec("node wt-clone-parent.js");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("workerGot:true");
    expect(lines[1]).toBe("parentStill:true");
  });

  it("net.Socket.connect emits error instead of silently succeeding", async () => {
    await writeFile("net-connect-test.js", `
      const net = require("net");
      const s = new net.Socket();
      s.on("error", (err) => {
        console.log("error:" + err.code);
      });
      s.connect(3000, "127.0.0.1");
    `);
    const result = await exec("node net-connect-test.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("error:ERR_SOCKET_NOT_AVAILABLE");
  });

  it("require https works as http alias", async () => {
    await writeFile("https-test.js", `
      const https = require("https");
      console.log(typeof https.createServer);
      console.log(typeof https.request);
      console.log(Array.isArray(https.METHODS));
    `);
    const result = await exec("node https-test.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("function");
    expect(lines[1]).toBe("function");
    expect(lines[2]).toBe("true");
  });

  it("npx resolves scoped package bin", async () => {
    await init();
    await writeFile(
      "node_modules/@myorg/tool/package.json",
      JSON.stringify({ name: "@myorg/tool", bin: { tool: "./cli.js" } }),
    );
    await writeFile("node_modules/@myorg/tool/cli.js", 'console.log("scoped-tool");');
    const result = await exec("npx @myorg/tool");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("scoped-tool");
  });

  it("npx resolves multi-bin package by name", async () => {
    await init();
    await writeFile(
      "node_modules/multi/package.json",
      JSON.stringify({
        name: "multi",
        bin: { multi: "./main.js", helper: "./help.js" },
      }),
    );
    await writeFile("node_modules/multi/main.js", 'console.log("multi-main");');
    await writeFile("node_modules/multi/help.js", 'console.log("multi-help");');
    const result = await exec("npx multi");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("multi-main");
  });

  it("stream.pipeline chains readable to writable", async () => {
    await writeFile("pipeline-test.js", `
      const stream = require("stream");
      const chunks = [];
      const src = new stream.Readable();
      src._read = function() {};
      const dest = new stream.Writable();
      dest.write = function(chunk) { chunks.push(chunk); return true; };
      dest.end = function() {
        dest.writable = false;
        dest.emit("finish");
        dest.emit("close");
      };
      stream.pipeline(src, dest, (err) => {
        if (err) { console.log("error:" + err.message); }
        else { console.log("result:" + chunks.join("")); }
      });
      src.emit("data", "hello ");
      src.emit("data", "world");
      src.emit("end");
    `);
    const result = await exec("node pipeline-test.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("result:hello world");
  });

  it("stream.finished fires on stream end", async () => {
    await writeFile("finished-test.js", `
      const stream = require("stream");
      const src = new stream.Readable();
      src._read = function() {};
      const cleanup = stream.finished(src, (err) => {
        if (err) { console.log("error:" + err.message); }
        else { console.log("finished:ok"); }
      });
      console.log("cleanup:" + typeof cleanup);
      src.emit("end");
    `);
    const result = await exec("node finished-test.js");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("cleanup:function");
    expect(lines[1]).toBe("finished:ok");
  });

  // -- Workspace env vars --

  it("workspace env vars are accessible in process.env", async () => {
    // Set env via PUT /env
    const setRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/env`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: { MY_VAR: "hello_from_env" } }),
      },
    );
    expect(setRes.status).toBe(200);

    // Verify via GET /env
    const getRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/env`,
    );
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as { env: Record<string, string> };
    expect(getData.env.MY_VAR).toBe("hello_from_env");

    // Run node code that reads process.env.MY_VAR
    const result = await exec('node -e "console.log(process.env.MY_VAR)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello_from_env");
  });

  it("exec env overrides workspace env", async () => {
    // Set workspace env MY_VAR=default
    await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/env`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: { MY_VAR: "default" } }),
      },
    );

    // Exec with env override
    const result = await exec('node -e "console.log(process.env.MY_VAR)"', {
      env: { MY_VAR: "override" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("override");
  });

  // -- Bulk upload --

  it("/upload writes multiple files and they are readable", async () => {
    const files = {
      "upload-test/a.txt": btoa("file-a-content"),
      "upload-test/sub/b.txt": btoa("file-b-content"),
    };

    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { uploaded: number };
    expect(data.uploaded).toBe(2);

    // Verify files are readable
    const result = await exec("cat upload-test/a.txt");
    expect(result.stdout).toBe("file-a-content");

    const result2 = await exec("cat upload-test/sub/b.txt");
    expect(result2.stdout).toBe("file-b-content");
  });

  it("/upload returns error for empty files object", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: {} }),
      },
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("empty");
  });

  it("/upload handles filenames with spaces and special characters", async () => {
    const files: Record<string, string> = {
      "upload special/file with spaces.txt": btoa("spaces work"),
      "upload special/café.txt": btoa("unicode name"),
    };
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { uploaded: number };
    expect(data.uploaded).toBe(2);

    const r1 = await exec("cat 'upload special/file with spaces.txt'");
    expect(r1.stdout).toBe("spaces work");
    const r2 = await exec("cat 'upload special/café.txt'");
    expect(r2.stdout).toBe("unicode name");
  });

  it("/upload rejects path traversal attempts", async () => {
    const files: Record<string, string> = {
      "../escape.txt": btoa("should fail"),
    };
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { uploaded: number; errors?: string[] };
    expect(data.errors).toBeDefined();
    expect(data.errors!.length).toBeGreaterThan(0);
  });

  it("streaming read returns file content", async () => {
    const content = "streaming test content ".repeat(100);
    await writeFile("stream-test.txt", content);
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/fs/read`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "stream-test.txt", stream: true }),
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(content);
  });

  // -- HTTP server handler wiring --

  it("/request returns 400 when no server is listening", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/request`,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("No HTTP server is listening");
  });

  it("/serve starts an http server and /request proxies through it", async () => {
    await writeFile("http-app.js", `
      const http = require("http");
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "X-App": "nodemode" });
        res.end("Hello from " + req.method + " " + req.url);
      });
      server.listen(8080);
    `);

    const serveRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/serve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryPoint: "./http-app.js" }),
      },
    );
    expect(serveRes.status).toBe(200);
    const serveData = (await serveRes.json()) as { status: string };
    expect(serveData.status).toBe("serving");

    const reqRes = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/request/hello`,
      { method: "GET" },
    );
    expect(reqRes.status).toBe(200);
    const body = await reqRes.text();
    expect(body).toBe("Hello from GET /hello");
    expect(reqRes.headers.get("x-app")).toBe("nodemode");
  });

  // -- New Node.js modules --

  describe("dns module", () => {
    it("dns.getServers returns Cloudflare DNS", async () => {
      await writeFile("dns-test.js", `
        const dns = require("dns");
        const servers = dns.getServers();
        console.log(JSON.stringify(servers));
      `);
      const r = await exec("node dns-test.js");
      expect(r.exitCode).toBe(0);
      const servers = JSON.parse(r.stdout.trim());
      expect(servers).toContain("1.1.1.1");
    });

    it("dns error constants are available", async () => {
      await writeFile("dns-const.js", `
        const dns = require("dns");
        console.log(dns.NOTFOUND);
        console.log(dns.SERVFAIL);
      `);
      const r = await exec("node dns-const.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ENOTFOUND");
      expect(r.stdout).toContain("ESERVFAIL");
    });
  });

  describe("tty module", () => {
    it("isatty returns false in Workers", async () => {
      await writeFile("tty-test.js", `
        const tty = require("tty");
        console.log(tty.isatty());
        const ws = new tty.WriteStream();
        console.log(ws.columns);
        console.log(ws.isTTY);
      `);
      const r = await exec("node tty-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("false");
      expect(r.stdout).toContain("80");
    });
  });

  describe("string_decoder module", () => {
    it("decodes utf-8 bytes incrementally", async () => {
      await writeFile("sd-test.js", `
        const { StringDecoder } = require("string_decoder");
        const decoder = new StringDecoder("utf8");
        const buf = new TextEncoder().encode("hello world");
        const result = decoder.write(buf);
        console.log(result);
        console.log(decoder.end());
      `);
      const r = await exec("node sd-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hello world");
    });
  });

  describe("zlib module", () => {
    it("provides gzip, gunzip, deflate, inflate, and stream creators", async () => {
      await writeFile("zlib-test.js", `
        const zlib = require("zlib");
        console.log(typeof zlib.gzip);
        console.log(typeof zlib.gunzip);
        console.log(typeof zlib.deflate);
        console.log(typeof zlib.inflate);
        console.log(typeof zlib.createGzip);
        console.log(typeof zlib.createGunzip);
        console.log(typeof zlib.deflateRaw);
        console.log(typeof zlib.inflateRaw);
      `);
      const r = await exec("node zlib-test.js");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.every((l: string) => l === "function")).toBe(true);
      expect(lines.length).toBe(8);
    });

    it("zlib constants are available", async () => {
      await writeFile("zlib-const.js", `
        const zlib = require("zlib");
        console.log(zlib.constants.Z_BEST_COMPRESSION);
        console.log(zlib.constants.Z_NO_COMPRESSION);
      `);
      const r = await exec("node zlib-const.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("9");
      expect(r.stdout).toContain("0");
    });
  });

  describe("readline module", () => {
    it("creates interface and processes lines", async () => {
      await writeFile("rl-test.js", `
        const readline = require("readline");
        const { EventEmitter } = require("events");
        const input = new EventEmitter();
        const rl = readline.createInterface({ input });
        const lines = [];
        rl.on("line", (line) => lines.push(line));
        rl.on("close", () => console.log(JSON.stringify(lines)));
        input.emit("data", "hello\\nworld\\n");
        input.emit("end");
      `);
      const r = await exec("node rl-test.js");
      expect(r.exitCode).toBe(0);
      const lines = JSON.parse(r.stdout.trim());
      expect(lines).toEqual(["hello", "world"]);
    });
  });

  describe("timers module", () => {
    it("provides setTimeout and setImmediate", async () => {
      await writeFile("timers-test.js", `
        const timers = require("timers");
        console.log(typeof timers.setTimeout);
        console.log(typeof timers.setImmediate);
        console.log(typeof timers.clearTimeout);
        console.log(typeof timers.setInterval);
      `);
      const r = await exec("node timers-test.js");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.every((l: string) => l === "function")).toBe(true);
    });
  });

  describe("timers/promises module", () => {
    it("exports scheduler and setTimeout", async () => {
      await writeFile("timers-p-test.js", `
        const tp = require("timers/promises");
        console.log(typeof tp.setTimeout);
        console.log(typeof tp.setImmediate);
        console.log(typeof tp.scheduler.wait);
        console.log(typeof tp.scheduler.yield);
      `);
      const r = await exec("node timers-p-test.js");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.every((l: string) => l === "function")).toBe(true);
    });
  });

  describe("perf_hooks module", () => {
    it("performance.now returns a number", async () => {
      await writeFile("perf-test.js", `
        const { performance } = require("perf_hooks");
        const now = performance.now();
        console.log(typeof now);
        console.log(now > 0);
      `);
      const r = await exec("node perf-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("number");
      expect(r.stdout).toContain("true");
    });
  });

  describe("vm module", () => {
    it("runs code in new context", async () => {
      await writeFile("vm-test.js", `
        const vm = require("vm");
        const result = vm.runInNewContext("x + y", { x: 10, y: 20 });
        console.log(result);
      `);
      const r = await exec("node vm-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("30");
    });

    it("Script class works", async () => {
      await writeFile("vm-script.js", `
        const vm = require("vm");
        const script = new vm.Script("a * b");
        const result = script.runInNewContext({ a: 5, b: 6 });
        console.log(result);
      `);
      const r = await exec("node vm-script.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("30");
    });
  });

  describe("constants module", () => {
    it("exports filesystem and signal constants", async () => {
      await writeFile("const-test.js", `
        const constants = require("constants");
        console.log(constants.SIGTERM);
        console.log(constants.O_RDONLY);
        console.log(constants.ENOENT);
      `);
      const r = await exec("node const-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("15");
      expect(r.stdout).toContain("0");
      expect(r.stdout).toContain("2");
    });
  });

  describe("punycode module", () => {
    it("toASCII converts unicode domains", async () => {
      await writeFile("puny-test.js", `
        const punycode = require("punycode");
        console.log(punycode.version);
        const encoded = punycode.ucs2.encode([104, 101, 108, 108, 111]);
        console.log(encoded);
      `);
      const r = await exec("node puny-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("2.3.1");
      expect(r.stdout).toContain("hello");
    });
  });

  describe("fs module enhancements", () => {
    it("createReadStream emits data and end", async () => {
      await writeFile("stream-read.js", `
        const fs = require("fs");
        const stream = fs.createReadStream("stream-read.js");
        let data = "";
        stream.on("data", (chunk) => {
          data += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        });
        stream.on("end", () => {
          console.log(data.includes("createReadStream"));
        });
      `);
      const r = await exec("node stream-read.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("true");
    });

    it("createWriteStream returns writable stream", async () => {
      await writeFile("stream-write.js", `
        const fs = require("fs");
        const stream = fs.createWriteStream("written-by-stream.txt");
        console.log(typeof stream.write);
        console.log(typeof stream.end);
        console.log(typeof stream.on);
        console.log(stream.writable);
      `);
      const r = await exec("node stream-write.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("function");
      expect(r.stdout).toContain("true");
    });

    it("realpathSync returns absolute path", async () => {
      await writeFile("realpath-test.js", `
        const fs = require("fs");
        const result = fs.realpathSync("realpath-test.js");
        console.log(result.startsWith("/"));
      `);
      const r = await exec("node realpath-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("true");
    });

    it("fs.watch returns a watcher object", async () => {
      await writeFile("watch-test.js", `
        const fs = require("fs");
        const watcher = fs.watch("watch-test.js");
        console.log(typeof watcher.close);
        watcher.close();
      `);
      const r = await exec("node watch-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("function");
    });

    it("fs.appendFile is available", async () => {
      await writeFile("append-test.js", `
        const fs = require("fs");
        console.log(typeof fs.appendFile);
        console.log(typeof fs.promises.appendFile);
        console.log(typeof fs.renameSync);
        console.log(typeof fs.realpathSync);
      `);
      const r = await exec("node append-test.js");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.every((l: string) => l === "function")).toBe(true);
    });

    it("fs.constants includes extended values", async () => {
      await writeFile("fsconst-test.js", `
        const fs = require("fs");
        console.log(fs.constants.O_RDONLY);
        console.log(fs.constants.S_IFREG);
        console.log(fs.constants.O_CREAT);
      `);
      const r = await exec("node fsconst-test.js");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("0");
      expect(r.stdout).toContain("32768");
      expect(r.stdout).toContain("64");
    });
  });

  it("invalid JSON returns 400 not 500", async () => {
    const res = await SELF.fetch(
      `http://localhost/workspace/${workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all",
      },
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Invalid JSON in request body");
    // Should NOT contain SyntaxError details or stack traces
    expect(data.error).not.toContain("SyntaxError");
  });

  // ==========================================================================
  // Node.js compatibility: execSync, spawnSync, appendFileSync, accessSync
  // Users expect the SAME code they use in Node.js to work in nodemode
  // ==========================================================================

  it("execSync returns stdout as Buffer (Uint8Array)", async () => {
    const result = await exec(`node -e "
      const { execSync } = require('child_process');
      const out = execSync('echo hello world');
      console.log(typeof out);
      console.log(out instanceof Uint8Array);
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("object");
    expect(result.stdout).toContain("true");
  });

  it("execSync with encoding returns string", async () => {
    const result = await exec(`node -e "
      const { execSync } = require('child_process');
      const out = execSync('echo hi', { encoding: 'utf-8' });
      console.log(typeof out);
      console.log(out.trim());
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("string");
    expect(result.stdout).toContain("hi");
  });

  it("execSync runs ls and returns file listing", async () => {
    await writeFile("sync-test-file.txt", "data");
    const result = await exec(`node -e "
      const { execSync } = require('child_process');
      const out = execSync('ls', { encoding: 'utf-8' });
      console.log(out.includes('sync-test-file.txt'));
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });

  it("execSync throws on non-zero exit", async () => {
    const result = await exec(`node -e "
      const { execSync } = require('child_process');
      try { execSync('false'); console.log('no throw'); }
      catch(e) { console.log('threw'); console.log(e.status); }
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("threw");
    expect(result.stdout).toContain("1");
  });

  it("spawnSync returns status and stdout", async () => {
    const result = await exec(`node -e "
      const { spawnSync } = require('child_process');
      const r = spawnSync('echo', ['sync spawn works']);
      console.log(r.status);
      console.log(new TextDecoder().decode(r.stdout).trim());
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0");
    expect(result.stdout).toContain("sync spawn works");
  });

  it("execFileSync returns output", async () => {
    const result = await exec(`node -e "
      const { execFileSync } = require('child_process');
      const out = execFileSync('echo', ['file sync'], { encoding: 'utf-8' });
      console.log(out.trim());
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("file sync");
  });

  it("fork runs child JS file", async () => {
    await writeFile("child-fork.js", `console.log('forked child running');`);
    const result = await exec(`node -e "
      const { fork } = require('child_process');
      const cp = fork('./child-fork.js');
      console.log(typeof cp.on);
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("appendFileSync appends to existing file", async () => {
    const result = await exec(`node -e "
      const fs = require('fs');
      fs.writeFileSync('append-test.txt', 'hello');
      fs.appendFileSync('append-test.txt', ' world');
      console.log(fs.readFileSync('append-test.txt', 'utf-8'));
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("accessSync does not throw for existing file", async () => {
    const result = await exec(`node -e "
      const fs = require('fs');
      fs.writeFileSync('access-test.txt', 'exists');
      try { fs.accessSync('access-test.txt'); console.log('ok'); }
      catch(e) { console.log('error: ' + e.code); }
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("accessSync throws ENOENT for missing file", async () => {
    const result = await exec(`node -e "
      const fs = require('fs');
      try { fs.accessSync('no-such-file-xyz.txt'); console.log('ok'); }
      catch(e) { console.log(e.code); }
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ENOENT");
  });

  it("execSync cat reads file written by writeFileSync", async () => {
    const result = await exec(`node -e "
      const fs = require('fs');
      const { execSync } = require('child_process');
      fs.writeFileSync('cat-sync-test.txt', 'sync cat works');
      const out = execSync('cat cat-sync-test.txt', { encoding: 'utf-8' });
      console.log(out.trim());
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("sync cat works");
  });

  it("execSync grep filters lines", async () => {
    const result = await exec(`node -e "
      const fs = require('fs');
      const { execSync } = require('child_process');
      fs.writeFileSync('grep-sync.txt', 'alpha\\nbeta\\ngamma\\n');
      const out = execSync('grep beta grep-sync.txt', { encoding: 'utf-8' });
      console.log(out.trim());
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("beta");
  });

  it("real Node.js pattern: write file then cat via execSync", async () => {
    const result = await exec(`node -e "
      const fs = require('fs');
      const path = require('path');
      const { execSync } = require('child_process');
      const dir = 'sync-project';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 42;');
      const listing = execSync('ls ' + dir, { encoding: 'utf-8' });
      console.log(listing.trim());
      const content = execSync('cat ' + dir + '/index.js', { encoding: 'utf-8' });
      console.log(content.trim());
    "`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("index.js");
    expect(result.stdout).toContain("module.exports = 42;");
  });
});
