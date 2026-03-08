// nodemode/client — types and utilities usable outside Cloudflare Workers
//
// Import from "nodemode/client" when you need types and validation
// without depending on @cloudflare/workers-types.
//
// Usage:
//   import type { FileStat, SpawnResult } from "nodemode/client";
//   import { validatePath } from "nodemode/client";

export { ValidationError, validatePath, validateCommand } from "./validate";
export type { FileStat, DirEntry } from "./fs-engine";
export type { SpawnOptions, SpawnResult, ProcessHandle } from "./process-manager";
export type { HandlerOptions } from "./handler";
