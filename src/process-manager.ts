// ProcessManager — maps Node.js child_process to tiered Cloudflare execution
//
// Tier 1: Shell builtins (cat, ls, grep, echo, pwd, env, head, tail, wc)
//         Handle in DO directly — $0, <1ms
//
// Tier 2: JS execution (node script.js, npx, ts-node)
//         Run in DO via JsRunner — $0, ~ms, V8 isolate IS the engine
//
// Tier 3: Native binaries (gcc, python, cargo, make)
//         Container — last resort, only when native code is required
//
// Permission model adapted from edgebox:
//   { "allow": ["git", "npm", "node"], "deny": ["sudo", "rm -rf"] }

import type { FsEngine } from "./fs-engine";
import { normalizePath } from "./fs-engine";
import type { UnsafeEval, Env } from "./env";
import { JsRunner } from "./js-runner";
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
const TRUNCATION_MARKER = "\n[truncated]";

function truncateOutput(s: string): string {
  if (s.length <= MAX_STORED_OUTPUT) return s;
  return s.slice(0, MAX_STORED_OUTPUT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
const MAX_PIPELINE_BYTES = 10 * 1024 * 1024; // 10MB cap on in-memory pipeline data
const PRUNE_INTERVAL = 50; // Only check prune every N executions
const NUMERIC_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);

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
  "git",
]);

type ContainerExecFn = (
  command: string,
  options: { cwd?: string; env?: Record<string, string> },
) => Promise<SpawnResult>;

export class ProcessManager {
  private execCount = 0;
  private _runner: JsRunner | null = null;

  constructor(
    private sql: SqlStorage,
    private fs: FsEngine,
    private cwd: string = "/",
    private containerExec?: ContainerExecFn,
    private unsafeEval?: UnsafeEval,
    private gitmode?: DurableObjectNamespace,
    private threadDO?: DurableObjectNamespace,
  ) {}

  /** Expose THREAD_DO binding so JsRunner can fan out worker_threads to child DOs. */
  get threadBinding(): DurableObjectNamespace | undefined {
    return this.threadDO;
  }

  // Returns the persistent JsRunner instance (created on first use).
  // Keeps the active http.Server across exec calls so Workspace can
  // route incoming fetch() requests through user code.
  get runner(): JsRunner {
    if (!this._runner) {
      this._runner = new JsRunner(this.fs, this, this.cwd, this.unsafeEval);
    }
    return this._runner;
  }

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
        truncateOutput(result.stdout),
        truncateOutput(result.stderr),
        Date.now(),
        pid,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sql.exec(
        "UPDATE processes SET status = 'error', exit_code = 1, stderr = ?, finished_at = ? WHERE pid = ?",
        truncateOutput(msg),
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
    let input = options.stdin ?? "";
    let lastResult: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };
    const allStderr: string[] = [];

    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      lastResult = await this.execSingle(trimmed, { ...options, stdin: input });
      input = lastResult.stdout;
      if (lastResult.stderr) allStderr.push(lastResult.stderr);
      if (lastResult.exitCode !== 0) break;
      if (input.length > MAX_PIPELINE_BYTES) {
        input = input.slice(0, MAX_PIPELINE_BYTES);
      }
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
    // Extract shell redirects before parsing command
    const { cleanCommand, redirects } = extractRedirects(command);

    // Handle input redirect: cmd < file
    let effectiveOptions = options;
    if (redirects.inputFile) {
      const effectiveCwd = options.cwd || this.cwd;
      const inputPath = resolvePath(effectiveCwd, redirects.inputFile);
      const content = await this.fs.readFileText(inputPath);
      if (content === null) {
        return fail(`${redirects.inputFile}: No such file or directory\n`);
      }
      effectiveOptions = { ...options, stdin: content };
    }

    const { cmd, args } = parseCommand(cleanCommand);
    const effectiveCwd = effectiveOptions.cwd || this.cwd;

    let result: SpawnResult;

    // Tier 1: Shell builtins — DO, $0, <1ms
    if (BUILTIN_COMMANDS.has(cmd)) {
      result = await this.execBuiltin(cmd, args, effectiveCwd, effectiveOptions);
    }
    // Tier 2: JS execution — DO, $0, ~ms
    else {
      const jsResult = await this.tryJsExec(cmd, args, effectiveCwd, effectiveOptions);
      if (jsResult) {
        result = jsResult;
      }
      // Tier 3: Container — last resort, native binaries only
      else if (this.containerExec) {
        result = await this.containerExec(command, {
          cwd: effectiveCwd,
          env: effectiveOptions.env,
        });
      } else {
        result = {
          exitCode: 127,
          stdout: "",
          stderr: `nodemode: command not found: ${cmd}\nBuilt-in commands: ${[...BUILTIN_COMMANDS].join(", ")}`,
        };
      }
    }

