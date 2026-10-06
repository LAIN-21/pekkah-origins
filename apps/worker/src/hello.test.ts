import { HelloMsg } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { boundHardware, boundHello, HELLO_BOUNDS, type HelloFields } from "./hello.js";
import { jobSizing } from "./sizing.js";

const PAY_TO = `addr_test1${"q".repeat(98)}`;

function hello(overrides: Partial<HelloFields> = {}): HelloFields {
  return {
    workerId: "p-1a2b3c",
    token: "t".repeat(32),
    version: "4cc1295c3f0e8f0f6a7a3a5b1f2d6c9e8b7a6f5e",
    name: "Worker A",
    payTo: PAY_TO,
    hardware: {
      cpuModel: "AMD EPYC 9354 32-Core Processor",
      vcpus: 8,
      memGb: 31.3,
      gpu: { name: "NVIDIA RTX 4000 Ada Generation", vramGb: 20, driver: "570.86.15" },
    },
    prices: [
      { workload: "fractal", usd: 0.05 },
      { workload: "image", usd: 0.05 },
    ],
    ...overrides,
  };
}

describe("hello bounds (PLAN2 PR-13)", () => {
  it("leaves a normal hello unchanged", () => {
    expect(boundHello(hello())).toEqual(hello());
    expect(boundHello(hello({ schedule: "09:00-23:00 Asia/Singapore" })).schedule).toBe(
      "09:00-23:00 Asia/Singapore",
    );
  });

  it("cuts every detected string to its bound", () => {
    const long = (n: number) => `${"x".repeat(n)}  `;
    const out = boundHello(
      hello({
        version: long(300),
        name: long(300),
        schedule: long(300),
        hardware: {
          cpuModel: long(500),
          vcpus: 4,
          memGb: 8,
          gpu: { name: long(500), vramGb: 16, driver: long(500) },
        },
      }),
    );
    expect(out.version).toHaveLength(HELLO_BOUNDS.version);
    expect(out.name).toHaveLength(HELLO_BOUNDS.name);
    expect(out.schedule).toHaveLength(HELLO_BOUNDS.schedule);
    expect(out.hardware.cpuModel).toHaveLength(HELLO_BOUNDS.cpuModel);
    expect(out.hardware.gpu?.name).toHaveLength(HELLO_BOUNDS.gpuName);
    expect(out.hardware.gpu?.driver).toHaveLength(HELLO_BOUNDS.driver);
    expect(HelloMsg.safeParse({ type: "hello", ...out, warm: [] }).success).toBe(true);
  });

  it("sends at most 4 prices", () => {
    const prices = Array.from({ length: 6 }, () => ({ workload: "fractal" as const, usd: 0.01 }));
    expect(boundHello(hello({ prices })).prices).toHaveLength(HELLO_BOUNDS.prices);
  });

  it("never sends an empty CPU model or a GPU without a name", () => {
    const hw = boundHardware({
      cpuModel: "   ",
      vcpus: 2,
      memGb: 2,
      gpu: { name: "  ", vramGb: 16, driver: "x" },
    });
    expect(hw.cpuModel).toBe("unknown");
    expect(hw.gpu).toBeUndefined();
  });
});

describe("job sizing", () => {
  it("matches the live workers B and C, and caps memory at 8g", () => {
    expect(jobSizing({ vcpus: 8, memGb: 15.6 })).toEqual({ cpus: 8, memory: "8g" });
    expect(jobSizing({ vcpus: 2, memGb: 1.9 })).toEqual({ cpus: 2, memory: "1g" });
    expect(jobSizing({ vcpus: 8, memGb: 31.3 })).toEqual({ cpus: 8, memory: "8g" });
    expect(jobSizing({ vcpus: 1, memGb: 0.5 })).toEqual({ cpus: 1, memory: "1g" });
  });
});
