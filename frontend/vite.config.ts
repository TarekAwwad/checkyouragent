import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Same-origin API in dev: forward /api to the backend so the browser never
    // makes a cross-origin call. Removes the CORS dependency and makes the dev
    // port irrelevant (the frontend talks to its own origin's /api).
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/vitest.setup.ts",
  },
});
