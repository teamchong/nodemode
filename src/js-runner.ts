// JsRunner — execute JavaScript/TypeScript from the virtual filesystem in-DO
//
// This is Tier 2 of the execution model:
//   Tier 1: Shell builtins (cat, ls, grep)     → DO, $0, <1ms
//   Tier 2: JS execution (node, npx)           → DO, $0, ~ms  ← THIS
//   Tier 3: Native binaries (gcc, python)       → Container, last resort
//
// Workers runtime IS a V8 isolate. We already have a JS engine —
// we just need to load code from the virtual fs and run it.
//
// Module resolution follows Node.js conventions:
//   1. Exact path         → load directly
//   2. Missing extension  → try .js, .mjs, .ts, .mts, .json
//   3. Directory          → try index.js, index.ts, index.mjs
//   4. node_modules       → walk up from cwd

import type { FsEngine } from "./fs-engine";
export interface CommandExecutor {
  exec(command: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
import type { UnsafeEval } from "./env";
// Workers with nodejs_compat provide node:crypto with synchronous createHash
// @ts-expect-error — node:crypto types not in @cloudflare/workers-types
import * as nodeCrypto from "node:crypto";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const JS_EXTENSIONS = [".js", ".mjs", ".ts", ".mts", ".json"];
const INDEX_FILES = ["index.js", "index.ts", "index.mjs"];
const BUILTIN_MODULES = new Set([
  "fs", "path", "child_process", "os", "util", "events",
  "url", "stream", "assert", "crypto", "buffer", "querystring",
  "http", "https", "net", "worker_threads",
]);

export class JsRunner {
  private moduleCache = new Map<string, Record<string, unknown>>();
  private _activeHttpServer: HttpServer | null = null;
  private _pendingWorkers: Promise<void>[] = [];
  private _threadContext: {
    isMainThread: boolean;
    parentPort: (MiniEventEmitter & { postMessage: (data: unknown) => void }) | null;
    workerData: unknown;
  } = { isMainThread: true, parentPort: null, workerData: null };

  constructor(
    private fs: FsEngine,
    private pm: CommandExecutor,
    private cwd: string,
    private unsafeEval?: UnsafeEval,
  ) {}

  /** Create a child JsRunner sharing the same fs/pm/cwd but with a fresh module cache. */
  fork(): JsRunner {
    return new JsRunner(this.fs, this.pm, this.cwd, this.unsafeEval);
  }

  /** Configure thread context so worker_threads returns correct isMainThread/parentPort/workerData. */
  setThreadContext(ctx: {
    isMainThread: boolean;
    parentPort: (MiniEventEmitter & { postMessage: (data: unknown) => void }) | null;
    workerData: unknown;
  }): void {
    this._threadContext = ctx;
  }

  // Returns the http.Server that called .listen(), if any.
  // Used by Workspace to route incoming fetch() requests through user code.
  get activeHttpServer(): HttpServer | null {
    return this._activeHttpServer;
  }

  // Route a Workers Request through the user's http.Server handler.
  // Returns null if no server is listening.
  async handleHttpRequest(request: Request): Promise<Response | null> {
    const server = this._activeHttpServer;
    if (!server || !server.listening) return null;

    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k] = v; });

    const req = new HttpIncomingMessage({
      method: request.method,
      url: url.pathname + url.search,
      headers,
    });

