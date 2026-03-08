// Shim context — global singleton that fs and child_process shims bind to
//
// Set up inside a Workspace DO before running user code:
//   import { setContext } from "nodemode/shims/context";
//   setContext(this.fs, this.processes);
//
// Then libraries that import "node:fs" or "node:child_process" (via wrangler
// alias) will transparently use nodemode's R2+SQLite filesystem and DO
// process manager — no Container needed, no HTTP API, $0 cost.

import type { FsEngine } from "../fs-engine";
import type { ProcessManager } from "../process-manager";

let _fs: FsEngine | null = null;
let _pm: ProcessManager | null = null;

export function setContext(fs: FsEngine, pm: ProcessManager): void {
  _fs = fs;
  _pm = pm;
}

export function clearContext(): void {
  _fs = null;
  _pm = null;
}

export function getFs(): FsEngine {
  if (!_fs) throw new Error("nodemode: shim context not initialized. Call setContext() inside your Workspace DO.");
  return _fs;
}

export function getPm(): ProcessManager {
  if (!_pm) throw new Error("nodemode: shim context not initialized. Call setContext() inside your Workspace DO.");
  return _pm;
}
