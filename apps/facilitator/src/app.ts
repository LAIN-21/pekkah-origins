// Ported from the x402-express starter's src/facilitator.ts
// (cardano-foundation/developer-portal, examples/templates/x402-express), under its MIT licence:
//
//   MIT License
//
//   Copyright (c) 2021 Cardano Foundation
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// My changes: zod-validated env, a pino logger, /health with the confirmation timeout, and
// GET /tx/:hash (on-chain status from Blockfrost). It holds no keys and no funds: it verifies
// payer-signed transactions and broadcasts them.
import { type FacilitatorHealth, NETWORK, type TxStatus } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import express from "express";

export interface FacilitatorAppOptions {
  facilitator: x402Facilitator;
  confirmationTimeoutMs: number;
  lookupTx(txHash: string): Promise<TxStatus>;
  log: Logger;
}

const TX_HASH = /^[0-9a-f]{64}$/;

export function createFacilitatorApp(options: FacilitatorAppOptions): express.Express {
  const { facilitator, log } = options;
  const app = express();
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = (req.body ?? {}) as {
        paymentPayload?: PaymentPayload;
        paymentRequirements?: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
        return;
      }
      const response = await facilitator.verify(paymentPayload, paymentRequirements);
      if (!response.isValid) {
        log.warn(
          { reason: response.invalidReason, message: response.invalidMessage },
          "verify rejected",
        );
      }
      res.json(response);
    } catch (error) {
      log.error({ err: error }, "verify failed");
      res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = (req.body ?? {}) as {
        paymentPayload?: PaymentPayload;
        paymentRequirements?: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
        return;
      }
      const response = await facilitator.settle(paymentPayload, paymentRequirements);
      log.info(
        {
          success: response.success,
          tx: response.transaction,
          reason: response.errorReason,
          extra: response.extra,
        },
        "settle",
      );
      res.json(response);
    } catch (error) {
      log.error({ err: error }, "settle failed");
      if (error instanceof Error && error.message.includes("Settlement aborted:")) {
        res.json({
          success: false,
          errorReason: error.message.replace("Settlement aborted: ", ""),
          network:
            (req.body as { paymentPayload?: { network?: string } })?.paymentPayload?.network ??
            "unknown",
          transaction: "",
        });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  app.get("/health", (_req, res) => {
    const body: FacilitatorHealth = {
      ok: true,
      network: NETWORK,
      confirmationTimeoutMs: options.confirmationTimeoutMs,
    };
    res.json(body);
  });

  // Proof that a cancelled payment never reached the chain. The market forwards its public
  // GET /api/tx/:hash here; the facilitator itself is never published.
  app.get("/tx/:hash", async (req, res) => {
    try {
      const hash = req.params.hash;
      if (!TX_HASH.test(hash)) {
        res.status(400).json({ error: "invalid_tx_hash" });
        return;
      }
      res.json(await options.lookupTx(hash));
    } catch (error) {
      log.error({ err: error }, "tx lookup failed");
      res.status(502).json({ error: "lookup_failed" });
    }
  });

  return app;
}
