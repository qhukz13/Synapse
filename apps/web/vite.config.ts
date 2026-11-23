import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwind()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      strict: true,
      deny: [
        "**/.local/**",
        "**/*.db*",
        "**/synapse.config.json",
        "**/.git/**",
        "**/.env*",
        "**/*.md",
      ],
    },
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
});
