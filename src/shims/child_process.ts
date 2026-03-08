// node:child_process shim — drop-in replacement backed by nodemode's ProcessManager
//
// Usage: configure wrangler alias so libraries pick this up transparently:
//   wrangler.jsonc: { "alias": { "child_process": "nodemode/shims/child_process" } }
//
// Then any library that does `import { exec } from "node:child_process"`
// gets nodemode's implementation — builtins in DO, heavy commands to Container.

import { getPm } from "./context";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  encoding?: string;
  timeout?: number;
}

// Minimal EventEmitter for Workers environment
class MiniEmitter {
  private _handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, fn: (...args: unknown[]) => void): this {
    (this._handlers[event] ??= []).push(fn);
    return this;
  }

  once(event: string, fn: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => { this.off(event, wrapped); fn(...args); };
    return this.on(event, wrapped);
  }

  off(event: string, fn: (...args: unknown[]) => void): this {
    const handlers = this._handlers[event];
    if (handlers) this._handlers[event] = handlers.filter((h) => h !== fn);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const handlers = this._handlers[event];
    if (!handlers?.length) return false;
    for (const fn of handlers) fn(...args);
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) delete this._handlers[event];
    else this._handlers = {};
    return this;
  }

  addListener(event: string, fn: (...args: unknown[]) => void): this { return this.on(event, fn); }
  removeListener(event: string, fn: (...args: unknown[]) => void): this { return this.off(event, fn); }
}

// -- exec --

export function exec(command: string, optionsOrCb?: ExecOptions | ExecCallback, cb?: ExecCallback): ChildProcessLike {
  const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
  const options = typeof optionsOrCb === "object" ? optionsOrCb : {};

  const cp = new ChildProcessLike(command);

  getPm().exec(command, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
  }).then((result) => {
    cp._exitCode = result.exitCode;

    if (callback) {
      if (result.exitCode !== 0) {
        const err = new Error(`Command failed: ${command}\n${result.stderr}`) as Error & { code: number };
        err.code = result.exitCode;
        callback(err, result.stdout, result.stderr);
      } else {
        callback(null, result.stdout, result.stderr);
      }
    }

    cp.emit("close", result.exitCode);
    cp.emit("exit", result.exitCode);
  }).catch((err) => {
    if (callback) callback(err as Error, "", "");
    cp.emit("error", err);
  });

  return cp;
}

// -- execSync --

export function execSync(_command: string, _options?: ExecOptions): string {
  throw new Error("nodemode: execSync not supported — use async exec");
}

// -- spawn --

export function spawn(command: string, args?: string[], options?: ExecOptions): ChildProcessLike {
  const fullCommand = args ? `${command} ${args.join(" ")}` : command;
  const cp = new ChildProcessLike(fullCommand);

  getPm().exec(fullCommand, {
    cwd: options?.cwd,
    env: options?.env,
  }).then((result) => {
    cp._exitCode = result.exitCode;

    if (result.stdout) cp.stdout.emit("data", result.stdout);
    if (result.stderr) cp.stderr.emit("data", result.stderr);
    cp.stdout.emit("end");
    cp.stderr.emit("end");
    cp.emit("close", result.exitCode);
    cp.emit("exit", result.exitCode);
  }).catch((err) => {
    cp.emit("error", err);
  });

  return cp;
}

// -- execFile --

export function execFile(file: string, args?: string[], optionsOrCb?: ExecOptions | ExecCallback, cb?: ExecCallback): ChildProcessLike {
  const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
  const options = typeof optionsOrCb === "object" ? optionsOrCb : {};
  const command = args ? `${file} ${args.join(" ")}` : file;
  return exec(command, options, callback);
}

// -- fork (not supported) --

export function fork(): never {
  throw new Error("nodemode: fork() not supported — Workers are single-threaded");
}

// -- ChildProcess-like object --

class ChildProcessLike extends MiniEmitter {
  pid = 1;
  stdin = new StreamLike();
  stdout = new StreamLike();
  stderr = new StreamLike();
  _exitCode: number | null = null;

  constructor(public command: string) {
    super();
  }

  get exitCode() { return this._exitCode; }
  kill() { /* no-op — command already finished */ }
  ref() { return this; }
  unref() { return this; }
}

class StreamLike extends MiniEmitter {
  pipe(dest: unknown) { return dest; }
  setEncoding() { return this; }
  read() { return null; }
}

// -- Default export --

export default {
  exec,
  execSync,
  spawn,
  execFile,
  fork,
};