    // Feed request body as data events
    if (request.body) {
      const reader = request.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          req.emit("data", new TextDecoder().decode(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    req.emit("end");

    const res = new HttpServerResponse();

    // Call the user's handler
    server._handleRequest(req, res);

    // Wait for res.end() if not already finished
    if (!res.finished) {
      await new Promise<void>((resolve) => res.on("finish", () => resolve()));
    }

    return new Response(res.getBody(), {
      status: res.statusCode,
      headers: res.getHeaders(),
    });
  }

  async run(
    entryPath: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<RunResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode = 0;

    const resolved = await this.resolve(entryPath, this.cwd);
    if (!resolved) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Cannot find module '${entryPath}'\n`,
      };
    }

    this.moduleCache.clear();

    // Pre-load the dependency tree so synchronous require() works
    await this.preloadDependencies(resolved);

    try {
      await this.loadModule(resolved, {
        argv: ["node", entryPath, ...args],
        env,
        stdout,
        stderr,
        onExit: (code) => { exitCode = code ?? 0; },
      });

      // Wait for any spawned worker threads to complete
      if (this._pendingWorkers.length > 0) {
        await Promise.all(this._pendingWorkers);
        this._pendingWorkers = [];
      }
    } catch (err) {
      if (err instanceof ExitSignal) {
        exitCode = err.code;
      } else {
        const msg = err instanceof Error ? err.stack || err.message : String(err);
        stderr.push(msg + "\n");
        exitCode = 1;
      }
    }

    return {
      exitCode,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  }

  private async loadModule(
    absPath: string,
    ctx: {
      argv: string[];
      env: Record<string, string>;
      stdout: string[];
      stderr: string[];
      onExit: (code?: number) => void;
    },
  ): Promise<Record<string, unknown>> {
    if (this.moduleCache.has(absPath)) {
      return this.moduleCache.get(absPath)!;
    }

    const source = await this.fs.readFileText(absPath);
    if (source === null) {
      throw new Error(`Cannot find module '${absPath}'`);
    }

    // JSON files — return parsed object directly (matches Node.js behavior)
    if (absPath.endsWith(".json")) {
      const parsed = JSON.parse(source);
      this.moduleCache.set(absPath, parsed);
      return parsed;
    }

    const dirName = absPath.includes("/") ? absPath.slice(0, absPath.lastIndexOf("/")) : "";
    const moduleExports: Record<string, unknown> = {};
    const moduleObj = { exports: moduleExports };

    // Pre-cache to handle circular requires
    this.moduleCache.set(absPath, moduleExports);

    const requireFn = this.buildRequireFn(dirName, ctx);
    const { consoleShim, processShim, globalRef } = this.buildShims(ctx);

    const js = prepareSource(source, absPath);

    const paramList = "exports, require, module, __filename, __dirname, console, process, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, global, globalThis, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa";

    const fn = this.compileFunction(paramList, js);

    fn(
      moduleExports, requireFn, moduleObj, absPath, dirName,
      consoleShim, processShim,
      globalThis.setTimeout.bind(globalThis), globalThis.clearTimeout.bind(globalThis),
      globalThis.setInterval.bind(globalThis), globalThis.clearInterval.bind(globalThis),
      BufferShim, globalRef, globalRef, queueMicrotask,
      URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    );

    const finalExports = moduleObj.exports;
    this.moduleCache.set(absPath, finalExports);
    return finalExports;
  }

  // Pre-load all require'd dependencies into SQLite cache so synchronous require() works
  private async preloadDependencies(absPath: string, visited = new Set<string>()): Promise<void> {
    if (visited.has(absPath)) return;
    visited.add(absPath);

    const source = await this.fs.readFileText(absPath);
    if (!source) return;

    const dirName = absPath.includes("/") ? absPath.slice(0, absPath.lastIndexOf("/")) : "";

    // Scan for require("...") and import ... from "..." statements
    const specifiers: string[] = [];
    const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    const importPattern = /\bimport\s+(?:[\s\S]*?\s+from\s+)?(['"])([^'"]+)\1/g;
    let match;
    while ((match = requirePattern.exec(source)) !== null) specifiers.push(match[2]);
    while ((match = importPattern.exec(source)) !== null) specifiers.push(match[2]);

    // Resolve and read all dependencies in parallel
    const filtered = specifiers.filter((s) => !BUILTIN_MODULES.has(s.replace(/^node:/, "")));
    const resolved = await Promise.all(
      filtered.map((s) => this.resolve(s, dirName)),
    );
    const uniquePaths = [...new Set(resolved.filter((r): r is string => r !== null && !visited.has(r)))];

    // Read all files into cache in parallel
    await Promise.all(uniquePaths.map((p) => this.fs.readFile(p)));

    // Recursively preload (mark visited first to avoid duplicate work)
    await Promise.all(uniquePaths.map((p) => this.preloadDependencies(p, visited)));
  }

  // Synchronous module loading — reads source from SQLite cache (populated by preloadDependencies)
  private loadModuleSync(
    absPath: string,
    ctx: {
      argv: string[];
      env: Record<string, string>;
      stdout: string[];
      stderr: string[];
      onExit: (code?: number) => void;
    },
  ): Record<string, unknown> {
    if (this.moduleCache.has(absPath)) {
      return this.moduleCache.get(absPath)!;
    }

    const rows = this.fs.sql.exec("SELECT data FROM file_cache WHERE path = ?", absPath).toArray();
    if (rows.length === 0) {
      throw new Error(`Cannot find module '${absPath}'`);
    }
    const source = new TextDecoder().decode(new Uint8Array(rows[0].data as ArrayBuffer));

    // JSON files
    if (absPath.endsWith(".json")) {
      const parsed = JSON.parse(source);
      this.moduleCache.set(absPath, parsed);
      return parsed;
    }

    const dirName = absPath.includes("/") ? absPath.slice(0, absPath.lastIndexOf("/")) : "";
    const moduleExports: Record<string, unknown> = {};
    const moduleObj = { exports: moduleExports };

    // Pre-cache to handle circular requires
    this.moduleCache.set(absPath, moduleExports);

    const requireFn = this.buildRequireFn(dirName, ctx);

    const { consoleShim, processShim, globalRef } = this.buildShims(ctx);

    const js = prepareSource(source, absPath);
    const paramList = "exports, require, module, __filename, __dirname, console, process, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, global, globalThis, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa";
    const fn = this.compileFunction(paramList, js);

    fn(
      moduleExports, requireFn, moduleObj, absPath, dirName,
      consoleShim, processShim,
      globalThis.setTimeout.bind(globalThis), globalThis.clearTimeout.bind(globalThis),
      globalThis.setInterval.bind(globalThis), globalThis.clearInterval.bind(globalThis),
      BufferShim, globalRef, globalRef, queueMicrotask,
      URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    );

    const finalExports = moduleObj.exports;
    this.moduleCache.set(absPath, finalExports);
    return finalExports;
  }

  private buildRequireFn(
    dirName: string,
    ctx: { argv: string[]; env: Record<string, string>; stdout: string[]; stderr: string[]; onExit: (code?: number) => void },
  ): ((specifier: string) => unknown) & { resolve: (specifier: string) => string } {
    const requireFn = ((specifier: string): unknown => {
      const builtin = this.getBuiltinModule(specifier, ctx);
      if (builtin) return builtin;

      const resolved = this.resolveSync(specifier, dirName);
      if (!resolved) {
        throw new Error(`Cannot find module '${specifier}'`);
      }

      // If already cached, return it
      if (this.moduleCache.has(resolved)) {
        return this.moduleCache.get(resolved)!;
      }

      // Try synchronous load from SQLite cache (populated by preloadDependencies)
      return this.loadModuleSync(resolved, ctx);
    }) as ((specifier: string) => unknown) & { resolve: (specifier: string) => string };

    requireFn.resolve = (specifier: string) => {
      const builtin = this.getBuiltinModule(specifier, ctx);
      if (builtin) return specifier;
      const r = this.resolveSync(specifier, dirName);
      if (r) return r;
      throw new Error(`Cannot find module '${specifier}'`);
    };

    return requireFn;
  }

  private buildShims(ctx: { argv: string[]; env: Record<string, string>; stdout: string[]; stderr: string[]; onExit: (code?: number) => void }) {
    const format = (...a: unknown[]): string =>
      a.map((v) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v))).join(" ");

    const mergedEnv: Record<string, string> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/nodemode",
      NODE_ENV: "production",
      ...ctx.env,
    };

    const processShim = {
      argv: ctx.argv,
      env: mergedEnv,
      cwd: () => this.cwd,
      exit: (code?: number) => { throw new ExitSignal(code ?? 0); },
      stdout: { write: (s: string) => { ctx.stdout.push(s); return true; } },
      stderr: { write: (s: string) => { ctx.stderr.push(s); return true; } },
      platform: "linux" as const,
      arch: "x64" as const,
      version: "v22.0.0",
      versions: { node: "22.0.0" },
      pid: 1,
      ppid: 0,
      execPath: "/usr/bin/node",
      nextTick: (fn: () => void) => { queueMicrotask(fn); },
    };

    const consoleShim = {
      log: (...a: unknown[]) => { ctx.stdout.push(format(...a) + "\n"); },
      error: (...a: unknown[]) => { ctx.stderr.push(format(...a) + "\n"); },
      warn: (...a: unknown[]) => { ctx.stderr.push(format(...a) + "\n"); },
      info: (...a: unknown[]) => { ctx.stdout.push(format(...a) + "\n"); },
      debug: (...a: unknown[]) => { ctx.stderr.push(format(...a) + "\n"); },
      dir: (obj: unknown) => { ctx.stdout.push((JSON.stringify(obj, null, 2) ?? String(obj)) + "\n"); },
      time: () => {},
      timeEnd: () => {},
      trace: (...a: unknown[]) => {
        ctx.stderr.push("Trace: " + format(...a) + "\n");
        ctx.stderr.push(new Error().stack?.split("\n").slice(2).join("\n") + "\n" || "");
      },
    };

    const globalRef = {
      process: processShim,
      console: consoleShim,
      Buffer: BufferShim,
    };

    return { consoleShim, processShim, globalRef };
  }

  // -- Built-in modules backed by nodemode engines --

  private compileFunction(paramList: string, body: string): (...args: unknown[]) => void {
    // 1. Use env-provided UnsafeEval binding
    if (this.unsafeEval) {
      return this.unsafeEval.newFunction(paramList, body) as (...args: unknown[]) => void;
    }

    // 2. Use `new Function()` — works in Workers when:
    //    - unsafe_eval binding is configured (production)
    //    - vitest-pool-workers patches Function constructor (tests)
    try {
      return new Function(...paramList.split(", "), body) as (...args: unknown[]) => void;
    } catch {
      throw new Error(
        "JsRunner requires the UNSAFE_EVAL binding to execute JS. " +
        'Add to wrangler.jsonc: "unsafe": { "bindings": [{ "name": "UNSAFE_EVAL", "type": "unsafe_eval" }] }',
      );
    }
  }

  private getBuiltinModule(
    specifier: string,
    ctx: { stdout: string[]; stderr: string[] },
  ): Record<string, unknown> | null {
    const name = specifier.replace(/^node:/, "");
    switch (name) {
      case "fs": return this.buildFsModule();
      case "path": return buildPathModule();
      case "child_process": return this.buildChildProcessModule(ctx);
      case "os": return buildOsModule();
      case "util": return buildUtilModule();
      case "events": return { default: MiniEventEmitter, EventEmitter: MiniEventEmitter };
      case "url": return { URL, URLSearchParams, parse: urlParse };
      case "stream": return buildStreamModule();
      case "assert": return buildAssertModule();
      case "crypto": return buildCryptoModule();
      case "buffer": return { Buffer: BufferShim };
      case "querystring": return buildQuerystringModule();
      case "http":
      case "https": return buildHttpModule((srv) => { this._activeHttpServer = srv; });
      case "net": return buildNetModule();
      case "worker_threads": return this.buildWorkerThreadsModule(ctx);
      default: return null;
    }
  }

  // fs module backed by FsEngine — sync ops use SQLite, async ops use R2
  private buildFsModule(): Record<string, unknown> {
    const fsEngine = this.fs;
    const sql = fsEngine.sql;

    const existsSync = (p: string): boolean => fsEngine.exists(String(p));

    const statSync = (p: string) => {
      const s = fsEngine.stat(String(p));
      if (!s) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
      return toStatObj(s);
    };

    const lstatSync = statSync;

    const readdirSync = (p: string): string[] =>
      fsEngine.readdir(String(p)).map((e) => e.name);

    const mkdirSync = (p: string, opts?: { recursive?: boolean }) =>
      fsEngine.mkdir(String(p), opts?.recursive ?? false);

    // readFileSync reads from SQLite cache (files get cached on write or first async read)
    const readFileSync = (p: string, encoding?: string | { encoding?: string }): string | Uint8Array => {
      const path = String(p);
      const rows = sql.exec("SELECT data FROM file_cache WHERE path = ?", path).toArray();
      if (rows.length > 0) {
        const data = new Uint8Array(rows[0].data as ArrayBuffer);
        const enc = typeof encoding === "string" ? encoding : encoding?.encoding;
        return enc ? new TextDecoder().decode(data) : data;
      }
      if (fsEngine.exists(path)) {
        throw Object.assign(
          new Error(`EAGAIN: file '${p}' exists in R2 but not in cache. Read it async first via fs.promises.readFile().`),
          { code: "EAGAIN" },
        );
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
    };

    // writeFileSync writes to SQLite index + cache synchronously. R2 orphan is cleaned by reconciliation.
    const writeFileSync = (p: string, data: string | Uint8Array) => {
      const path = String(p);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      fsEngine.ensureParentDirs(path);
      const now = Date.now();
      sql.exec(
        `INSERT OR REPLACE INTO files (path, r2_key, size, mode, mtime, is_dir) VALUES (?, ?, ?, ?, ?, 0)`,
        path, `pending/${path}`, bytes.byteLength, 0o644, now,
      );
      sql.exec(
        "INSERT OR REPLACE INTO file_cache (path, data, cached_at) VALUES (?, ?, ?)",
        path, bytes, now,
      );
    };

    const unlinkSync = (p: string) => {
      const path = String(p);
      const s = fsEngine.stat(path);
      if (!s) throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${p}'`), { code: "ENOENT" });
      if (s.isDirectory) throw Object.assign(new Error(`EISDIR: illegal operation on a directory '${p}'`), { code: "EISDIR" });
      sql.exec("DELETE FROM files WHERE path = ?", path);
      sql.exec("DELETE FROM file_cache WHERE path = ?", path);
    };

