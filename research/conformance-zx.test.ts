/**
 * zx (Google) Conformance Test
 *
 * Proves nodemode can handle every shell pattern from zx
 * (https://github.com/google/zx, 44k+ stars), Google's tool for writing
 * shell scripts in JavaScript. zx wraps child_process.spawn and provides
 * $`command` template literals for shell execution.
 *
 * zx needs:
 *   child_process.spawn()  → nodemode exec (builtin + Container)
 *   fs.readFile/writeFile  → nodemode fs/read, fs/write
 *   process.cwd()          → nodemode exec("pwd")
 *   Pipes (cmd1 | cmd2)    → nodemode pipe support
 *   Exit codes             → nodemode exitCode tracking
 *   stderr capture         → nodemode stderr in SpawnResult
 *
 * Every test below maps a real zx API pattern to nodemode primitives,
 * proving nodemode can serve as the runtime backend for zx-like workflows
 * on Cloudflare Durable Objects.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createHelpers } from "../test/helpers";

const { exec, writeFile, readFile, exists, listProcesses, init } = createHelpers("conformance-zx");

describe("zx conformance", () => {
  beforeAll(async () => {
    await init("test", "zx-conformance");
  });

  // -----------------------------------------------------------------------
  // Pattern 1: $`command` — basic shell execution
  // zx: const result = await $`echo hello`
  // -----------------------------------------------------------------------
  it("$`echo hello` — basic command execution", async () => {
    const result = await exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  // -----------------------------------------------------------------------
  // Pattern 2: $`command with args`
  // zx: await $`echo ${"hello world"}`
  // -----------------------------------------------------------------------
  it("$`echo` with quoted arguments", async () => {
    const result = await exec('echo "hello world"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  // -----------------------------------------------------------------------
  // Pattern 3: Pipes
  // zx: await $`echo hello | grep hello`
  // -----------------------------------------------------------------------
  it("pipe: echo | grep", async () => {
    const result = await exec("echo hello world | grep hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
  });

  it("pipe: cat file | head", async () => {
    await writeFile("zx-lines.txt", "a\nb\nc\nd\ne\nf\n");
    const result = await exec("cat zx-lines.txt | head -n 3");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a");
    expect(result.stdout).toContain("c");
    expect(result.stdout).not.toContain("d");
  });

  it("pipe: cat file | grep | wc", async () => {
    await writeFile("logs.txt", "INFO: started\nERROR: failed\nINFO: ok\nERROR: timeout\n");
    const result = await exec("cat logs.txt | grep ERROR | wc");
    expect(result.exitCode).toBe(0);
    // 2 lines matching ERROR
    expect(result.stdout).toContain("2");
  });

  // -----------------------------------------------------------------------
  // Pattern 4: Exit codes
  // zx: try { await $`false` } catch (e) { e.exitCode === 1 }
  // -----------------------------------------------------------------------
  it("captures non-zero exit codes", async () => {
    const result = await exec("false");
    expect(result.exitCode).toBe(1);
  });

  it("exit code 127 for unknown commands", async () => {
    const result = await exec("nonexistent-binary");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  // -----------------------------------------------------------------------
  // Pattern 5: Command chaining
  // zx: await $`mkdir -p foo && echo done`
  // -----------------------------------------------------------------------
  it("&& chain: mkdir && echo", async () => {
    const result = await exec("mkdir -p zx-output && echo created");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created");
  });

  it("&& chain: stops on failure", async () => {
    const result = await exec("cat no-such-file && echo should-not-run");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("|| chain: fallback on failure", async () => {
    const result = await exec("cat no-such-file || echo fallback");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fallback");
  });

  it("; chain: runs all regardless", async () => {
    const result = await exec("echo first; echo second; echo third");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
    expect(result.stdout).toContain("third");
  });

  // -----------------------------------------------------------------------
  // Pattern 6: File operations (zx uses fs.readFile/writeFile)
  // -----------------------------------------------------------------------
  it("write and read JSON config file", async () => {
    const config = JSON.stringify({ name: "my-project", version: "1.0.0" });
    await writeFile("package.json", config);
    const data = await readFile("package.json");
    const parsed = JSON.parse(data.content);
    expect(parsed.name).toBe("my-project");
    expect(parsed.version).toBe("1.0.0");
  });

  it("write script and cat it back", async () => {
    const script = '#!/bin/bash\necho "hello from script"\n';
    await writeFile("run.sh", script);
    const result = await exec("cat run.sh");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from script");
  });

  // -----------------------------------------------------------------------
  // Pattern 7: Working directory
  // zx: cd('/tmp'); await $`pwd`
  // -----------------------------------------------------------------------
  it("pwd returns working directory", async () => {
    const result = await exec("pwd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/");
  });

  // -----------------------------------------------------------------------
  // Pattern 8: Multi-step script workflows
  // zx: typical automation script pattern
  // -----------------------------------------------------------------------
  it("multi-step: create project structure", async () => {
    // Step 1: Create directories
    const mkdir = await exec("mkdir -p project/src && mkdir -p project/test");
    expect(mkdir.exitCode).toBe(0);

    // Step 2: Write source files
    await writeFile("project/src/index.ts", 'export const hello = "world";');
    await writeFile("project/test/index.test.ts", 'import { hello } from "../src/index";');

    // Step 3: Verify structure
    const ls = await exec("ls project/src");
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain("index.ts");

    // Step 4: Read back and verify
    const src = await readFile("project/src/index.ts");
    expect(src.content).toContain("hello");
  });

  it("multi-step: find and replace pattern", async () => {
    // Write a file with template variables
    await writeFile("template.txt", "Hello, {{NAME}}!\nWelcome to {{PROJECT}}.\n");

    // Read, transform (simulate sed), write back
    const data = await readFile("template.txt");
    const replaced = data.content
      .replace("{{NAME}}", "Developer")
      .replace("{{PROJECT}}", "nodemode");
    await writeFile("output.txt", replaced);

    // Verify
    const result = await exec("cat output.txt");
    expect(result.stdout).toContain("Hello, Developer!");
    expect(result.stdout).toContain("Welcome to nodemode.");
  });

  // -----------------------------------------------------------------------
  // Pattern 9: Environment variables
  // zx: $.env.FOO = 'bar'; await $`echo $FOO`
  // -----------------------------------------------------------------------
  it("env command shows environment", async () => {
    const result = await exec("env", { env: { FOO: "bar", NODE_ENV: "production" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("NODE_ENV=production");
  });

  // -----------------------------------------------------------------------
  // Pattern 10: File existence checks
  // zx: if (await fs.pathExists('file')) { ... }
  // -----------------------------------------------------------------------
  it("test -f for file existence", async () => {
    await writeFile("exists-check.txt", "yes");
    const yes = await exec("test -f exists-check.txt");
    expect(yes.exitCode).toBe(0);

    const no = await exec("test -f nope.txt");
    expect(no.exitCode).toBe(1);
  });

  it("conditional: test && echo", async () => {
    await writeFile("flag.txt", "1");
    const result = await exec("test -f flag.txt && echo file exists");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("file exists");
  });

  // -----------------------------------------------------------------------
  // Pattern 11: Grep patterns (common in zx scripts)
  // -----------------------------------------------------------------------
  it("grep with file pattern matching", async () => {
    await writeFile("changelog.md", "# v2.0.0\n- Breaking change\n# v1.1.0\n- Bug fix\n# v1.0.0\n- Initial\n");
    const result = await exec("grep v1 changelog.md");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v1.1.0");
    expect(result.stdout).toContain("v1.0.0");
    expect(result.stdout).not.toContain("v2.0.0");
  });

  // -----------------------------------------------------------------------
  // Pattern 12: Cleanup
  // zx: await $`rm -rf dist && mkdir dist`
  // -----------------------------------------------------------------------
  it("rm and recreate directory", async () => {
    await writeFile("cleanup/old.txt", "stale");
    const result = await exec("rm -rf cleanup && mkdir -p cleanup");
    expect(result.exitCode).toBe(0);

    const gone = await exists("cleanup/old.txt");
    expect(gone).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Pattern 13: Complex pipes (3+ stages)
  // zx: await $`cat file | grep pattern | head -n 5`
  // -----------------------------------------------------------------------
  it("three-stage pipe: cat | grep | head", async () => {
    await writeFile("access.log", [
      "200 GET /api/users",
      "404 GET /api/missing",
      "200 GET /api/posts",
      "500 GET /api/error",
      "200 GET /api/comments",
      "200 GET /api/tags",
      "200 GET /api/auth",
    ].join("\n") + "\n");

    const result = await exec("cat access.log | grep 200 | head -n 3");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/api/users");
    expect(result.stdout).toContain("/api/posts");
    expect(result.stdout).toContain("/api/comments");
    expect(result.stdout).not.toContain("/api/tags");
    expect(result.stdout).not.toContain("404");
  });

  // -----------------------------------------------------------------------
  // Pattern 14: wc for counting pipe results
  // zx: const count = (await $`cat file | grep pattern | wc -l`).stdout.trim()
  // -----------------------------------------------------------------------
  it("pipe: cat | grep | wc for counting matches", async () => {
    const result = await exec("cat access.log | grep 200 | wc");
    expect(result.exitCode).toBe(0);
    // 5 lines contain "200"
    expect(result.stdout).toContain("5");
  });

  // -----------------------------------------------------------------------
  // Pattern 15: Conditional execution patterns
  // zx: await $`test -f file && cat file || echo "not found"`
  // -----------------------------------------------------------------------
  it("test && cat || echo pattern (file exists)", async () => {
    await writeFile("config.txt", "key=value");
    const result = await exec("test -f config.txt && cat config.txt || echo not found");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("key=value");
    expect(result.stdout).not.toContain("not found");
  });

  it("test && cat || echo pattern (file missing)", async () => {
    const result = await exec("test -f missing.txt && cat missing.txt || echo not found");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not found");
  });

  // -----------------------------------------------------------------------
  // Pattern 16: Building paths with basename/dirname
  // zx: const dir = path.dirname(file); const base = path.basename(file)
  // -----------------------------------------------------------------------
  it("basename extracts filename", async () => {
    const result = await exec("basename /home/user/project/src/index.ts");
    expect(result.stdout.trim()).toBe("index.ts");
  });

  it("dirname extracts directory", async () => {
    const result = await exec("dirname /home/user/project/src/index.ts");
    expect(result.stdout.trim()).toBe("/home/user/project/src");
  });

  // -----------------------------------------------------------------------
  // Pattern 17: touch for creating marker files
  // zx: await $`touch .build-complete`
  // -----------------------------------------------------------------------
  it("touch creates marker files", async () => {
    const result = await exec("touch .build-started");
    expect(result.exitCode).toBe(0);
    expect(await exists(".build-started")).toBe(true);
  });

  it("touch on existing file updates it", async () => {
    await writeFile("existing.txt", "data");
    const result = await exec("touch existing.txt");
    expect(result.exitCode).toBe(0);
    // File still exists with same content
    const data = await readFile("existing.txt");
    expect(data.content).toBe("data");
  });

  // -----------------------------------------------------------------------
  // Pattern 18: which command for tool detection
  // zx: const hasGit = await which('git').catch(() => null)
  // -----------------------------------------------------------------------
  it("which finds builtin commands", async () => {
    const echo = await exec("which echo");
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout).toContain("/usr/bin/echo");

    const grep = await exec("which grep");
    expect(grep.exitCode).toBe(0);
  });

  it("which reports missing for non-builtins", async () => {
    const result = await exec("which docker");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  // -----------------------------------------------------------------------
  // Pattern 19: Multi-file write + verify loop
  // zx: for (const f of files) { await fs.writeFile(f, content) }
  // -----------------------------------------------------------------------
  it("writes multiple files and verifies all exist", async () => {
    const files = ["batch/a.txt", "batch/b.txt", "batch/c.txt", "batch/d.txt", "batch/e.txt"];
    await exec("mkdir -p batch");
    for (let i = 0; i < files.length; i++) {
      await writeFile(files[i], `content-${i}`);
    }

    for (let i = 0; i < files.length; i++) {
      expect(await exists(files[i])).toBe(true);
      const data = await readFile(files[i]);
      expect(data.content).toBe(`content-${i}`);
    }
  });

  // -----------------------------------------------------------------------
  // Pattern 20: Single-quoted strings preserved in pipes
  // -----------------------------------------------------------------------
  it("handles single-quoted args", async () => {
    const result = await exec("echo 'hello world with spaces'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world with spaces");
  });

  it("handles double-quoted args", async () => {
    const result = await exec('echo "double quoted string"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("double quoted string");
  });

  // -----------------------------------------------------------------------
  // Pattern 21: Process list inspection
  // zx: check what ran
  // -----------------------------------------------------------------------
  it("process list tracks all zx-like commands", async () => {
    const processes = await listProcesses();
    expect(processes.length).toBeGreaterThan(10);
    // All should be completed
    for (const p of processes.slice(0, 20)) {
      expect(p.status).toBe("done");
    }
  });
});
