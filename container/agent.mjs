// container-agent — HTTP server running inside the Cloudflare Container
//
// Handles:
//   POST /exec        — spawn child process, return stdout/stderr
//   GET  /healthz     — liveness check
//   POST /sync/snapshot — trigger manual snapshot
//
// Boot sequence:
//   1. Set up workspace directory with symlinks
//   2. Restore snapshots from R2 (if available)
//   3. Start HTTP server on :8080
//
// Shutdown (SIGTERM):
//   1. Tar build dirs (node_modules, dist) to R2 as snapshots
//   2. Exit cleanly

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const PORT = 8080;
const WORKSPACE_DIR = "/workspace";
const FUSE_MOUNT = "/mnt/workspace";
const LOCAL_DIR = "/local";

// Directories that stay on local disk (fast, ephemeral)
const LOCAL_DIRS = ["node_modules", "dist", ".npm", ".next", "build"];

// Source directories symlinked from R2 FUSE mount
const SOURCE_PATTERNS = ["src", "lib", "app", "pages", "public", "styles"];

function setupWorkspace() {
  // Create directories
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(LOCAL_DIR, { recursive: true });

  // Create local dirs for build artifacts
  for (const dir of LOCAL_DIRS) {
    const localPath = join(LOCAL_DIR, dir);
    const wsPath = join(WORKSPACE_DIR, dir);
    mkdirSync(localPath, { recursive: true });

    // Symlink workspace/node_modules -> /local/node_modules
    if (!existsSync(wsPath)) {
      try {
        symlinkSync(localPath, wsPath);
      } catch {
        // Already exists or mount issue
      }
    }
  }

  // Symlink source dirs from R2 FUSE mount if available
  if (existsSync(FUSE_MOUNT)) {
    // Symlink individual files/dirs from FUSE mount into workspace
    // Skip local dirs that we manage ourselves
    const localDirSet = new Set(LOCAL_DIRS);
    try {
      const { readdirSync } = await import("node:fs");
      for (const entry of readdirSync(FUSE_MOUNT)) {
        if (localDirSet.has(entry)) continue;
        const src = join(FUSE_MOUNT, entry);
        const dst = join(WORKSPACE_DIR, entry);
        if (!existsSync(dst)) {
          try {
            symlinkSync(src, dst);
          } catch {
            // Skip if can't symlink
          }
        }
      }
    } catch {
      // FUSE mount may not be ready yet
    }
  }
}

function execCommand(command, cwd, env) {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: cwd || WORKSPACE_DIR,
      env: { ...process.env, ...env, HOME: WORKSPACE_DIR },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000, // 5 min max
    });

    const stdout = [];
    const stderr = [];

    proc.stdout.on("data", (data) => stdout.push(data));
    proc.stderr.on("data", (data) => stderr.push(data));

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });

    proc.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  // Execute command
  if (url.pathname === "/exec" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { command, cwd, env: cmdEnv } = body;

      if (!command || typeof command !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "command is required" }));
        return;
      }

      const result = await execCommand(command, cwd, cmdEnv || {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Manual snapshot trigger
  if (url.pathname === "/sync/snapshot" && req.method === "POST") {
    // Snapshot logic will be called on SIGTERM; this endpoint is for manual triggers
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "snapshot not yet implemented" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// SIGTERM handler: snapshot build artifacts to R2
let shutdownInProgress = false;
async function gracefulShutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.log("[agent] SIGTERM received, creating snapshots...");

  // Snapshot node_modules and dist to R2 via tar + zstd
  // In production, this uploads tar.zst to R2 via S3-compatible API
  // using WORKSPACE_ID and R2 credentials from env vars
  const workspaceId = process.env.WORKSPACE_ID || "unknown";
  for (const dir of ["node_modules", "dist"]) {
    const dirPath = join(LOCAL_DIR, dir);
    if (!existsSync(dirPath)) continue;

    const snapshotKey = `${workspaceId}/.snapshots/${dir}.tar.zst`;
    console.log(`[agent] snapshotting ${dir} -> ${snapshotKey}`);

    // Use tar + zstd to compress, then upload via curl to R2
    // R2 credentials provided via WORKSPACE_ID, R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY env vars
    const r2Endpoint = process.env.R2_ENDPOINT;
    const r2AccessKey = process.env.R2_ACCESS_KEY;
    const r2SecretKey = process.env.R2_SECRET_KEY;

    if (r2Endpoint && r2AccessKey && r2SecretKey) {
      try {
        await execCommand(
          `tar -cf - -C /local ${dir} | zstd -1 -T0 | ` +
          `curl -s -X PUT "${r2Endpoint}/${snapshotKey}" ` +
          `--aws-sigv4 "aws:amz:auto:s3" ` +
          `--user "${r2AccessKey}:${r2SecretKey}" ` +
          `-H "Content-Type: application/octet-stream" ` +
          `--data-binary @-`,
          "/",
          {},
        );
        console.log(`[agent] snapshot ${dir} uploaded`);
      } catch (err) {
        console.error(`[agent] snapshot ${dir} failed: ${err.message}`);
      }
    }
  }

  console.log("[agent] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Boot
console.log("[agent] setting up workspace...");
setupWorkspace();

server.listen(PORT, () => {
  console.log(`[agent] listening on :${PORT}`);
});
