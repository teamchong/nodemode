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

beforeAll(async () => {
  await h.init("test", "shim-test");
  await h.writeFile("hello.txt", "hello from shim test");
});

describe("fs shim (via HTTP — same backing as node:fs shim)", () => {
  it("readFile returns content", async () => {
    expect((await h.readFile("hello.txt")).content).toBe("hello from shim test");
  });

  it("readFile returns 404 for missing file", async () => {
    const res = await SELF.fetch("http://localhost/workspace/shim-test/fs/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "nope.txt" }),
    });
    expect(res.status).toBe(404);
  });

  it("writeFile + readFile round-trip", async () => {
    await h.writeFile("shim-out.txt", "written via shim");
    expect((await h.readFile("shim-out.txt")).content).toBe("written via shim");
  });

  it("appendFile adds to file", async () => {
    await h.writeFile("append.txt", "line1\n");
    const existing = (await h.readFile("append.txt")).content;
    await h.writeFile("append.txt", existing + "line2\n");
    expect((await h.readFile("append.txt")).content).toBe("line1\nline2\n");
  });

  it("stat returns file metadata", async () => {
    const s = await h.stat("hello.txt");
    expect(s.size).toBeGreaterThan(0);
    expect(s.isDirectory).toBe(false);
  });

  it("stat returns 404 for missing file", async () => {
    expect((await h.statRaw("nope.txt")).status).toBe(404);
  });

  it("mkdir + readdir", async () => {
    await h.mkdir("shim-dir");
    await h.writeFile("shim-dir/a.txt", "a");
    await h.writeFile("shim-dir/b.txt", "b");
    const names = (await h.readdir("shim-dir")).map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("unlink removes file", async () => {
    await h.writeFile("to-delete.txt", "gone");
    await h.unlink("to-delete.txt");
    expect((await h.statRaw("to-delete.txt")).status).toBe(404);
  });

  it("rename moves file", async () => {
    await h.writeFile("old-name.txt", "renamed");
    await h.rename("old-name.txt", "new-name.txt");
    expect((await h.readFile("new-name.txt")).content).toBe("renamed");
    expect((await h.statRaw("old-name.txt")).status).toBe(404);
  });

  it("exists returns true/false", async () => {
    expect(await h.exists("hello.txt")).toBe(true);
    expect(await h.exists("nope.txt")).toBe(false);
  });

  it("copyFile via read+write round-trip", async () => {
    await h.writeFile("original.txt", "copy me");
    await h.writeFile("copy.txt", (await h.readFile("original.txt")).content);
    expect((await h.readFile("copy.txt")).content).toBe("copy me");
  });
});

describe("child_process shim (via HTTP — same backing as node:child_process shim)", () => {
  it("exec echo", async () => {
    expect((await h.exec("echo hello from shim")).stdout.trim()).toBe("hello from shim");
  });

  it("exec with env", async () => {
    const result = await h.exec("env", { env: { MY_VAR: "hello123" } });
    expect(result.stdout).toContain("MY_VAR=hello123");
  });

  it("exec non-zero exit returns error", async () => {
    expect((await h.exec("false")).exitCode).toBe(1);
  });

  it("exec pipe works", async () => {
    await h.writeFile("pipe-test.txt", "alpha\nbeta\ngamma\n");
    expect((await h.exec("cat pipe-test.txt | grep beta")).stdout.trim()).toBe("beta");
  });

  it("exec chain with &&", async () => {
    const result = await h.exec("echo first && echo second");
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
  });

  it("exec chain with || on failure", async () => {
    expect((await h.exec("false || echo fallback")).stdout.trim()).toBe("fallback");
  });

  it("exec with semicolons", async () => {
    const result = await h.exec("echo a; echo b; echo c");
    expect(result.stdout).toContain("a");
    expect(result.stdout).toContain("b");
    expect(result.stdout).toContain("c");
  });

  it("exec chain with pipe in segment", async () => {
    await h.writeFile("chain-pipe.txt", "alpha\nbeta\ngamma\n");
    const result = await h.exec("echo start && cat chain-pipe.txt | grep beta");
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).not.toContain("alpha");
  });

  it("exec cat reads file", async () => {
    await h.writeFile("cat-test.txt", "cat content");
    expect((await h.exec("cat cat-test.txt")).stdout.trim()).toBe("cat content");
  });

  it("exec ls lists directory", async () => {
    await h.mkdir("ls-dir");
    await h.writeFile("ls-dir/file1.txt", "1");
    await h.writeFile("ls-dir/file2.txt", "2");
    const result = await h.exec("ls ls-dir");
    expect(result.stdout).toContain("file1.txt");
    expect(result.stdout).toContain("file2.txt");
  });

  it("exec grep searches content", async () => {
    await h.writeFile("grep-test.txt", "foo\nbar\nbaz\n");
    expect((await h.exec("grep bar grep-test.txt")).stdout.trim()).toBe("bar");
  });

  it("exec wc counts lines", async () => {
    await h.writeFile("wc-test.txt", "one\ntwo\nthree\n");
    expect((await h.exec("wc -l wc-test.txt")).stdout.trim()).toContain("3");
  });

  it("exec head", async () => {
    await h.writeFile("ht-test.txt", "1\n2\n3\n4\n5\n");
    expect((await h.exec("head -n 2 ht-test.txt")).stdout.trim()).toBe("1\n2");
  });

  it("exec tail", async () => {
    await h.writeFile("tail-test.txt", "1\n2\n3\n4\n5\n");
    const result = await h.exec("tail -n 2 tail-test.txt");
    expect(result.stdout).toContain("4");
    expect(result.stdout).toContain("5");
  });

  it("exec pwd", async () => {
    expect((await h.exec("pwd")).stdout.trim()).toBe("/");
  });

  it("exec true/false exit codes", async () => {
    expect((await h.exec("true")).exitCode).toBe(0);
    expect((await h.exec("false")).exitCode).toBe(1);
  });
});
