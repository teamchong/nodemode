// container-agent — HTTP server running inside the Cloudflare Container
//
// Handles:
//   POST /exec          — spawn child process, return stdout/stderr
//   GET  /healthz       — liveness check
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
import { existsSync, mkdirSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = 8080;
const WORKSPACE_DIR = "/workspace";
const FUSE_MOUNT = "/mnt/workspace";
const LOCAL_DIR = "/local";

// Directories that stay on local disk (fast, ephemeral)
const LOCAL_DIRS = new Set(["node_modules", "dist", ".npm", ".next", "build"]);

// Directories to snapshot on SIGTERM and restore on boot
const SNAPSHOT_DIRS = ["node_modules", "dist"];

function setupWorkspace() {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(LOCAL_DIR, { recursive: true });

  // Create local dirs for build artifacts and symlink into workspace
  for (const dir of LOCAL_DIRS) {
    const localPath = join(LOCAL_DIR, dir);
    const wsPath = join(WORKSPACE_DIR, dir);
    mkdirSync(localPath, { recursive: true });
    if (!existsSync(wsPath)) {
      try {
        symlinkSync(localPath, wsPath);
      } catch {
        // Already exists or permission issue
      }
    }
  }

  // Symlink source files/dirs from R2 FUSE mount into workspace
  if (existsSync(FUSE_MOUNT)) {
    try {
      for (const entry of readdirSync(FUSE_MOUNT)) {
        if (LOCAL_DIRS.has(entry)) continue;
        const src = join(FUSE_MOUNT, entry);
        const dst = join(WORKSPACE_DIR, entry);
        if (!existsSync(dst)) {
          try {
            symlinkSync(src, dst);
          } catch {
            // Skip entries that can't be symlinked
          }
        }
      }
    } catch {
      // FUSE mount may not be populated yet
    }
  }
}

async function restoreSnapshots() {
  const workspaceId = process.env.WORKSPACE_ID;
  const r2Endpoint = process.env.R2_ENDPOINT;
  const r2AccessKey = process.env.R2_ACCESS_KEY;
  const r2SecretKey = process.env.R2_SECRET_KEY;

  if (!workspaceId || !r2Endpoint || !r2AccessKey || !r2SecretKey) return;

  for (const dir of SNAPSHOT_DIRS) {
    const localPath = join(LOCAL_DIR, dir);
    // Skip if directory already has content (e.g. from a previous restore)
    try {
      if (readdirSync(localPath).length > 0) continue;
    } catch {
      continue;
    }

    const snapshotKey = `${workspaceId}/.snapshots/${dir}.tar.zst`;
    console.log(`[agent] restoring ${dir} from ${snapshotKey}...`);

    try {
      const { exitCode, stderr } = await execCommand(
        `curl -sf "${r2Endpoint}/${snapshotKey}" ` +
        `--aws-sigv4 "aws:amz:auto:s3" ` +
        `--user "${r2AccessKey}:${r2SecretKey}" ` +
        `| zstd -d | tar -xf - -C /local`,
        "/",
        {},
      );
      if (exitCode === 0) {
        console.log(`[agent] restored ${dir}`);
      } else {
        // 404 or download error — not fatal, user will npm install
        console.log(`[agent] no snapshot for ${dir} (${stderr.trim() || "not found"})`);
      }
    } catch {
      console.log(`[agent] snapshot restore skipped for ${dir}`);
    }
  }
}

async function createSnapshots() {
  const workspaceId = process.env.WORKSPACE_ID;
  const r2Endpoint = process.env.R2_ENDPOINT;
  const r2AccessKey = process.env.R2_ACCESS_KEY;
  const r2SecretKey = process.env.R2_SECRET_KEY;

  if (!workspaceId || !r2Endpoint || !r2AccessKey || !r2SecretKey) {
    console.log("[agent] skipping snapshots (no R2 credentials)");
    return;
  }

  for (const dir of SNAPSHOT_DIRS) {
    const dirPath = join(LOCAL_DIR, dir);
    if (!existsSync(dirPath)) continue;
    // Skip empty directories
    try {
      if (readdirSync(dirPath).length === 0) continue;
    } catch {
      continue;
    }

    const snapshotKey = `${workspaceId}/.snapshots/${dir}.tar.zst`;
    console.log(`[agent] snapshotting ${dir} -> ${snapshotKey}`);

    try {
      const { exitCode } = await execCommand(
        `tar -cf - -C /local ${dir} | zstd -1 -T0 | ` +
        `curl -s -X PUT "${r2Endpoint}/${snapshotKey}" ` +
        `--aws-sigv4 "aws:amz:auto:s3" ` +
        `--user "${r2AccessKey}:${r2SecretKey}" ` +
        `-H "Content-Type: application/octet-stream" ` +
        `--data-binary @-`,
        "/",
        {},
      );
      if (exitCode === 0) {
        console.log(`[agent] snapshot ${dir} uploaded`);
      } else {
        console.error(`[agent] snapshot ${dir} upload failed`);
      }
    } catch (err) {
      console.error(`[agent] snapshot ${dir} failed: ${err.message}`);
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
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
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

  if (url.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

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

  if (url.pathname === "/sync/snapshot" && req.method === "POST") {
    try {
      await createSnapshots();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "snapshots created" }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// SIGTERM: snapshot build artifacts to R2, then exit
let shutdownInProgress = false;
async function gracefulShutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log("[agent] SIGTERM received, creating snapshots...");
  await createSnapshots();
  console.log("[agent] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Boot
console.log("[agent] setting up workspace...");
setupWorkspace();

console.log("[agent] restoring snapshots...");
restoreSnapshots().then(() => {
  server.listen(PORT, () => {
    console.log(`[agent] listening on :${PORT}`);
  });
});
