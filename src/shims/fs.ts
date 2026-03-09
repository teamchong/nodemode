// node:fs shim — drop-in replacement backed by nodemode's R2+SQLite FsEngine
//
// Usage: configure wrangler alias so libraries pick this up transparently:
//   wrangler.jsonc: { "alias": { "fs": "nodemode/shims/fs" } }
//
// Then any library that does `import fs from "node:fs"` or `require("fs")`
// gets nodemode's implementation — R2 for storage, SQLite for indexing,
// running entirely in the DO with $0 cost and <1ms for cached reads.

import { getFs } from "./context";

type Callback<T> = (err: Error | null, result?: T) => void;
type Encoding = string | { encoding?: string };

function getEncoding(enc?: Encoding): string | undefined {
  if (!enc) return undefined;
  if (typeof enc === "string") return enc;
  return enc.encoding;
}

// -- Async (callback) API --

export function readFile(path: string, encodingOrCb?: Encoding | Callback<Uint8Array | string>, cb?: Callback<Uint8Array | string>): void {
  const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb!;
  const encoding = typeof encodingOrCb === "function" ? undefined : getEncoding(encodingOrCb);

  getFs().readFile(String(path)).then((data) => {
    if (!data) return callback(new Error(`ENOENT: no such file or directory, open '${path}'`));
    if (encoding) return callback(null, new TextDecoder().decode(data));
    callback(null, data);
  }).catch(callback);
}

export function writeFile(path: string, data: string | Uint8Array, encodingOrCb?: Encoding | Callback<void>, cb?: Callback<void>): void {
  const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb!;
  getFs().writeFile(String(path), typeof data === "string" ? data : new Uint8Array(data)).then(() => {
    callback(null);
  }).catch(callback);
}

export function appendFile(path: string, data: string | Uint8Array, encodingOrCb?: Encoding | Callback<void>, cb?: Callback<void>): void {
  const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb!;
  getFs().appendFile(String(path), typeof data === "string" ? data : new Uint8Array(data)).then(() => {
    callback(null);
  }).catch(callback);
}

export function unlink(path: string, cb: Callback<void>): void {
  getFs().unlink(String(path)).then(() => cb(null)).catch(cb);
}

export function mkdir(path: string, optionsOrCb?: { recursive?: boolean } | Callback<void>, cb?: Callback<void>): void {
  const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb!;
  const recursive = typeof optionsOrCb === "object" ? optionsOrCb.recursive ?? false : false;
  try {
    getFs().mkdir(String(path), recursive);
    callback(null);
  } catch (e) { callback(e as Error); }
}

export function readdir(path: string, optionsOrCb?: unknown, cb?: Callback<string[]>): void {
  const callback = (typeof optionsOrCb === "function" ? optionsOrCb : cb!) as Callback<string[]>;
  try {
    const entries = getFs().readdir(String(path));
    callback(null, entries.map((e) => e.name));
  } catch (e) { callback(e as Error); }
}

export function stat(path: string, cb: Callback<StatResult>): void {
  try {
    const s = getFs().stat(String(path));
    if (!s) return cb(new Error(`ENOENT: no such file or directory, stat '${path}'`));
    cb(null, new StatResult(s.size, s.mode, s.mtime, s.isDirectory));
  } catch (e) { cb(e as Error); }
}

export function lstat(path: string, cb: Callback<StatResult>): void {
  stat(path, cb); // no symlink distinction
}

export function rename(oldPath: string, newPath: string, cb: Callback<void>): void {
  getFs().rename(String(oldPath), String(newPath)).then(() => cb(null)).catch(cb);
}

export function copyFile(src: string, dest: string, flagsOrCb?: number | Callback<void>, cb?: Callback<void>): void {
  const callback = typeof flagsOrCb === "function" ? flagsOrCb : cb!;
  getFs().readFile(String(src)).then((data) => {
    if (!data) throw new Error(`ENOENT: no such file or directory, open '${src}'`);
    return getFs().writeFile(String(dest), data);
  }).then(() => callback(null)).catch(callback);
}

export function existsSync(path: string): boolean {
  return getFs().exists(String(path));
}

export function access(path: string, modeOrCb?: unknown, cb?: Callback<void>): void {
  const callback = (typeof modeOrCb === "function" ? modeOrCb : cb!) as Callback<void>;
  if (getFs().exists(String(path))) callback(null);
  else callback(new Error(`ENOENT: no such file or directory, access '${path}'`));
}

export function rmdir(path: string, optionsOrCb?: { recursive?: boolean } | Callback<void>, cb?: Callback<void>): void {
  const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb!;
  const recursive = typeof optionsOrCb === "object" ? optionsOrCb.recursive ?? false : false;
  getFs().rmdir(String(path), recursive).then(() => callback(null)).catch(callback);
}

