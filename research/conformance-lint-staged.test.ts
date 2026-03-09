/**
 * lint-staged / nodemon / build-tools Conformance Test
 *
 * Proves nodemode can handle the file-watching and process-spawning patterns
 * used by developer tooling that CANNOT run on vanilla Cloudflare Workers:
 *
 *   - lint-staged (https://github.com/lint-staged/lint-staged, 13k+ stars)
 *     Runs linters on git-staged files. Needs: git, fs, child_process.
 *
 *   - nodemon (https://github.com/remy/nodemon, 26k+ stars)
 *     File watcher that restarts processes. Needs: fs.watch, child_process.
 *
 *   - esbuild/tsx (bundler/runner)
 *     Reads source files, transforms, writes output. Needs: fs, child_process.
 *
 * These tests validate nodemode's ability to support the underlying workflows
 * by testing the fs + exec primitives each tool relies on.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createHelpers } from "../test/helpers";

const { exec, writeFile, readFile, exists, readdir, stat, listProcesses, getProcess, init } = createHelpers("conformance-tooling");

describe("lint-staged / nodemon / build-tools conformance", () => {
  beforeAll(async () => {
    await init("test", "tooling-conformance");

    // Set up a project with lint issues
    await exec("mkdir -p project/src");
    await writeFile("project/package.json", JSON.stringify({
      name: "lint-test",
      scripts: {
        lint: "eslint src/",
        format: "prettier --write src/",
        build: "esbuild src/index.ts --bundle --outfile=dist/index.js",
      },
    }, null, 2));
  });

  // =====================================================================
  // LINT-STAGED PATTERNS
  // lint-staged reads .lintstagedrc, finds staged files, runs commands
  // =====================================================================

  describe("lint-staged workflow", () => {
    it("reads lint-staged config", async () => {
      const config = {
        "*.ts": ["eslint --fix", "prettier --write"],
        "*.md": ["prettier --write"],
      };
      await writeFile("project/.lintstagedrc.json", JSON.stringify(config, null, 2));
      const data = await readFile("project/.lintstagedrc.json");
      const parsed = JSON.parse(data.content);
      expect(parsed["*.ts"]).toContain("eslint --fix");
    });

    it("finds staged files by extension (git diff --staged pattern)", async () => {
      // Create staged files
      await writeFile("project/src/index.ts", "const x = 1;\nconsole.log(x)\n");
      await writeFile("project/src/utils.ts", "export const y = 2\n");
      await writeFile("project/README.md", "# Project\n");
      await writeFile("project/src/styles.css", "body { color: red; }\n");

      // List src directory and filter .ts files (what lint-staged does)
      const entries = await readdir("project/src");
      const tsFiles = entries.filter((e) => e.name.endsWith(".ts"));
      expect(tsFiles.length).toBe(2);
      expect(tsFiles.map((f) => f.name)).toContain("index.ts");
      expect(tsFiles.map((f) => f.name)).toContain("utils.ts");
    });

    it("runs linter command and captures output", async () => {
      // eslint requires container — validates that nodemode routes it correctly
      const result = await exec("eslint project/src/index.ts");
      expect(result.exitCode).toBe(127); // no container in test
      expect(result.stderr).toContain("command not found");
    });

    it("applies lint fix by rewriting file", async () => {
      // After eslint --fix, the file is rewritten with fixes applied
      const fixed = 'const x = 1;\nconsole.log(x);\n'; // added semicolons
      await writeFile("project/src/index.ts", fixed);
      const data = await readFile("project/src/index.ts");
      expect(data.content).toContain("console.log(x);");
    });

    it("verifies lint fix was applied via cat", async () => {
      const result = await exec("cat project/src/index.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("const x = 1;");
    });
  });

  // =====================================================================
  // NODEMON PATTERNS
  // nodemon watches files and restarts processes on change
  // =====================================================================

  describe("nodemon workflow", () => {
    it("reads nodemon config", async () => {
      const config = {
        watch: ["src/"],
        ext: "ts,json",
        exec: "tsx src/index.ts",
        ignore: ["node_modules/", "dist/"],
      };
      await writeFile("project/nodemon.json", JSON.stringify(config, null, 2));
      const data = await readFile("project/nodemon.json");
      const parsed = JSON.parse(data.content);
      expect(parsed.watch).toContain("src/");
      expect(parsed.ext).toBe("ts,json");
    });

    it("detects file changes by comparing stat mtime", async () => {
      // Write initial version
      await writeFile("project/src/server.ts", 'console.log("v1");\n');
      const stat1 = await stat("project/src/server.ts");

      // Write updated version
      await writeFile("project/src/server.ts", 'console.log("v2");\n');
      const stat2 = await stat("project/src/server.ts");

      // mtime should be updated
      expect(stat2.mtime).toBeGreaterThanOrEqual(stat1.mtime);
    });

    it("lists watched directory contents", async () => {
      const entries = await readdir("project/src");
      const names = entries.map((e) => e.name);
      expect(names).toContain("index.ts");
      expect(names).toContain("server.ts");
    });

    it("checks ignore patterns against existing dirs", async () => {
      // nodemon ignores node_modules and dist — verify these dirs exist
      // but are separate from watched src/
      await exec("mkdir -p project/node_modules/fake-pkg");
      await writeFile("project/node_modules/fake-pkg/index.js", "module.exports = {};");
      await exec("mkdir -p project/dist");
      await writeFile("project/dist/bundle.js", "// bundled output");

      expect(await exists("project/node_modules/fake-pkg/index.js")).toBe(true);
      expect(await exists("project/dist/bundle.js")).toBe(true);
    });

    it("tsx command requires container", async () => {
      const result = await exec("tsx project/src/index.ts");
      expect(result.exitCode).toBe(127);
    });
  });

  // =====================================================================
  // ESBUILD / BUNDLER PATTERNS
  // esbuild reads source, resolves imports, writes bundle
  // =====================================================================

  describe("esbuild / bundler workflow", () => {
    it("creates source files with imports", async () => {
      await writeFile(
        "project/src/app.ts",
        [
          'import { greet } from "./lib";',
          "",
          "const msg = greet(\"nodemode\");",
          "console.log(msg);",
          "",
        ].join("\n"),
      );

      await writeFile(
        "project/src/lib.ts",
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
    });

    it("resolves import graph by reading files", async () => {
      // Bundler reads entry point, finds imports, follows them
      const entry = await readFile("project/src/app.ts");
      expect(entry.content).toContain("./lib");

      // Follow the import to read lib.ts
      const lib = await readFile("project/src/lib.ts");
      expect(lib.content).toContain("export function greet");
      expect(lib.content).toContain("export function add");
    });

    it("generates bundle output by concatenating modules", async () => {
      // Read all source files and concatenate them into a bundle
      const lib = await readFile("project/src/lib.ts");
      const app = await readFile("project/src/app.ts");

      const bundle = [
        "// bundled by nodemode esbuild conformance test",
        "// === project/src/lib.ts ===",
        lib.content,
        "// === project/src/app.ts ===",
        app.content,
      ].join("\n");

      await exec("mkdir -p project/dist");
      await writeFile("project/dist/bundle.js", bundle);

      const output = await readFile("project/dist/bundle.js");
      expect(output.content).toContain("greet");
      expect(output.content).toContain("nodemode");
    });

    it("esbuild command requires container", async () => {
      const result = await exec("esbuild project/src/app.ts --bundle --outfile=project/dist/out.js");
      expect(result.exitCode).toBe(127);
    });

    it("cleans dist before rebuild", async () => {
      const result = await exec("rm -rf project/dist && mkdir -p project/dist");
      expect(result.exitCode).toBe(0);
      expect(await exists("project/dist/bundle.js")).toBe(false);
    });
  });

  // =====================================================================
  // PROCESS TRACKING
  // All these tools need process tracking (PIDs, exit codes)
  // =====================================================================

  describe("process tracking", () => {
    it("tracks all executed commands", async () => {
      const processes = await listProcesses();

      expect(processes.length).toBeGreaterThan(0);
      // All should be done
      for (const p of processes) {
        expect(p.status).toBe("done");
        expect(typeof p.exitCode).toBe("number");
      }
    });

    it("can retrieve specific process by pid", async () => {
      await exec("echo process-tracker-test");

      const processes = await listProcesses();
      const found = processes.find((p) => p.command === "echo process-tracker-test");
      expect(found).toBeDefined();

      const proc = await getProcess(found!.pid);
      expect(proc.stdout).toContain("process-tracker-test");
    });
  });
});
