# Pekkah MCP server

Claude can buy compute from Pekkah with a tool call. This is a stdio MCP server that runs on my Mac. It uses the same x402 buyer as my agent: same wallet, same caps, same check that the 402 matches the offer it took. It pays per job in test tUSDM on Cardano preprod, and only after the job delivers. A failed job is cancelled and charges nothing.

## Tools

- `pekkah_market`: the machines selling compute right now, with hardware, measured speed, prices and status. Free; nothing is bought.
- `pekkah_generate_image({ prompt, maxUsd, seed? })`: buys one 1024×1024 image from a GPU worker. `maxUsd` is the most my agent may pay, at most 0.10 (default 0.05). It returns the image plus a receipt with the Cardanoscan link. The image comes as a JPEG (about 150 to 200 KB): MCP clients drop large results, and Claude Desktop dropped the 1.7 MB PNG. The receipt links the full PNG on the market, with the sha256 of that PNG.
- `pekkah_get_image({ runId })`: a paid image takes 30 to 120 s (the job, then the payment settling on Cardano), longer than many clients wait for one call. So `pekkah_generate_image` waits about 45 s, and if the payment is still settling it returns a run id; this tool then collects the image and the receipt. Buys nothing.

## Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop. Replace `<node>` with the absolute path of Node 22 (`which node`) and `<repo>` with the absolute path of this checkout. Claude Desktop starts the server with no working directory and a short PATH, so every path is absolute.

```json
{
  "mcpServers": {
    "pekkah": {
      "command": "<node>",
      "args": [
        "--import",
        "<repo>/apps/mcp/node_modules/tsx/dist/loader.mjs",
        "<repo>/apps/mcp/src/index.ts"
      ],
      "env": {
        "MARKET_URL": "<the market's public URL>",
        "PEKKAH_ENV_FILE": "<home>/.pekkah/env/market.env"
      }
    }
  }
}
```

The config holds no secrets. The server reads the rest from the env file in `~/.pekkah`, which stays on my Mac:

| Name | |
| --- | --- |
| `MARKET_URL` | The market, e.g. `https://<ip-with-dashes>.sslip.io`. Set in the config, so it wins over the file's internal URL |
| `BUYER_MNEMONIC`, `BUYER_ACCOUNT_INDEX` | The buyer wallet (the same one as the hosted agent) |
| `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_BASE_URL` | Preprod Blockfrost, for signing |
| `PEKKAH_ASSET` | tUSDM |
| `CAP_PER_PAYMENT_USD` | At most 0.10; one image is one payment, so it is also the per-run cap |
| `CAP_DAY_USD` | Default 1 |
| `AGENT_TOKEN` | Optional: with it, the market's page shows these runs as my agent's |

Then ask Claude, for example: "Use Pekkah to make an image of a lighthouse at dusk, at most 5 cents."

## One wallet

The server pays from the same wallet as the hosted agent. Don't use it while a run is in progress on the market's page. A collision costs at most one failed payment (the buyer refuses or the facilitator rejects the second spend), never a double charge.

## Check it without Claude

```bash
MARKET_URL=<url> PEKKAH_ENV_FILE=~/.pekkah/env/market.env pnpm --dir apps/mcp smoke
```

That starts the server over stdio like Claude Desktop does, lists the tools and calls `pekkah_market`. With `--buy "<prompt>"` it also buys an image: a real payment.
