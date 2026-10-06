import { defineConfig } from "vitest/config";

// Every package and app is its own project, so a package can add its own vitest config
// (for example a browser environment for apps/web) without editing this file.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
