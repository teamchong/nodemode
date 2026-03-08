/**
 * OpenCode / AI Coding Agent Conformance Test
 *
 * Proves nodemode can handle the workspace operations that AI coding agents
 * like opencode (https://github.com/anomalyco/opencode), aider, and
 * Claude Code perform. These tools need a full dev environment: read project
 * files, write code, run shell commands (git, npm, tsc), and inspect results.
 *
 * AI coding agent workflow:
 *   1. Read project structure (ls, cat, readdir)
 *   2. Read/write source files (fs read/write)
 *   3. Run build tools (npm install, tsc, esbuild) — Container exec
 *   4. Run tests (vitest, jest) — Container exec
 *   5. Git operations (git status, diff, commit) — Container exec
 *   6. Inspect results (grep, cat output)
 *
 * Without nodemode: IMPOSSIBLE on Cloudflare Workers (no fs, no shell).
 * With nodemode: Full dev environment on Durable Objects + R2 + Containers.
 */

import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

const W = "conformance-opencode";

function exec(command: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
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

function readdir(path: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/fs/readdir?path=${path}`)
    .then((r) => r.json() as Promise<Array<{ name: string; isDirectory: boolean }>>);
}

function stat(path: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/fs/stat?path=${path}`)
    .then((r) => r.json() as Promise<{ size: number; isDirectory: boolean; mtime: number }>);
}

function exists(path: string) {
  return SELF.fetch(`http://localhost/workspace/${W}/fs/exists?path=${path}`)
    .then((r) => r.json() as Promise<{ exists: boolean }>)
    .then((d) => d.exists);
}

