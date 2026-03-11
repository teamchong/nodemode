// Tests for the pre-deploy pipeline (runs in Node.js, not Workers)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeProject, transformSource, deployProject, NATIVE_ADDON_SWAPS } from "../src/deploy";
import type { DeployIssue } from "../src/deploy";

const TEST_DIR = join(import.meta.dirname, ".deploy-test-fixture");
const OUT_DIR = join(import.meta.dirname, ".deploy-test-output");

function setupProject(files: Record<string, string>) {
  mkdirSync(TEST_DIR, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(TEST_DIR, path);
    const dir = join(fullPath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }
}

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("deploy pipeline", () => {
  // -- analyzeProject --

  it("detects native addon dependencies", async () => {
    setupProject({
      "package.json": JSON.stringify({
        dependencies: { bcrypt: "^5.0.0", express: "^4.0.0" },
      }),
      "index.js": 'const bcrypt = require("bcrypt");',
    });

    const result = await analyzeProject(TEST_DIR);
    const nativeIssues = result.issues.filter((i) => i.kind === "native-addon");
    expect(nativeIssues.length).toBe(1);
    expect(nativeIssues[0].message).toContain("bcrypt");
    expect(nativeIssues[0].message).toContain("bcryptjs");
    expect(nativeIssues[0].autoFix).toBe(true);
  });

  it("detects removable native addons", async () => {
    setupProject({
      "package.json": JSON.stringify({
        dependencies: { fsevents: "^2.0.0" },
      }),
      "index.js": 'console.log("hello");',
    });

    const result = await analyzeProject(TEST_DIR);
    const nativeIssues = result.issues.filter((i) => i.kind === "native-addon");
    expect(nativeIssues.length).toBe(1);
    expect(nativeIssues[0].message).toContain("remove");
  });

  it("detects HTTP server patterns", async () => {
    setupProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "server.js": `
        const http = require("http");
        const server = http.createServer((req, res) => {
          res.end("hello");
        });
        server.listen(3000, () => console.log("running"));
      `,
    });

    const result = await analyzeProject(TEST_DIR);
    const httpIssues = result.issues.filter((i) => i.kind === "http-server");
    expect(httpIssues.length).toBeGreaterThan(0);
    expect(httpIssues[0].autoFix).toBe(true);
  });

  it("detects worker_threads usage", async () => {
    setupProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "worker.js": `
        const { Worker, isMainThread } = require("worker_threads");
        if (isMainThread) new Worker(__filename);
      `,
    });

    const result = await analyzeProject(TEST_DIR);
    const wtIssues = result.issues.filter((i) => i.kind === "worker-threads");
    expect(wtIssues.length).toBeGreaterThan(0);
  });

  it("detects dynamic require patterns", async () => {
    setupProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "loader.js": `
        const mod = require(path.join(__dirname, "lib"));
      `,
    });

    const result = await analyzeProject(TEST_DIR);
    const dynIssues = result.issues.filter((i) => i.kind === "dynamic-require");
    expect(dynIssues.length).toBeGreaterThan(0);
    expect(dynIssues[0].autoFix).toBe(false);
  });

  it("detects entry point from package.json main", async () => {
    setupProject({
      "package.json": JSON.stringify({ main: "src/app.js" }),
      "src/app.js": 'console.log("app");',
    });

    const result = await analyzeProject(TEST_DIR);
    expect(result.entryPoint).toBe("src/app.js");
  });

  it("detects entry point from scripts.start", async () => {
    setupProject({
      "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
      "server.js": 'console.log("server");',
    });

    const result = await analyzeProject(TEST_DIR);
    expect(result.entryPoint).toBe("server.js");
  });

  it("detects entry point from index.js default", async () => {
    setupProject({
      "package.json": JSON.stringify({}),
      "index.js": 'console.log("index");',
    });

    const result = await analyzeProject(TEST_DIR);
    expect(result.entryPoint).toBe("index.js");
  });

  it("lists all dependencies", async () => {
    setupProject({
      "package.json": JSON.stringify({
        dependencies: { express: "^4.0.0", lodash: "^4.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
      "index.js": "",
    });

    const result = await analyzeProject(TEST_DIR);
    expect(result.dependencies).toContain("express");
    expect(result.dependencies).toContain("lodash");
    expect(result.dependencies).toContain("vitest");
  });

  it("deduplicates issues at same location", async () => {
    setupProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "server.js": `
        const http = require("http");
        http.createServer().listen(3000);
      `,
    });

    const result = await analyzeProject(TEST_DIR);
    const httpIssues = result.issues.filter((i) => i.kind === "http-server");
    // Should not have duplicate entries for the same line
    const lines = httpIssues.map((i) => `${i.file}:${i.line}`);
    expect(new Set(lines).size).toBe(lines.length);
  });

  // -- transformSource --

  it("rewrites native addon require to swap package", () => {
    const source = 'const bcrypt = require("bcrypt");\nbcrypt.hash("pw", 10);';
    const issues: DeployIssue[] = [{
      kind: "native-addon",
      file: "index.js",
      line: 1,
      message: 'Native addon "bcrypt" → swap to "bcryptjs"',
      autoFix: true,
    }];

    const result = transformSource(source, issues);
    expect(result).toContain('require("bcryptjs")');
    expect(result).not.toContain('require("bcrypt")');
    expect(result).toContain("bcrypt.hash"); // usage preserved
  });

  it("rewrites native addon import to swap package", () => {
    const source = 'import bcrypt from "bcrypt";\nbcrypt.hash("pw", 10);';
    const issues: DeployIssue[] = [{
      kind: "native-addon",
      file: "index.js",
      line: 1,
      message: 'Native addon "bcrypt" → swap to "bcryptjs"',
      autoFix: true,
    }];

    const result = transformSource(source, issues);
    expect(result).toContain('from "bcryptjs"');
    expect(result).not.toContain('from "bcrypt"');
  });

  it("removes native addon when swap is empty", () => {
    const source = 'const fsevents = require("fsevents");\nconsole.log("ok");';
    const issues: DeployIssue[] = [{
      kind: "native-addon",
      file: "index.js",
      line: 1,
      message: 'Native addon "fsevents" → remove (not needed in Workers)',
      autoFix: true,
    }];

    const result = transformSource(source, issues);
    expect(result).toContain("// [nodemode] removed: fsevents");
    expect(result).not.toContain('require("fsevents")');
    expect(result).toContain('console.log("ok")');
  });

  it("transforms HTTP server listen port to 0", () => {
    const source = `
const http = require("http");
const server = http.createServer(handler);
server.listen(3000, () => console.log("ready"));
    `.trim();
    const issues: DeployIssue[] = [{
      kind: "http-server",
      file: "server.js",
      line: 3,
      message: "HTTP server detected",
      autoFix: true,
    }];

    const result = transformSource(source, issues);
    expect(result).toContain(".listen(0 /* nodemode: original 3000 */");
    expect(result).toContain("http.createServer(handler)");
  });

  it("transforms HTTP server listen with env var port", () => {
    const source = 'server.listen(process.env.PORT, callback);';
    const issues: DeployIssue[] = [{
      kind: "http-server",
      file: "server.js",
      line: 1,
      message: "HTTP server detected",
      autoFix: true,
    }];

    const result = transformSource(source, issues);
    expect(result).toContain(".listen(0 /* nodemode: original process.env.PORT */");
  });

  it("skips non-autoFix issues", () => {
    const source = 'const { Worker } = require("worker_threads");';
    const issues: DeployIssue[] = [{
      kind: "worker-threads",
      file: "worker.js",
      line: 1,
      message: "worker_threads import",
      autoFix: false,
    }];

    const result = transformSource(source, issues);
    expect(result).toBe(source); // no changes
  });

  // -- NATIVE_ADDON_SWAPS --

  it("has swap entries for known native addons", () => {
    expect(NATIVE_ADDON_SWAPS["bcrypt"]).toBe("bcryptjs");
    expect(NATIVE_ADDON_SWAPS["sharp"]).toBe("@cf-wasm/photon");
    expect(NATIVE_ADDON_SWAPS["better-sqlite3"]).toBe("sql.js");
    expect(NATIVE_ADDON_SWAPS["fsevents"]).toBe("");
  });

  // -- deployProject (end-to-end) --

  it("deploys transformed files to output directory", async () => {
    setupProject({
      "package.json": JSON.stringify({
        main: "index.js",
        dependencies: { bcrypt: "^5.0.0" },
      }),
      "index.js": 'const bcrypt = require("bcrypt");\nmodule.exports = bcrypt;',
    });

    const { analysis, outputDir } = await deployProject(TEST_DIR, OUT_DIR);

    // Analysis found the native addon
    expect(analysis.issues.some((i) => i.kind === "native-addon")).toBe(true);

    // Output file exists with transformed content
    const outFile = join(outputDir, "index.js");
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain('require("bcryptjs")');
    expect(content).not.toContain('require("bcrypt")');
  });

  it("preserves directory structure in output", async () => {
    setupProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "src/lib/utils.js": 'module.exports = { add: (a, b) => a + b };',
      "src/index.js": 'const utils = require("./lib/utils");\nconsole.log(utils.add(1, 2));',
    });

    const { outputDir } = await deployProject(TEST_DIR, OUT_DIR);

    expect(existsSync(join(outputDir, "src/index.js"))).toBe(true);
    expect(existsSync(join(outputDir, "src/lib/utils.js"))).toBe(true);
  });

  it("skips node_modules and .git directories", async () => {
    setupProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "index.js": 'console.log("app");',
      "node_modules/foo/index.js": 'module.exports = "foo";',
    });

    const result = await analyzeProject(TEST_DIR);
    const files = result.issues.map((i) => i.file);
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
  });
});