    const rmdirSync = (p: string, opts?: { recursive?: boolean }) => {
      const path = String(p);
      const s = fsEngine.stat(path);
      if (!s) throw Object.assign(new Error(`ENOENT: no such file or directory '${p}'`), { code: "ENOENT" });
      if (!s.isDirectory) throw Object.assign(new Error(`ENOTDIR: not a directory '${p}'`), { code: "ENOTDIR" });
      if (opts?.recursive) {
        sql.exec("DELETE FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'", path, escapeLike(path) + "/%");
        sql.exec("DELETE FROM file_cache WHERE path = ? OR path LIKE ? ESCAPE '\\'", path, escapeLike(path) + "/%");
      } else {
        sql.exec("DELETE FROM files WHERE path = ?", path);
      }
    };

    const chmodSync = (p: string, mode: number) => fsEngine.chmod(String(p), mode);

    const copyFileSync = (src: string, dest: string) => {
      const data = readFileSync(String(src));
      writeFileSync(String(dest), data as Uint8Array);
    };

    const promises = {
      readFile: async (p: string, encoding?: string | { encoding?: string }) => {
        const data = await fsEngine.readFile(String(p));
        if (!data) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
        const enc = typeof encoding === "string" ? encoding : encoding?.encoding;
        return enc ? new TextDecoder().decode(data) : data;
      },
      writeFile: async (p: string, data: string | Uint8Array) => {
        await fsEngine.writeFile(String(p), typeof data === "string" ? data : new Uint8Array(data));
      },
      readdir: async (p: string) => fsEngine.readdir(String(p)).map((e) => e.name),
      stat: async (p: string) => statSync(p),
      lstat: async (p: string) => statSync(p),
      mkdir: async (p: string, opts?: { recursive?: boolean }) => {
        fsEngine.mkdir(String(p), opts?.recursive ?? false);
      },
      unlink: async (p: string) => { await fsEngine.unlink(String(p)); },
      rmdir: async (p: string, opts?: { recursive?: boolean }) => { await fsEngine.rmdir(String(p), opts?.recursive ?? false); },
      rename: async (from: string, to: string) => { await fsEngine.rename(String(from), String(to)); },
      copyFile: async (src: string, dest: string) => {
        const data = await fsEngine.readFile(String(src));
        if (!data) throw Object.assign(new Error(`ENOENT: '${src}'`), { code: "ENOENT" });
        await fsEngine.writeFile(String(dest), data);
      },
      access: async (p: string) => {
        if (!fsEngine.exists(String(p))) throw Object.assign(new Error(`ENOENT: '${p}'`), { code: "ENOENT" });
      },
      chmod: async (p: string, mode: number) => { fsEngine.chmod(String(p), mode); },
      rm: async (p: string, opts?: { recursive?: boolean; force?: boolean }) => {
        const s = fsEngine.stat(String(p));
        if (!s) {
          if (opts?.force) return;
          throw Object.assign(new Error(`ENOENT: '${p}'`), { code: "ENOENT" });
        }
        if (s.isDirectory) await fsEngine.rmdir(String(p), opts?.recursive ?? false);
        else await fsEngine.unlink(String(p));
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapCb = (promiseFn: (...a: any[]) => Promise<unknown>) =>
      (...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null, result?: unknown) => void;
        const fnArgs = args.slice(0, -1);
        promiseFn(...fnArgs).then((r) => cb(null, r)).catch(cb);
      };

    return {
      existsSync, statSync, lstatSync, readdirSync, mkdirSync,
      readFileSync, writeFileSync, unlinkSync, rmdirSync,
      chmodSync, copyFileSync,
      readFile: wrapCb(promises.readFile),
      writeFile: wrapCb(promises.writeFile),
      unlink: wrapCb(promises.unlink),
      mkdir: wrapCb(promises.mkdir),
      readdir: wrapCb(promises.readdir),
      stat: wrapCb(promises.stat),
      lstat: wrapCb(promises.stat),
      rename: wrapCb(promises.rename),
      copyFile: wrapCb(promises.copyFile),
      access: wrapCb(promises.access),
      rmdir: wrapCb(promises.rmdir),
      rm: wrapCb(promises.rm),
      chmod: wrapCb(promises.chmod),
      promises,
      constants: {
        F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
        COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2,
      },
    };
  }

