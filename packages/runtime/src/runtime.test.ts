import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvError, envFlag, envPort, isUnset, loadLocalEnv, parseEnvShape } from "./env.js";
import { REDACTED, redact } from "./log.js";

describe("env", () => {
  it("treats empty strings and the placeholder as unset", () => {
    expect(isUnset(undefined)).toBe(true);
    expect(isUnset("")).toBe(true);
    expect(isUnset("  ")).toBe(true);
    expect(isUnset("__FILL_ME__")).toBe(true);
    expect(isUnset("x")).toBe(false);
  });

  it("names missing and invalid variables without their values", () => {
    const shape = { A_URL: z.string().url(), B_NAME: z.string(), C_PORT: envPort(8080) };
    const env = { A_URL: "not a url, value-must-not-leak", B_NAME: "" };
    try {
      parseEnvShape("svc", shape, env);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const e = err as EnvError;
      expect(e.missing).toEqual(["B_NAME"]);
      expect(e.invalid).toEqual(["A_URL (invalid_string)"]);
      expect(e.message).not.toContain("value-must-not-leak");
    }
  });

  it("applies defaults for unset names and parses flags", () => {
    const shape = { PORT: envPort(4022), DEV: envFlag, OFF: envFlag };
    expect(parseEnvShape("svc", shape, { PORT: "", DEV: "1" })).toEqual({
      PORT: 4022,
      DEV: true,
      OFF: false,
    });
  });

  it("fills only unset names from the local env file, quotes and spaces included", () => {
    const dir = mkdtempSync(join(tmpdir(), "pekkah-env-"));
    const file = join(dir, "local.env");
    writeFileSync(file, 'PHRASE="alpha beta gamma"\nKEEP=from-file\nEMPTY=from-file\n# note\n');
    const env: NodeJS.ProcessEnv = { PEKKAH_ENV_FILE: file, KEEP: "from-process", EMPTY: "" };
    expect(loadLocalEnv(env)).toBe(file);
    expect(env.PHRASE).toBe("alpha beta gamma");
    expect(env.KEEP).toBe("from-process");
    expect(env.EMPTY).toBe("from-file");
  });

  it("is a no-op without a local env file", () => {
    const env: NodeJS.ProcessEnv = { PEKKAH_HOME: mkdtempSync(join(tmpdir(), "pekkah-home-")) };
    expect(loadLocalEnv(env)).toBeNull();
    expect(() => loadLocalEnv({ PEKKAH_ENV_FILE: "/nonexistent/local.env" })).toThrow();
  });
});

describe("redact", () => {
  it("redacts secret-looking keys at any depth", () => {
    const out = redact({
      msg: "hello",
      BUYER_MNEMONIC: "x",
      nested: { token: "x", projectId: "x", project_id: "x", list: [{ Authorization: "x" }] },
      WORKER_TOKENS: "x",
      clientSecret: "x",
      payTo: "addr_test1…",
    });
    expect(out).toEqual({
      msg: "hello",
      BUYER_MNEMONIC: REDACTED,
      nested: {
        token: REDACTED,
        projectId: REDACTED,
        project_id: REDACTED,
        list: [{ Authorization: REDACTED }],
      },
      WORKER_TOKENS: REDACTED,
      clientSecret: REDACTED,
      payTo: "addr_test1…",
    });
  });

  it("survives cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[circular]" });
  });
});
