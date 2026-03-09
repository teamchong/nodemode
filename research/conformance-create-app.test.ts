/**
 * create-next-app / create-vite / degit Conformance Test
 *
 * Proves nodemode can handle project scaffolding workflows used by:
 *   - create-next-app (https://github.com/vercel/next.js, 130k+ stars)
 *   - create-vite (https://github.com/vitejs/vite, 70k+ stars)
 *   - degit/tiged (https://github.com/Rich-Harris/degit, 7k+ stars)
 *
 * These tools all do the same thing:
 *   1. mkdir -p project/
 *   2. Write template files (package.json, tsconfig, src/*, config files)
 *   3. Run npm/pnpm install (Container exec)
 *   4. Optionally run git init
 *
 * Without nodemode: IMPOSSIBLE on Cloudflare Workers.
 * With nodemode: Full scaffolding on DO + R2, npm install in Container.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createHelpers } from "../test/helpers";

const { exec, writeFile, readFile, readdir, exists, init } = createHelpers("conformance-create-app");

describe("create-app / scaffolding conformance", () => {
  beforeAll(async () => {
    await init("test", "create-app-conformance");
  });

  // =====================================================================
  // SCENARIO 1: create-next-app scaffold
  // =====================================================================

  describe("create-next-app scaffold", () => {
    it("creates Next.js directory structure", async () => {
      const dirs = [
        "nextapp/app",
        "nextapp/app/api/hello",
        "nextapp/public",
        "nextapp/styles",
      ];
      for (const dir of dirs) {
        await exec(`mkdir -p ${dir}`);
      }

      const entries = await readdir("nextapp");
      const names = entries.map((e) => e.name);
      expect(names).toContain("app");
      expect(names).toContain("public");
      expect(names).toContain("styles");
    });

    it("writes package.json with Next.js deps", async () => {
      const pkg = {
        name: "my-next-app",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          lint: "next lint",
        },
        dependencies: {
          next: "15.1.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          "@types/node": "^22",
          "@types/react": "^19",
          typescript: "^5",
        },
      };
      await writeFile("nextapp/package.json", JSON.stringify(pkg, null, 2));
      const data = await readFile("nextapp/package.json");
      const parsed = JSON.parse(data.content);
      expect(parsed.dependencies.next).toBe("15.1.0");
    });

    it("writes next.config.ts", async () => {
      const config = [
        "import type { NextConfig } from 'next';",
        "",
        "const nextConfig: NextConfig = {",
        "  output: 'standalone',",
        "};",
        "",
        "export default nextConfig;",
        "",
      ].join("\n");
      await writeFile("nextapp/next.config.ts", config);
      const data = await readFile("nextapp/next.config.ts");
      expect(data.content).toContain("standalone");
    });

    it("writes tsconfig.json", async () => {
      const tsconfig = {
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          jsx: "preserve",
          module: "esnext",
          moduleResolution: "bundler",
          paths: { "@/*": ["./src/*"] },
          strict: true,
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
        exclude: ["node_modules"],
      };
      await writeFile("nextapp/tsconfig.json", JSON.stringify(tsconfig, null, 2));
      const data = await readFile("nextapp/tsconfig.json");
      expect(JSON.parse(data.content).compilerOptions.jsx).toBe("preserve");
    });

    it("writes app/layout.tsx", async () => {
      const layout = [
        "export const metadata = {",
        "  title: 'My Next App',",
        "  description: 'Created with nodemode',",
        "};",
        "",
        "export default function RootLayout({",
        "  children,",
        "}: {",
        "  children: React.ReactNode;",
        "}) {",
        "  return (",
        "    <html lang=\"en\">",
        "      <body>{children}</body>",
        "    </html>",
        "  );",
        "}",
        "",
      ].join("\n");
      await writeFile("nextapp/app/layout.tsx", layout);
      const data = await readFile("nextapp/app/layout.tsx");
      expect(data.content).toContain("RootLayout");
    });

    it("writes app/page.tsx", async () => {
      const page = [
        "export default function Home() {",
        "  return (",
        "    <main>",
        "      <h1>Welcome to Next.js on nodemode</h1>",
        "      <p>This app was scaffolded on a Cloudflare Durable Object.</p>",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n");
      await writeFile("nextapp/app/page.tsx", page);
      const data = await readFile("nextapp/app/page.tsx");
      expect(data.content).toContain("nodemode");
    });

    it("writes API route", async () => {
      const route = [
        "import { NextResponse } from 'next/server';",
        "",
        "export async function GET() {",
        "  return NextResponse.json({ message: 'Hello from nodemode!' });",
        "}",
        "",
      ].join("\n");
      await writeFile("nextapp/app/api/hello/route.ts", route);
      const data = await readFile("nextapp/app/api/hello/route.ts");
      expect(data.content).toContain("NextResponse");
    });

    it("writes .gitignore", async () => {
      const gitignore = [
        "node_modules/",
        ".next/",
        "out/",
        ".env*.local",
        "*.tsbuildinfo",
        "next-env.d.ts",
        "",
      ].join("\n");
      await writeFile("nextapp/.gitignore", gitignore);
      const data = await readFile("nextapp/.gitignore");
      expect(data.content).toContain(".next");
    });

    it("verifies complete Next.js project structure", async () => {
      const files = [
        "nextapp/package.json",
        "nextapp/tsconfig.json",
        "nextapp/next.config.ts",
        "nextapp/app/layout.tsx",
        "nextapp/app/page.tsx",
        "nextapp/app/api/hello/route.ts",
        "nextapp/.gitignore",
      ];
      for (const f of files) {
        expect(await exists(f)).toBe(true);
      }
    });

    it("npm install would require container (exit 127)", async () => {
      const result = await exec("npm install");
      expect(result.exitCode).toBe(127);
    });
  });

  // =====================================================================
  // SCENARIO 2: create-vite scaffold
  // =====================================================================

  describe("create-vite scaffold", () => {
    it("creates Vite React project structure", async () => {
      const dirs = ["viteapp/src", "viteapp/public"];
      for (const dir of dirs) {
        await exec(`mkdir -p ${dir}`);
      }
    });

    it("writes Vite package.json", async () => {
      const pkg = {
        name: "my-vite-app",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "tsc -b && vite build",
          preview: "vite preview",
        },
        dependencies: {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          "@vitejs/plugin-react": "^4.3.4",
          typescript: "~5.7.2",
          vite: "^6.0.5",
        },
      };
      await writeFile("viteapp/package.json", JSON.stringify(pkg, null, 2));
      const data = await readFile("viteapp/package.json");
      expect(JSON.parse(data.content).scripts.dev).toBe("vite");
    });

    it("writes vite.config.ts", async () => {
      const config = [
        "import { defineConfig } from 'vite';",
        "import react from '@vitejs/plugin-react';",
        "",
        "export default defineConfig({",
        "  plugins: [react()],",
        "});",
        "",
      ].join("\n");
      await writeFile("viteapp/vite.config.ts", config);
      const data = await readFile("viteapp/vite.config.ts");
      expect(data.content).toContain("defineConfig");
    });

    it("writes index.html", async () => {
      const html = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="UTF-8" />',
        "    <title>Vite + React on nodemode</title>",
        "  </head>",
        "  <body>",
        '    <div id="root"></div>',
        '    <script type="module" src="/src/main.tsx"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n");
      await writeFile("viteapp/index.html", html);
      const data = await readFile("viteapp/index.html");
      expect(data.content).toContain("root");
    });

    it("writes React entry point", async () => {
      const main = [
        "import React from 'react';",
        "import ReactDOM from 'react-dom/client';",
        "import App from './App';",
        "",
        "ReactDOM.createRoot(document.getElementById('root')!).render(",
        "  <React.StrictMode>",
        "    <App />",
        "  </React.StrictMode>,",
        ");",
        "",
      ].join("\n");
      await writeFile("viteapp/src/main.tsx", main);

      const app = [
        "function App() {",
        "  return <h1>Hello from Vite on nodemode!</h1>;",
        "}",
        "",
        "export default App;",
        "",
      ].join("\n");
      await writeFile("viteapp/src/App.tsx", app);

      const data = await readFile("viteapp/src/App.tsx");
      expect(data.content).toContain("nodemode");
    });

    it("verifies Vite project structure", async () => {
      const files = [
        "viteapp/package.json",
        "viteapp/vite.config.ts",
        "viteapp/index.html",
        "viteapp/src/main.tsx",
        "viteapp/src/App.tsx",
      ];
      for (const f of files) {
        expect(await exists(f)).toBe(true);
      }
    });
  });

  // =====================================================================
  // SCENARIO 3: degit-style clone (copy template without .git)
  // =====================================================================

  describe("degit-style template copy", () => {
    it("copies a project template to new location", async () => {
      // degit copies files from a template repo — we simulate by
      // copying the viteapp structure to a new project
      await exec("mkdir -p cloned/src");
      await exec("cp viteapp/package.json cloned/package.json");
      await exec("cp viteapp/vite.config.ts cloned/vite.config.ts");
      await exec("cp viteapp/index.html cloned/index.html");
      await exec("cp viteapp/src/main.tsx cloned/src/main.tsx");
      await exec("cp viteapp/src/App.tsx cloned/src/App.tsx");

      // Verify all files were copied
      expect(await exists("cloned/package.json")).toBe(true);
      expect(await exists("cloned/src/App.tsx")).toBe(true);
    });

    it("modifies cloned project without affecting original", async () => {
      // Update the cloned project name
      const data = await readFile("cloned/package.json");
      const pkg = JSON.parse(data.content);
      pkg.name = "cloned-app";
      await writeFile("cloned/package.json", JSON.stringify(pkg, null, 2));

      // Original unchanged
      const original = await readFile("viteapp/package.json");
      expect(JSON.parse(original.content).name).toBe("my-vite-app");

      // Clone updated
      const cloned = await readFile("cloned/package.json");
      expect(JSON.parse(cloned.content).name).toBe("cloned-app");
    });

    it("cloned project has no .git directory (degit behavior)", async () => {
      expect(await exists("cloned/.git")).toBe(false);
    });
  });
});