  // child_process module backed by ProcessManager
  private buildChildProcessModule(ctx: { stdout: string[]; stderr: string[] }): Record<string, unknown> {
    const pm = this.pm;

    return {
      exec: (command: string, optionsOrCb?: unknown, cb?: unknown) => {
        const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
        const options = typeof optionsOrCb === "object" ? optionsOrCb as Record<string, unknown> : {};
        const cp = new ChildProcessLike();

        pm.exec(command, {
          cwd: options.cwd as string | undefined,
          env: options.env as Record<string, string> | undefined,
        }).then((result) => {
          cp._exitCode = result.exitCode;
          if (typeof callback === "function") {
            if (result.exitCode !== 0) {
              const err = Object.assign(new Error(`Command failed: ${command}`), { code: result.exitCode });
              (callback as (e: Error | null, stdout: string, stderr: string) => void)(err, result.stdout, result.stderr);
            } else {
              (callback as (e: Error | null, stdout: string, stderr: string) => void)(null, result.stdout, result.stderr);
            }
          }
          cp.emit("exit", result.exitCode);
          cp.emit("close", result.exitCode);
        }).catch((err) => {
          if (typeof callback === "function") (callback as (e: Error) => void)(err as Error);
          cp.emit("error", err);
        });

        return cp;
      },

      execSync: (command: string): never => {
        throw new Error(
          `execSync('${command}') requires synchronous process execution which is not available. ` +
          `Use exec() with a callback or util.promisify(exec)() instead.`,
        );
      },

      spawn: (command: string, args?: string[], options?: Record<string, unknown>) => {
        const fullCommand = args ? `${command} ${args.map(quoteArg).join(" ")}` : command;
        const cp = new ChildProcessLike();

        pm.exec(fullCommand, {
          cwd: options?.cwd as string | undefined,
          env: options?.env as Record<string, string> | undefined,
        }).then((result) => {
          cp._exitCode = result.exitCode;
          if (result.stdout) cp.stdout.emit("data", result.stdout);
          if (result.stderr) cp.stderr.emit("data", result.stderr);
          cp.stdout.emit("end");
          cp.stderr.emit("end");
          cp.emit("exit", result.exitCode);
          cp.emit("close", result.exitCode);
        }).catch((err) => {
          cp.emit("error", err);
        });

        return cp;
      },

      execFile: (file: string, args?: string[], optionsOrCb?: unknown, cb?: unknown) => {
        const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
        const options = typeof optionsOrCb === "object" ? optionsOrCb as Record<string, unknown> : {};
        const command = args ? `${file} ${args.map(quoteArg).join(" ")}` : file;
        const cp = new ChildProcessLike();

        pm.exec(command, {
          cwd: options.cwd as string | undefined,
          env: options.env as Record<string, string> | undefined,
        }).then((result) => {
          cp._exitCode = result.exitCode;
          if (typeof callback === "function") {
            if (result.exitCode !== 0) {
              const err = Object.assign(new Error(`Command failed: ${command}`), { code: result.exitCode });
              (callback as (e: Error | null, stdout: string, stderr: string) => void)(err, result.stdout, result.stderr);
            } else {
              (callback as (e: Error | null, stdout: string, stderr: string) => void)(null, result.stdout, result.stderr);
            }
          }
          cp.emit("exit", result.exitCode);
          cp.emit("close", result.exitCode);
        }).catch((err) => {
          if (typeof callback === "function") (callback as (e: Error) => void)(err as Error);
          cp.emit("error", err);
        });

        return cp;
      },

      fork: (): never => {
        throw new Error("fork() is not available — Workers are single-threaded");
      },
    };
  }

  // worker_threads module — uses separate JsRunner instances for true isolation
  private _workerThreadId = 0;
  private buildWorkerThreadsModule(ctx: { stdout: string[]; stderr: string[] }): Record<string, unknown> {
    const runner = this;
    let threadIdCounter = runner._workerThreadId;

    class Worker extends MiniEventEmitter {
      threadId: number;
      private _childPort: MiniEventEmitter;

      constructor(filename: string, options?: { workerData?: unknown }) {
        super();
        this.threadId = ++threadIdCounter;

        const childRunner = runner.fork();

        // Create parent port for the child — postMessage sends to parent Worker
        const parentWorker = this;
        const childParentPort = new MiniEventEmitter();
        (childParentPort as unknown as Record<string, unknown>).postMessage = (data: unknown) => {
          const cloned = JSON.parse(JSON.stringify(data));
          parentWorker.emit("message", cloned);
        };

        this._childPort = childParentPort;

        // Configure child as a worker thread
        childRunner.setThreadContext({
          isMainThread: false,
          parentPort: childParentPort as MiniEventEmitter & { postMessage: (data: unknown) => void },
          workerData: options?.workerData !== undefined
            ? JSON.parse(JSON.stringify(options.workerData))
            : null,
        });

        // Resolve worker filename relative to cwd (bare names are local files, not packages)
        const workerPath = filename.startsWith("/") || filename.startsWith("./") || filename.startsWith("../")
          ? filename
          : `./${filename}`;

        // Run the worker script in a separate execution context (own module cache)
        const workerPromise = childRunner.run(workerPath, [], {}).then((result) => {
          if (result.stdout) ctx.stdout.push(result.stdout);
          if (result.stderr) ctx.stderr.push(result.stderr);
          this.emit("exit", result.exitCode);
        }).catch((err) => {
          this.emit("error", err);
        });
        runner._pendingWorkers.push(workerPromise);
      }

      postMessage(data: unknown) {
        const cloned = JSON.parse(JSON.stringify(data));
        this._childPort.emit("message", cloned);
      }

      terminate() {
        queueMicrotask(() => {
          this.emit("exit", 0);
        });
        return Promise.resolve(0);
      }

      ref() { return this; }
      unref() { return this; }
    }

    return {
      Worker,
      isMainThread: runner._threadContext.isMainThread,
      parentPort: runner._threadContext.parentPort,
      workerData: runner._threadContext.workerData,
      threadId: runner._threadContext.isMainThread ? 0 : runner._workerThreadId,
      MessageChannel: class {
        port1 = new MiniEventEmitter();
        port2 = new MiniEventEmitter();
      },
      MessagePort: MiniEventEmitter,
    };
  }

  // -- Module resolution --

  async resolve(specifier: string, fromDir: string): Promise<string | null> {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? specifier.replace(/^\/+/, "")
        : joinPath(fromDir, specifier);
      return (await this.resolveFile(base)) ?? (await this.resolveDir(base));
    }

    const parts = fromDir ? fromDir.split("/") : [];
    for (let i = parts.length; i >= 0; i--) {
      const nmDir = parts.slice(0, i).concat("node_modules").join("/");
      const candidate = joinPath(nmDir, specifier);
      const found = (await this.resolveFile(candidate))
        ?? (await this.resolveDir(candidate))
        ?? (await this.resolvePackage(candidate));
      if (found) return found;
    }

    return null;
  }

  private resolveSync(specifier: string, fromDir: string): string | null {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? specifier.replace(/^\/+/, "")
        : joinPath(fromDir, specifier);
      return this.resolveFileSync(base) ?? this.resolveIndexSync(base);
    }

    const parts = fromDir ? fromDir.split("/") : [];
    for (let i = parts.length; i >= 0; i--) {
      const nmDir = parts.slice(0, i).concat("node_modules").join("/");
      const candidate = joinPath(nmDir, specifier);
      const found = this.resolveFileSync(candidate) ?? this.resolveIndexSync(candidate);
      if (found) return found;
    }
    return null;
  }

  private async resolveFile(path: string): Promise<string | null> {
    if (this.fs.exists(path)) {
      const s = this.fs.stat(path);
      if (s && !s.isDirectory) return path;
    }
    for (const ext of JS_EXTENSIONS) {
      const candidate = path + ext;
      if (this.fs.exists(candidate)) return candidate;
    }
    return null;
  }

  private resolveFileSync(path: string): string | null {
    if (this.fs.exists(path)) {
      const s = this.fs.stat(path);
      if (s && !s.isDirectory) return path;
    }
    for (const ext of JS_EXTENSIONS) {
      const candidate = path + ext;
      if (this.fs.exists(candidate)) return candidate;
    }
    return null;
  }

  private async resolveDir(path: string): Promise<string | null> {
    return (await this.resolvePackage(path)) ?? (await this.resolveIndex(path));
  }

  private async resolvePackage(path: string): Promise<string | null> {
    const pkgPath = path + "/package.json";
    const pkgText = await this.fs.readFileText(pkgPath);
    if (!pkgText) return null;
    try {
      const pkg = JSON.parse(pkgText) as { main?: string; module?: string };
      const entry = pkg.module || pkg.main;
      if (entry) {
        const resolved = await this.resolveFile(joinPath(path, entry));
        if (resolved) return resolved;
      }
    } catch { /* invalid package.json */ }
    return this.resolveIndex(path);
  }

  private async resolveIndex(path: string): Promise<string | null> {
    for (const idx of INDEX_FILES) {
      const candidate = joinPath(path, idx);
      if (this.fs.exists(candidate)) return candidate;
    }
    return null;
  }

  private resolveIndexSync(path: string): string | null {
    for (const idx of INDEX_FILES) {
      const candidate = joinPath(path, idx);
      if (this.fs.exists(candidate)) return candidate;
    }
    return null;
  }
}

// Signal thrown by process.exit() — caught at the top level
class ExitSignal extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitSignal";
  }
}

// -- Buffer --

