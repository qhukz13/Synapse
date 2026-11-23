import { defineConfig } from "vitest/config";
export default defineConfig({
  server: { host: "127.0.0.1" },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: { provider: "v8", include: ["packages/core/src/**/*.ts"] },
  },
});