    // Handle output redirects: cmd > file, cmd >> file
    if (redirects.outputFile && result.exitCode === 0) {
      const outPath = resolvePath(effectiveCwd, redirects.outputFile);
      if (redirects.append) {
        await this.fs.appendFile(outPath, result.stdout);
      } else {
        await this.fs.writeFile(outPath, result.stdout);
      }
      // Stdout goes to file, not returned
      result = { ...result, stdout: "" };
    }

    return result;
  }

  private async tryJsExec(
    cmd: string,
    args: string[],
    cwd: string,
    options: SpawnOptions,
  ): Promise<SpawnResult | null> {
    const runner = this.runner;

    // `node script.js [args...]`
    if (cmd === "node" && args.length > 0 && !args[0].startsWith("-")) {
      // Resolve relative to cwd — prefix bare names with ./ so resolver treats as path
      const entry = args[0].startsWith("/") || args[0].startsWith("./") || args[0].startsWith("../")
        ? args[0]
        : "./" + args[0];
      return runner.run(entry, args.slice(1), options.env);
    }

    // `node -e "code"` / `node --eval "code"`
    if (cmd === "node" && (args[0] === "-e" || args[0] === "--eval") && args[1]) {
      // Write to temp file and execute
      const tmpPath = `./__nodemode_eval_${Date.now()}.js`;
      await this.fs.writeFile(tmpPath, args[1]);
      try {
        return await runner.run(tmpPath, [], options.env);
      } finally {
        await this.fs.unlink(tmpPath);
      }
    }

    // `node -p "expr"` / `node --print "expr"`
    if (cmd === "node" && (args[0] === "-p" || args[0] === "--print") && args[1]) {
      const tmpPath = `./__nodemode_eval_${Date.now()}.js`;
      const code = `const __result = (${args[1]}); process.stdout.write(String(__result) + "\\n");`;
      await this.fs.writeFile(tmpPath, code);
      try {
        return await runner.run(tmpPath, [], options.env);
      } finally {
        await this.fs.unlink(tmpPath);
      }
    }

    // `npx command [args...]` — resolve bin from node_modules
    if (cmd === "npx" && args.length > 0) {
      const binEntry = await this.resolveNpxBin(args[0], cwd);
      if (binEntry) {
        return runner.run(binEntry, args.slice(1), options.env);
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `npx: command '${args[0]}' not found in node_modules\n`,
      };
    }

    // Direct JS file execution: `./script.js` or `script.js` (if file exists)
    if (!cmd.startsWith("-")) {
      const resolved = await runner.resolve(cmd, cwd);
      if (resolved && (resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".ts") || resolved.endsWith(".mts"))) {
        return runner.run(cmd, args, options.env);
      }
    }

    return null;
  }

  private async resolveNpxBin(name: string, cwd: string): Promise<string | null> {
    const cwdPrefix = cwd === "/" ? "" : cwd.replace(/^\/+/, "").replace(/\/+$/, "");

    // For .bin lookup, use the short name (last segment for scoped packages)
    const shortName = name.startsWith("@") ? name.split("/").pop()! : name;

    // 1. Check node_modules/.bin/{shortName} — typically a JS file
    const binPath = cwdPrefix ? `${cwdPrefix}/node_modules/.bin/${shortName}` : `node_modules/.bin/${shortName}`;
    if (this.fs.exists(binPath)) {
      return "./" + binPath;
    }

    // 2. Check node_modules/{name}/package.json#bin
    const pkgPath = cwdPrefix ? `${cwdPrefix}/node_modules/${name}/package.json` : `node_modules/${name}/package.json`;
    const pkgText = await this.fs.readFileText(pkgPath);
    if (pkgText) {
      try {
        const pkg = JSON.parse(pkgText) as { bin?: string | Record<string, string>; main?: string };
        let entry: string | undefined;
        if (typeof pkg.bin === "string") {
          entry = pkg.bin;
        } else if (typeof pkg.bin === "object") {
          // Try the short name first (handles scoped packages: @scope/pkg → pkg)
          entry = pkg.bin[shortName] ?? pkg.bin[name];
        }
        if (!entry) entry = pkg.main;
        if (entry) {
          const full = cwdPrefix
            ? `${cwdPrefix}/node_modules/${name}/${entry}`
            : `node_modules/${name}/${entry}`;
          if (this.fs.exists(full)) return "./" + full;
        }
      } catch { /* invalid package.json */ }
    }

    return null;
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
      case "echo": {
        let i = 0;
        while (args[i] === "-n") i++;
        return ok(args.slice(i).join(" ") + (i > 0 ? "" : "\n"));
      }
      case "true":
        return ok("");
      case "false":
        return fail("");
      case "pwd":
        return ok(cwd + "\n");
      case "date":
        return ok(new Date().toISOString() + "\n");
      case "whoami":
        return ok((options.env?.["USER"] || "nodemode") + "\n");

      case "env":
        return ok(Object.entries(options.env || {}).map(([k, v]) => `${k}=${v}\n`).join(""));

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
        if (!args[0]) return fail("which: missing argument\n");
        return BUILTIN_COMMANDS.has(args[0])
          ? ok(`/usr/bin/${args[0]}\n`)
          : fail(`which: ${args[0]}: not found\n`);
      case "printf":
        return this.builtinPrintf(args);
      case "test":
        return this.builtinTest(args, cwd);
      case "sleep":
        // No-op in DO (we don't actually sleep)
        return ok("");
      case "git":
        return this.builtinGit(args, cwd);

      default:
        return {
          exitCode: 127,
          stdout: "",
          stderr: `${cmd}: command not found\n`,
        };
    }
  }

  private async builtinCat(args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    const files = args.filter((a) => a === "-" || !a.startsWith("-"));
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
    if (entries.length === 0 && dir && dir !== "/" && !this.fs.exists(dir)) {
      return fail(`ls: cannot access '${dir}': No such file or directory\n`);
    }

    const filtered = showAll ? entries : entries.filter((e) => !e.name.startsWith("."));

    if (longFormat) {
      const lines = filtered.map((e) => {
        const stat = this.fs.stat(resolvePath(dir, e.name));
        return lsLine(e.isDirectory ? "d" : "-", stat, e.name);
      });
      return ok(lines.length ? lines.join("\n") + "\n" : "");
    }

    return ok(filtered.length ? filtered.map((e) => e.name).join("\n") + "\n" : "");
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
    } else if (options?.stdin != null) {
      content = options.stdin;
      label = "";
    } else {
      content = "";
      label = "";
    }
    const lineCount = content.split("\n").length - 1; // wc counts newline chars
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
    // grep [flags] pattern [file/dir]
    // Supports: -i (case insensitive), -v (invert), -c (count), -n (line numbers),
    //           -r (recursive), -l (files with matches only)
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const nonFlags = args.filter((a) => !a.startsWith("-"));
    if (nonFlags.length < 1) {
      return fail("grep: usage: grep PATTERN [FILE]\n");
    }
    const pattern = nonFlags[0];
    const caseInsensitive = flags.includes("i");
    const invert = flags.includes("v");
    const countOnly = flags.includes("c");
    const showLineNumbers = flags.includes("n");
    const recursive = flags.includes("r");
    const filesOnly = flags.includes("l");

    // Build the test function once
    const test = this.buildGrepTest(pattern, caseInsensitive);

    // Recursive mode: query SQLite index for all files, fan-out parallel R2 reads
    if (recursive) {
      const targetDir = nonFlags.length >= 2 ? resolvePath(cwd, nonFlags[1]) : cwd;
      return this.grepRecursive(targetDir, test, invert, countOnly, showLineNumbers, filesOnly);
    }

    // Single-file or stdin mode
    let content: string;
    let filePath: string | undefined;
    if (nonFlags.length >= 2) {
      const file = nonFlags[1];
      filePath = resolvePath(cwd, file);
      const fileContent = await this.fs.readFileText(filePath);
      if (fileContent === null) return fail(`grep: ${file}: No such file or directory\n`);
      content = fileContent;
    } else if (options?.stdin) {
      content = options.stdin;
    } else {
      return fail(""); // No file and no stdin — no matches
    }

    const result = this.grepContent(content, test, invert, countOnly, showLineNumbers);
    if (result === null) return fail("");
    return ok(result);
  }

  private buildGrepTest(pattern: string, caseInsensitive: boolean): (line: string) => boolean {
    // Reject patterns with nested quantifiers that cause catastrophic backtracking (ReDoS)
    const isSafeRegex = !/\([^)]*[+*][^)]*\)[+*{]/.test(pattern) && pattern.length <= 1024;
    try {
      if (!isSafeRegex) throw new Error("unsafe pattern");
      const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
      return (line) => regex.test(line);
    } catch {
      return caseInsensitive
        ? (line) => line.toLowerCase().includes(pattern.toLowerCase())
        : (line) => line.includes(pattern);
    }
  }

  /** Search content, return formatted output or null for no matches */
  private grepContent(
    content: string, test: (line: string) => boolean,
    invert: boolean, countOnly: boolean, showLineNumbers: boolean,
  ): string | null {
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (invert ? !test(lines[i]) : test(lines[i])) matchIndices.push(i);
    }
    if (matchIndices.length === 0) return null;
    if (countOnly) return `${matchIndices.length}\n`;
    if (showLineNumbers) {
      return matchIndices.map((i) => `${i + 1}:${lines[i]}`).join("\n") + "\n";
    }
    return matchIndices.map((i) => lines[i]).join("\n") + "\n";
  }

  /** Recursive grep: SQLite index for file discovery, parallel R2 reads for content */
  private async grepRecursive(
    dir: string, test: (line: string) => boolean,
    invert: boolean, countOnly: boolean, showLineNumbers: boolean, filesOnly: boolean,
  ): Promise<SpawnResult> {
    // Query all non-directory files under dir from SQLite index
    const normalizedDir = normalizePath(dir);
    const prefix = normalizedDir ? normalizedDir + "/" : "";
    const sql = this.fs.sql;

    // Get all file paths (non-directory) under this prefix
    const rows = prefix
      ? sql.exec(
          "SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' AND is_dir = 0",
          prefix.replace(/[%_\\]/g, "\\$&") + "%",
        ).toArray()
      : sql.exec("SELECT path FROM files WHERE is_dir = 0").toArray();

    const filePaths = rows.map((r) => r.path as string).sort();
    if (filePaths.length === 0) return fail("");

    // Fan-out parallel R2 reads (batch to avoid overwhelming)
    const BATCH_SIZE = 50;
    const output: string[] = [];

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      const contents = await Promise.all(
        batch.map((p) => this.fs.readFileText("/" + p).then((c) => ({ path: p, content: c }))),
      );

      for (const { path: filePath, content } of contents) {
        if (content === null) continue;
        // Compute relative path from dir for display
        const displayPath = prefix && filePath.startsWith(prefix)
          ? filePath.slice(prefix.length)
          : filePath;

        if (filesOnly) {
          // -l: just check if any line matches
          const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
          const hasMatch = lines.some((line) => invert ? !test(line) : test(line));
          if (hasMatch) output.push(displayPath);
          continue;
        }

        const result = this.grepContent(content, test, invert, countOnly, showLineNumbers);
        if (result === null) continue;

        // Prefix each line with the filename
        const resultLines = result.endsWith("\n") ? result.slice(0, -1).split("\n") : result.split("\n");
        for (const line of resultLines) {
          output.push(`${displayPath}:${line}`);
        }
      }
    }

    if (output.length === 0) return fail("");
    return ok(output.join("\n") + "\n");
  }

  private async builtinGit(args: string[], cwd: string): Promise<SpawnResult> {
    if (!this.gitmode) {
      return fail("git: not configured — add GITMODE binding to wrangler.jsonc\n");
    }

    const subcommand = args[0];
    if (!subcommand) {
      return fail("usage: git <command> [<args>]\n");
    }

    try {
      const id = this.gitmode.idFromName(cwd === "/" ? "default" : cwd);
      const gitDO = this.gitmode.get(id);
      const response = await gitDO.fetch("http://gitmode/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args, cwd }),
      });

      if (!response.ok) {
        const text = await response.text();
        return fail(`git: ${text}\n`);
      }

      const result = (await response.json()) as { stdout: string; stderr: string; exitCode: number };
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`git: ${msg}\n`);
    }
  }

  private builtinMkdir(args: string[], cwd: string): SpawnResult {
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const recursive = flags.includes("p");
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
    if (data === null) return fail(`cp: cannot stat '${src}': No such file or directory\n`);
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
    if (args.length === 0) return fail("");

    // Handle ! negation
    const negate = args[0] === "!";
    const a = negate ? args.slice(1) : args;
    if (a.length === 0) return negate ? ok("") : fail("");

    let pass = false;

    if (a.length === 1) {
      // Single arg: test STRING → true if non-empty
      pass = a[0] !== "";
    } else if (a.length >= 3 && (a[1] === "=" || a[1] === "!=")) {
      // String comparison: test A = B, test A != B
      pass = a[1] === "=" ? a[0] === a[2] : a[0] !== a[2];
    } else if (a.length >= 3 && NUMERIC_OPS.has(a[1])) {
      // Numeric comparison: test A -eq B, test A -lt B, etc.
      const l = parseInt(a[0], 10) || 0;
      const r = parseInt(a[2], 10) || 0;
      switch (a[1]) {
        case "-eq": pass = l === r; break;
        case "-ne": pass = l !== r; break;
        case "-lt": pass = l < r; break;
        case "-le": pass = l <= r; break;
        case "-gt": pass = l > r; break;
        case "-ge": pass = l >= r; break;
      }
    } else {
      // Unary operators
      switch (a[0]) {
        case "-f":
        case "-d": {
          const stat = a[1] ? this.fs.stat(resolvePath(cwd, a[1])) : null;
          pass = a[0] === "-f" ? !!stat && !stat.isDirectory : !!stat?.isDirectory;
          break;
        }
        case "-e":
          pass = !!a[1] && this.fs.exists(resolvePath(cwd, a[1]));
          break;
        case "-s": {
          const s = a[1] ? this.fs.stat(resolvePath(cwd, a[1])) : null;
          pass = !!s && s.size > 0;
          break;
        }
        case "-z":
          pass = !a[1];
          break;
        case "-n":
          pass = !!a[1];
          break;
      }
    }
    if (negate) pass = !pass;
    return pass ? ok("") : fail("");
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
    else if (ch === "\\" && !inSingle && i + 1 < command.length) {
      current += ch + command[++i];
    }
    else if (ch === "|" && !inSingle && !inDouble) {
      if (command[i + 1] === "|") {
        // || operator — not a pipe, pass through (splitChain handles ||)
        current += ch + command[++i];
      } else {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function splitChain(command: string): ChainSegment[] {
  const segments: ChainSegment[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let pendingOp: ChainSegment["operator"] = "";

  const flush = (nextOp: ChainSegment["operator"]) => {
    segments.push({ command: current.trim(), operator: pendingOp });
    current = "";
    pendingOp = nextOp;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; }
    else if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; }
    else if (ch === "\\" && !inSingle && i + 1 < command.length) {
      current += ch + command[++i];
    }
    else if (inSingle || inDouble) { current += ch; }
    else if (ch === "&" && command[i + 1] === "&") { flush("&&"); i++; }
    else if (ch === "|" && command[i + 1] === "|") { flush("||"); i++; }
    else if (ch === ";" || ch === "\n") { flush(";"); }
    else { current += ch; }
  }
  if (current.trim()) flush("");
  return segments;
}

function parseCommand(command: string): { cmd: string; args: string[] } {
  // Shell-like parsing: handles quotes, backslash escapes, preserves empty quoted strings
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasQuote = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasQuote = true;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasQuote = true;
    } else if (ch === "\\" && !inSingle && i + 1 < command.length) {
      const next = command[++i];
      if (inDouble) {
        // In double quotes: only \", \\, \$, \` are special
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
        } else {
          current += "\\" + next;
        }
      } else {
        // Outside quotes: backslash escapes any character
        current += next;
      }
    } else if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current || hasQuote) {
        tokens.push(current);
        current = "";
        hasQuote = false;
      }
    } else {
      current += ch;
    }
  }
  if (current || hasQuote) tokens.push(current);

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

interface RedirectInfo {
  outputFile?: string;
  inputFile?: string;
  append: boolean;
}

function extractRedirects(command: string): { cleanCommand: string; redirects: RedirectInfo } {
  const redirects: RedirectInfo = { append: false };
  let clean = command;

  // >> file (append)
  const appendMatch = clean.match(/\s*>>\s*(\S+)\s*$/);
  if (appendMatch) {
    redirects.outputFile = appendMatch[1];
    redirects.append = true;
    clean = clean.slice(0, appendMatch.index).trimEnd();
  } else {
    // > file (overwrite) — but not >>
    const writeMatch = clean.match(/\s*>\s*(\S+)\s*$/);
    if (writeMatch) {
      redirects.outputFile = writeMatch[1];
      clean = clean.slice(0, writeMatch.index).trimEnd();
    }
  }

  // < file (input)
  const inputMatch = clean.match(/\s*<\s*(\S+)/);
  if (inputMatch) {
    redirects.inputFile = inputMatch[1];
    clean = clean.slice(0, inputMatch.index) + clean.slice(inputMatch.index! + inputMatch[0].length);
    clean = clean.trim();
  }

  return { cleanCommand: clean, redirects };
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
