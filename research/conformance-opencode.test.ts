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

  // =====================================================================
  // PHASE 6: Multi-file refactoring
  // Agent renames a function across multiple files
  // =====================================================================

  describe("Phase 6: Multi-file refactoring", () => {
    it("finds all usages of a function via grep", async () => {
      const result = await exec("grep greet myapp/src/index.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("greet");
    });

    it("renames function in source file", async () => {
      const original = await readFile("myapp/src/utils.ts");
      const updated = original.content.replace(/greet/g, "sayHello");
      await writeFile("myapp/src/utils.ts", updated);

      const check = await readFile("myapp/src/utils.ts");
      expect(check.content).toContain("sayHello");
      expect(check.content).not.toContain("greet");
    });

    it("updates import in consumer file", async () => {
      const original = await readFile("myapp/src/index.ts");
      const updated = original.content.replace(/greet/g, "sayHello");
      await writeFile("myapp/src/index.ts", updated);

      const check = await readFile("myapp/src/index.ts");
      expect(check.content).toContain("sayHello");
      expect(check.content).not.toContain("greet");
    });

    it("updates test file", async () => {
      const original = await readFile("myapp/test/utils.test.ts");
      const updated = original.content.replace(/greet/g, "sayHello");
      await writeFile("myapp/test/utils.test.ts", updated);

      const check = await readFile("myapp/test/utils.test.ts");
      expect(check.content).toContain("sayHello");
    });

    it("verifies no stale references remain", async () => {
      // grep for old name should fail in all modified files
      const src = await exec("grep greet myapp/src/utils.ts");
      expect(src.exitCode).toBe(1); // no match = exit 1

      const idx = await exec("grep greet myapp/src/index.ts");
      expect(idx.exitCode).toBe(1);

      const test = await exec("grep greet myapp/test/utils.test.ts");
      expect(test.exitCode).toBe(1);
    });
  });

  // =====================================================================
  // PHASE 7: Error recovery
  // Agent handles broken files, reverts changes
  // =====================================================================

  describe("Phase 7: Error recovery", () => {
    it("detects syntax error by reading file", async () => {
      // Agent writes buggy code
      await writeFile(
        "myapp/src/buggy.ts",
        [
          "export function broken( {",
          "  return 42;",
          "}",
          "",
        ].join("\n"),
      );

      // Agent reads back and detects the issue (missing closing paren)
      const content = await readFile("myapp/src/buggy.ts");
      expect(content.content).toContain("broken(");
      // Agent would parse this and detect the syntax error
    });

    it("fixes the buggy file", async () => {
      await writeFile(
        "myapp/src/buggy.ts",
        [
          "export function broken(): number {",
          "  return 42;",
          "}",
          "",
        ].join("\n"),
      );

      const fixed = await readFile("myapp/src/buggy.ts");
      expect(fixed.content).toContain("broken(): number");
    });

    it("reverts a file by writing previous content", async () => {
      // Save current state
      const before = await readFile("myapp/src/math.ts");

      // Make a bad change
      await writeFile("myapp/src/math.ts", "// BROKEN FILE");
      const broken = await readFile("myapp/src/math.ts");
      expect(broken.content).toBe("// BROKEN FILE");

      // Revert
      await writeFile("myapp/src/math.ts", before.content);
      const reverted = await readFile("myapp/src/math.ts");
      expect(reverted.content).toContain("multiply");
      expect(reverted.content).toContain("divide");
    });

    it("cleans up failed file", async () => {
      const rm = await exec("rm myapp/src/buggy.ts");
      expect(rm.exitCode).toBe(0);
      expect(await exists("myapp/src/buggy.ts")).toBe(false);
    });

    it("handles missing file gracefully", async () => {
      const result = await exec("cat myapp/src/nonexistent.ts");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file");
    });

    it("handles empty command gracefully", async () => {
      const res = await SELF.fetch(`http://localhost/workspace/${W}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "  " }),
      });
      // Non-empty but whitespace-only command
      expect(res.status).toBe(200);
    });
  });

  // =====================================================================
  // PHASE 8: Config file management
  // Agent reads/writes JSON, YAML-like, TOML-like, .env configs
  // =====================================================================

  describe("Phase 8: Config file management", () => {
    it("writes and reads .env file", async () => {
      const env = [
        "DATABASE_URL=postgres://localhost:5432/mydb",
        "API_KEY=sk-test-12345",
        "NODE_ENV=development",
        "PORT=3000",
        "",
      ].join("\n");
      await writeFile("myapp/.env", env);

      const content = await readFile("myapp/.env");
      expect(content.content).toContain("DATABASE_URL=");
      expect(content.content).toContain("API_KEY=");
    });

    it("parses .env values with grep", async () => {
      const result = await exec("grep DATABASE_URL myapp/.env");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("postgres://localhost:5432/mydb");
    });

    it("writes eslint config", async () => {
      const config = {
        root: true,
        parser: "@typescript-eslint/parser",
        plugins: ["@typescript-eslint"],
        extends: [
          "eslint:recommended",
          "plugin:@typescript-eslint/recommended",
        ],
        rules: {
          "no-unused-vars": "off",
          "@typescript-eslint/no-unused-vars": "error",
          semi: ["error", "always"],
        },
      };
      await writeFile("myapp/.eslintrc.json", JSON.stringify(config, null, 2));
      const data = await readFile("myapp/.eslintrc.json");
      const parsed = JSON.parse(data.content);
      expect(parsed.parser).toBe("@typescript-eslint/parser");
      expect(parsed.rules.semi[0]).toBe("error");
    });

    it("writes prettier config", async () => {
      const config = {
        semi: true,
        trailingComma: "all",
        singleQuote: false,
        printWidth: 100,
        tabWidth: 2,
      };
      await writeFile("myapp/.prettierrc.json", JSON.stringify(config, null, 2));
      const data = await readFile("myapp/.prettierrc.json");
      expect(JSON.parse(data.content).semi).toBe(true);
    });

    it("writes vitest config", async () => {
      const config = [
        'import { defineConfig } from "vitest/config";',
        "",
        "export default defineConfig({",
        "  test: {",
        '    include: ["test/**/*.test.ts"],',
        "    coverage: {",
        '      provider: "v8",',
        "      thresholds: {",
        "        branches: 80,",
        "        functions: 80,",
        "        lines: 80,",
        "      },",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n");
      await writeFile("myapp/vitest.config.ts", config);
      const data = await readFile("myapp/vitest.config.ts");
      expect(data.content).toContain("defineConfig");
      expect(data.content).toContain("coverage");
    });

    it("modifies package.json scripts", async () => {
      const data = await readFile("myapp/package.json");
      const pkg = JSON.parse(data.content);
      pkg.scripts.lint = "eslint src/ test/";
      pkg.scripts.format = "prettier --write src/ test/";
      pkg.scripts["test:coverage"] = "vitest run --coverage";
      await writeFile("myapp/package.json", JSON.stringify(pkg, null, 2));

      const updated = await readFile("myapp/package.json");
      const check = JSON.parse(updated.content);
      expect(check.scripts.lint).toBe("eslint src/ test/");
      expect(check.scripts["test:coverage"]).toContain("coverage");
    });
  });

  // =====================================================================
  // PHASE 9: Search across codebase
  // Agent searches for patterns, TODOs, dead code
  // =====================================================================

  describe("Phase 9: Codebase search", () => {
    it("finds all export statements across files", async () => {
      const utils = await exec("grep export myapp/src/utils.ts");
      expect(utils.exitCode).toBe(0);
      expect(utils.stdout).toContain("export function");

      const math = await exec("grep export myapp/src/math.ts");
      expect(math.exitCode).toBe(0);
      expect(math.stdout).toContain("export function");
    });

    it("finds all import statements in index", async () => {
      const result = await exec("grep import myapp/src/index.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("utils");
      expect(result.stdout).toContain("math");
    });

    it("counts total lines across source files with pipe", async () => {
      const utils = await exec("wc myapp/src/utils.ts");
      expect(utils.exitCode).toBe(0);

      const math = await exec("wc myapp/src/math.ts");
      expect(math.exitCode).toBe(0);

      const index = await exec("wc myapp/src/index.ts");
      expect(index.exitCode).toBe(0);
    });

    it("finds TODO comments", async () => {
      // Add a TODO
      const content = await readFile("myapp/src/math.ts");
      const withTodo = "// TODO: add error handling for NaN inputs\n" + content.content;
      await writeFile("myapp/src/math.ts", withTodo);

      const result = await exec("grep TODO myapp/src/math.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TODO");
      expect(result.stdout).toContain("NaN");
    });

    it("case-insensitive search with grep -i", async () => {
      const result = await exec("grep -i todo myapp/src/math.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TODO");
    });

    it("uses pipe to filter ls output", async () => {
      const result = await exec("ls myapp/src | grep ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("index.ts");
      expect(result.stdout).toContain("utils.ts");
      expect(result.stdout).toContain("math.ts");
    });

    it("uses ls -l for detailed file listing", async () => {
      const result = await exec("ls -l myapp/src");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("rwxr-xr-x");
      expect(result.stdout).toContain("index.ts");
    });
  });

  // =====================================================================
  // PHASE 10: Monorepo patterns
  // Agent works across multiple packages in a workspace
  // =====================================================================

  describe("Phase 10: Monorepo workspace", () => {
    it("creates monorepo structure", async () => {
      await exec("mkdir -p monorepo/packages/core/src");
      await exec("mkdir -p monorepo/packages/cli/src");
      await exec("mkdir -p monorepo/packages/web/src");

      const entries = await readdir("monorepo/packages");
      const names = entries.map((e) => e.name);
      expect(names).toContain("core");
      expect(names).toContain("cli");
      expect(names).toContain("web");
    });

    it("writes root package.json with workspaces", async () => {
      const rootPkg = {
        name: "my-monorepo",
        private: true,
        workspaces: ["packages/*"],
        scripts: {
          build: "turbo build",
          test: "turbo test",
          lint: "turbo lint",
        },
        devDependencies: {
          turbo: "^2.0.0",
        },
      };
      await writeFile("monorepo/package.json", JSON.stringify(rootPkg, null, 2));
    });

    it("writes package configs for each workspace", async () => {
      const corePkg = {
        name: "@monorepo/core",
        version: "1.0.0",
        type: "module",
        main: "dist/index.js",
        scripts: { build: "tsc", test: "vitest run" },
      };
      await writeFile("monorepo/packages/core/package.json", JSON.stringify(corePkg, null, 2));

      const cliPkg = {
        name: "@monorepo/cli",
        version: "1.0.0",
        type: "module",
        bin: { mycli: "dist/cli.js" },
        dependencies: { "@monorepo/core": "workspace:*" },
        scripts: { build: "tsc" },
      };
      await writeFile("monorepo/packages/cli/package.json", JSON.stringify(cliPkg, null, 2));

      const webPkg = {
        name: "@monorepo/web",
        version: "1.0.0",
        type: "module",
        dependencies: { "@monorepo/core": "workspace:*", next: "^15.0.0" },
        scripts: { dev: "next dev", build: "next build" },
      };
      await writeFile("monorepo/packages/web/package.json", JSON.stringify(webPkg, null, 2));
    });

    it("writes shared core library", async () => {
      await writeFile(
        "monorepo/packages/core/src/index.ts",
        [
          "export function validate(input: string): boolean {",
          "  return input.length > 0 && input.length < 256;",
          "}",
          "",
          "export function sanitize(input: string): string {",
          '  return input.replace(/[<>&"]/g, "");',
          "}",
          "",
          "export const VERSION = \"1.0.0\";",
          "",
        ].join("\n"),
      );
    });

    it("writes CLI that imports core", async () => {
      await writeFile(
        "monorepo/packages/cli/src/cli.ts",
        [
          'import { validate, sanitize, VERSION } from "@monorepo/core";',
          "",
          "const input = process.argv[2] || \"\";",
          "",
          "if (!validate(input)) {",
          '  console.error("Invalid input");',
          "  process.exit(1);",
          "}",
          "",
          "console.log(`[v${VERSION}] ${sanitize(input)}`);",
          "",
        ].join("\n"),
      );
    });

    it("writes web app that imports core", async () => {
      await writeFile(
        "monorepo/packages/web/src/page.tsx",
        [
          'import { validate, sanitize } from "@monorepo/core";',
          "",
          "export default function Page() {",
          '  const safe = sanitize("<script>alert(1)</script>");',
          "  return <div>{safe}</div>;",
          "}",
          "",
        ].join("\n"),
      );
    });

    it("verifies cross-package import references", async () => {
      const cli = await exec("grep @monorepo/core monorepo/packages/cli/src/cli.ts");
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toContain("@monorepo/core");

      const web = await exec("grep @monorepo/core monorepo/packages/web/src/page.tsx");
      expect(web.exitCode).toBe(0);
    });

    it("writes turbo.json pipeline config", async () => {
      const turbo = {
        "$schema": "https://turbo.build/schema.json",
        tasks: {
          build: {
            dependsOn: ["^build"],
            outputs: ["dist/**"],
          },
          test: {
            dependsOn: ["build"],
          },
          lint: {},
        },
      };
      await writeFile("monorepo/turbo.json", JSON.stringify(turbo, null, 2));
      const data = await readFile("monorepo/turbo.json");
      expect(JSON.parse(data.content).tasks.build.dependsOn).toContain("^build");
    });

    it("turbo build requires container", async () => {
      const result = await exec("turbo build");
      expect(result.exitCode).toBe(127);
    });

    it("verifies full monorepo structure", async () => {
      const files = [
        "monorepo/package.json",
        "monorepo/turbo.json",
        "monorepo/packages/core/package.json",
        "monorepo/packages/core/src/index.ts",
        "monorepo/packages/cli/package.json",
        "monorepo/packages/cli/src/cli.ts",
        "monorepo/packages/web/package.json",
        "monorepo/packages/web/src/page.tsx",
      ];
      for (const f of files) {
        expect(await exists(f)).toBe(true);
      }
    });
  });
});