const BufferShim = {
  from(data: string | Uint8Array | number[], encoding?: string): Uint8Array {
    if (typeof data === "string") {
      if (encoding === "base64") {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }
      if (encoding === "hex") {
        const bytes = new Uint8Array(data.length / 2);
        for (let i = 0; i < data.length; i += 2) bytes[i / 2] = parseInt(data.slice(i, i + 2), 16);
        return bytes;
      }
      return new TextEncoder().encode(data);
    }
    return new Uint8Array(data);
  },
  isBuffer(obj: unknown): boolean {
    return obj instanceof Uint8Array;
  },
  alloc(size: number, fill?: number): Uint8Array {
    const buf = new Uint8Array(size);
    if (fill !== undefined) buf.fill(fill);
    return buf;
  },
  allocUnsafe(size: number): Uint8Array {
    return new Uint8Array(size);
  },
  concat(list: Uint8Array[], totalLength?: number): Uint8Array {
    const total = totalLength ?? list.reduce((sum, b) => sum + b.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const b of list) {
      result.set(b, offset);
      offset += b.length;
    }
    return result;
  },
  byteLength(str: string, encoding?: string): number {
    if (encoding === "base64") return Math.ceil(str.length * 3 / 4);
    return new TextEncoder().encode(str).byteLength;
  },
};

// -- MiniEventEmitter --

class MiniEventEmitter {
  private _h: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(e: string, fn: (...args: unknown[]) => void) { (this._h[e] ??= []).push(fn); return this; }
  once(e: string, fn: (...args: unknown[]) => void) {
    const w = (...a: unknown[]) => { this.off(e, w); fn(...a); };
    return this.on(e, w);
  }
  off(e: string, fn: (...args: unknown[]) => void) {
    if (this._h[e]) this._h[e] = this._h[e].filter((h) => h !== fn);
    return this;
  }
  emit(e: string, ...a: unknown[]) {
    const h = this._h[e];
    if (!h?.length) return false;
    for (const fn of h) fn(...a);
    return true;
  }
  removeAllListeners(e?: string) {
    if (e) delete this._h[e];
    else this._h = {};
    return this;
  }
  addListener(e: string, fn: (...args: unknown[]) => void) { return this.on(e, fn); }
  removeListener(e: string, fn: (...args: unknown[]) => void) { return this.off(e, fn); }
  listenerCount(e: string) { return this._h[e]?.length ?? 0; }
  listeners(e: string) { return [...(this._h[e] ?? [])]; }
  rawListeners(e: string) { return this.listeners(e); }
  eventNames() { return Object.keys(this._h).filter((k) => this._h[k]?.length); }
}

// -- ChildProcessLike --

class ChildProcessLike extends MiniEventEmitter {
  pid = 1;
  stdin = new StreamLike();
  stdout = new StreamLike();
  stderr = new StreamLike();
  _exitCode: number | null = null;
  get exitCode() { return this._exitCode; }
  kill() {}
  ref() { return this; }
  unref() { return this; }
}

class StreamLike extends MiniEventEmitter {
  pipe(dest: unknown) { return dest; }
  setEncoding() { return this; }
  read() { return null; }
}

// -- Node.js built-in module implementations --

function toStatObj(s: { size: number; mode: number; mtime: number; isDirectory: boolean }) {
  return {
    size: s.size, mode: s.mode, mtimeMs: s.mtime,
    isFile: () => !s.isDirectory,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => false,
    mtime: new Date(s.mtime),
    atime: new Date(s.mtime),
    ctime: new Date(s.mtime),
    birthtime: new Date(s.mtime),
    atimeMs: s.mtime,
    ctimeMs: s.mtime,
    birthtimeMs: s.mtime,
    dev: 0, ino: 0, nlink: 1, uid: 0, gid: 0, rdev: 0,
    blksize: 4096, blocks: Math.ceil(s.size / 512),
  };
}

function buildPathModule(): Record<string, unknown> {
  const mod: Record<string, unknown> = {
    join: (...parts: string[]) => {
      const joined = parts.filter(Boolean).join("/");
      const segs = joined.split("/");
      const out: string[] = [];
      for (const s of segs) {
        if (s === "." || s === "") continue;
        if (s === "..") out.pop();
        else out.push(s);
      }
      return out.join("/") || ".";
    },
    resolve: (...parts: string[]) => {
      let resolved = "";
      for (let i = parts.length - 1; i >= 0; i--) {
        resolved = parts[i] + (resolved ? "/" + resolved : "");
        if (parts[i].startsWith("/")) break;
      }
      const segs = resolved.split("/");
      const out: string[] = [];
      for (const s of segs) {
        if (s === "." || s === "") continue;
        if (s === "..") out.pop();
        else out.push(s);
      }
      return "/" + out.join("/");
    },
    dirname: (p: string) => {
      const i = p.lastIndexOf("/");
      return i > 0 ? p.slice(0, i) : i === 0 ? "/" : ".";
    },
    basename: (p: string, ext?: string) => {
      const base = p.replace(/\/+$/, "").split("/").pop() || "";
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p: string) => {
      const base = p.split("/").pop() || "";
      const dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(dot) : "";
    },
    sep: "/",
    delimiter: ":",
    posix: null as unknown,
    isAbsolute: (p: string) => p.startsWith("/"),
    normalize: (p: string) => {
      const segs = p.split("/");
      const out: string[] = [];
      for (const s of segs) {
        if (s === ".") continue;
        if (s === "..") out.pop();
        else if (s !== "" || out.length === 0) out.push(s);
      }
      return out.join("/") || ".";
    },
    relative: (from: string, to: string) => {
      const fromParts = from.split("/").filter(Boolean);
      const toParts = to.split("/").filter(Boolean);
      let common = 0;
      while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
      const ups = Array(fromParts.length - common).fill("..");
      return [...ups, ...toParts.slice(common)].join("/") || ".";
    },
    parse: (p: string) => {
      const dir = p.slice(0, p.lastIndexOf("/")) || ".";
      const base = p.split("/").pop() || "";
      const dotIdx = base.lastIndexOf(".");
      const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
      const name = ext ? base.slice(0, -ext.length) : base;
      return { root: p.startsWith("/") ? "/" : "", dir, base, ext, name };
    },
    format: (obj: { dir?: string; root?: string; base?: string; name?: string; ext?: string }) => {
      const dir = obj.dir || obj.root || "";
      const base = obj.base || ((obj.name || "") + (obj.ext || ""));
      return dir ? dir + "/" + base : base;
    },
  };
  mod.posix = mod;
  return mod;
}

function buildOsModule(): Record<string, unknown> {
  return {
    platform: () => "linux",
    arch: () => "x64",
    homedir: () => "/home/nodemode",
    tmpdir: () => "/tmp",
    hostname: () => "nodemode",
    cpus: () => [{ model: "Workers V8 Isolate", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    totalmem: () => 128 * 1024 * 1024,
    freemem: () => 64 * 1024 * 1024,
    type: () => "Linux",
    release: () => "6.0.0-nodemode",
    uptime: () => 0,
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    userInfo: () => ({ username: "nodemode", uid: 1000, gid: 1000, shell: "/bin/sh", homedir: "/home/nodemode" }),
    endianness: () => "LE",
    EOL: "\n",
    devNull: "/dev/null",
    constants: { signals: {}, errno: {} },
  };
}

function buildUtilModule(): Record<string, unknown> {
  const promisify = (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: unknown, ...results: unknown[]) => {
          if (err) reject(err);
          else resolve(results.length <= 1 ? results[0] : results);
        });
      });

  const inspect = (obj: unknown, _opts?: unknown): string => {
    if (typeof obj === "string") return `'${obj}'`;
    if (obj === null) return "null";
    if (obj === undefined) return "undefined";
    if (typeof obj === "function") return `[Function: ${obj.name || "anonymous"}]`;
    try { return JSON.stringify(obj, null, 2) ?? String(obj); } catch { return String(obj); }
  };

  const format = (fmt: unknown, ...args: unknown[]): string => {
    if (typeof fmt !== "string") return [fmt, ...args].map((a) => inspect(a)).join(" ");
    let i = 0;
    return fmt.replace(/%[sdjOo%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      if (m === "%s") return String(a);
      if (m === "%d") return Number(a).toString();
      return inspect(a);
    });
  };

  return {
    promisify,
    inspect,
    format,
    debuglog: () => () => {},
    deprecate: (fn: unknown) => fn,
    inherits: (ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }) => {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      ctor.super_ = superCtor;
    },
    types: {
      isDate: (v: unknown) => v instanceof Date,
      isRegExp: (v: unknown) => v instanceof RegExp,
      isNativeError: (v: unknown) => v instanceof Error,
      isPromise: (v: unknown) => v instanceof Promise,
      isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    },
    callbackify: (fn: (...args: unknown[]) => Promise<unknown>) =>
      (...args: unknown[]) => {
        const cb = args.pop() as (err: unknown, result?: unknown) => void;
        fn(...args).then((r) => cb(null, r)).catch(cb);
      },
    TextDecoder,
    TextEncoder,
  };
}

