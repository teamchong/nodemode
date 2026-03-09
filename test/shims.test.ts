/**
 * Module shim tests — verify that node:fs and node:child_process shims
 * work correctly when backed by nodemode's R2+SQLite engine.
 *
 * These test the same API surface that libraries like simple-git and zx
 * would call when running on Workers with wrangler module aliases.
 *
 * Note: shims use a context singleton set inside the Workspace DO, so we
 * test through HTTP endpoints (SELF.fetch) rather than importing shims
 * directly — Cloudflare's DO I/O isolation prevents cross-context access.
 */

import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createHelpers } from "./helpers";

const h = createHelpers("shim-test");

// Shim tests need raw Response access for status code checks
async function fsWrite(path: string, content: string) {
  const res = await h.writeFile(path, content);
  expect(res.status).toBe(200);
  return res;
}

async function fsRead(path: string): Promise<string> {
  const data = await h.readFile(path);
  return data.content;
}

async function fsReaddir(path: string) {
  const entries = await h.readdir(path);
  return entries.map((e) => e.name);
}

async function exec(command: string) {
  return SELF.fetch(`http://localhost/workspace/shim-test/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
}

// Initialize workspace
beforeAll(async () => {
  await h.init("test", "shim-test");
  await fsWrite("hello.txt", "hello from shim test");
});

describe("fs shim (via HTTP — same backing as node:fs shim)", () => {
  it("readFile returns content", async () => {
    const content = await fsRead("hello.txt");
    expect(content).toBe("hello from shim test");
  });

  it("readFile returns 404 for missing file", async () => {
    const res = await SELF.fetch(`http://localhost/workspace/shim-test/fs/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "nope.txt" }),
    });
    expect(res.status).toBe(404);
  });

  it("writeFile + readFile round-trip", async () => {
    await fsWrite("shim-out.txt", "written via shim");
    const content = await fsRead("shim-out.txt");
    expect(content).toBe("written via shim");
  });

  it("appendFile adds to file", async () => {
    await fsWrite("append.txt", "line1\n");
    const existing = await fsRead("append.txt");
    await fsWrite("append.txt", existing + "line2\n");
    const content = await fsRead("append.txt");
    expect(content).toBe("line1\nline2\n");
  });

  it("stat returns file metadata", async () => {
    const res = await h.statRaw("hello.txt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { size: number; isDirectory: boolean; mtime: number };
    expect(data.size).toBeGreaterThan(0);
    expect(data.isDirectory).toBe(false);
  });

  it("stat returns 404 for missing file", async () => {
    const res = await h.statRaw("nope.txt");
    expect(res.status).toBe(404);
  });

  it("mkdir + readdir", async () => {
    await h.mkdir("shim-dir");
    await fsWrite("shim-dir/a.txt", "a");
    await fsWrite("shim-dir/b.txt", "b");
    const entries = await fsReaddir("shim-dir");
    expect(entries).toContain("a.txt");
    expect(entries).toContain("b.txt");
  });

  it("unlink removes file", async () => {
    await fsWrite("to-delete.txt", "gone");
    const delRes = await h.unlink("to-delete.txt");
    expect(delRes.status).toBe(200);
    const statRes = await h.statRaw("to-delete.txt");
    expect(statRes.status).toBe(404);
  });

  it("rename moves file", async () => {
    await fsWrite("old-name.txt", "renamed");
    const renameRes = await h.rename("old-name.txt", "new-name.txt");
    expect(renameRes.status).toBe(200);
    const content = await fsRead("new-name.txt");
    expect(content).toBe("renamed");
    const statRes = await h.statRaw("old-name.txt");
    expect(statRes.status).toBe(404);
  });

  it("exists returns true/false", async () => {
    expect(await h.exists("hello.txt")).toBe(true);
    expect(await h.exists("nope.txt")).toBe(false);
  });

  it("copyFile via read+write round-trip", async () => {
    await fsWrite("original.txt", "copy me");
    const content = await fsRead("original.txt");
    await fsWrite("copy.txt", content);
    const copied = await fsRead("copy.txt");
    expect(copied).toBe("copy me");
  });
});

describe("child_process shim (via HTTP — same backing as node:child_process shim)", () => {
  it("exec echo", async () => {
    const res = await exec("echo hello from shim");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("hello from shim");
  });

  it("exec with env", async () => {
    const res = await SELF.fetch(`http://localhost/workspace/shim-test/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "env", env: { MY_VAR: "hello123" } }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout).toContain("MY_VAR=hello123");
  });

  it("exec non-zero exit returns error", async () => {
    const res = await exec("false");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { exitCode: number };
    expect(data.exitCode).toBe(1);
  });

  it("exec pipe works", async () => {
    await fsWrite("pipe-test.txt", "alpha\nbeta\ngamma\n");
    const res = await exec("cat pipe-test.txt | grep beta");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("beta");
  });

  it("exec chain with &&", async () => {
    const res = await exec("echo first && echo second");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout).toContain("first");
    expect(data.stdout).toContain("second");
  });

  it("exec chain with || on failure", async () => {
    const res = await exec("false || echo fallback");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("fallback");
  });

  it("exec with semicolons", async () => {
    const res = await exec("echo a; echo b; echo c");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout).toContain("a");
    expect(data.stdout).toContain("b");
    expect(data.stdout).toContain("c");
  });

  it("exec chain with pipe in segment", async () => {
    await fsWrite("chain-pipe.txt", "alpha\nbeta\ngamma\n");
    const res = await exec("echo start && cat chain-pipe.txt | grep beta");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout).toContain("start");
    expect(data.stdout).toContain("beta");
    expect(data.stdout).not.toContain("alpha");
  });

  it("exec cat reads file", async () => {
    await fsWrite("cat-test.txt", "cat content");
    const res = await exec("cat cat-test.txt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("cat content");
  });

  it("exec ls lists directory", async () => {
    await h.mkdir("ls-dir");
    await fsWrite("ls-dir/file1.txt", "1");
    await fsWrite("ls-dir/file2.txt", "2");
    const res = await exec("ls ls-dir");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout).toContain("file1.txt");
    expect(data.stdout).toContain("file2.txt");
  });

  it("exec grep searches content", async () => {
    await fsWrite("grep-test.txt", "foo\nbar\nbaz\n");
    const res = await exec("grep bar grep-test.txt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("bar");
  });

  it("exec wc counts lines", async () => {
    await fsWrite("wc-test.txt", "one\ntwo\nthree\n");
    const res = await exec("wc -l wc-test.txt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toContain("3");
  });

  it("exec head", async () => {
    await fsWrite("ht-test.txt", "1\n2\n3\n4\n5\n");
    const res = await exec("head -n 2 ht-test.txt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("1\n2");
  });

  it("exec tail", async () => {
    await fsWrite("tail-test.txt", "1\n2\n3\n4\n5\n");
    const res = await exec("tail -n 2 tail-test.txt");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    // tail -n 2 on "1\n2\n3\n4\n5\n" gives the last 2 lines: "4" and "5"
    expect(data.stdout).toContain("4");
    expect(data.stdout).toContain("5");
  });

  it("exec pwd", async () => {
    const res = await exec("pwd");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stdout: string };
    expect(data.stdout.trim()).toBe("/");
  });

  it("exec true/false exit codes", async () => {
    const trueRes = await exec("true");
    const trueData = (await trueRes.json()) as { exitCode: number };
    expect(trueData.exitCode).toBe(0);

    const falseRes = await exec("false");
    const falseData = (await falseRes.json()) as { exitCode: number };
    expect(falseData.exitCode).toBe(1);
  });
});
