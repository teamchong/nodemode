import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
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
