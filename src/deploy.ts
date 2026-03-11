// nodemode/deploy — Pre-deploy source transforms
//
// Runs in Node.js at deploy time (NOT in Workers). Analyzes a project's
// source files and applies transforms to make them compatible with the
// Workers runtime:
//
//   1. Native addon swaps   — Replace native packages with pure JS/WASM alternatives
//   2. Streams polyfill     — Bundle readable-stream for code using Node streams
//   3. HTTP server handler  — Convert .listen() to handler export for DO routing
//   4. worker_threads       — Rewrite to DO fan-out RPC calls
//   5. Dynamic requires     — Flag or bundle dynamic require() patterns
//
// Usage:
//   import { analyzeProject, transformSource } from "nodemode/deploy";
//   const issues = await analyzeProject("./my-app");
//   const transformed = transformSource(source, issues);

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

// -- Analysis types --

export type IssueKind =
  | "native-addon"
  | "streams"
  | "http-server"
  | "worker-threads"
  | "dynamic-require";

export interface DeployIssue {
  kind: IssueKind;
  file: string;
  line: number;
  message: string;
  autoFix: boolean;
}

export interface AnalysisResult {
  issues: DeployIssue[];
  entryPoint: string | null;
  dependencies: string[];
}

// -- Native addon swap map --
// Maps native npm packages to their pure JS/WASM replacements.
// Used by transformSource to rewrite import specifiers.
export const NATIVE_ADDON_SWAPS: Record<string, string> = {
  "bcrypt": "bcryptjs",
  "sharp": "@cf-wasm/photon",
  "canvas": "@napi-rs/canvas",
  "better-sqlite3": "sql.js",
  "node-sass": "sass",
  "leveldown": "level-js",
  "sodium-native": "libsodium-wrappers",
  "argon2": "argon2-browser",
  "cpu-features": "",          // remove — not needed
  "microtime": "",             // remove — use performance.now()
  "fsevents": "",              // remove — platform-specific, not used in Workers
};

// -- Project analysis --

