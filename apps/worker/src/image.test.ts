import type { ImageParams } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { describe, expect, it } from "vitest";
import { createImageWorkload, pngSize, readCapped } from "./workloads/image.js";
import type { JobContext } from "./workloads/types.js";

/** A PNG signature and IHDR chunk: enough for the size check. */
function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const params: ImageParams = { prompt: "a lighthouse at dusk", seed: 7, size: 1024, steps: 4 };

function ctx(overrides: Partial<JobContext<ImageParams>> = {}): JobContext<ImageParams> {
  return {
    jobId: "01JOB",
    kind: "dev",
    params,
    deadlineSec: 60,
    signal: new AbortController().signal,
    progress: () => {},
    log: createLogger("test").child({ test: true }),
    ...overrides,
  };
}

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

describe("image workload", () => {
  it("validates params like the protocol: prompt length, size, steps", () => {
    const w = createImageWorkload({ fluxUrl: "http://flux:8000" });
    expect(w.validate(params)).toEqual(params);
    expect(() => w.validate({ ...params, prompt: "x".repeat(301) })).toThrow();
    expect(() => w.validate({ ...params, size: 512 })).toThrow();
    expect(() => w.validate({ ...params, steps: 5 })).toThrow();
    expect(() => w.validate({ ...params, extra: true })).toThrow();
  });

  it("is ready only while flux reports ready", async () => {
    for (const [answer, expected] of [
      [new Response(JSON.stringify({ ready: true, model: "flux" })), true],
      [new Response(JSON.stringify({ ready: false, model: "flux" })), false],
      [new Response("busy", { status: 503 }), false],
    ] as const) {
      const f = fakeFetch(() => answer);
      const w = createImageWorkload({ fluxUrl: "http://flux:8000" }, f.impl);
      expect(await w.ready()).toBe(expected);
      expect(f.calls[0]?.url).toBe("http://flux:8000/health");
    }
    const down = createImageWorkload({ fluxUrl: "http://flux:8000" }, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(await down.ready()).toBe(false);
  });

  it("posts the validated params as JSON and returns the PNG", async () => {
    const png = fakePng(1024, 1024);
    const f = fakeFetch(
      () =>
        new Response(png, { headers: { "content-type": "image/png", "x-duration-ms": "6850" } }),
    );
    const out = await createImageWorkload({ fluxUrl: "http://flux:8000" }, f.impl).run(ctx());
    expect(out.mime).toBe("image/png");
    expect(out.data.equals(png)).toBe(true);
    expect(f.calls[0]?.url).toBe("http://flux:8000/generate");
    expect(f.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual(params);
  });

  it("fails the job on anything but a PNG of the requested size", async () => {
    const run = (answer: Response) =>
      createImageWorkload({ fluxUrl: "http://flux:8000" }, fakeFetch(() => answer).impl).run(ctx());
    await expect(run(new Response(fakePng(768, 768)))).rejects.toThrow("expected a 1024x1024 PNG");
    await expect(run(new Response("not an image"))).rejects.toThrow("not a PNG");
    await expect(run(new Response("model not ready", { status: 503 }))).rejects.toThrow(
      "flux answered 503",
    );
  });

  it("stops at once when the job is canceled", async () => {
    const abort = new AbortController();
    abort.abort("market canceled the job");
    const f = fakeFetch(() => new Response(fakePng(1024, 1024)));
    await expect(
      createImageWorkload({ fluxUrl: "http://flux:8000" }, f.impl).run(
        ctx({ signal: abort.signal }),
      ),
    ).rejects.toThrow("canceled before start");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a result over the cap without reading all of it", async () => {
    const declared = new Response(fakePng(1024, 1024), {
      headers: { "content-length": "999999999" },
    });
    await expect(readCapped(declared, 1000)).rejects.toThrow("999999999 bytes declared");

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(400));
      },
    });
    await expect(readCapped(new Response(endless), 1000)).rejects.toThrow("over 1000 bytes");
    expect(pulled).toBeLessThan(10);

    const w = createImageWorkload(
      { fluxUrl: "http://flux:8000", maxBytes: 20 },
      fakeFetch(() => new Response(fakePng(1024, 1024))).impl,
    );
    await expect(w.run(ctx())).rejects.toThrow("result too large");
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(pngSize(fakePng(768, 1024))).toEqual({ width: 768, height: 1024 });
    expect(pngSize(Buffer.from("GIF89a"))).toBeNull();
  });
});
