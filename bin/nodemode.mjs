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

const [, , command, ...args] = process.argv;

switch (command) {
  case "init":
    init();
    break;
  case "deploy":
    await deploy();
    break;
  case "analyze":
    await analyze();
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
  init                Scaffold a nodemode Worker project in the current directory
  analyze [dir]       Analyze a project for Workers compatibility issues
  deploy [dir]        Transform, build, and deploy to Cloudflare Workers
    --output <dir>    Output directory for transformed files (default: .nodemode-build)
    --dry-run         Show analysis without transforming or deploying

Options:
  --help              Show this help message

Examples:
  npx nodemode init
  npx nodemode analyze ./my-app
  npx nodemode deploy
  npx nodemode deploy ./my-app --dry-run
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

async function analyze() {
  const { analyzeProject } = await import("../src/deploy.ts");
  const projectDir = resolve(args[0] || ".");

  console.log(`Analyzing ${projectDir}...\n`);

  const result = await analyzeProject(projectDir);

  if (result.entryPoint) {
    console.log(`  Entry point: ${result.entryPoint}`);
  }
  console.log(`  Dependencies: ${result.dependencies.length}`);
  console.log(`  Issues found: ${result.issues.length}\n`);

  for (const issue of result.issues) {
    const fixLabel = issue.autoFix ? " [auto-fix]" : " [manual]";
    console.log(`  ${issue.kind}${fixLabel}`);
    console.log(`    ${issue.file}:${issue.line} — ${issue.message}`);
  }

  if (result.issues.length === 0) {
    console.log("  No compatibility issues found.");
  }
}

async function deploy() {
  const projectDir = resolve(args.find(a => !a.startsWith("-")) || ".");
  const dryRun = args.includes("--dry-run");
  const outputIdx = args.indexOf("--output");
  const outputDir = outputIdx >= 0 && args[outputIdx + 1]
    ? resolve(args[outputIdx + 1])
    : join(projectDir, ".nodemode-build");

  // Run analysis
  const { analyzeProject, deployProject } = await import("../src/deploy.ts");
  console.log(`Analyzing ${projectDir}...\n`);

  const analysis = await analyzeProject(projectDir);

  if (analysis.entryPoint) {
    console.log(`  Entry point: ${analysis.entryPoint}`);
  }
  console.log(`  Dependencies: ${analysis.dependencies.length}`);
  console.log(`  Issues found: ${analysis.issues.length}`);

  const autoFixable = analysis.issues.filter(i => i.autoFix);
  const manual = analysis.issues.filter(i => !i.autoFix);

  if (autoFixable.length > 0) {
    console.log(`\n  Auto-fixable (${autoFixable.length}):`);
    for (const issue of autoFixable) {
      console.log(`    ${issue.kind}: ${issue.message}`);
    }
  }

  if (manual.length > 0) {
    console.log(`\n  Manual review (${manual.length}):`);
    for (const issue of manual) {
      console.log(`    ${issue.kind} ${issue.file}:${issue.line} — ${issue.message}`);
    }
  }

  if (dryRun) {
    console.log("\n  --dry-run: no files written.");
    return;
  }

  // Transform and write output
  console.log(`\n  Transforming to ${outputDir}...`);
  await deployProject(projectDir, outputDir);
  console.log(`  Done. ${autoFixable.length} auto-fixes applied.\n`);

  // Deploy with wrangler if wrangler config exists
  const hasWrangler = existsSync(join(projectDir, "wrangler.jsonc"))
    || existsSync(join(projectDir, "wrangler.toml"));

  if (hasWrangler) {
    console.log("Deploying to Cloudflare Workers...\n");
    try {
      execSync("npx wrangler deploy", { cwd: projectDir, stdio: "inherit" });
    } catch {
      process.exit(1);
    }
  } else {
    console.log("No wrangler.jsonc found — skipping wrangler deploy.");
    console.log("To deploy, run: npx wrangler deploy");
  }
}
