# Pekkah MCP server

Claude can shop for compute on Pekkah with tool calls. It looks at the market, gets free quotes, keeps to the budget I gave, asks me before paying more, and buys. This is a stdio MCP server that runs on my Mac. It uses the same x402 buyer as my agent: the same caps, and the same check that the 402 matches the offer it took. It pays per job in test tUSDM on Cardano preprod, and only after the job delivers. A failed job is cancelled and charges nothing.

## Tools

- `pekkah_market`: who sells right now. Hardware as each machine reports it, speed as the market measured it, prices, status, the worker that sells through Masumi escrow, and the workers joining on probation (listed, not selling). Free.
- `pekkah_quote`: offers for one job, an image (prompt, size, steps, seed) or a CPU render (preset), with a deadline and `budgetUsd`, the budget I gave. Free: nothing is bought. It returns each offer (offerId, worker, hardware, price, estimate, seconds left, escrow or not), the counter-offer, the market price, every rejected worker with its reason, and a one-line hint: "fits the budget", or "nothing within $X: ask your human before paying $Y". The first quote of a task starts a run on the market's page, shown as "Claude via MCP".
- `pekkah_buy({ offerId, maxUsd, escrow?, overBudgetApproved?, reason })`: buys an offer it quoted itself, with the quoted request, payTo and price. `maxUsd` is the most my agent commits to, at most 0.10. Escrow is on by default when the offer's worker sells through it. An expired offer (120 s) is quoted again and bought only from the same worker, under the same rules. It waits about 45 s, then hands over to `pekkah_result`.
- `pekkah_result({ runId })`: the image (as a JPEG), the full PNG (linked, and saved in `PEKKAH_OUTPUT_DIR`), the receipt with the transaction link, and for escrow every step the market has seen: locked, result hash submitted, the unlock time, released. Call it again later to see the release. `pekkah_get_image` is the same tool under its older name.
- `pekkah_generate_image({ prompt, maxUsd, seed? })`: the one-shot from Phase 1. It quotes and buys in one call, never above `maxUsd`.

The image travels as a JPEG of about 150 to 200 KB because MCP clients drop large results: Claude Desktop dropped the 1.7 MB PNG. The receipt links the full PNG with its sha256.

## The budget rule

The tool enforces it, so the ask happens even if the model skips the skill:
- A price above the budget of the quote is refused unless `overBudgetApproved` is true: "This is above the $X budget your human gave. Ask them first."
- No budget at all is refused too: Claude asks me for one, then quotes again.
- With `overBudgetApproved`, the market records my agent's statement that I approved (`agent.decision.overBudget`). It is my agent's statement, never proof. The wallet's spend caps stay the hard limit.

## Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config). Replace `<node>` with the absolute path of Node 22 (`which node`), `<repo>` with the absolute path of a checkout that only changes after merges (mine is a detached worktree at `origin/main`), and `<home>` with my home folder. Claude Desktop starts the server with no working directory and a short PATH, so every path is absolute.

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
        "PEKKAH_ENV_FILE": "<home>/.pekkah/env/market.env",
        "BUYER_ACCOUNT_INDEX": "1",
        "PEKKAH_OUTPUT_DIR": "<home>/Pictures/pekkah"
      }
    }
  }
}
```

Claude Desktop starts the server once, at launch, and keeps this file's contents in memory: an edit made while it runs can be written over. Quit Claude Desktop, edit, then open it again. The same goes for new code in `<repo>`. The Code tab in the desktop app uses the same server.

The config holds no secrets. The server reads the rest from the env file in `~/.pekkah`, which stays on my Mac. Entries in the config's `env` win over the file:

| Name | |
| --- | --- |
| `MARKET_URL` | The market, e.g. `https://<ip-with-dashes>.sslip.io` |
| `BUYER_MNEMONIC` | The buyer wallet's mnemonic (in the env file) |
| `BUYER_ACCOUNT_INDEX` | `1`: the MCP pays from its own account, never the hosted agent's (account 0) |
| `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_BASE_URL` | Preprod Blockfrost, for signing |
| `PEKKAH_ASSET` | tUSDM |
| `CAP_PER_PAYMENT_USD` | At most 0.10, also the per-run cap |
| `CAP_DAY_USD` | Default 1 |
| `AGENT_TOKEN` | Optional: with it, the market's page shows these runs |
| `PEKKAH_OUTPUT_DIR` | Optional: where the full PNGs are saved |

## Claude Code (terminal)

User scope, with the same paths and `env` as above:

```bash
claude mcp add-json --scope user pekkah '{"type":"stdio","command":"<node>","args":["--import","<repo>/apps/mcp/node_modules/tsx/dist/loader.mjs","<repo>/apps/mcp/src/index.ts"],"env":{"MARKET_URL":"<url>","PEKKAH_ENV_FILE":"<home>/.pekkah/env/market.env","BUYER_ACCOUNT_INDEX":"1","PEKKAH_OUTPUT_DIR":"<home>/Pictures/pekkah"}}'
```

## The skill

The server's instructions carry a short shopping policy. The full one is the skill in `skill/pekkah/SKILL.md`:
- Claude Code: copy it to `~/.claude/skills/pekkah` (`cp -R apps/mcp/skill/pekkah ~/.claude/skills/`).
- Claude Desktop: zip the folder (`cd apps/mcp/skill && zip -r ~/Desktop/pekkah-skill.zip pekkah`), then upload the zip under Settings → Capabilities → Skills.

## Pre-allowed tools, for recording

So that no permission dialog appears and my "yes" in the chat is the only approval on screen, allow these tools in `~/.claude/settings.json` (Claude Code), or choose "Always allow" the first time each one asks (Claude Desktop):

```json
{
  "permissions": {
    "allow": [
      "mcp__pekkah__pekkah_market",
      "mcp__pekkah__pekkah_quote",
      "mcp__pekkah__pekkah_buy",
      "mcp__pekkah__pekkah_result"
    ]
  }
}
```

`pekkah_buy` then runs without a dialog. The budget rule and the spend caps still apply.

Then ask Claude, for example: "Make a poster of a lighthouse at dusk with Pekkah. Spend at most 3 cents."

## Check it without Claude

```bash
MARKET_URL=<url> PEKKAH_ENV_FILE=~/.pekkah/env/market.env BUYER_ACCOUNT_INDEX=1 pnpm --dir apps/mcp smoke
```

That starts the server over stdio like Claude Desktop does, lists the tools and calls `pekkah_market`. With `--buy "<prompt>"` it also buys an image through `pekkah_generate_image`: a real payment.
