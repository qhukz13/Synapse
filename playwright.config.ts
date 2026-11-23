import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  use: {
    launchOptions: process.env.SYNAPSE_CHROMIUM
      ? { executablePath: process.env.SYNAPSE_CHROMIUM }
      : {},
    baseURL: "http://127.0.0.1:5173",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "medium", use: { viewport: { width: 1024, height: 768 } } },
    { name: "compact", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "node scripts/dev.mjs --stable",
    url: "http://127.0.0.1:5173/api/health",
    reuseExistingServer: false,
  },
  workers: 1,
});
