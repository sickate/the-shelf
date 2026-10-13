import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  site: process.env.SHELF_SITE_URL || "http://localhost:4321",
  base: process.env.SHELF_BASE_PATH || "/",
  trailingSlash: "always",
  server: { host: "127.0.0.1", port: 4321 },
  vite: {
    server: { fs: { deny: ["**/.local/**", "**/.git/**", "**/.env*"] } },
  },
});
