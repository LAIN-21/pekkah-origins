// Test-only: a structurally valid (unsigned) Cardano transaction built from raw CBOR, so the
// tests exercise the real @x402/cardano decoder without a wallet or a chain.
import { blake2b } from "@noble/hashes/blake2.js";
import { DEFAULT_ASSET } from "@pekkah/protocol";

type Cbor = number | bigint | Uint8Array | Cbor[] | Map<number | Uint8Array, Cbor> | boolean | null;

function head(major: number, n: number | bigint): number[] {
  const v = BigInt(n);
  if (v < 24n) return [(major << 5) | Number(v)];
  const sizes: [number, number][] = [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ];
  for (const [info, bytes] of sizes) {
    if (v < 1n << BigInt(bytes * 8)) {
      const out = [(major << 5) | info];
      for (let i = bytes - 1; i >= 0; i--) out.push(Number((v >> BigInt(i * 8)) & 0xffn));
      return out;
    }
  }
  throw new RangeError("too large");
}

export function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const write = (v: Cbor): void => {
    if (v === null) out.push(0xf6);
    else if (v === true) out.push(0xf5);
    else if (v === false) out.push(0xf4);
    else if (typeof v === "number" || typeof v === "bigint") out.push(...head(0, v));
    else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      for (const item of v) write(item);
    } else {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        write(k);
        write(item);
      }
    }
  };
  write(value);
  return Uint8Array.from(out);
}

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

export interface TestTx {
  transaction: string;
  txHash: string;
  fee: bigint;
  paymentCoin: bigint;
}

/** A tx paying `amount` of tUSDM (plus `paymentCoin` lovelace) to an enterprise testnet address. */
export function buildTestTx(
  options: { amount?: bigint; seed?: number; fee?: bigint } = {},
): TestTx {
  const seed = options.seed ?? 1;
  const [policy, name] = DEFAULT_ASSET.split(".") as [string, string];
  const payee = Uint8Array.from([0x60, ...new Array(28).fill(seed)]);
  const change = Uint8Array.from([0x60, ...new Array(28).fill(seed + 1)]);
  const fee = options.fee ?? 180_000n;
  const paymentCoin = 1_189_560n;
  const value: Cbor = [
    paymentCoin,
    new Map([[hex(policy), new Map([[hex(name), options.amount ?? 10_000n]])]]),
  ];
  const body = new Map<number, Cbor>([
    [0, [[new Uint8Array(32).fill(seed), 0]]],
    [
      1,
      [
        [payee, value],
        [change, 5_000_000n],
      ],
    ],
    [2, fee],
    [3, 120_000_000n],
  ]);
  const bodyBytes = cbor(body);
  const tx = cbor([body, new Map(), true, null]);
  return {
    transaction: Buffer.from(tx).toString("base64"),
    txHash: Buffer.from(blake2b(bodyBytes, { dkLen: 32 })).toString("hex"),
    fee,
    paymentCoin,
  };
}