function buildStreamModule(): Record<string, unknown> {
  class Readable extends MiniEventEmitter {
    readable = true;
    destroyed = false;
    pipe(dest: { write: (c: unknown) => void; end: () => void }) {
      this.on("data", (chunk: unknown) => dest.write(chunk));
      this.on("end", () => dest.end());
      return dest;
    }
    read() { return null; }
    destroy() { this.destroyed = true; this.emit("close"); return this; }
    setEncoding() { return this; }
    resume() { return this; }
    pause() { return this; }
    unpipe() { return this; }
  }

  class Writable extends MiniEventEmitter {
    writable = true;
    destroyed = false;
    private _chunks: unknown[] = [];
    write(chunk: unknown, _encoding?: unknown, cb?: () => void) {
      this._chunks.push(chunk);
      if (typeof cb === "function") cb();
      return true;
    }
    end(chunk?: unknown, _encoding?: unknown, cb?: () => void) {
      if (chunk !== undefined) this._chunks.push(chunk);
      this.writable = false;
      this.emit("finish");
      this.emit("close");
      if (typeof cb === "function") cb();
      return this;
    }
    destroy() { this.destroyed = true; this.emit("close"); return this; }
  }

  class Transform extends MiniEventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    write(chunk: unknown, _encoding?: unknown, cb?: () => void) {
      this.emit("data", chunk);
      if (typeof cb === "function") cb();
      return true;
    }
    end(chunk?: unknown, _encoding?: unknown, cb?: () => void) {
      if (chunk !== undefined) this.emit("data", chunk);
      this.emit("end");
      this.emit("finish");
      if (typeof cb === "function") cb();
      return this;
    }
    destroy() { this.destroyed = true; this.emit("close"); return this; }
    pipe(dest: { write: (c: unknown) => void; end: () => void }) {
      this.on("data", (chunk: unknown) => dest.write(chunk));
      this.on("end", () => dest.end());
      return dest;
    }
    setEncoding() { return this; }
  }

  class PassThrough extends Transform {}

  const finished = (stream: MiniEventEmitter, cb: (err?: Error) => void): (() => void) => {
    let called = false;
    const done = (err?: Error) => {
      if (called) return;
      called = true;
      cb(err);
    };
    stream.once("end", () => done());
    stream.once("finish", () => done());
    stream.once("error", (e: unknown) => done(e as Error));
    return () => {
      // cleanup — prevent callback from firing
      called = true;
    };
  };

  const pipeline = (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() as (err?: Error) => void : null;
    const streams = args as Array<{ pipe?: (d: unknown) => unknown; destroy?: () => void; on?: (e: string, fn: (...a: unknown[]) => void) => void }>;
    const destroyAll = (err: Error) => {
      for (const s of streams) {
        if (s && typeof s.destroy === "function") s.destroy();
      }
      if (cb) cb(err);
    };
    try {
      for (let i = 0; i < streams.length; i++) {
        const s = streams[i];
        if (s && typeof s.on === "function") {
          s.on("error", (e: unknown) => destroyAll(e as Error));
        }
        if (i < streams.length - 1 && s && typeof s.pipe === "function") {
          s.pipe(streams[i + 1] as { write: (c: unknown) => void; end: () => void });
        }
      }
      const last = streams[streams.length - 1];
      if (last && typeof last.on === "function") {
        let done = false;
        const onDone = () => {
          if (done) return;
          done = true;
          if (cb) cb(undefined);
        };
        last.on("finish", onDone);
        last.on("end", onDone);
      }
    } catch (err) {
      if (cb) cb(err as Error);
    }
  };

  const promisePipeline = (...streams: unknown[]): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      pipeline(...streams, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  const promises = { pipeline: promisePipeline };

  return {
    Readable, Writable, Transform, PassThrough,
    pipeline,
    finished,
    promises,
  };
}

function buildAssertModule(): Record<string, unknown> {
  const assert = (value: unknown, message?: string) => {
    if (!value) throw new Error(message || `AssertionError: ${value} is not truthy`);
  };
  assert.ok = assert;
  assert.strictEqual = (actual: unknown, expected: unknown, message?: string) => {
    if (actual !== expected) throw new Error(message || `AssertionError: ${actual} !== ${expected}`);
  };
  assert.deepStrictEqual = (actual: unknown, expected: unknown, message?: string) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(message || `AssertionError: deepStrictEqual failed`);
    }
  };
  assert.notStrictEqual = (actual: unknown, expected: unknown, message?: string) => {
    if (actual === expected) throw new Error(message || `AssertionError: ${actual} === ${expected}`);
  };
  assert.throws = (fn: () => void, _expected?: unknown, message?: string) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error(message || "AssertionError: Missing expected exception");
  };
  assert.rejects = async (fn: (() => Promise<unknown>) | Promise<unknown>, _expected?: unknown, message?: string) => {
    try { await (typeof fn === "function" ? fn() : fn); } catch { return; }
    throw new Error(message || "AssertionError: Missing expected rejection");
  };
  assert.fail = (message?: string) => { throw new Error(message || "AssertionError: Failed"); };
  assert.ifError = (value: unknown) => { if (value) throw value; };
  return assert as unknown as Record<string, unknown>;
}

function buildCryptoModule(): Record<string, unknown> {
  // Delegate to Workers' node:crypto (nodejs_compat) for synchronous createHash
  return {
    createHash: nodeCrypto.createHash,
    createHmac: nodeCrypto.createHmac,
    randomBytes: nodeCrypto.randomBytes,
    randomUUID: nodeCrypto.randomUUID,
    timingSafeEqual: nodeCrypto.timingSafeEqual,
    createCipheriv: nodeCrypto.createCipheriv,
    createDecipheriv: nodeCrypto.createDecipheriv,
    pbkdf2: nodeCrypto.pbkdf2,
    pbkdf2Sync: nodeCrypto.pbkdf2Sync,
    scrypt: nodeCrypto.scrypt,
    scryptSync: nodeCrypto.scryptSync,
    constants: nodeCrypto.constants,
  };
}

function buildQuerystringModule(): Record<string, unknown> {
  return {
    parse: (str: string) => Object.fromEntries(new URLSearchParams(str)),
    stringify: (obj: Record<string, string>) => new URLSearchParams(obj).toString(),
    encode: (obj: Record<string, string>) => new URLSearchParams(obj).toString(),
    decode: (str: string) => Object.fromEntries(new URLSearchParams(str)),
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
  };
}

// Module-level HTTP classes — shared between buildHttpModule() and JsRunner.handleHttpRequest()
class HttpIncomingMessage extends MiniEventEmitter {
  headers: Record<string, string> = {};
  method = "GET";
  url = "/";
  statusCode = 200;
  httpVersion = "1.1";
  constructor(init?: { method?: string; url?: string; headers?: Record<string, string> }) {
    super();
    if (init) {
      this.method = init.method ?? "GET";
      this.url = init.url ?? "/";
      this.headers = init.headers ?? {};
    }
  }
}

class HttpServerResponse extends MiniEventEmitter {
  statusCode = 200;
  private _headers: Record<string, string> = {};
  private _body: string[] = [];
  headersSent = false;
  finished = false;

