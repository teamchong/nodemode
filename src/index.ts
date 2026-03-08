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
export { FsEngine } from "./fs-engine";
export { ProcessManager } from "./process-manager";
export { createHandler } from "./handler";
export { ValidationError, validatePath, validateCommand } from "./validate";
export type { Env } from "./env";
export type { FileStat, DirEntry } from "./fs-engine";
export type { HandlerOptions } from "./handler";
export type { SpawnOptions, SpawnResult, ProcessHandle, ContainerExecFn } from "./process-manager";
export type { ContainerStatus, ContainerExecRequest, ContainerExecResult } from "./container";
export { setContext, clearContext } from "./shims/context";
