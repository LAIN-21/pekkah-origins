import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthResponse } from "@pekkah/protocol";
import type express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type MarketAppOptions } from "./app.js";

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const base: MarketAppOptions = {
  version: "0.1.0",
  sha: "abc",
  webDist: null,
  workersOnline: () => 2,
};

describe("market app", () => {
  it("answers health with the git sha", async () => {
    const url = await serve(createApp(base));
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({
      ok: true,
      version: "0.1.0",
      sha: "abc",
      workersOnline: 2,
    });
  });

  it("matches routes case-sensitively and strictly", async () => {
    const url = await serve(createApp(base));
    expect((await fetch(`${url}/api/Health`)).status).toBe(404);
    expect((await fetch(`${url}/api/health/`)).status).toBe(404);
    expect(await (await fetch(`${url}/api/nope`)).json()).toEqual({ error: "not_found" });
  });

  it("serves the web build with an SPA fallback, never for /api", async () => {
    const dist = mkdtempSync(join(tmpdir(), "pekkah-web-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Pekkah</title>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    const url = await serve(createApp({ ...base, webDist: dist }));
    expect(await (await fetch(`${url}/`)).text()).toContain("<title>Pekkah</title>");
    expect(await (await fetch(`${url}/runs/42`)).text()).toContain("<title>Pekkah</title>");
    expect(await (await fetch(`${url}/assets/app.js`)).text()).toBe("console.log(1)");
    expect((await fetch(`${url}/api/missing`)).status).toBe(404);
  });

  it("serves nothing at / without a web build", async () => {
    const url = await serve(createApp({ ...base, webDist: join(tmpdir(), "pekkah-no-web") }));
    expect((await fetch(`${url}/`)).status).toBe(404);
  });
});
