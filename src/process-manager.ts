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
const MAX_PROCESS_ROWS = 1000;
const MAX_STORED_OUTPUT = 4096; // Truncate stdout/stderr stored in process table
const PRUNE_INTERVAL = 50; // Only check prune every N executions

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

type ContainerExecFn = (
  command: string,
  options: { cwd?: string; env?: Record<string, string> },
) => Promise<SpawnResult>;

export class ProcessManager {
  private execCount = 0;

  constructor(
    private sql: SqlStorage,
    private fs: FsEngine,
    private cwd: string = "/",
    private containerExec?: ContainerExecFn,
  ) {}

  async exec(command: string, options: SpawnOptions = {}): Promise<SpawnResult> {
    validateCommand(command);

    // Shell precedence: chains (&&, ||, ;) bind looser than pipes (|)
    // So split on chains first, then handle pipes within each segment.
    const chain = splitChain(command);
    if (chain.length > 1) {
      return this.execChain(chain, options);
    }

    const pipeline = splitPipeline(command);
    if (pipeline.length > 1) {
      return this.execPipeline(pipeline, options);
    }

    return this.execSingle(command, options);
  }

  private async execPipeline(commands: string[], options: SpawnOptions): Promise<SpawnResult> {
    let input = "";
    let lastResult: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };

    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      // Feed previous stdout as stdin to next command (via grep/head/etc that read from stdin)
      // For builtins, we pass the input as a virtual file "-"
      lastResult = await this.execSingle(trimmed, { ...options, stdin: input });
      input = lastResult.stdout;
      if (lastResult.exitCode !== 0) break;
    }

    return lastResult;
  }

  private async execChain(segments: ChainSegment[], options: SpawnOptions): Promise<SpawnResult> {
    let lastResult: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };
    const allStdout: string[] = [];
    const allStderr: string[] = [];

    for (const { command, operator } of segments) {
      const trimmed = command.trim();
      if (!trimmed) continue;

      // Check operator condition
      if (operator === "&&" && lastResult.exitCode !== 0) continue;
      if (operator === "||" && lastResult.exitCode === 0) continue;

      // Each chain segment may contain pipes, so route through full exec
      // (which handles pipes before falling through to execSingle)
      const pipeline = splitPipeline(trimmed);
      lastResult = pipeline.length > 1
        ? await this.execPipeline(pipeline, options)
        : await this.execSingle(trimmed, options);
      if (lastResult.stdout) allStdout.push(lastResult.stdout);
      if (lastResult.stderr) allStderr.push(lastResult.stderr);
    }

    return {
      exitCode: lastResult.exitCode,
      stdout: allStdout.join(""),
      stderr: allStderr.join(""),
    };
  }

  private async execSingle(command: string, options: SpawnOptions): Promise<SpawnResult> {
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

    let result: SpawnResult;
    try {
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

      // Record result (truncate stored output to save SQLite space)
      this.sql.exec(
        "UPDATE processes SET status = 'done', exit_code = ?, stdout = ?, stderr = ?, finished_at = ? WHERE pid = ?",
        result.exitCode,
        result.stdout.slice(0, MAX_STORED_OUTPUT),
        result.stderr.slice(0, MAX_STORED_OUTPUT),
        Date.now(),
        pid,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sql.exec(
        "UPDATE processes SET status = 'error', exit_code = 1, stderr = ?, finished_at = ? WHERE pid = ?",
        msg.slice(0, MAX_STORED_OUTPUT),
        Date.now(),
        pid,
      );
      result = { exitCode: 1, stdout: "", stderr: msg };
    } finally {
      if (++this.execCount % PRUNE_INTERVAL === 0) this.pruneProcessTable();
    }
    return result;
  }

  private pruneProcessTable(): void {
    const count = this.sql
      .exec("SELECT COUNT(*) as cnt FROM processes")
      .toArray()[0].cnt as number;
    if (count > MAX_PROCESS_ROWS) {
      this.sql.exec(
        `DELETE FROM processes WHERE pid IN (
           SELECT pid FROM processes WHERE status != 'running' ORDER BY pid ASC LIMIT ?
         )`,
        count - MAX_PROCESS_ROWS,
      );
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
        "SELECT pid, command, status, exit_code FROM processes ORDER BY pid DESC LIMIT 100",
      )
      .toArray()
      .map((row) => ({
        pid: row.pid as number,
        command: row.command as string,
        status: row.status as ProcessHandle["status"],
        exitCode: row.exit_code as number | null,
        stdout: "",
        stderr: "",
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
        if (args[0] === "-n") return ok(args.slice(1).join(" "));
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

      case "env": {
        const entries = Object.entries(options.env || {});
        return ok(entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n" : "");
      }

      case "cat":
        return this.builtinCat(args, cwd, options);
      case "ls":
        return this.builtinLs(args, cwd);
      case "head":
      case "tail":
        return this.builtinHeadTail(cmd as "head" | "tail", args, cwd, options);
      case "wc":
        return this.builtinWc(args, cwd, options);
      case "grep":
        return this.builtinGrep(args, cwd, options);
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

  private async builtinCat(args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    const files = args.filter((a) => !a.startsWith("-"));
    // No files: pass through stdin (pipe support)
    if (files.length === 0 && options?.stdin) {
      return ok(options.stdin);
    }
    const outputs: string[] = [];
    for (const arg of files) {
      if (arg === "-" && options?.stdin) {
        outputs.push(options.stdin);
        continue;
      }
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
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const longFormat = flags.includes("l");
    const showAll = flags.includes("a");
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

  private async builtinHeadTail(cmd: "head" | "tail", args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    let lines = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-n" && args[i + 1]) {
        lines = parseInt(args[++i], 10);
      } else if (!args[i].startsWith("-")) {
        files.push(args[i]);
      }
    }
    let content: string;
    if (files.length > 0) {
      const path = resolvePath(cwd, files[0]);
      const fileContent = await this.fs.readFileText(path);
      if (fileContent === null) return fail(`${cmd}: ${files[0]}: No such file or directory\n`);
      content = fileContent;
    } else if (options?.stdin) {
      content = options.stdin;
    } else {
      return ok("");
    }
    const allLines = content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n");
    const sliced = cmd === "head" ? allLines.slice(0, lines) : allLines.slice(-lines);
    return ok(sliced.join("\n") + "\n");
  }

  private async builtinWc(args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    const files = args.filter((a) => !a.startsWith("-"));
    let content: string;
    let label: string;
    if (files.length > 0) {
      const path = resolvePath(cwd, files[0]);
      const fileContent = await this.fs.readFileText(path);
      if (fileContent === null) return fail(`wc: ${files[0]}: No such file or directory\n`);
      content = fileContent;
      label = files[0];
    } else if (options?.stdin) {
      content = options.stdin;
      label = "";
    } else {
      return ok("0 0 0\n");
    }
    const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const byteCount = new TextEncoder().encode(content).byteLength;
    const suffix = label ? ` ${label}` : "";
    return ok(`${lineCount} ${wordCount} ${byteCount}${suffix}\n`);
  }

  private async builtinGrep(args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    // Simple grep: grep pattern [file]
    // If no file, reads from stdin (piped input)
    const nonFlags = args.filter((a) => !a.startsWith("-"));
    if (nonFlags.length < 1) {
      return fail("grep: usage: grep PATTERN [FILE]\n");
    }
    const pattern = nonFlags[0];
    const caseInsensitive = args.includes("-i");

    let content: string;
    if (nonFlags.length >= 2) {
      const file = nonFlags[1];
      const path = resolvePath(cwd, file);
      const fileContent = await this.fs.readFileText(path);
      if (fileContent === null) return fail(`grep: ${file}: No such file or directory\n`);
      content = fileContent;
    } else if (options?.stdin) {
      content = options.stdin;
    } else {
      return fail("grep: usage: grep PATTERN [FILE]\n");
    }

    let test: (line: string) => boolean;
    try {
      const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
      test = (line) => regex.test(line);
    } catch {
      // Fall back to literal string match if regex is invalid
      test = caseInsensitive
        ? (line) => line.toLowerCase().includes(pattern.toLowerCase())
        : (line) => line.includes(pattern);
    }
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const matches = lines.filter(test);
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
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const recursive = flags.includes("r");
    const force = flags.includes("f");
    const files = args.filter((a) => !a.startsWith("-"));
    for (const file of files) {
      const path = resolvePath(cwd, file);
      const stat = this.fs.stat(path);
      if (!stat) {
        if (force) continue;
        return fail(`rm: ${file}: No such file or directory\n`);
      }
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
        this.fs.touch(path);
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
    const stat = this.fs.stat(src);
    await this.fs.writeFile(dst, data, stat?.mode);
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
    const testFail: SpawnResult = { exitCode: 1, stdout: "", stderr: "" };
    if (args.length === 0) return testFail;

    let pass = false;
    switch (args[0]) {
      case "-f":
      case "-d": {
        const stat = args[1] ? this.fs.stat(resolvePath(cwd, args[1])) : null;
        pass = args[0] === "-f" ? !!stat && !stat.isDirectory : !!stat?.isDirectory;
        break;
      }
      case "-e":
        pass = !!args[1] && this.fs.exists(resolvePath(cwd, args[1]));
        break;
      case "-z":
        pass = !args[1];
        break;
      case "-n":
        pass = !!args[1];
        break;
    }
    return pass ? ok("") : testFail;
  }
}

// -- Helpers --

function ok(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string): SpawnResult {
  return { exitCode: 1, stdout: "", stderr };
}

interface ChainSegment {
  command: string;
  operator: ";" | "&&" | "||" | "";
}

function splitPipeline(command: string): string[] {
  // Split on | but not || and not inside quotes
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; }
    else if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; }
    else if (ch === "|" && !inSingle && !inDouble && command[i + 1] !== "|" && (i === 0 || command[i - 1] !== "|")) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function splitChain(command: string): ChainSegment[] {
  // Split on &&, ||, ; outside quotes
  const segments: ChainSegment[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let pendingOp: ChainSegment["operator"] = "";

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    if (ch === "&" && command[i + 1] === "&") {
      segments.push({ command: current.trim(), operator: pendingOp });
      current = "";
      pendingOp = "&&";
      i++; // skip second &
    } else if (ch === "|" && command[i + 1] === "|") {
      segments.push({ command: current.trim(), operator: pendingOp });
      current = "";
      pendingOp = "||";
      i++; // skip second |
    } else if (ch === ";") {
      segments.push({ command: current.trim(), operator: pendingOp });
      current = "";
      pendingOp = ";";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    segments.push({ command: current.trim(), operator: pendingOp });
  }
  return segments;
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
