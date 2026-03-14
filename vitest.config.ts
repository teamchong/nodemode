import path from "path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  resolve: {
    alias: {
      "gitmode/git-engine": path.resolve(__dirname, "vendor/gitmode/src/git-engine.ts"),
      "gitmode/git-porcelain": path.resolve(__dirname, "vendor/gitmode/src/git-porcelain.ts"),
      "gitmode/wasm-engine": path.resolve(__dirname, "vendor/gitmode/src/wasm-engine.ts"),
      "zerobuf": path.resolve(__dirname, "vendor/zerobuf/src/index.ts"),
    },
  },
  test: {
    exclude: ["test/deploy.test.ts", "**/node_modules/**", "**/dist/**", "vendor/**"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: "./test/wrangler.jsonc" },
        miniflare: {
          unsafeEvalBinding: "UNSAFE_EVAL",
        },
      },
    },
  },
});
