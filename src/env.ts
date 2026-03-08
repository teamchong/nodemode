// Shared Env type for Cloudflare bindings
//
// Storage architecture:
//   R2 (FS_BUCKET)        — virtual filesystem (files as R2 objects)
//   DO (WORKSPACE)        — per-workspace SQLite for fs index, process state, metadata
//   Container             — real Linux environment via ctx.container on the DO
export interface Env {
  FS_BUCKET: R2Bucket;
  WORKSPACE: DurableObjectNamespace;

  // Optional: R2 S3-compatible credentials for container snapshot upload/restore
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY?: string;
  R2_SECRET_KEY?: string;
}
