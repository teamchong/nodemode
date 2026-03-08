#!/usr/bin/env node

// nodemode CLI — scaffold and deploy a nodemode Worker
//
// Usage:
//   npx nodemode init           Create wrangler.jsonc + worker entry in current dir
//   npx nodemode deploy         Deploy to Cloudflare Workers

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templateDir = join(__dirname, "template");

const [, , command] = process.argv;

switch (command) {
  case "init":
    init();
    break;
  case "deploy":
    deploy();
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown command: ${command ?? "(none)"}`);
    usage();
    process.exit(1);
}

function usage() {
  console.log(`
nodemode — Node.js runtime on Cloudflare Workers

Commands:
  init      Scaffold a nodemode Worker project in the current directory
  deploy    Build and deploy to Cloudflare Workers

Options:
  --help    Show this help message

Examples:
  npx nodemode init
  npx nodemode deploy
`);
}

function init() {
  const cwd = process.cwd();

  // Create worker entry
  const workerDir = join(cwd, "worker");
  const workerFile = join(workerDir, "index.ts");
  if (!existsSync(workerDir)) {
    mkdirSync(workerDir, { recursive: true });
  }

  if (existsSync(workerFile)) {
    console.log("  skip  worker/index.ts (already exists)");
  } else {
    copyFileSync(join(templateDir, "worker.ts"), workerFile);
    console.log("  create  worker/index.ts");
  }

  // Create wrangler.jsonc
  const wranglerFile = join(cwd, "wrangler.jsonc");
  if (existsSync(wranglerFile)) {
    console.log("  skip  wrangler.jsonc (already exists)");
  } else {
    copyFileSync(join(templateDir, "wrangler.jsonc"), wranglerFile);
    console.log("  create  wrangler.jsonc");
  }

  // Create or update package.json
  const pkgFile = join(cwd, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
    let changed = false;
    if (!pkg.dependencies?.nodemode) {
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies.nodemode = "latest";
      changed = true;
    }
    if (changed) {
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
      console.log("  update  package.json (added nodemode dependency)");
    } else {
      console.log("  skip  package.json (nodemode already in dependencies)");
    }
  } else {
    const pkg = {
      name: "my-nodemode-workspace",
      version: "0.1.0",
      type: "module",
      dependencies: {
        nodemode: "latest",
      },
      devDependencies: {
        wrangler: "^4.0.0",
        "@cloudflare/workers-types": "^4.0.0",
        typescript: "^5.0.0",
      },
    };
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    console.log("  create  package.json");
  }

  console.log(`
Done! Next steps:
  1. npm install
  2. npx nodemode deploy   (or: npx wrangler deploy)
`);
}

function deploy() {
  const cwd = process.cwd();

  if (!existsSync(join(cwd, "wrangler.jsonc")) && !existsSync(join(cwd, "wrangler.toml"))) {
    console.error("No wrangler.jsonc found. Run `npx nodemode init` first.");
    process.exit(1);
  }

  console.log("Deploying nodemode to Cloudflare Workers...\n");

  try {
    execSync("npx wrangler deploy", { cwd, stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}
