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
import { createHelpers } from "../test/helpers";

const { exec, execRaw, writeFile, readFile, readdir, stat, exists, init } = createHelpers("conformance-opencode");

describe("opencode/AI agent conformance", () => {
  beforeAll(async () => {
    await init("test", "opencode-conformance");
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
      // In test env (no container), npm/tsc return 127
      // In production with container, these would actually execute
      const npm = await exec("npm install");
      expect(npm.exitCode).toBe(127);
      expect(npm.stderr).toContain("command not found");

      const tsc = await exec("tsc --noEmit");
      expect(tsc.exitCode).toBe(127);
    });

    it("node executes JS in-DO via JsRunner, returns error for missing module", async () => {
      const node = await exec("node dist/index.js");
      expect(node.exitCode).toBe(1);
      expect(node.stderr).toContain("Cannot find module");
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
      const res = await execRaw("  ");
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
      expect(result.stdout).toContain("rw-r--r--");
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

  // =====================================================================
  // PHASE 11: In-DO code execution (JsRunner / Tier 2)
  // Agent writes JS and runs it with `node` — no container needed
  // =====================================================================

  describe("Phase 11: In-DO code execution", () => {
    it("runs a simple script with node", async () => {
      await writeFile("myapp/scripts/hello.js", 'console.log("hello from script");');
      const result = await exec("node myapp/scripts/hello.js");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello from script");
    });

    it("runs script that requires a local module", async () => {
      await writeFile("myapp/scripts/lib.js", [
        "module.exports.sum = (a, b) => a + b;",
      ].join("\n"));
      await writeFile("myapp/scripts/calc.js", [
        'const { sum } = require("./lib");',
        "console.log(sum(10, 20));",
      ].join("\n"));
      const result = await exec("node myapp/scripts/calc.js");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("30");
    });

    it("runs script with process.argv", async () => {
      await writeFile("myapp/scripts/args.js", [
        "const args = process.argv.slice(2);",
        'console.log("args:" + args.join(","));',
      ].join("\n"));
      const result = await exec("node myapp/scripts/args.js foo bar baz");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("args:foo,bar,baz");
    });

    it("runs node -e for inline evaluation", async () => {
      const result = await exec('node -e "console.log(JSON.stringify({a:1,b:2}))"');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ a: 1, b: 2 });
    });

    it("runs script that reads files via fs module", async () => {
      await writeFile("myapp/scripts/read-pkg.js", [
        'const fs = require("fs");',
        'const pkg = JSON.parse(fs.readFileSync("myapp/package.json", "utf-8"));',
        "console.log(pkg.name);",
      ].join("\n"));
      const result = await exec("node myapp/scripts/read-pkg.js");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("myapp");
    });

    it("runs script that uses path module", async () => {
      await writeFile("myapp/scripts/path-test.js", [
        'const path = require("path");',
        'console.log(path.join("src", "utils.ts"));',
        'console.log(path.basename("/foo/bar/baz.txt"));',
        'console.log(path.extname("index.ts"));',
      ].join("\n"));
      const result = await exec("node myapp/scripts/path-test.js");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines[0]).toBe("src/utils.ts");
      expect(lines[1]).toBe("baz.txt");
      expect(lines[2]).toBe(".ts");
    });

    it("script exits with non-zero on error", async () => {
      await writeFile("myapp/scripts/fail.js", [
        "process.exit(42);",
      ].join("\n"));
      const result = await exec("node myapp/scripts/fail.js");
      expect(result.exitCode).toBe(42);
    });

    it("script stderr captured separately", async () => {
      await writeFile("myapp/scripts/stderr.js", [
        'console.log("out");',
        'console.error("err");',
      ].join("\n"));
      const result = await exec("node myapp/scripts/stderr.js");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("out");
      expect(result.stderr).toContain("err");
    });
  });

  // =====================================================================
  // PHASE 12: Binary file detection and large file handling
  // Agent detects binary files and handles large outputs
  // =====================================================================

  describe("Phase 12: Binary and large file handling", () => {
    it("writes and reads a file with null bytes (binary detection)", async () => {
      // Opencode detects binary files by checking for null bytes
      // Write a file with binary content (base64-encoded null bytes)
      await writeFile("myapp/dist/binary.dat", "hello\x00world");
      const content = await readFile("myapp/dist/binary.dat");
      // File should be readable (nodemode stores text)
      expect(content.content).toContain("hello");
    });

    it("handles large file content", async () => {
      // Opencode caps reads at ~50KB / 2000 lines
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(80)}`);
      await writeFile("myapp/dist/large.txt", lines.join("\n"));
      const content = await readFile("myapp/dist/large.txt");
      expect(content.content).toContain("line 0:");
      expect(content.content).toContain("line 99:");
    });

    it("handles large command output", async () => {
      // Generate large output — agent needs to handle truncation
      const script = Array.from({ length: 200 }, (_, i) => `console.log("line-${i}");`).join("\n");
      await writeFile("myapp/scripts/verbose.js", script);
      const result = await exec("node myapp/scripts/verbose.js");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line-0");
      expect(result.stdout).toContain("line-199");
    });
  });

  // =====================================================================
  // PHASE 13: Symlink security boundary
  // Agent must not escape workspace via symlinks
  // =====================================================================

  describe("Phase 13: Symlink and path traversal security", () => {
    it("rejects path traversal in file read", async () => {
      const res = await execRaw("cat ../../../etc/passwd");
      const data = (await res.json()) as { exitCode: number; stderr: string };
      expect(data.exitCode).toBe(1);
    });

    it("rejects path traversal in file write", async () => {
      const res = await SELF.fetch(
        `http://localhost/workspace/conformance-opencode/fs/write`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "../../../tmp/escape.txt", content: "escaped" }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("rejects path traversal with encoded dots", async () => {
      const result = await exec("cat ..%2F..%2Fetc/passwd");
      expect(result.exitCode).toBe(1);
    });

    it("rejects absolute path escape", async () => {
      const result = await exec("cat /etc/passwd");
      expect(result.exitCode).toBe(1);
    });
  });

  // =====================================================================
  // PHASE 14: Complex piping and chaining
  // Agent builds command pipelines like opencode's bash tool
  // =====================================================================

  describe("Phase 14: Complex piping and chaining", () => {
    it("multi-stage pipe: ls | grep | wc", async () => {
      const result = await exec("ls myapp/src | grep ts | wc");
      expect(result.exitCode).toBe(0);
      // Should count the .ts files
      const count = parseInt(result.stdout.trim().split(/\s+/)[0], 10);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it("pipe with head: cat file | head -n 3", async () => {
      const result = await exec("cat myapp/src/utils.ts | head -n 3");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines.length).toBe(3);
    });

    it("chained commands with && and ||", async () => {
      const result = await exec("echo step1 && echo step2 && echo step3");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("step1");
      expect(result.stdout).toContain("step2");
      expect(result.stdout).toContain("step3");
    });

    it("|| fallback when first command fails", async () => {
      const result = await exec("false || echo fallback");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("fallback");
    });

    it("semicolon chain runs all regardless of failure", async () => {
      const result = await exec("false; echo still-runs");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("still-runs");
    });

    it("pipe with grep -c for counting matches", async () => {
      const result = await exec("grep -c export myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      expect(parseInt(result.stdout.trim(), 10)).toBeGreaterThanOrEqual(2);
    });
  });

  // =====================================================================
  // PHASE 15: Environment variables and working directory
  // Agent passes env vars and cwd to commands (opencode workdir param)
  // =====================================================================

  describe("Phase 15: Environment variables and working directory", () => {
    it("passes environment variables to commands", async () => {
      await writeFile("myapp/scripts/env-test.js", [
        "console.log(process.env.MY_VAR || 'undefined');",
      ].join("\n"));
      const result = await exec("node myapp/scripts/env-test.js", { env: { MY_VAR: "hello-from-env" } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello-from-env");
    });

    it("env vars do not leak between commands", async () => {
      // First command sets env
      await exec("node myapp/scripts/env-test.js", { env: { MY_VAR: "first" } });
      // Second command without env should not see it
      const result = await exec("node myapp/scripts/env-test.js");
      expect(result.stdout.trim()).toBe("undefined");
    });

    it("pwd returns workspace root", async () => {
      const result = await exec("pwd");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("/");
    });

    it("env command runs", async () => {
      const result = await exec("env");
      expect(result.exitCode).toBe(0);
    });
  });

  // =====================================================================
  // PHASE 16: Recursive grep (ripgrep-style search)
  // Agent searches across entire codebase
  // =====================================================================

  describe("Phase 16: Recursive codebase search", () => {
    it("grep -r searches recursively across files", async () => {
      const result = await exec("grep -r export myapp/src");
      expect(result.exitCode).toBe(0);
      // Each line should be file:content format
      const lines = result.stdout.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(line).toContain(":");
        expect(line).toContain("export");
      }
    });

    it("grep -rn shows line numbers with file prefix", async () => {
      const result = await exec("grep -rn export myapp/src");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      // Format: file:linenum:content
      for (const line of lines) {
        const parts = line.split(":");
        expect(parts.length).toBeGreaterThanOrEqual(3);
        expect(parseInt(parts[1], 10)).toBeGreaterThan(0);
      }
    });

    it("grep -rl lists only matching filenames", async () => {
      const result = await exec("grep -rl export myapp/src");
      expect(result.exitCode).toBe(0);
      const files = result.stdout.trim().split("\n");
      expect(files.length).toBeGreaterThanOrEqual(2);
      // Should be filenames only, no colons (no content)
      for (const file of files) {
        expect(file).not.toContain(":");
      }
    });

    it("grep -v inverts match", async () => {
      const result = await exec("grep -v export myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      // Should return lines that don't contain "export"
      for (const line of result.stdout.trim().split("\n")) {
        if (line.trim()) {
          expect(line).not.toContain("export");
        }
      }
    });

    it("grep with regex pattern", async () => {
      const result = await exec("grep 'function.*number' myapp/src/math.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("function");
    });

    it("grep -n shows line numbers for single file", async () => {
      const result = await exec("grep -n export myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        // Format: linenum:content
        const colonIdx = line.indexOf(":");
        expect(colonIdx).toBeGreaterThan(0);
        const lineNum = parseInt(line.slice(0, colonIdx), 10);
        expect(lineNum).toBeGreaterThan(0);
        expect(line.slice(colonIdx + 1)).toContain("export");
      }
    });

    it("grep -c counts matches", async () => {
      const result = await exec("grep -c export myapp/src/utils.ts");
      expect(result.exitCode).toBe(0);
      expect(parseInt(result.stdout.trim(), 10)).toBeGreaterThanOrEqual(2);
    });
  });

  // =====================================================================
  // PHASE 17: sed-like find-and-replace (opencode edit tool)
  // Agent does in-place text replacement across files
  // =====================================================================

  describe("Phase 17: Find-and-replace editing", () => {
    it("agent reads file, replaces content, writes back", async () => {
      const original = await readFile("myapp/src/math.ts");
      const updated = original.content.replace("multiply", "mul");
      await writeFile("myapp/src/math.ts", updated);

      const check = await readFile("myapp/src/math.ts");
      expect(check.content).toContain("function mul(");
      expect(check.content).not.toContain("function multiply(");

      // Revert for other tests
      await writeFile("myapp/src/math.ts", original.content);
    });

    it("agent applies multi-line replacement", async () => {
      const original = await readFile("myapp/src/math.ts");

      // Add a new function
      const additions = original.content + [
        "",
        "export function square(n: number): number {",
        "  return n * n;",
        "}",
        "",
      ].join("\n");
      await writeFile("myapp/src/math.ts", additions);

      const check = await readFile("myapp/src/math.ts");
      expect(check.content).toContain("square");
      expect(check.content).toContain("multiply"); // original preserved

      // Revert
      await writeFile("myapp/src/math.ts", original.content);
    });

    it("agent does search-and-replace across multiple files", async () => {
      // Rename VERSION constant in core to APP_VERSION
      const coreSrc = await readFile("monorepo/packages/core/src/index.ts");
      const cliSrc = await readFile("monorepo/packages/cli/src/cli.ts");

      const updatedCore = coreSrc.content.replace(/VERSION/g, "APP_VERSION");
      const updatedCli = cliSrc.content.replace(/VERSION/g, "APP_VERSION");

      await writeFile("monorepo/packages/core/src/index.ts", updatedCore);
      await writeFile("monorepo/packages/cli/src/cli.ts", updatedCli);

      // Verify
      const checkCore = await exec("grep APP_VERSION monorepo/packages/core/src/index.ts");
      expect(checkCore.exitCode).toBe(0);
      const checkCli = await exec("grep APP_VERSION monorepo/packages/cli/src/cli.ts");
      expect(checkCli.exitCode).toBe(0);

      // No stale references — use exact pattern to check old name is gone
      const staleCore = await exec("grep VERSION monorepo/packages/core/src/index.ts");
      // All VERSION occurrences should now be APP_VERSION
      for (const line of staleCore.stdout.trim().split("\n")) {
        if (line.trim()) expect(line).toContain("APP_VERSION");
      }

      // Revert
      await writeFile("monorepo/packages/core/src/index.ts", coreSrc.content);
      await writeFile("monorepo/packages/cli/src/cli.ts", cliSrc.content);
    });
  });

  // =====================================================================
  // PHASE 18: Concurrent operations
  // Agent issues parallel reads/writes (opencode does this)
  // =====================================================================

  describe("Phase 18: Concurrent file operations", () => {
    it("parallel reads return correct content", async () => {
      const [utils, math, index] = await Promise.all([
        readFile("myapp/src/utils.ts"),
        readFile("myapp/src/math.ts"),
        readFile("myapp/src/index.ts"),
      ]);
      expect(utils.content).toContain("sayHello");
      expect(math.content).toContain("multiply");
      expect(index.content).toContain("import");
    });

    it("parallel writes followed by reads are consistent", async () => {
      // Write 5 files in parallel
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          writeFile(`myapp/dist/parallel-${i}.txt`, `content-${i}`),
        ),
      );

      // Read them back in parallel
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          readFile(`myapp/dist/parallel-${i}.txt`),
        ),
      );

      for (let i = 0; i < 5; i++) {
        expect(results[i].content).toBe(`content-${i}`);
      }

      // Clean up
      for (let i = 0; i < 5; i++) {
        await exec(`rm myapp/dist/parallel-${i}.txt`);
      }
    });

    it("parallel exec commands complete independently", async () => {
      const [echo1, echo2, echo3] = await Promise.all([
        exec("echo parallel-1"),
        exec("echo parallel-2"),
        exec("echo parallel-3"),
      ]);
      expect(echo1.stdout.trim()).toBe("parallel-1");
      expect(echo2.stdout.trim()).toBe("parallel-2");
      expect(echo3.stdout.trim()).toBe("parallel-3");
    });
  });

  // =====================================================================
  // PHASE 19: Diff generation (opencode generates diffs for review)
  // Agent compares file versions
  // =====================================================================

  describe("Phase 19: Diff and version comparison", () => {
    it("detects changes between file versions", async () => {
      const before = await readFile("myapp/src/utils.ts");

      // Modify the file
      const modified = before.content.replace("sayHello", "greetPerson");
      await writeFile("myapp/src/utils.ts", modified);
      const after = await readFile("myapp/src/utils.ts");

      // Agent compares versions
      expect(before.content).toContain("sayHello");
      expect(after.content).toContain("greetPerson");
      expect(before.content).not.toBe(after.content);

      // Revert
      await writeFile("myapp/src/utils.ts", before.content);
    });

    it("tracks file creation and deletion", async () => {
      // Create
      expect(await exists("myapp/src/newfile.ts")).toBe(false);
      await writeFile("myapp/src/newfile.ts", "export const NEW = true;");
      expect(await exists("myapp/src/newfile.ts")).toBe(true);

      // Delete
      const rm = await exec("rm myapp/src/newfile.ts");
      expect(rm.exitCode).toBe(0);
      expect(await exists("myapp/src/newfile.ts")).toBe(false);
    });

    it("detects file size changes via stat", async () => {
      const before = await stat("myapp/src/utils.ts");

      // Append content
      const content = await readFile("myapp/src/utils.ts");
      const expanded = content.content + "\n// Added comment for size change\n";
      await writeFile("myapp/src/utils.ts", expanded);

      const after = await stat("myapp/src/utils.ts");
      expect(after.size).toBeGreaterThan(before.size);

      // Revert
      await writeFile("myapp/src/utils.ts", content.content);
    });
  });

  // =====================================================================
  // PHASE 20: HTTP requests (opencode webfetch tool)
  // Agent makes HTTP requests to external services
  // =====================================================================

  describe("Phase 20: HTTP requests from user code", () => {
    it("http.request is available and functional", async () => {
      await writeFile("myapp/scripts/http-test.js", [
        'const http = require("http");',
        "console.log(typeof http.request);",
        "console.log(typeof http.get);",
        "console.log(typeof http.createServer);",
      ].join("\n"));
      const result = await exec("node myapp/scripts/http-test.js");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines[0]).toBe("function");
      expect(lines[1]).toBe("function");
      expect(lines[2]).toBe("function");
    });

    it("worker_threads available for parallel computation", async () => {
      await writeFile("myapp/scripts/wt-check.js", [
        'const { isMainThread, Worker } = require("worker_threads");',
        'console.log("main:" + isMainThread);',
        'console.log("hasWorker:" + (typeof Worker === "function"));',
      ].join("\n"));
      const result = await exec("node myapp/scripts/wt-check.js");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("main:true");
      expect(result.stdout).toContain("hasWorker:true");
    });
  });

  // =====================================================================
  // PHASE 21: Edge cases from real agent sessions
  // Corner cases that break real AI coding agents
  // =====================================================================

  describe("Phase 21: Agent edge cases", () => {
    it("handles file with unicode content", async () => {
      await writeFile("myapp/src/i18n.ts", [
        "export const messages = {",
        '  en: "Hello",',
        '  zh: "你好",',
        '  ja: "こんにちは",',
        '  ko: "안녕하세요",',
        '  ar: "مرحبا",',
        '  emoji: "👋🌍",',
        "};",
        "",
      ].join("\n"));
      const content = await readFile("myapp/src/i18n.ts");
      expect(content.content).toContain("你好");
      expect(content.content).toContain("こんにちは");
      expect(content.content).toContain("👋🌍");

      await exec("rm myapp/src/i18n.ts");
    });

    it("handles deeply nested directory creation", async () => {
      const result = await exec("mkdir -p myapp/deep/a/b/c/d/e/f");
      expect(result.exitCode).toBe(0);
      expect(await exists("myapp/deep/a/b/c/d/e/f")).toBe(true);

      await exec("rm -rf myapp/deep");
    });

    it("handles file with very long lines", async () => {
      const longLine = "x".repeat(5000);
      await writeFile("myapp/dist/longline.txt", longLine);
      const content = await readFile("myapp/dist/longline.txt");
      expect(content.content.length).toBe(5000);
      await exec("rm myapp/dist/longline.txt");
    });

    it("handles empty file", async () => {
      await writeFile("myapp/dist/empty.txt", "");
      const s = await stat("myapp/dist/empty.txt");
      expect(s.size).toBe(0);
      await exec("rm myapp/dist/empty.txt");
    });

    it("handles rapid successive writes to same file", async () => {
      for (let i = 0; i < 10; i++) {
        await writeFile("myapp/dist/rapid.txt", `version-${i}`);
      }
      const content = await readFile("myapp/dist/rapid.txt");
      expect(content.content).toBe("version-9");
      await exec("rm myapp/dist/rapid.txt");
    });

    it("handles special characters in filenames", async () => {
      await writeFile("myapp/dist/file with spaces.txt", "spaces");
      const content = await readFile("myapp/dist/file with spaces.txt");
      expect(content.content).toBe("spaces");

      const cat = await exec("cat 'myapp/dist/file with spaces.txt'");
      expect(cat.stdout).toBe("spaces");

      await exec("rm 'myapp/dist/file with spaces.txt'");
    });

    it("echo with special characters", async () => {
      const result = await exec('echo "hello\tworld"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello");
      expect(result.stdout).toContain("world");
    });

    it("handles JSON with nested quotes in echo", async () => {
      const result = await exec("echo '{\"key\":\"value\"}'");
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.key).toBe("value");
    });
  });
});
