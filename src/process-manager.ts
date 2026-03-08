// ProcessManager — maps Node.js child_process to tiered Cloudflare execution
//
// Tier 1: Built-in emulators (cat, ls, grep, echo, pwd, env, head, tail, wc)
//         Handle in DO directly — $0, <1ms
//
// Tier 2: Container spawn (npm, node, python, cargo, make, gcc)
//         Spawn Cloudflare Container — ~$0.02/hr, real Linux
//
// Permission model adapted from edgebox:
//   { "allow": ["git", "npm", "node"], "deny": ["sudo", "rm -rf"] }

import type { FsEngine } from "./fs-engine";
import { validateCommand } from "./validate";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessHandle {
  pid: number;
  command: string;
  status: "running" | "done" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// Commands handled entirely in-DO (no Container needed)
const BUILTIN_COMMANDS = new Set([
  "echo",
  "cat",
  "ls",
  "pwd",
  "env",
  "head",
  "tail",
  "wc",
  "grep",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "basename",
  "dirname",
  "true",
  "false",
  "printf",
  "test",
  "which",
  "whoami",
  "date",
  "sleep",
]);

export type ContainerExecFn = (
  command: string,
  options: { cwd?: string; env?: Record<string, string> },
) => Promise<SpawnResult>;

export class ProcessManager {
  constructor(
    private sql: SqlStorage,
    private fs: FsEngine,
    private cwd: string = "/",
    private containerExec?: ContainerExecFn,
  ) {}

  async exec(command: string, options: SpawnOptions = {}): Promise<SpawnResult> {
    validateCommand(command);
    const { cmd, args } = parseCommand(command);
    const effectiveCwd = options.cwd || this.cwd;

    // Record in process table
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO processes (command, args, status, created_at) VALUES (?, ?, 'running', ?)",
      command,
      JSON.stringify(args),
      now,
    );
    const pid = this.sql
      .exec("SELECT last_insert_rowid() as pid")
      .toArray()[0].pid as number;

    try {
      let result: SpawnResult;

      if (BUILTIN_COMMANDS.has(cmd)) {
        result = await this.execBuiltin(cmd, args, effectiveCwd, options);
      } else if (this.containerExec) {
        result = await this.containerExec(command, {
          cwd: effectiveCwd,
          env: options.env,
        });
      } else {
        result = {
          exitCode: 127,
          stdout: "",
          stderr: `nodemode: command not found: ${cmd}\nNo container available. Built-in commands: ${[...BUILTIN_COMMANDS].join(", ")}`,
        };
      }

      // Record result
      this.sql.exec(
        "UPDATE processes SET status = 'done', exit_code = ?, stdout = ?, stderr = ?, finished_at = ? WHERE pid = ?",
        result.exitCode,
        result.stdout,
        result.stderr,
        Date.now(),
        pid,
      );

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sql.exec(
        "UPDATE processes SET status = 'error', exit_code = 1, stderr = ?, finished_at = ? WHERE pid = ?",
        msg,
        Date.now(),
        pid,
      );
      return { exitCode: 1, stdout: "", stderr: msg };
    }
  }

  getProcess(pid: number): ProcessHandle | null {
    const rows = this.sql
      .exec(
        "SELECT pid, command, status, exit_code, stdout, stderr FROM processes WHERE pid = ?",
        pid,
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      pid: row.pid as number,
      command: row.command as string,
      status: row.status as ProcessHandle["status"],
      exitCode: row.exit_code as number | null,
      stdout: (row.stdout as string) || "",
      stderr: (row.stderr as string) || "",
    };
  }

  listProcesses(): ProcessHandle[] {
    return this.sql
      .exec(
        "SELECT pid, command, status, exit_code, stdout, stderr FROM processes ORDER BY pid DESC LIMIT 100",
      )
      .toArray()
      .map((row) => ({
        pid: row.pid as number,
        command: row.command as string,
        status: row.status as ProcessHandle["status"],
        exitCode: row.exit_code as number | null,
        stdout: (row.stdout as string) || "",
        stderr: (row.stderr as string) || "",
      }));
  }

  // -- Built-in command emulators --

  private async execBuiltin(
    cmd: string,
    args: string[],
    cwd: string,
    options: SpawnOptions,
  ): Promise<SpawnResult> {
    switch (cmd) {
      case "echo":
        return ok(args.join(" ") + "\n");
      case "true":
        return ok("");
      case "false":
        return { exitCode: 1, stdout: "", stderr: "" };
      case "pwd":
        return ok(cwd + "\n");
      case "date":
        return ok(new Date().toISOString() + "\n");
      case "whoami":
        return ok((options.env?.["USER"] || "nodemode") + "\n");

      case "env":
        return ok(
          Object.entries(options.env || {})
            .map(([k, v]) => `${k}=${v}`)
            .join("\n") + "\n",
        );

      case "cat":
        return this.builtinCat(args, cwd);
      case "ls":
        return this.builtinLs(args, cwd);
      case "head":
        return this.builtinHead(args, cwd);
      case "tail":
        return this.builtinTail(args, cwd);
      case "wc":
        return this.builtinWc(args, cwd);
      case "grep":
        return this.builtinGrep(args, cwd);
      case "mkdir":
        return this.builtinMkdir(args, cwd);
      case "rm":
        return this.builtinRm(args, cwd);
      case "touch":
        return this.builtinTouch(args, cwd);
      case "cp":
        return this.builtinCp(args, cwd);
      case "mv":
        return this.builtinMv(args, cwd);
      case "basename":
        return ok((args[0]?.split("/").pop() || "") + "\n");
      case "dirname":
        return ok(
          (args[0]?.split("/").slice(0, -1).join("/") || ".") + "\n",
        );
      case "which":
        return BUILTIN_COMMANDS.has(args[0])
          ? ok(`/usr/bin/${args[0]}\n`)
          : { exitCode: 1, stdout: "", stderr: `which: ${args[0]}: not found\n` };
      case "printf":
        return ok(args.join(" "));
      case "test":
        return this.builtinTest(args, cwd);
      case "sleep":
        // No-op in DO (we don't actually sleep)
        return ok("");

      default:
        return {
          exitCode: 127,
          stdout: "",
          stderr: `${cmd}: command not found\n`,
        };
    }
  }

  private async builtinCat(args: string[], cwd: string): Promise<SpawnResult> {
    const outputs: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const path = resolvePath(cwd, arg);
      const content = await this.fs.readFileText(path);
      if (content === null) {
        return fail(`cat: ${arg}: No such file or directory\n`);
      }
      outputs.push(content);
    }
    return ok(outputs.join(""));
  }

  private builtinLs(args: string[], cwd: string): SpawnResult {
    const longFormat = args.includes("-l") || args.includes("-la") || args.includes("-al");
    const showAll = args.includes("-a") || args.includes("-la") || args.includes("-al");
    const paths = args.filter((a) => !a.startsWith("-"));
    const dir = paths[0] ? resolvePath(cwd, paths[0]) : cwd;

    const entries = this.fs.readdir(dir);
    if (entries.length === 0 && !this.fs.exists(dir)) {
      return fail(`ls: cannot access '${dir}': No such file or directory\n`);
    }

    const filtered = showAll ? entries : entries.filter((e) => !e.name.startsWith("."));

    if (longFormat) {
      const lines = filtered.map((e) => {
        const stat = this.fs.stat(resolvePath(dir, e.name));
        const type = e.isDirectory ? "d" : "-";
        const size = stat?.size ?? 0;
        const mtime = stat?.mtime ? new Date(stat.mtime).toISOString().slice(0, 16) : "1970-01-01T00:00";
        return `${type}rwxr-xr-x  1 nodemode nodemode  ${String(size).padStart(8)} ${mtime} ${e.name}`;
      });
      return ok(lines.join("\n") + "\n");
    }

    return ok(filtered.map((e) => e.name).join("\n") + "\n");
  }

  private async builtinHead(args: string[], cwd: string): Promise<SpawnResult> {
    let lines = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && args[i + 1]) {
        lines = parseInt(args[++i], 10);
      } else if (!args[i].startsWith("-")) {
        files.push(args[i]);
      }
    }
    if (files.length === 0) return ok("");
    const path = resolvePath(cwd, files[0]);
    const content = await this.fs.readFileText(path);
    if (content === null) return fail(`head: ${files[0]}: No such file or directory\n`);
    return ok(content.split("\n").slice(0, lines).join("\n") + "\n");
  }

  private async builtinTail(args: string[], cwd: string): Promise<SpawnResult> {
    let lines = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && args[i + 1]) {
        lines = parseInt(args[++i], 10);
      } else if (!args[i].startsWith("-")) {
        files.push(args[i]);
      }
    }
    if (files.length === 0) return ok("");
    const path = resolvePath(cwd, files[0]);
    const content = await this.fs.readFileText(path);
    if (content === null) return fail(`tail: ${files[0]}: No such file or directory\n`);
    const allLines = content.split("\n");
    return ok(allLines.slice(-lines).join("\n") + "\n");
  }

  private async builtinWc(args: string[], cwd: string): Promise<SpawnResult> {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length === 0) return ok("0 0 0\n");
    const path = resolvePath(cwd, files[0]);
    const content = await this.fs.readFileText(path);
    if (content === null) return fail(`wc: ${files[0]}: No such file or directory\n`);
    const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const byteCount = new TextEncoder().encode(content).byteLength;
    return ok(`${lineCount} ${wordCount} ${byteCount} ${files[0]}\n`);
  }

  private async builtinGrep(args: string[], cwd: string): Promise<SpawnResult> {
    // Simple grep: grep pattern file
    const nonFlags = args.filter((a) => !a.startsWith("-"));
    if (nonFlags.length < 2) {
      return fail("grep: usage: grep PATTERN FILE\n");
    }
    const pattern = nonFlags[0];
    const file = nonFlags[1];
    const path = resolvePath(cwd, file);
    const content = await this.fs.readFileText(path);
    if (content === null) return fail(`grep: ${file}: No such file or directory\n`);

    const caseInsensitive = args.includes("-i");
    const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    const matches = content.split("\n").filter((line) => regex.test(line));
    if (matches.length === 0) return { exitCode: 1, stdout: "", stderr: "" };
    return ok(matches.join("\n") + "\n");
  }

  private builtinMkdir(args: string[], cwd: string): SpawnResult {
    const recursive = args.includes("-p");
    const dirs = args.filter((a) => !a.startsWith("-"));
    for (const dir of dirs) {
      this.fs.mkdir(resolvePath(cwd, dir), recursive);
    }
    return ok("");
  }

  private async builtinRm(args: string[], cwd: string): Promise<SpawnResult> {
    const recursive = args.includes("-r") || args.includes("-rf") || args.includes("-fr");
    const files = args.filter((a) => !a.startsWith("-"));
    for (const file of files) {
      const path = resolvePath(cwd, file);
      const stat = this.fs.stat(path);
      if (!stat) return fail(`rm: ${file}: No such file or directory\n`);
      if (stat.isDirectory) {
        await this.fs.rmdir(path, recursive);
      } else {
        await this.fs.unlink(path);
      }
    }
    return ok("");
  }

  private async builtinTouch(args: string[], cwd: string): Promise<SpawnResult> {
    const files = args.filter((a) => !a.startsWith("-"));
    for (const file of files) {
      const path = resolvePath(cwd, file);
      if (!this.fs.exists(path)) {
        await this.fs.writeFile(path, "");
      } else {
        // Update mtime
        this.fs.chmod(path, this.fs.stat(path)!.mode);
      }
    }
    return ok("");
  }

  private async builtinCp(args: string[], cwd: string): Promise<SpawnResult> {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length < 2) return fail("cp: missing operand\n");
    const src = resolvePath(cwd, files[0]);
    const dst = resolvePath(cwd, files[1]);
    const data = await this.fs.readFile(src);
    if (data === null) return fail(`cp: ${files[0]}: No such file or directory\n`);
    await this.fs.writeFile(dst, data);
    return ok("");
  }

  private async builtinMv(args: string[], cwd: string): Promise<SpawnResult> {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length < 2) return fail("mv: missing operand\n");
    const src = resolvePath(cwd, files[0]);
    const dst = resolvePath(cwd, files[1]);
    await this.fs.rename(src, dst);
    return ok("");
  }

  private builtinTest(args: string[], cwd: string): SpawnResult {
    if (args.length === 0) return { exitCode: 1, stdout: "", stderr: "" };
    // test -f file / test -d dir / test -e path
    if (args[0] === "-f" && args[1]) {
      const stat = this.fs.stat(resolvePath(cwd, args[1]));
      return stat && !stat.isDirectory
        ? ok("")
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "-d" && args[1]) {
      const stat = this.fs.stat(resolvePath(cwd, args[1]));
      return stat?.isDirectory
        ? ok("")
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "-e" && args[1]) {
      return this.fs.exists(resolvePath(cwd, args[1]))
        ? ok("")
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "-z") {
      return !args[1] || args[1] === ""
        ? ok("")
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "-n") {
      return args[1] && args[1] !== ""
        ? ok("")
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  }
}

// -- Helpers --

function ok(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string): SpawnResult {
  return { exitCode: 1, stdout: "", stderr };
}

function parseCommand(command: string): { cmd: string; args: string[] } {
  // Simple shell-like parsing (handles quotes)
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return { cmd: tokens[0] || "", args: tokens.slice(1) };
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return path.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = cwd.replace(/^\/+/, "").replace(/\/+$/, "");
  const combined = base ? `${base}/${path}` : path;
  // Resolve . and ..
  const parts = combined.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}