describe("opencode/AI agent conformance", () => {
  beforeAll(async () => {
    await SELF.fetch(`http://localhost/workspace/${W}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "test", name: "opencode-conformance" }),
    });
  });

  // =====================================================================
  // PHASE 1: Project scaffolding
  // Agent creates a new TypeScript project from scratch
  // =====================================================================

  describe("Phase 1: Project scaffolding", () => {
    it("creates project directory structure", async () => {
      const result = await exec("mkdir -p myapp/src && mkdir -p myapp/test && mkdir -p myapp/dist");
      expect(result.exitCode).toBe(0);

      const entries = await readdir("myapp");
      const names = entries.map((e) => e.name);
      expect(names).toContain("src");
      expect(names).toContain("test");
      expect(names).toContain("dist");
    });

    it("generates package.json", async () => {
      const pkg = {
        name: "myapp",
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "tsc",
          test: "vitest run",
          start: "node dist/index.js",
        },
        dependencies: {
          hono: "^4.0.0",
        },
        devDependencies: {
          typescript: "^5.7.0",
          vitest: "^3.0.0",
        },
      };
      await writeFile("myapp/package.json", JSON.stringify(pkg, null, 2));

      const data = await readFile("myapp/package.json");
      const parsed = JSON.parse(data.content);
      expect(parsed.name).toBe("myapp");
      expect(parsed.scripts.build).toBe("tsc");
    });

    it("generates tsconfig.json", async () => {
      const tsconfig = {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          outDir: "./dist",
          rootDir: "./src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      };
      await writeFile("myapp/tsconfig.json", JSON.stringify(tsconfig, null, 2));

      const data = await readFile("myapp/tsconfig.json");
      const parsed = JSON.parse(data.content);
      expect(parsed.compilerOptions.strict).toBe(true);
    });

    it("writes source files", async () => {
      await writeFile(
        "myapp/src/index.ts",
        [
          'import { greet } from "./utils";',
          "",
          "const name = process.env.USER || \"world\";",
          "console.log(greet(name));",
          "",
        ].join("\n"),
      );

      await writeFile(
        "myapp/src/utils.ts",
        [
          "export function greet(name: string): string {",
          "  return `Hello, ${name}!`;",
          "}",
          "",
          "export function add(a: number, b: number): number {",
          "  return a + b;",
          "}",
          "",
        ].join("\n"),
      );

      const src = await readFile("myapp/src/index.ts");
      expect(src.content).toContain("greet");
      expect(src.content).toContain("import");
    });

    it("writes test files", async () => {
      await writeFile(
        "myapp/test/utils.test.ts",
        [
          'import { describe, it, expect } from "vitest";',
          'import { greet, add } from "../src/utils";',
          "",
          'describe("utils", () => {',
          '  it("greets by name", () => {',
          '    expect(greet("Alice")).toBe("Hello, Alice!");',
          "  });",
          "",
          '  it("adds numbers", () => {',
          "    expect(add(2, 3)).toBe(5);",
          "  });",
          "});",
          "",
        ].join("\n"),
      );

      const test = await readFile("myapp/test/utils.test.ts");
      expect(test.content).toContain("describe");
      expect(test.content).toContain("greet");
    });
  });

  // =====================================================================
  // PHASE 2: Code inspection (what AI agents do most)
  // Agent reads and analyzes the codebase
  // =====================================================================

  describe("Phase 2: Code inspection", () => {
    it("lists project root", async () => {
      const result = await exec("ls myapp");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("package.json");
      expect(result.stdout).toContain("tsconfig.json");
      expect(result.stdout).toContain("src");
    });

    it("reads source with cat", async () => {
      const result = await exec("cat myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export function greet");
      expect(result.stdout).toContain("export function add");
    });

    it("searches code with grep", async () => {
      const result = await exec("grep export myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export function greet");
      expect(result.stdout).toContain("export function add");
    });

    it("inspects file metadata", async () => {
      const s = await stat("myapp/src/utils.ts");
      expect(s.size).toBeGreaterThan(0);
      expect(s.isDirectory).toBe(false);
      expect(s.mtime).toBeGreaterThan(0);
    });

    it("checks file existence before editing", async () => {
      expect(await exists("myapp/src/utils.ts")).toBe(true);
      expect(await exists("myapp/src/database.ts")).toBe(false);
    });

    it("reads directory tree", async () => {
      const root = await readdir("myapp");
      const src = await readdir("myapp/src");
      const test = await readdir("myapp/test");

      expect(root.map((e) => e.name)).toContain("src");
      expect(src.map((e) => e.name)).toContain("index.ts");
      expect(src.map((e) => e.name)).toContain("utils.ts");
      expect(test.map((e) => e.name)).toContain("utils.test.ts");
    });

    it("counts lines with wc", async () => {
      const result = await exec("wc myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      // Should show line/word/byte counts
      expect(result.stdout).toMatch(/\d+\s+\d+\s+\d+/);
    });

    it("inspects with head and tail", async () => {
      const head = await exec("head -n 2 myapp/src/utils.ts");
      expect(head.exitCode).toBe(0);
      expect(head.stdout).toContain("export function greet");

      const tail = await exec("tail -n 1 myapp/src/utils.ts");
      expect(tail.exitCode).toBe(0);
    });
  });

  // =====================================================================
  // PHASE 3: Code modification
  // Agent edits files, adds new features
  // =====================================================================

  describe("Phase 3: Code modification", () => {
    it("adds a new module", async () => {
      await writeFile(
        "myapp/src/math.ts",
        [
          "export function multiply(a: number, b: number): number {",
          "  return a * b;",
          "}",
          "",
          "export function divide(a: number, b: number): number {",
          '  if (b === 0) throw new Error("Division by zero");',
          "  return a / b;",
          "}",
          "",
        ].join("\n"),
      );

      const content = await readFile("myapp/src/math.ts");
      expect(content.content).toContain("multiply");
      expect(content.content).toContain("divide");
    });

    it("adds tests for new module", async () => {
      await writeFile(
        "myapp/test/math.test.ts",
        [
          'import { describe, it, expect } from "vitest";',
          'import { multiply, divide } from "../src/math";',
          "",
          'describe("math", () => {',
          '  it("multiplies", () => {',
          "    expect(multiply(3, 4)).toBe(12);",
          "  });",
          "",
          '  it("divides", () => {',
          "    expect(divide(10, 2)).toBe(5);",
          "  });",
          "",
          '  it("throws on division by zero", () => {',
          "    expect(() => divide(1, 0)).toThrow();",
          "  });",
          "});",
          "",
        ].join("\n"),
      );

      const content = await readFile("myapp/test/math.test.ts");
      expect(content.content).toContain("multiply");
      expect(content.content).toContain("division by zero");
    });

    it("updates index to use new module", async () => {
      await writeFile(
        "myapp/src/index.ts",
        [
          'import { greet } from "./utils";',
          'import { multiply } from "./math";',
          "",
          "const name = process.env.USER || \"world\";",
          "console.log(greet(name));",
          "console.log(`3 x 4 = ${multiply(3, 4)}`);",
          "",
        ].join("\n"),
      );

      const content = await readFile("myapp/src/index.ts");
      expect(content.content).toContain("multiply");
      expect(content.content).toContain("math");
    });

    it("copies a file as backup", async () => {
      const result = await exec("cp myapp/src/utils.ts myapp/src/utils.backup.ts");
      expect(result.exitCode).toBe(0);
      expect(await exists("myapp/src/utils.backup.ts")).toBe(true);
    });

    it("renames a file", async () => {
      await writeFile("myapp/src/temp.ts", "// temporary file");
      const result = await exec("mv myapp/src/temp.ts myapp/src/helpers.ts");
      expect(result.exitCode).toBe(0);
      expect(await exists("myapp/src/temp.ts")).toBe(false);
      expect(await exists("myapp/src/helpers.ts")).toBe(true);
    });
  });

  // =====================================================================
  // PHASE 4: Build simulation
  // Agent runs build commands (Container exec in production)
  // =====================================================================

  describe("Phase 4: Build and tooling", () => {
    it("non-builtin commands report exit 127 without container", async () => {
      // In test env (no container), npm/tsc/node return 127
      // In production with container, these would actually execute
      const npm = await exec("npm install");
      expect(npm.exitCode).toBe(127);
      expect(npm.stderr).toContain("command not found");

      const tsc = await exec("tsc --noEmit");
      expect(tsc.exitCode).toBe(127);

      const node = await exec("node dist/index.js");
      expect(node.exitCode).toBe(127);
    });

    it("builtin commands still work alongside container commands", async () => {
      // Even without container, builtins work — agent can still inspect
      const ls = await exec("ls myapp/src");
      expect(ls.exitCode).toBe(0);
      expect(ls.stdout).toContain("index.ts");
      expect(ls.stdout).toContain("utils.ts");
      expect(ls.stdout).toContain("math.ts");
    });

    it("grep across source files to find imports", async () => {
      const result = await exec("grep import myapp/src/index.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("utils");
      expect(result.stdout).toContain("math");
    });
  });

  // =====================================================================
  // PHASE 5: Workspace management
  // Agent manages multiple files, cleans up
  // =====================================================================

  describe("Phase 5: Workspace management", () => {
    it("creates .gitignore", async () => {
      await writeFile(
        "myapp/.gitignore",
        ["node_modules/", "dist/", ".env", "*.backup.ts", ""].join("\n"),
      );
      const content = await readFile("myapp/.gitignore");
      expect(content.content).toContain("node_modules");
      expect(content.content).toContain("dist");
    });

    it("creates README.md", async () => {
      await writeFile(
        "myapp/README.md",
        [
          "# myapp",
          "",
          "A sample TypeScript project scaffolded by AI agent on nodemode.",
          "",
          "## Usage",
          "",
          "```bash",
          "npm install",
          "npm run build",
          "npm start",
          "```",
          "",
        ].join("\n"),
      );
      const content = await readFile("myapp/README.md");
      expect(content.content).toContain("myapp");
    });

    it("verifies final project structure", async () => {
      const root = await readdir("myapp");
      const names = root.map((e) => e.name);

      // Expected files and directories
      expect(names).toContain("package.json");
      expect(names).toContain("tsconfig.json");
      expect(names).toContain("README.md");
      expect(names).toContain("src");
      expect(names).toContain("test");
      expect(names).toContain("dist");
    });

    it("verifies all source files exist", async () => {
      const files = [
        "myapp/src/index.ts",
        "myapp/src/utils.ts",
        "myapp/src/math.ts",
        "myapp/test/utils.test.ts",
        "myapp/test/math.test.ts",
        "myapp/package.json",
        "myapp/tsconfig.json",
      ];
      for (const f of files) {
        expect(await exists(f)).toBe(true);
      }
    });

    it("cleans up backup files", async () => {
      const rm = await exec("rm myapp/src/utils.backup.ts");
      expect(rm.exitCode).toBe(0);
      expect(await exists("myapp/src/utils.backup.ts")).toBe(false);
    });

    it("cleans up helper file", async () => {
      const rm = await exec("rm myapp/src/helpers.ts");
      expect(rm.exitCode).toBe(0);
      expect(await exists("myapp/src/helpers.ts")).toBe(false);
    });
  });
});
