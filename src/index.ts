// nodemode — Node.js runtime on Cloudflare Workers
//
// Maps Node.js primitives to Cloudflare primitives:
//   fs           → R2 (files) + DO SQLite (directory index, metadata)
//   child_process → built-in emulators + Container for heavy commands
//   stdio        → WebSocket (stdin/stdout/stderr)
//   process      → DO state (env, argv, cwd)
//   os           → static values (platform, arch, tmpdir)
//
// Usage in your worker:
//   import { Workspace, createHandler } from "nodemode";
//   export { Workspace };
//   export default { fetch: createHandler() };

export { Workspace } from "./workspace";
export { FsEngine, normalizePath } from "./fs-engine";
export { ProcessManager } from "./process-manager";
export { JsRunner } from "./js-runner";
export { createHandler } from "./handler";
export { ValidationError, validatePath, validateCommand } from "./validate";
export { setContext, clearContext } from "./shims/context";
export type { Env } from "./env";
export type { FileStat, DirEntry } from "./fs-engine";
export type { HandlerOptions } from "./handler";
export type { SpawnOptions, SpawnResult, ProcessHandle } from "./process-manager";
export type { ContainerStatus, ContainerExecResult } from "./container";
