import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the page talks to a local market on :8080. In production the market
// serves dist/ itself, so everything is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
