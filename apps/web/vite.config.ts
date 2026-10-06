/// <reference types="node" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the page talks to a market through Vite's proxy: a local one on :8080,
// or the hosted one with PEKKAH_MARKET_URL=https://… (read-only: the page only
// reads /api and /ws/ui, and the run buttons need the market's own guards).
// In production the market serves dist/ itself, so everything is same-origin.
const market = process.env.PEKKAH_MARKET_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: market, changeOrigin: true },
      "/ws": { target: market.replace(/^http/, "ws"), ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
