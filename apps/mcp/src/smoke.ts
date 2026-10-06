// pnpm --dir apps/mcp smoke [--buy "<prompt>"] [--max-usd 0.05]
// Starts the MCP server over stdio the way Claude Desktop does, lists its tools and calls
// pekkah_market (free). With --buy it also calls pekkah_generate_image: a real payment.
// The server reads its own env (MARKET_URL, PEKKAH_ENV_FILE); this script never sees secrets.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values } = parseArgs({
  options: { buy: { type: "string" }, "max-usd": { type: "string", default: "0.05" } },
});
const appDir = join(import.meta.dirname, "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  cwd: appDir,
  env: Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  ),
  stderr: "inherit",
});
const client = new Client({ name: "pekkah-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

const market = await client.callTool({ name: "pekkah_market", arguments: {} });
for (const c of market.content as { type: string; text?: string }[]) {
  if (c.type === "text") console.log(c.text);
}

type Content = { type: string; text?: string; data?: string }[];

if (values.buy) {
  // Like Claude: when the purchase is still settling, ask for it again by run id.
  let result = await client.callTool({
    name: "pekkah_generate_image",
    arguments: { prompt: values.buy, maxUsd: Number(values["max-usd"]) },
  });
  for (let i = 0; i < 4; i++) {
    const pending = (result.content as Content)
      .map((c) => c.text ?? "")
      .join(" ")
      .match(/pekkah_get_image with runId "([^"]+)"/);
    if (!pending?.[1]) break;
    console.log(`still settling, asking again for run ${pending[1]}`);
    result = await client.callTool({ name: "pekkah_get_image", arguments: { runId: pending[1] } });
  }
  for (const c of result.content as Content) {
    if (c.type === "text") console.log(c.text);
    if (c.type === "image" && c.data) {
      const file = join(appDir, "..", "..", "results", "mcp-smoke.png");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(c.data, "base64"));
      console.log(`image: ${c.data.length} base64 chars, saved to results/mcp-smoke.png`);
    }
  }
  if (result.isError) process.exitCode = 1;
}
await client.close();
