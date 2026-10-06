import { execFileSync } from "node:child_process";

let cached: string | undefined;

/** GIT_SHA is set at image build time; in local dev, ask git. */
export function gitSha(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GIT_SHA?.trim()) return env.GIT_SHA.trim();
  if (cached) return cached;
  try {
    cached = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cached = "unknown";
  }
  return cached;
}