  setHeader(name: string, value: string) { this._headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string) { return this._headers[name.toLowerCase()]; }
  removeHeader(name: string) { delete this._headers[name.toLowerCase()]; }
  writeHead(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) for (const [k, v] of Object.entries(headers)) this._headers[k.toLowerCase()] = v;
    this.headersSent = true;
    return this;
  }
  write(chunk: string) { this._body.push(chunk); return true; }
  end(data?: string) {
    if (data) this._body.push(data);
    this.finished = true;
    this.emit("finish");
  }
  getBody() { return this._body.join(""); }
  getHeaders() { return { ...this._headers }; }
}

class HttpServer extends MiniEventEmitter {
  private _handler: ((req: HttpIncomingMessage, res: HttpServerResponse) => void) | null = null;
  private _port = 0;
  private _onListen: ((srv: HttpServer) => void) | null = null;
  listening = false;

  constructor(handler?: (req: HttpIncomingMessage, res: HttpServerResponse) => void, onListen?: (srv: HttpServer) => void) {
    super();
    if (handler) this._handler = handler;
    this._onListen = onListen ?? null;
  }

  // In Workers there is no TCP bind — listen() signals readiness and registers
  // the server with JsRunner so the DO's fetch() can route requests through it.
  listen(port?: number, _host?: string | (() => void), cb?: () => void) {
    this._port = port ?? 0;
    this.listening = true;
    if (this._onListen) this._onListen(this);
    const callback = typeof _host === "function" ? _host : cb;
    if (callback) queueMicrotask(callback);
    this.emit("listening");
    return this;
  }

  close(cb?: () => void) {
    this.listening = false;
    if (cb) queueMicrotask(cb);
    this.emit("close");
    return this;
  }

  address() { return { address: "0.0.0.0", family: "IPv4", port: this._port }; }

  // Called by the DO's fetch() handler to route a Workers Request through
  // the user's Node.js-style (req, res) handler and produce a Response.
  _handleRequest(req: HttpIncomingMessage, res: HttpServerResponse) {
    if (this._handler) this._handler(req, res);
    else this.emit("request", req, res);
  }
}

function buildHttpModule(onServerListen?: (server: HttpServer) => void): Record<string, unknown> {
  const createServer = (handler?: (req: HttpIncomingMessage, res: HttpServerResponse) => void) =>
    new HttpServer(handler, onServerListen);

  const STATUS_CODES_MAP: Record<number, string> = {
    200: "OK", 201: "Created", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 500: "Internal Server Error",
  };

  class ClientRequest extends MiniEventEmitter {
    private _headers: Record<string, string> = {};
    private _body: string[] = [];
    private _method: string;
    private _url: string;
    private _abortController = new AbortController();
    private _callback?: (res: HttpIncomingMessage) => void;

    constructor(opts: {
      protocol?: string;
      hostname?: string;
      host?: string;
      port?: number | string;
      path?: string;
      method?: string;
      headers?: Record<string, string>;
    }, callback?: (res: HttpIncomingMessage) => void) {
      super();
      const protocol = (opts.protocol ?? "http:").replace(/:?$/, ":");
      const hostname = opts.hostname ?? opts.host ?? "localhost";
      const port = opts.port ? `:${opts.port}` : "";
      const path = opts.path ?? "/";
      this._method = (opts.method ?? "GET").toUpperCase();
      this._url = `${protocol}//${hostname}${port}${path}`;
      if (opts.headers) {
        for (const [k, v] of Object.entries(opts.headers)) {
          this._headers[k.toLowerCase()] = v;
        }
      }
      this._callback = callback;
    }

    setHeader(name: string, value: string) { this._headers[name.toLowerCase()] = value; }
    getHeader(name: string) { return this._headers[name.toLowerCase()]; }

    write(chunk: string | Uint8Array) {
      this._body.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return this;
    }

    end(chunk?: string | Uint8Array | (() => void), _encoding?: string, _cb?: () => void) {
      if (typeof chunk === "function") {
        // end(callback) signature — no body to append
      } else if (chunk != null) {
        this.write(chunk);
      }

      const body = this._body.length > 0 ? this._body.join("") : undefined;
      const fetchOpts: RequestInit = {
        method: this._method,
        headers: this._headers,
        signal: this._abortController.signal,
      };
      if (body && this._method !== "GET" && this._method !== "HEAD") {
        fetchOpts.body = body;
      }

      fetch(this._url, fetchOpts)
        .then(async (fetchRes) => {
          const incomingHeaders: Record<string, string> = {};
          fetchRes.headers.forEach((v, k) => { incomingHeaders[k.toLowerCase()] = v; });

          const res = new HttpIncomingMessage({ headers: incomingHeaders });
          res.statusCode = fetchRes.status;
          (res as unknown as Record<string, unknown>).statusMessage =
            fetchRes.statusText || STATUS_CODES_MAP[fetchRes.status] || "";

          if (this._callback) this._callback(res);
          this.emit("response", res);

          const text = await fetchRes.text();
          if (text.length > 0) {
            res.emit("data", text);
          }
          res.emit("end");
        })
        .catch((err: unknown) => {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        });

      return this;
    }

    abort() {
      this._abortController.abort();
      this.emit("abort");
    }

    destroy(err?: Error) {
      this._abortController.abort();
      if (err) this.emit("error", err);
      this.emit("close");
      return this;
    }
  }

  const request = (
    opts: string | Record<string, unknown>,
    cb?: ((res: HttpIncomingMessage) => void) | Record<string, unknown>,
  ) => {
    let parsedOpts: Record<string, unknown>;
    let callback: ((res: HttpIncomingMessage) => void) | undefined;

    if (typeof opts === "string") {
      const url = new URL(opts);
      parsedOpts = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
      };
    } else {
      parsedOpts = opts;
    }

    if (typeof cb === "function") {
      callback = cb as (res: HttpIncomingMessage) => void;
    }

    return new ClientRequest(
      parsedOpts as {
        protocol?: string; hostname?: string; host?: string;
        port?: number | string; path?: string; method?: string;
        headers?: Record<string, string>;
      },
      callback,
    );
  };

  const get = (
    opts: string | Record<string, unknown>,
    cb?: ((res: HttpIncomingMessage) => void) | Record<string, unknown>,
  ) => {
    let parsedOpts: Record<string, unknown>;
    if (typeof opts === "string") {
      const url = new URL(opts);
      parsedOpts = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "GET",
      };
    } else {
      parsedOpts = { ...opts, method: "GET" };
    }
    const req = request(parsedOpts, cb);
    req.end();
    return req;
  };

  return {
    createServer,
    Server: HttpServer,
    IncomingMessage: HttpIncomingMessage,
    ServerResponse: HttpServerResponse,
    request,
    get,
    STATUS_CODES: { 200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error" },
    METHODS: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    globalAgent: { maxSockets: Infinity },
  };
}

