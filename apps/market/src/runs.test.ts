import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JobEventInput, scenarioRequest } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./events.js";
import { RunStore } from "./runs.js";

const log = createLogger("runs-test");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "pekkah-runs-"));
  dirs.push(dir);
  return dir;
};
const runId = (i: number) => `01RUN${String(i).padStart(21, "0")}`;
const started = (i: number): JobEventInput => ({
  source: "agent",
  type: "run.started",
  runId: runId(i),
  data: { scenario: "cpu-tight", request: scenarioRequest("cpu-tight") },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("run logs", () => {
  it("keeps a run's outcome even past the event cap", () => {
    const bus = new EventBus(log);
    const runs = new RunStore(bus, null, log);
    bus.emit(started(1));
    for (let i = 0; i < 600; i++) {
      bus.emit({
        source: "market",
        type: "job.progress",
        runId: runId(1),
        jobId: "01JOB",
        data: { workerId: "B", pct: i % 100 },
      });
    }
    bus.emit({ source: "agent", type: "run.failed", runId: runId(1), data: { reason: "x" } });
    expect(runs.get(runId(1))?.events.at(-1)?.type).toBe("run.failed");
  });

  it("deletes a run's file when it leaves memory, so files follow the same limit", async () => {
    const dir = tempDir();
    const bus = new EventBus(log);
    new RunStore(bus, dir, log);
    for (let i = 1; i <= 31; i++) bus.emit(started(i));
    await settle();
    const files = readdirSync(join(dir, "runs"));
    expect(files).toHaveLength(30);
    expect(files).not.toContain(`${runId(1)}.json`);
  });

  it("skips an unreadable file and keeps the other runs", async () => {
    const dir = tempDir();
    const bus = new EventBus(log);
    new RunStore(bus, dir, log);
    bus.emit(started(1));
    bus.emit(started(2));
    await settle();
    writeFileSync(join(dir, "runs", "01BROKEN.json"), '{"runId": "01BRO');
    const restored = new RunStore(new EventBus(log), dir, log);
    expect(restored.get(runId(1))?.events).toHaveLength(1);
    expect(restored.latest()?.runId).toBe(runId(2));
  });

  it("drops the oldest saved runs past the limit when it loads", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "runs"));
    for (let i = 1; i <= 33; i++) {
      const ts = new Date(Date.UTC(2026, 9, 6, 0, i)).toISOString();
      const event = { ...started(i), id: `01EV${String(i).padStart(22, "0")}`, ts };
      writeFileSync(
        join(dir, "runs", `${runId(i)}.json`),
        JSON.stringify({ runId: runId(i), scenario: "cpu-tight", startedAt: ts, events: [event] }),
      );
    }
    const runs = new RunStore(new EventBus(log), dir, log);
    expect(runs.get(runId(3))).toBeUndefined();
    expect(runs.get(runId(4))).toBeDefined();
    expect(readdirSync(join(dir, "runs"))).toHaveLength(30);
  });
});
