// Container integration types and helpers
//
// Cloudflare Containers are accessed via ctx.container on a Durable Object.
// The Workspace DO uses this to run non-builtin commands in a real Linux
// environment with R2 FUSE mount for source file sync.
//
// File sync model:
//   Source files:     R2 FUSE mount (bidirectional, automatic)
//   Build artifacts:  Container local disk (fast, snapshot to R2 on sleep)
//   SQLite index:     DO is sole writer (Container sends invalidations)

export type ContainerStatus = "stopped" | "starting" | "running" | "sleeping" | "crashed";

export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