// net module — provides Socket and Server for TCP-like operations.
// In Workers there is no raw TCP access, so Socket operations use the
// EventEmitter pattern to signal connect/data/end lifecycle events.
// Libraries that import net (e.g., database drivers) use these to detect
// capability and fall back to fetch-based transports when connect fails.
function buildNetModule(): Record<string, unknown> {
  const TCP_ERR = "Raw TCP sockets are not available in Workers. Use fetch() for HTTP or connect() from cloudflare:sockets for TCP.";

  class Socket extends MiniEventEmitter {
    remoteAddress = "127.0.0.1";
    remotePort = 0;
    localAddress = "0.0.0.0";
    localPort = 0;
    writable = false;
    readable = false;
    destroyed = false;

    connect(_port: number, _host?: string | (() => void), _cb?: () => void) {
      const err = Object.assign(new Error(TCP_ERR), { code: "ERR_SOCKET_NOT_AVAILABLE" });
      queueMicrotask(() => this.emit("error", err));
      return this;
    }
    write(_data: unknown, _enc?: unknown, _cb?: () => void) {
      throw Object.assign(new Error(TCP_ERR), { code: "ERR_SOCKET_NOT_AVAILABLE" });
    }
    end() { this.writable = false; this.emit("end"); return this; }
    destroy() { this.destroyed = true; this.emit("close"); return this; }
    setKeepAlive() { return this; }
    setNoDelay() { return this; }
    setTimeout(_ms: number, cb?: () => void) { if (cb) this.on("timeout", cb); return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return { address: this.localAddress, family: "IPv4", port: this.localPort }; }
  }

  class NetServer extends MiniEventEmitter {
    listening = false;
    listen(_port?: number, _host?: string | (() => void), _cb?: () => void) {
      const err = Object.assign(new Error("TCP server not available in Workers. Use http.createServer() which routes through the DO's fetch handler."), { code: "ERR_SERVER_NOT_AVAILABLE" });
      queueMicrotask(() => this.emit("error", err));
      return this;
    }
    close(cb?: () => void) { this.listening = false; if (cb) queueMicrotask(cb); this.emit("close"); return this; }
    address() { return { address: "0.0.0.0", family: "IPv4", port: 0 }; }
    ref() { return this; }
    unref() { return this; }
  }

  return {
    Socket,
    Server: NetServer,
    createServer: (cb?: (...args: unknown[]) => void) => {
      const srv = new NetServer();
      if (cb) srv.on("connection", cb);
      return srv;
    },
    createConnection: (port: number, host?: string | (() => void), cb?: () => void) => {
      const s = new Socket();
      s.connect(port, host, cb);
      return s;
    },
    connect: (port: number, host?: string | (() => void), cb?: () => void) => {
      const s = new Socket();
      s.connect(port, host, cb);
      return s;
    },
    isIP: (input: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(input) ? 4 : /^[0-9a-f:]+$/i.test(input) ? 6 : 0,
    isIPv4: (input: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(input),
    isIPv6: (input: string) => /^[0-9a-f:]+$/i.test(input),
  };
}

function urlParse(urlStr: string): Record<string, string | null> {
  try {
    const u = new URL(urlStr);
    return {
      protocol: u.protocol, hostname: u.hostname, host: u.host,
      port: u.port || null, pathname: u.pathname,
      search: u.search || null, hash: u.hash || null,
      href: u.href, origin: u.origin,
      query: u.search ? u.search.slice(1) : null,
    };
  } catch {
    return { protocol: null, hostname: null, host: null, port: null, pathname: urlStr, search: null, hash: null, href: urlStr, origin: null, query: null };
  }
}

// Pipeline: strip TS types (for .ts/.mts files only) → convert ESM to CJS
function prepareSource(source: string, filePath?: string): string {
  const needsTypeStrip = filePath ? /\.m?ts$/.test(filePath) : true;
  return esmToCjs(needsTypeStrip ? stripTypes(source) : source);
}

// Converts ESM import/export syntax to CJS require/module.exports.
function esmToCjs(source: string): string {
  let r = source;

  // import X from "mod" → const X = require("mod").default || require("mod")
  r = r.replace(
    /^\s*import\s+(\w+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_m, name, _q, mod) => `const ${name} = require("${mod}");`,
  );

  // import { a, b as c } from "mod" → const { a, b: c } = require("mod")
  r = r.replace(
    /^\s*import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_m, imports, _q, mod) => {
      const mapped = imports.split(",").map((s: string) => {
        const parts = s.trim().split(/\s+as\s+/);
        return parts.length === 2 ? `${parts[0].trim()}: ${parts[1].trim()}` : parts[0].trim();
      }).filter(Boolean).join(", ");
      return `const { ${mapped} } = require("${mod}");`;
    },
  );

  // import * as X from "mod" → const X = require("mod")
  r = r.replace(
    /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
    (_m, name, _q, mod) => `const ${name} = require("${mod}");`,
  );

  // import "mod" → require("mod")
  r = r.replace(
    /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
    (_m, _q, mod) => `require("${mod}");`,
  );

  // export default expression → module.exports = expression
  r = r.replace(
    /^\s*export\s+default\s+/gm,
    "module.exports = ",
  );

  // export { a, b, c as d } → Object.assign(module.exports, { a, b, d: c })
  r = r.replace(
    /^\s*export\s+\{([^}]+)\}\s*;?\s*$/gm,
    (_m, exports) => {
      const mapped = exports.split(",").map((s: string) => {
        const parts = s.trim().split(/\s+as\s+/);
        return parts.length === 2 ? `${parts[1].trim()}: ${parts[0].trim()}` : parts[0].trim();
      }).filter(Boolean).join(", ");
      return `Object.assign(module.exports, { ${mapped} });`;
    },
  );

  // export const/let/var name = ... → const/let/var name = ...; module.exports.name = name;
  r = r.replace(
    /^\s*export\s+(const|let|var)\s+(\w+)/gm,
    (_m, kw, name) => `${kw} ${name}`,
  );
  // For the above, we need to add module.exports assignments. Collect exported names and append.
  const exportedVars: string[] = [];
  source.replace(
    /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
    (_m, name) => { exportedVars.push(name); return ""; },
  );

  // export function name / export class name
  r = r.replace(
    /^\s*export\s+(function|class)\s+(\w+)/gm,
    (_m, kw, name) => { exportedVars.push(name); return `${kw} ${name}`; },
  );

  // Append module.exports assignments for exported declarations
  if (exportedVars.length > 0) {
    const assignments = exportedVars
      .map((n) => `module.exports.${n} = ${n};`)
      .join("\n");
    r += "\n" + assignments;
  }

  return r;
}

// Removes TypeScript type annotations so the V8 isolate can execute the code.
// Uses multi-pass regex stripping — handles the most common TS patterns.
function stripTypes(source: string): string {
  let r = source;

  // 1. Remove import type statements (single-line and multi-line)
  r = r.replace(/^\s*import\s+type\s+[\s\S]*?from\s+['"][^'"]*['"];?\s*$/gm, "");

  // 2. Remove export type / export interface blocks (multi-line aware)
  r = r.replace(/^\s*(?:export\s+)?(?:declare\s+)?interface\s+\w+[\s\S]*?^\s*\}/gm, "");
  r = r.replace(/^\s*(?:export\s+)?(?:declare\s+)?type\s+\w+\s*(?:<[^>]*>)?\s*=[^;]*;\s*$/gm, "");

  // 3. Remove enum declarations
  r = r.replace(/^\s*(?:export\s+)?(?:const\s+)?enum\s+\w+\s*\{[\s\S]*?^\s*\}/gm, "");

  // 4. Remove declare statements
  r = r.replace(/^\s*declare\s+.*$/gm, "");

  // 5. Strip generic type parameters from function/class declarations: foo<T, U>( → foo(
  r = r.replace(/(<[^>()]*>)\s*(?=\()/g, "");

  // 6. Strip return type annotations: ): string { → ) {
  r = r.replace(/\)\s*:\s*[^{=]*?(?=\s*[{=])/g, ")");

  // 7. Strip parameter type annotations: (x: string, y: number) → (x, y)
  //    Handle complex types including generics, unions, intersections, arrays
  r = r.replace(/(\w)\s*:\s*(?:[A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\])*(?:\s*[|&]\s*[A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\])*)*)(\s*[,)=])/g, "$1$2");
  // Also handle simple keyword types
  r = r.replace(/(\w)\s*:\s*(?:string|number|boolean|any|void|never|unknown|null|undefined|object|bigint|symbol)(?:\[\])*(\s*[,)=;])/g, "$1$2");

  // 8. Strip as-casts: value as Type → value
  r = r.replace(/\s+as\s+(?:const|[A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\])*)/g, "");

  // 9. Strip non-null assertions: value! → value (but not !== or !=)
  r = r.replace(/(\w)\s*!(?=[.[\s,);])/g, "$1");

  // 10. Remove angle-bracket type assertions: <Type>value → value
  r = r.replace(/<[A-Za-z_$][\w$.]*(?:<[^>]*>)?>\s*(?=\w)/g, "");

  return r;
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function joinPath(base: string, rel: string): string {
  const raw = base ? base + "/" + rel : rel;
  const parts = raw.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
