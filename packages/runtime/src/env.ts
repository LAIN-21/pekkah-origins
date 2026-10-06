import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

/** Placeholder that init-env.sh writes for secrets I fill in by hand. */
const PLACEHOLDER = "__FILL_ME__";

/** Empty strings count as unset: compose passes "" for an unset ${VAR}. */
export function isUnset(value: string | undefined): value is undefined {
  if (value === undefined) return true;
  const v = value.trim();
  return v === "" || v === PLACEHOLDER;
}

export function localEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  if (!isUnset(env.PEKKAH_ENV_FILE)) return env.PEKKAH_ENV_FILE;
  const home = isUnset(env.PEKKAH_HOME) ? join(homedir(), ".pekkah") : env.PEKKAH_HOME;
  return join(home, "local.env");
}

/**
 * Local dev: fill names the process env lacks from ~/.pekkah/local.env (or PEKKAH_ENV_FILE).
 * Deployed containers get their env from compose and have no such file. Never logs values.
 * Returns the file it read, or null.
 */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = localEnvPath(env);
  if (!existsSync(file)) {
    if (!isUnset(env.PEKKAH_ENV_FILE)) throw new Error(`PEKKAH_ENV_FILE not found: ${file}`);
    return null;
  }
  const values = parseEnv(readFileSync(file, "utf8"));
  for (const [name, value] of Object.entries(values)) {
    if (isUnset(env[name]) && value !== undefined) env[name] = value;
  }
  return file;
}

export class EnvError extends Error {
  constructor(
    readonly service: string,
    readonly missing: string[],
    readonly invalid: string[],
  ) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(", ")}`);
    if (invalid.length) parts.push(`invalid ${invalid.join(", ")}`);
    super(`${service}: env ${parts.join("; ")}`);
  }
}

/**
 * Validates only the names in `shape`. Unset (empty or placeholder) values become undefined, so
 * `.default()` and `.optional()` apply. Errors name the variables, never their values.
 */
export function parseEnvShape<S extends z.ZodRawShape>(
  service: string,
  shape: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<S>> {
  const input: Record<string, string | undefined> = {};
  for (const name of Object.keys(shape)) {
    const value = env[name];
    input[name] = isUnset(value) ? undefined : value.trim();
  }
  const result = z.object(shape).safeParse(input);
  if (result.success) return result.data;
  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    const name = String(issue.path[0]);
    if (input[name] === undefined) missing.add(name);
    else invalid.add(`${name} (${issue.code})`);
  }
  throw new EnvError(service, [...missing], [...invalid]);
}

/** Loads local.env when present, validates, and exits listing the missing names on failure. */
export function readEnv<S extends z.ZodRawShape>(
  service: string,
  shape: S,
): z.infer<z.ZodObject<S>> {
  try {
    loadLocalEnv();
    return parseEnvShape(service, shape);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** Helpers for common env shapes. */
export const envPort = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);
export const envFlag = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");