export function rm(path: string, optionsOrCb?: { recursive?: boolean; force?: boolean } | Callback<void>, cb?: Callback<void>): void {
  const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb!;
  const options = typeof optionsOrCb === "object" ? optionsOrCb : {};
  const recursive = options.recursive ?? false;
  const s = getFs().stat(String(path));
  if (!s) {
    if (options.force) return callback(null);
    return callback(new Error(`ENOENT: no such file or directory, rm '${path}'`));
  }
  if (s.isDirectory) {
    getFs().rmdir(String(path), recursive).then(() => callback(null)).catch(callback);
  } else {
    getFs().unlink(String(path)).then(() => callback(null)).catch(callback);
  }
}

export function chmod(path: string, mode: number, cb: Callback<void>): void {
  try {
    getFs().chmod(String(path), mode);
    cb(null);
  } catch (e) { cb(e as Error); }
}

// -- Sync API --

export function readFileSync(path: string, _encoding?: Encoding): Uint8Array | string {
  throw new Error("nodemode: readFileSync not supported — use async readFile or fs.promises.readFile");
}

export function writeFileSync(path: string, _data: string | Uint8Array): void {
  throw new Error("nodemode: writeFileSync not supported — use async writeFile or fs.promises.writeFile");
}

export function mkdirSync(path: string, options?: { recursive?: boolean }): void {
  getFs().mkdir(String(path), options?.recursive ?? false);
}

export function readdirSync(path: string): string[] {
  return getFs().readdir(String(path)).map((e) => e.name);
}

export function statSync(path: string): StatResult {
  const s = getFs().stat(String(path));
  if (!s) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  return new StatResult(s.size, s.mode, s.mtime, s.isDirectory);
}

export function lstatSync(path: string): StatResult {
  return statSync(path);
}

export function unlinkSync(path: string): void {
  throw new Error("nodemode: unlinkSync not supported — use async unlink");
}

export function rmdirSync(path: string, _options?: { recursive?: boolean }): void {
  throw new Error("nodemode: rmdirSync not supported — use async rmdir");
}

// -- Stat result --

class StatResult {
  dev = 0;
  ino = 0;
  nlink = 1;
  uid = 0;
  gid = 0;
  rdev = 0;
  blksize = 4096;
  blocks = 0;

  constructor(
    public size: number,
    public mode: number,
    public mtimeMs: number,
    private _isDir: boolean,
  ) {
    this.blocks = Math.ceil(size / 512);
  }

  get atime() { return new Date(this.mtimeMs); }
  get mtime() { return new Date(this.mtimeMs); }
  get ctime() { return new Date(this.mtimeMs); }
  get birthtime() { return new Date(this.mtimeMs); }
  get atimeMs() { return this.mtimeMs; }
  get ctimeMs() { return this.mtimeMs; }
  get birthtimeMs() { return this.mtimeMs; }

  isFile() { return !this._isDir; }
  isDirectory() { return this._isDir; }
  isSymbolicLink() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

// -- Promises API --

export const promises = {
  async readFile(path: string, encoding?: Encoding): Promise<Uint8Array | string> {
    const data = await getFs().readFile(String(path));
    if (!data) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    if (getEncoding(encoding)) return new TextDecoder().decode(data);
    return data;
  },

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await getFs().writeFile(String(path), typeof data === "string" ? data : new Uint8Array(data));
  },

  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    await getFs().appendFile(String(path), typeof data === "string" ? data : new Uint8Array(data));
  },

  async unlink(path: string): Promise<void> {
    await getFs().unlink(String(path));
  },

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    getFs().mkdir(String(path), options?.recursive ?? false);
  },

  async readdir(path: string): Promise<string[]> {
    return getFs().readdir(String(path)).map((e) => e.name);
  },

  async stat(path: string): Promise<StatResult> {
    const s = getFs().stat(String(path));
    if (!s) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return new StatResult(s.size, s.mode, s.mtime, s.isDirectory);
  },

  async lstat(path: string): Promise<StatResult> {
    return promises.stat(path);
  },

  async rename(oldPath: string, newPath: string): Promise<void> {
    await getFs().rename(String(oldPath), String(newPath));
  },

  async copyFile(src: string, dest: string): Promise<void> {
    const data = await getFs().readFile(String(src));
    if (!data) throw new Error(`ENOENT: no such file or directory, copyFile '${src}'`);
    await getFs().writeFile(String(dest), data);
  },

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const s = getFs().stat(String(path));
    if (!s) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }
    if (s.isDirectory) {
      await getFs().rmdir(String(path), options?.recursive ?? false);
    } else {
      await getFs().unlink(String(path));
    }
  },

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await getFs().rmdir(String(path), options?.recursive ?? false);
  },

  async chmod(path: string, mode: number): Promise<void> {
    getFs().chmod(String(path), mode);
  },

  async access(path: string): Promise<void> {
    if (!getFs().exists(String(path))) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  },
};

// -- Default export (matches node:fs shape) --

export default {
  readFile,
  writeFile,
  appendFile,
  unlink,
  mkdir,
  readdir,
  stat,
  lstat,
  rename,
  copyFile,
  existsSync,
  access,
  rmdir,
  rm,
  chmod,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  unlinkSync,
  rmdirSync,
  promises,
};
