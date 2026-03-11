// Vitest config for Node.js-only tests (deploy pipeline, etc.)
// These tests run in standard Node.js, NOT in pool-workers.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/deploy.test.ts"],
  },
});
