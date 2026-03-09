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

    // Record top-level command in process table
    this.sql.exec(
      "INSERT INTO processes (command, status, created_at) VALUES (?, 'running', ?)",
      command,
      Date.now(),
    );
    const pid = this.sql
      .exec("SELECT last_insert_rowid() as pid")
      .toArray()[0].pid as number;

    let result: SpawnResult;
    try {
      result = await this.execChain(splitChain(command), options);
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

  private async execPipeline(commands: string[], options: SpawnOptions): Promise<SpawnResult> {
    let input = "";
    let lastResult: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };
    const allStderr: string[] = [];

    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      lastResult = await this.execSingle(trimmed, { ...options, stdin: input });
      input = lastResult.stdout;
      if (lastResult.stderr) allStderr.push(lastResult.stderr);
      if (lastResult.exitCode !== 0) break;
    }

    return { exitCode: lastResult.exitCode, stdout: lastResult.stdout, stderr: allStderr.join("") };
  }

  private async execChain(segments: ChainSegment[], options: SpawnOptions): Promise<SpawnResult> {
    let lastResult: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };
    const allStdout: string[] = [];
    const allStderr: string[] = [];

    for (const { command, operator } of segments) {
      const trimmed = command.trim();
      if (!trimmed) continue;

      if (operator === "&&" && lastResult.exitCode !== 0) continue;
      if (operator === "||" && lastResult.exitCode === 0) continue;

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

    if (BUILTIN_COMMANDS.has(cmd)) {
      return this.execBuiltin(cmd, args, effectiveCwd, options);
    } else if (this.containerExec) {
      return this.containerExec(command, {
        cwd: effectiveCwd,
        env: options.env,
      });
    }
    return {
      exitCode: 127,
      stdout: "",
      stderr: `nodemode: command not found: ${cmd}\nNo container available. Built-in commands: ${[...BUILTIN_COMMANDS].join(", ")}`,
    };
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
      case "basename": {
        // Strip trailing slashes, then extract last component
        const cleaned = (args[0] || "").replace(/\/+$/, "");
        return ok((cleaned.split("/").pop() || "/") + "\n");
      }
      case "dirname": {
        const cleaned = (args[0] || "").replace(/\/+$/, "");
        const parent = cleaned.split("/").slice(0, -1).join("/");
        // dirname / → /, dirname foo → ., dirname /foo → /
        return ok((parent || (args[0]?.startsWith("/") ? "/" : ".")) + "\n");
      }
      case "which":
        return BUILTIN_COMMANDS.has(args[0])
          ? ok(`/usr/bin/${args[0]}\n`)
          : { exitCode: 1, stdout: "", stderr: `which: ${args[0]}: not found\n` };
      case "printf":
        return this.builtinPrintf(args);
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
    const errors: string[] = [];
    for (const arg of files) {
      if (arg === "-" && options?.stdin) {
        outputs.push(options.stdin);
        continue;
      }
      const path = resolvePath(cwd, arg);
      const content = await this.fs.readFileText(path);
      if (content === null) {
        errors.push(`cat: ${arg}: No such file or directory\n`);
      } else {
        outputs.push(content);
      }
    }
    return {
      exitCode: errors.length > 0 ? 1 : 0,
      stdout: outputs.join(""),
      stderr: errors.join(""),
    };
  }

  private builtinLs(args: string[], cwd: string): SpawnResult {
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const longFormat = flags.includes("l");
    const showAll = flags.includes("a");
    const paths = args.filter((a) => !a.startsWith("-"));
    const dir = paths[0] ? resolvePath(cwd, paths[0]) : cwd;

    // If target is a file (not a directory), list just that file
    const targetStat = paths[0] ? this.fs.stat(dir) : null;
    if (targetStat && !targetStat.isDirectory) {
      return ok(longFormat ? lsLine("-", targetStat, paths[0]) + "\n" : paths[0] + "\n");
    }

    const entries = this.fs.readdir(dir);
    const normalized = dir.replace(/^\/+/, "").replace(/\/+$/, "");
    if (entries.length === 0 && normalized && !this.fs.exists(dir)) {
      return fail(`ls: cannot access '${dir}': No such file or directory\n`);
    }

    const filtered = showAll ? entries : entries.filter((e) => !e.name.startsWith("."));

    if (longFormat) {
      const lines = filtered.map((e) => {
        const stat = this.fs.stat(resolvePath(dir, e.name));
        return lsLine(e.isDirectory ? "d" : "-", stat, e.name);
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
      } else if (/^-n\d+$/.test(args[i])) {
        // No-space form: head -n2 file.txt
        lines = parseInt(args[i].slice(2), 10);
      } else if (/^-\d+$/.test(args[i])) {
        // Short form: head -5 file.txt
        lines = parseInt(args[i].slice(1), 10);
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
    if (!content) return ok("");
    const allLines = content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n");
    const sliced = cmd === "head" ? allLines.slice(0, lines) : allLines.slice(-lines);
    return ok(sliced.join("\n") + "\n");
  }

  private async builtinWc(args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    const flags = args.filter((a) => a.startsWith("-")).join("");
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
    const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const byteCount = new TextEncoder().encode(content).byteLength;
    const suffix = label ? ` ${label}` : "";
    // Respect -l, -w, -c flags (default: show all)
    const showLines = flags.includes("l");
    const showWords = flags.includes("w");
    const showBytes = flags.includes("c");
    const showAll = !showLines && !showWords && !showBytes;
    const parts: number[] = [];
    if (showAll || showLines) parts.push(lineCount);
    if (showAll || showWords) parts.push(wordCount);
    if (showAll || showBytes) parts.push(byteCount);
    return ok(`${parts.join(" ")}${suffix}\n`);
  }

  private async builtinGrep(args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    // Simple grep: grep pattern [file]
    // If no file, reads from stdin (piped input)
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const nonFlags = args.filter((a) => !a.startsWith("-"));
    if (nonFlags.length < 1) {
      return fail("grep: usage: grep PATTERN [FILE]\n");
    }
    const pattern = nonFlags[0];
    const caseInsensitive = flags.includes("i");
    const invert = flags.includes("v");
    const countOnly = flags.includes("c");

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
      // No file and no stdin — no matches (like grep on empty stdin)
      return { exitCode: 1, stdout: "", stderr: "" };
    }

    let test: (line: string) => boolean;
    try {
      const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
      test = (line) => regex.test(line);
    } catch {
      test = caseInsensitive
        ? (line) => line.toLowerCase().includes(pattern.toLowerCase())
        : (line) => line.includes(pattern);
    }
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const matches = lines.filter((line) => invert ? !test(line) : test(line));
    if (matches.length === 0) return { exitCode: 1, stdout: "", stderr: "" };
    if (countOnly) return ok(`${matches.length}\n`);
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
        if (!recursive) return fail(`rm: cannot remove '${file}': Is a directory\n`);
        await this.fs.rmdir(path, true);
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

  private resolveSrcDst(cmd: string, args: string[], cwd: string): { src: string; dst: string } | SpawnResult {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length < 2) return fail(`${cmd}: missing operand\n`);
    const src = resolvePath(cwd, files[0]);
    let dst = resolvePath(cwd, files[1]);
    const dstStat = this.fs.stat(dst);
    if (dstStat?.isDirectory) {
      const basename = src.split("/").pop() || src;
      dst = dst ? `${dst}/${basename}` : basename;
    }
    return { src, dst };
  }

  private async builtinCp(args: string[], cwd: string): Promise<SpawnResult> {
    const resolved = this.resolveSrcDst("cp", args, cwd);
    if ("exitCode" in resolved) return resolved;
    const { src, dst } = resolved;
    const data = await this.fs.readFile(src);
    if (data === null) return fail(`cp: ${args.filter((a) => !a.startsWith("-"))[0]}: No such file or directory\n`);
    const stat = this.fs.stat(src);
    await this.fs.writeFile(dst, data, stat?.mode);
    return ok("");
  }

  private async builtinMv(args: string[], cwd: string): Promise<SpawnResult> {
    const resolved = this.resolveSrcDst("mv", args, cwd);
    if ("exitCode" in resolved) return resolved;
    await this.fs.rename(resolved.src, resolved.dst);
    return ok("");
  }

  private builtinPrintf(args: string[]): SpawnResult {
    if (args.length === 0) return ok("");
    const fmt = args[0];
    const fmtArgs = args.slice(1);
    let argIdx = 0;
    let output = "";
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] === "%" && i + 1 < fmt.length) {
        const spec = fmt[++i];
        if (spec === "s") { output += fmtArgs[argIdx++] ?? ""; }
        else if (spec === "d") { output += parseInt(fmtArgs[argIdx++] ?? "0", 10); }
        else if (spec === "%") { output += "%"; }
        else { output += "%" + spec; } // unknown specifier, pass through
      } else if (fmt[i] === "\\" && i + 1 < fmt.length) {
        const esc = fmt[++i];
        if (esc === "n") output += "\n";
        else if (esc === "t") output += "\t";
        else if (esc === "\\") output += "\\";
        else output += "\\" + esc;
      } else {
        output += fmt[i];
      }
    }
    return ok(output);
  }

  private builtinTest(args: string[], cwd: string): SpawnResult {
    const testFail: SpawnResult = { exitCode: 1, stdout: "", stderr: "" };
    if (args.length === 0) return testFail;

    let pass = false;

    // Binary operators: test A = B, test A != B
    if (args.length >= 3 && (args[1] === "=" || args[1] === "!=")) {
      pass = args[1] === "=" ? args[0] === args[2] : args[0] !== args[2];
    } else {
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

function lsLine(type: string, stat: { size: number; mode: number; mtime: number } | null, name: string): string {
  const perms = formatMode(stat?.mode ?? 0o644);
  const size = stat?.size ?? 0;
  const mtime = stat?.mtime ? new Date(stat.mtime).toISOString().slice(0, 16) : "1970-01-01T00:00";
  return `${type}${perms}  1 nodemode nodemode  ${String(size).padStart(8)} ${mtime} ${name}`;
}

function formatMode(mode: number): string {
  const m = mode & 0o777;
  let result = "";
  for (let i = 8; i >= 0; i--) {
    const ch = i % 3 === 2 ? "r" : i % 3 === 1 ? "w" : "x";
    result += (m & (1 << i)) ? ch : "-";
  }
  return result;
}

function resolvePath(cwd: string, path: string): string {
  const raw = path.startsWith("/") ? path : (cwd.replace(/^\/+/, "").replace(/\/+$/, "") + "/" + path);
  const parts = raw.split("/");
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
