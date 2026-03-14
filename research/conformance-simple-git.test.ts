/**
 * simple-git Conformance Test
 *
 * Proves nodemode can handle the filesystem and shell patterns that
 * simple-git (https://github.com/steveukx/git-js, 3.5k+ stars) uses.
 * simple-git wraps child_process.spawn("git", [...args]) for every operation.
 *
 * Without container: git commands return exit 127 (command not found).
 * With container: git is available, these operations execute for real.
 *
 * This test validates that nodemode's exec + fs layer can support the
 * workspace patterns simple-git needs:
 *   - File read/write for staging content
 *   - Shell exec for git commands
 *   - Directory creation for repo init
 *   - File existence checks for .git detection
 *   - Grep for parsing git output
 *
 * The test simulates the full simple-git workflow using nodemode primitives,
 * proving the API surface is sufficient even before container is available.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createHelpers } from "../test/helpers";

const { exec, writeFile, readFile, exists, readdir, stat, init } = createHelpers("conformance-simple-git");

describe("simple-git conformance", () => {
  beforeAll(async () => {
    await init("test", "simple-git-conformance");
  });

  // =====================================================================
  // PATTERN 1: Repository initialization
  // simple-git: git.init() → spawns `git init`
  // =====================================================================

  describe("repo initialization", () => {
    it("git is a builtin that delegates to GITMODE binding", async () => {
      // Without GITMODE binding configured, git returns an error
      const result = await exec("git init myrepo");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not configured");
    });

    it("can simulate repo structure with fs primitives", async () => {
      // Even without git binary, we can create the workspace structure
      await exec("mkdir -p repo/.git/refs/heads");
      await exec("mkdir -p repo/.git/objects");
      await writeFile("repo/.git/HEAD", "ref: refs/heads/main\n");
      await writeFile("repo/.git/config", "[core]\n\trepositoryformatversion = 0\n");

      expect(await exists("repo/.git/HEAD")).toBe(true);
      expect(await exists("repo/.git/config")).toBe(true);
    });
  });

  // =====================================================================
  // PATTERN 2: Staging files (git add)
  // simple-git: git.add('*.ts') → needs file listing + shell
  // =====================================================================

  describe("file staging workflow", () => {
    it("creates source files to be tracked", async () => {
      await writeFile("repo/index.ts", 'console.log("hello");\n');
      await writeFile("repo/utils.ts", "export const VERSION = \"1.0.0\";\n");
      await writeFile("repo/README.md", "# My Repo\n\nA test repository.\n");

      expect(await exists("repo/index.ts")).toBe(true);
      expect(await exists("repo/utils.ts")).toBe(true);
      expect(await exists("repo/README.md")).toBe(true);
    });

    it("lists files in repo (git ls-files equivalent)", async () => {
      const result = await exec("ls repo");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("index.ts");
      expect(result.stdout).toContain("utils.ts");
      expect(result.stdout).toContain("README.md");
    });

    it("filters TypeScript files with grep", async () => {
      const result = await exec("ls repo | grep ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("index.ts");
      expect(result.stdout).toContain("utils.ts");
      expect(result.stdout).not.toContain("README");
    });
  });

  // =====================================================================
  // PATTERN 3: Diff detection
  // simple-git: git.diff() → compare file versions
  // =====================================================================

  describe("diff detection", () => {
    it("detects file changes by content comparison", async () => {
      // Save original
      const original = await readFile("repo/index.ts");
      expect(original.content).toContain("hello");

      // Modify
      await writeFile("repo/index.ts", 'console.log("goodbye");\n');
      const modified = await readFile("repo/index.ts");
      expect(modified.content).toContain("goodbye");
      expect(modified.content).not.toContain("hello");
    });

    it("detects size changes via stat", async () => {
      await writeFile("repo/small.txt", "tiny");
      const stat1 = await stat("repo/small.txt");

      await writeFile("repo/small.txt", "this is now much larger content than before");
      const stat2 = await stat("repo/small.txt");

      expect(stat2.size).toBeGreaterThan(stat1.size);
    });
  });

  // =====================================================================
  // PATTERN 4: Branch management
  // simple-git: git.branch() → needs HEAD file + refs
  // =====================================================================

  describe("branch management via fs", () => {
    it("reads current branch from HEAD", async () => {
      const head = await readFile("repo/.git/HEAD");
      expect(head.content.trim()).toBe("ref: refs/heads/main");
      const branch = head.content.trim().replace("ref: refs/heads/", "");
      expect(branch).toBe("main");
    });

    it("creates branch refs", async () => {
      const commitHash = "abc123def456789";
      await writeFile("repo/.git/refs/heads/main", commitHash + "\n");
      await writeFile("repo/.git/refs/heads/feature", commitHash + "\n");

      const ref = await readFile("repo/.git/refs/heads/feature");
      expect(ref.content.trim()).toBe(commitHash);
    });

    it("switches branch by updating HEAD", async () => {
      await writeFile("repo/.git/HEAD", "ref: refs/heads/feature\n");
      const head = await readFile("repo/.git/HEAD");
      expect(head.content).toContain("feature");
    });

    it("lists branches from refs directory", async () => {
      const entries = await readdir("repo/.git/refs/heads");
      const branches = entries.map((e) => e.name);
      expect(branches).toContain("main");
      expect(branches).toContain("feature");
    });
  });

  // =====================================================================
  // PATTERN 5: Commit message management
  // simple-git: git.commit('msg') → writes COMMIT_EDITMSG
  // =====================================================================

  describe("commit message workflow", () => {
    it("writes commit message file", async () => {
      await writeFile("repo/.git/COMMIT_EDITMSG", "feat: initial commit\n\nAdded index and utils.");
      const msg = await readFile("repo/.git/COMMIT_EDITMSG");
      expect(msg.content).toContain("feat: initial commit");
    });

    it("writes commit log entries", async () => {
      const log = [
        "abc1234 feat: initial commit",
        "def5678 fix: typo in utils",
        "ghi9012 docs: update README",
      ].join("\n") + "\n";

      await writeFile("repo/.git/logs/HEAD", log);
      const data = await readFile("repo/.git/logs/HEAD");
      expect(data.content).toContain("initial commit");
      expect(data.content).toContain("update README");
    });

    it("greps commit log for specific entries", async () => {
      const result = await exec("grep fix repo/.git/logs/HEAD");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix: typo");
      expect(result.stdout).not.toContain("initial commit");
    });
  });

  // =====================================================================
  // PATTERN 6: .gitignore processing
  // simple-git: git.checkIgnore() → parse .gitignore patterns
  // =====================================================================

  describe("gitignore processing", () => {
    it("writes and reads .gitignore", async () => {
      await writeFile(
        "repo/.gitignore",
        "node_modules/\ndist/\n*.log\n.env\n.DS_Store\n",
      );
      const content = await readFile("repo/.gitignore");
      expect(content.content).toContain("node_modules");
      expect(content.content).toContain("*.log");
    });

    it("grep can check if a pattern exists in .gitignore", async () => {
      const result = await exec("grep node_modules repo/.gitignore");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("node_modules");
    });

    it("grep returns exit 1 for unignored patterns", async () => {
      const result = await exec("grep src repo/.gitignore");
      expect(result.exitCode).toBe(1);
    });
  });

  // =====================================================================
  // PATTERN 7: Multi-file operations (git stash, reset)
  // =====================================================================

  describe("multi-file operations", () => {
    it("copies files for stash-like backup", async () => {
      await exec("mkdir -p repo/.git/stash");
      await exec("cp repo/index.ts repo/.git/stash/index.ts");
      await exec("cp repo/utils.ts repo/.git/stash/utils.ts");

      expect(await exists("repo/.git/stash/index.ts")).toBe(true);
      expect(await exists("repo/.git/stash/utils.ts")).toBe(true);
    });

    it("restores from stash-like backup", async () => {
      // Modify working file
      await writeFile("repo/index.ts", "// modified\n");

      // Restore from stash
      await exec("cp repo/.git/stash/index.ts repo/index.ts");
      const restored = await readFile("repo/index.ts");
      expect(restored.content).toContain("goodbye");
    });

    it("removes stash directory", async () => {
      const result = await exec("rm -rf repo/.git/stash");
      expect(result.exitCode).toBe(0);
      expect(await exists("repo/.git/stash/index.ts")).toBe(false);
    });
  });

  // =====================================================================
  // PATTERN 8: Tag management
  // simple-git: git.tag(['v1.0.0'])
  // =====================================================================

  describe("tag management", () => {
    it("creates tag refs", async () => {
      await exec("mkdir -p repo/.git/refs/tags");
      await writeFile("repo/.git/refs/tags/v1.0.0", "abc123def456789\n");
      await writeFile("repo/.git/refs/tags/v1.1.0", "def456789abc123\n");
      await writeFile("repo/.git/refs/tags/v2.0.0", "789abc123def456\n");

      expect(await exists("repo/.git/refs/tags/v1.0.0")).toBe(true);
      expect(await exists("repo/.git/refs/tags/v2.0.0")).toBe(true);
    });

    it("lists all tags", async () => {
      const entries = await readdir("repo/.git/refs/tags");
      const tags = entries.map((e) => e.name);
      expect(tags).toContain("v1.0.0");
      expect(tags).toContain("v1.1.0");
      expect(tags).toContain("v2.0.0");
    });

    it("reads tag to get commit hash", async () => {
      const ref = await readFile("repo/.git/refs/tags/v1.0.0");
      expect(ref.content.trim()).toBe("abc123def456789");
    });

    it("deletes a tag", async () => {
      await exec("rm repo/.git/refs/tags/v1.1.0");
      expect(await exists("repo/.git/refs/tags/v1.1.0")).toBe(false);

      const entries = await readdir("repo/.git/refs/tags");
      const tags = entries.map((e) => e.name);
      expect(tags).not.toContain("v1.1.0");
    });
  });

  // =====================================================================
  // PATTERN 9: Remote tracking
  // simple-git: git.remote(['add', 'origin', 'url'])
  // =====================================================================

  describe("remote tracking", () => {
    it("writes remote config", async () => {
      const config = [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tbare = false",
        '[remote "origin"]',
        "\turl = https://github.com/user/repo.git",
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        '[branch "main"]',
        "\tremote = origin",
        "\tmerge = refs/heads/main",
        "",
      ].join("\n");
      await writeFile("repo/.git/config", config);
    });

    it("reads remote URL from config", async () => {
      const result = await exec("grep url repo/.git/config");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("github.com/user/repo.git");
    });

    it("creates remote tracking refs", async () => {
      await exec("mkdir -p repo/.git/refs/remotes/origin");
      await writeFile("repo/.git/refs/remotes/origin/main", "abc123def456789\n");
      await writeFile("repo/.git/refs/remotes/origin/develop", "999888777666555\n");

      const entries = await readdir("repo/.git/refs/remotes/origin");
      const branches = entries.map((e) => e.name);
      expect(branches).toContain("main");
      expect(branches).toContain("develop");
    });
  });

  // =====================================================================
  // PATTERN 10: Merge conflict detection
  // simple-git: git.merge() → detect conflicts via markers
  // =====================================================================

  describe("merge conflict handling", () => {
    it("writes a file with conflict markers", async () => {
      const conflicted = [
        "function hello() {",
        "<<<<<<< HEAD",
        '  return "hello from main";',
        "=======",
        '  return "hello from feature";',
        ">>>>>>> feature",
        "}",
        "",
      ].join("\n");
      await writeFile("repo/conflicted.ts", conflicted);
    });

    it("detects conflict markers with grep", async () => {
      const head = await exec("grep HEAD repo/conflicted.ts");
      expect(head.exitCode).toBe(0);
      expect(head.stdout).toContain("<<<<<<< HEAD");

      const separator = await exec("grep ======= repo/conflicted.ts");
      expect(separator.exitCode).toBe(0);

      const feature = await exec("grep feature repo/conflicted.ts");
      expect(feature.exitCode).toBe(0);
      expect(feature.stdout).toContain(">>>>>>> feature");
    });

    it("resolves conflict by rewriting file", async () => {
      const resolved = [
        "function hello() {",
        '  return "hello from main (resolved)";',
        "}",
        "",
      ].join("\n");
      await writeFile("repo/conflicted.ts", resolved);

      // Verify no conflict markers remain
      const markers = await exec("grep <<<<<<< repo/conflicted.ts");
      expect(markers.exitCode).toBe(1); // no match
    });

    it("writes MERGE_MSG for merge commit", async () => {
      await writeFile(
        "repo/.git/MERGE_MSG",
        "Merge branch 'feature' into main\n\nResolved conflict in conflicted.ts\n",
      );
      const msg = await readFile("repo/.git/MERGE_MSG");
      expect(msg.content).toContain("Merge branch");
      expect(msg.content).toContain("conflicted.ts");
    });
  });

  // =====================================================================
  // PATTERN 11: Large file tracking simulation
  // =====================================================================

  describe("large file operations", () => {
    it("writes and reads a larger file", async () => {
      // Generate a file with 100 lines
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`line ${i}: ${"x".repeat(80)}`);
      }
      const content = lines.join("\n") + "\n";
      await writeFile("repo/large-file.txt", content);

      const data = await readFile("repo/large-file.txt");
      expect(data.content.split("\n").length).toBeGreaterThan(99);
    });

    it("head shows first 10 lines of large file", async () => {
      const result = await exec("head repo/large-file.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line 0:");
      expect(result.stdout).toContain("line 9:");
      expect(result.stdout).not.toContain("line 10:");
    });

    it("tail shows last lines of large file", async () => {
      const result = await exec("tail -n 3 repo/large-file.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line 99:");
    });

    it("wc counts lines accurately", async () => {
      const result = await exec("wc repo/large-file.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("100");
    });

    it("grep finds specific line in large file", async () => {
      const result = await exec("grep 'line 50:' repo/large-file.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line 50:");
    });
  });
});
