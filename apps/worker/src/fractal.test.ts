import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FRACTAL_PRESETS, FRACTAL_SOURCE_SHA256, FractalParams } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { fractalDockerArgs } from "./workloads/fractal.js";

const core = new URL("../../../workloads/fractal/fractal/core.py", import.meta.url);

describe("fractal job container", () => {
  const args = fractalDockerArgs(
    "01JOB",
    FractalParams.parse({ preset: "hd-heavy", palette: "mint" }),
    { image: "pekkah/fractal:local", cpus: 7, memory: "6g", dataDir: "/var/lib/pekkah" },
  );
  const flag = (name: string) => args[args.indexOf(name) + 1];

  it("runs with every sandbox flag (PLAN 7.3)", () => {
    expect(flag("--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(flag("--tmpfs")).toBe("/tmp:rw,size=64m");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--security-opt")).toBe("no-new-privileges");
    expect(flag("--pids-limit")).toBe("256");
    expect(flag("--memory")).toBe("6g");
    expect(flag("--memory-swap")).toBe("6g");
    expect(flag("--cpus")).toBe("7");
    expect(flag("--user")).toBe("1000:1000");
    expect(flag("-e")).toBe("WORKERS=7");
    expect(flag("--name")).toBe("pekkah-job-01JOB");
    expect(flag("--label")).toBe("pekkah.job=01JOB");
  });

  it("mounts only the job's output dir, by host path", () => {
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
    expect(flag("-v")).toBe("/var/lib/pekkah/jobs/01JOB:/out");
  });

  it("passes the params as one JSON argument, never through a shell", () => {
    expect(args.at(-2)).toBe("pekkah/fractal:local");
    expect(JSON.parse(args.at(-1) ?? "")).toEqual({
      preset: "hd-heavy",
      palette: "mint",
      format: "png",
    });
  });

  it("refuses job ids that are not plain ids", () => {
    const params = FractalParams.parse({ preset: "tiny" });
    const cfg = { image: "x", cpus: 1, memory: "1g", dataDir: "/d" };
    expect(() => fractalDockerArgs("../etc", params, cfg)).toThrow();
    expect(() => fractalDockerArgs("a b", params, cfg)).toThrow();
  });
});

describe("calibration references", () => {
  const source = readFileSync(core);

  it("were generated from the current fractal code (else run pnpm calib:ref)", () => {
    expect(createHash("sha256").update(source).digest("hex")).toBe(FRACTAL_SOURCE_SHA256);
  });

  it("use the same presets as the protocol", () => {
    for (const [name, p] of Object.entries(FRACTAL_PRESETS)) {
      const line = `"${name}": Preset(${p.width}, ${p.height}, ${p.supersample}, ${p.maxIter})`;
      expect(source.toString(), name).toContain(line);
    }
  });
});