export async function analyzeProject(projectDir: string): Promise<AnalysisResult> {
  const issues: DeployIssue[] = [];
  const dependencies = detectDependencies(projectDir);
  const entryPoint = detectEntryPoint(projectDir);

  // Check for native addons in dependencies
  for (const dep of dependencies) {
    if (dep in NATIVE_ADDON_SWAPS) {
      const swap = NATIVE_ADDON_SWAPS[dep];
      issues.push({
        kind: "native-addon",
        file: "package.json",
        line: 0,
        message: swap
          ? `Native addon "${dep}" → swap to "${swap}"`
          : `Native addon "${dep}" → remove (not needed in Workers)`,
        autoFix: true,
      });
    }
  }

  // Scan source files for patterns
  const sourceFiles = collectSourceFiles(projectDir);
  for (const file of sourceFiles) {
    const relPath = relative(projectDir, file);
    const source = readFileSync(file, "utf-8");
    const lines = source.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect http.createServer / http.listen patterns
      if (/\.(createServer|listen)\s*\(/.test(line) &&
          /require\s*\(\s*['"](?:node:)?https?['"]\s*\)/.test(source)) {
        issues.push({
          kind: "http-server",
          file: relPath,
          line: lineNum,
          message: "HTTP server detected — .listen() will be converted to handler export for DO routing",
          autoFix: true,
        });
      }

      // Detect worker_threads usage
      if (/require\s*\(\s*['"](?:node:)?worker_threads['"]\s*\)/.test(line) ||
          /from\s+['"](?:node:)?worker_threads['"]/.test(line)) {
        issues.push({
          kind: "worker-threads",
          file: relPath,
          line: lineNum,
          message: "worker_threads import — will use JsRunner's built-in worker_threads module",
          autoFix: false,
        });
      }

      // Detect Node.js streams that need polyfill
      if (/require\s*\(\s*['"](?:node:)?stream['"]\s*\)/.test(line) ||
          /from\s+['"](?:node:)?stream['"]/.test(line)) {
        if (!/readable-stream/.test(source)) {
          issues.push({
            kind: "streams",
            file: relPath,
            line: lineNum,
            message: "Node.js stream import — JsRunner provides built-in stream module",
            autoFix: false,
          });
        }
      }

      // Detect dynamic require patterns
      const dynamicReqMatch = line.match(/require\s*\(\s*[^'"]/);
      if (dynamicReqMatch && !/require\s*\(\s*['"]/.test(line)) {
        issues.push({
          kind: "dynamic-require",
          file: relPath,
          line: lineNum,
          message: "Dynamic require() — computed module path cannot be resolved at deploy time",
          autoFix: false,
        });
      }
    }
  }

  // Deduplicate issues (same file + same kind at same line)
  const seen = new Set<string>();
  const deduped = issues.filter((issue) => {
    const key = `${issue.file}:${issue.line}:${issue.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { issues: deduped, entryPoint, dependencies };
}

// -- Source transforms --

export function transformSource(source: string, issues: DeployIssue[]): string {
  let result = source;

  for (const issue of issues) {
    if (!issue.autoFix) continue;

    switch (issue.kind) {
      case "native-addon": {
        // Rewrite require("bcrypt") → require("bcryptjs"), etc.
        const match = issue.message.match(/"(\S+)" → swap to "(\S+)"/);
        if (match) {
          const [, from, to] = match;
          result = rewriteImport(result, from, to);
        }
        const removeMatch = issue.message.match(/"(\S+)" → remove/);
        if (removeMatch) {
          const [, pkg] = removeMatch;
          result = removeImport(result, pkg);
        }
        break;
      }
      case "http-server": {
        result = transformHttpServer(result);
        break;
      }
    }
  }

  return result;
}

// -- Deploy (write transformed output) --

export async function deployProject(
  projectDir: string,
  outputDir: string,
): Promise<{ analysis: AnalysisResult; outputDir: string }> {
  const analysis = await analyzeProject(projectDir);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const sourceFiles = collectSourceFiles(projectDir);
  for (const file of sourceFiles) {
    const relPath = relative(projectDir, file);
    const outPath = join(outputDir, relPath);
    const outDir = join(outputDir, relative(projectDir, join(file, "..")));

    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const source = readFileSync(file, "utf-8");
    // Native addon swaps apply to all source files; other issues are file-specific
    const fileIssues = analysis.issues.filter(
      (i) => i.kind === "native-addon" || i.file === relPath,
    );
    const transformed = transformSource(source, fileIssues);
    writeFileSync(outPath, transformed, "utf-8");
  }

  return { analysis, outputDir };
}

// -- Internal helpers --

function detectEntryPoint(projectDir: string): string | null {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return null;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // Check common entry point fields
  for (const field of ["main", "module", "source"]) {
    if (pkg[field] && existsSync(join(projectDir, pkg[field]))) {
      return pkg[field];
    }
  }

  // Check scripts.start for "node <file>"
  if (pkg.scripts?.start) {
    const match = pkg.scripts.start.match(/node\s+(\S+)/);
    if (match && existsSync(join(projectDir, match[1]))) {
      return match[1];
    }
  }

  // Common defaults
  for (const candidate of ["index.js", "src/index.js", "server.js", "app.js", "src/server.js", "src/app.js"]) {
    if (existsSync(join(projectDir, candidate))) return candidate;
  }

  return null;
}

function detectDependencies(projectDir: string): string[] {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return [];

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
}

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    // Skip non-source directories
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".next") continue;

    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      collectSourceFiles(fullPath, files);
    } else {
      const ext = extname(entry);
      if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"].includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function rewriteImport(source: string, from: string, to: string): string {
  // Rewrite both require() and import statements
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source
    .replace(new RegExp(`require\\s*\\(\\s*(['"])${escaped}\\1\\s*\\)`, "g"), `require($1${to}$1)`)
    .replace(new RegExp(`from\\s+(['"])${escaped}\\1`, "g"), `from $1${to}$1`);
}

function removeImport(source: string, pkg: string): string {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Remove require lines
  let result = source.replace(
    new RegExp(`^.*require\\s*\\(\\s*['"]${escaped}['"]\\s*\\).*$`, "gm"),
    "// [nodemode] removed: " + pkg,
  );
  // Remove import lines
  result = result.replace(
    new RegExp(`^\\s*import\\s+.*from\\s+['"]${escaped}['"]\\s*;?\\s*$`, "gm"),
    "// [nodemode] removed: " + pkg,
  );
  return result;
}

function transformHttpServer(source: string): string {
  let result = source;

  // Transform server.listen(port, ...) → server.listen(0, ...) with export
  // This makes .listen() a no-op (port 0) while still calling the callback.
  // The DO's fetch() handler will route requests to the server's handler directly.
  result = result.replace(
    /\.listen\s*\(\s*(\d+|process\.env\.\w+|\w+)\s*/g,
    ".listen(0 /* nodemode: original $1 */",
  );

  return result;
}
