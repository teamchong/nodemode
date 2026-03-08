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

import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

const W = "conformance-zx";

function exec(command: string, opts?: { env?: Record<string, string> }) {
  return SELF.fetch(`http://localhost/workspace/${W}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, ...opts }),
  }).then((r) => r.json() as Promise<{ exitCode: number; stdout: string; stderr: string }>);
}

function writeFile(path: string, content: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/fs/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

function readFile(path: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/fs/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).then((r) => r.json() as Promise<{ content: string }>);
}

function exists(path: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/fs/exists?path=${path}`)
    .then((r) => r.json() as Promise<{ exists: boolean }>)
    .then((d) => d.exists);
}

describe("zx conformance", () => {
  beforeAll(async () => {
    await SELF.fetch(`http://localhost/workspace/${W}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "test", name: "zx-conformance" }),
    });
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
});
