// Shared Env type for Cloudflare bindings
//
// Storage architecture:
//   R2 (FS_BUCKET)        — virtual filesystem (files as R2 objects)
//   DO (WORKSPACE)        — per-workspace SQLite for fs index, process state, metadata
//   Container             — real Linux environment via ctx.container on the DO
export interface UnsafeEval {
  eval(code: string): unknown;
  newFunction(...args: string[]): (...args: unknown[]) => unknown;
}

export interface Env {
  FS_BUCKET: R2Bucket;
  WORKSPACE: DurableObjectNamespace;
  UNSAFE_EVAL?: UnsafeEval;

  // Optional: R2 S3-compatible credentials for container snapshot upload/restore
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY?: string;
  R2_SECRET_KEY?: string;

  // Optional: container agent port (default: 8080)
  CONTAINER_PORT?: string;
}
