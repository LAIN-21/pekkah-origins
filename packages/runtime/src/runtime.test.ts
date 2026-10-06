import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvError, envFlag, envPort, isUnset, loadLocalEnv, parseEnvShape } from "./env.js";
import { REDACTED, redact } from "./log.js";
import { assertMnemonic, mnemonicProblem, normalizeMnemonic } from "./mnemonic.js";

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

  it("redacts password, API-key, private-key and cookie fields", () => {
    const keys = [
      "password",
      "dbPassword",
      "passwd",
      "passphrase",
      "apiKey",
      "api_key",
      "x-api-key",
      "privateKey",
      "private_key",
      "cookie",
      "set-cookie",
    ];
    const out = redact(Object.fromEntries(keys.map((k) => [k, "x"]))) as Record<string, unknown>;
    for (const key of keys) expect(out[key], key).toBe(REDACTED);
  });

  it("keeps fields that only look close, such as an image seed", () => {
    const params = { prompt: "a fox", seed: 7, size: 1024, keyCount: 3, passes: 2 };
    expect(redact(params)).toEqual(params);
  });

  it("survives cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[circular]" });
  });
});

describe("mnemonic checks", () => {
  // The public BIP-39 test vector; never a real wallet.
  const valid = `${"abandon ".repeat(11)}about`;

  it("accepts a valid mnemonic", () => {
    expect(mnemonicProblem(valid)).toBeNull();
    expect(mnemonicProblem(`  ${valid.toUpperCase()}  `)).toBeNull();
  });

  it("names positions and counts, never the words", () => {
    const typo = valid.replace(/about$/, "abuot");
    expect(mnemonicProblem(typo)).toBe("word 12 of 12 is not in the BIP-39 English wordlist");
    const two = `zzzq ${"abandon ".repeat(10)}qqqz`;
    expect(mnemonicProblem(two)).toBe("words 1, 12 of 12 are not in the BIP-39 English wordlist");
    expect(mnemonicProblem("abandon abandon")).toBe(
      "has 2 words; a mnemonic has 12, 15, 18, 21 or 24",
    );
    expect(mnemonicProblem("abandon ".repeat(12))).toMatch(/checksum/);
    for (const bad of [typo, two]) {
      const message = mnemonicProblem(bad) ?? "";
      for (const word of bad.split(" ")) expect(message).not.toContain(word);
    }
  });

  it("normalizes case and whitespace the same way for the check and the library", () => {
    const messy = `  ${"ABANDON\t ".repeat(11)}About \n`;
    expect(normalizeMnemonic(messy)).toBe(valid);
    expect(assertMnemonic("BUYER_MNEMONIC", messy)).toBe(valid);
  });

  it("throws with the variable name only", () => {
    expect(() => assertMnemonic("BUYER_MNEMONIC", "abandon abuot")).toThrow(
      "BUYER_MNEMONIC has 2 words; a mnemonic has 12, 15, 18, 21 or 24",
    );
  });
});
