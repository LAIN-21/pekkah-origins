// Tests only: public preprod chain data for escrow tests.

// The inline datum of a real lock on preprod (tx a6be16bc…#0, public chain data).
export const LOCK_DATUM = [
  "d8799fd8799fd8799f581c57866dd4917ae0c7dd5775d9ae293463d38b26f0d9bb110f3aa33d2fffd8799fd8799fd879",
  "9f581c48818dac1373cf717c199be6bae14a475e8936cedb21f5c8ef6e912affffffffd87a80d8799fd8799f581c4ebf",
  "110b65aecb2218c3c6461e635f9211b073671a483ae750d7c755ffd8799fd8799fd8799f581cdaf7b595a29bb7e9c4e4",
  "f88e72630e7739e4b09805bde820117cebbaffffffffd87a80582aa4010103272006215820ace3ae5fd197969587df2d",
  "fe1387c017da109da4e5805c795a5d9268499343865f5840845846a2012767616464726573735839004ebf110b65aecb",
  "2218c3c6461e635f9211b073671a483ae750d7c755daf7b595a29bb7e9c4e4f88e72630e7739e4b058409805bde82011",
  "7cebbaa166686173686564f4582063bb25ef6740f3d9eb5860470f6d137ec83ef9257f71ab389cd2f45fc6e2f7d15840",
  "b46a77ec3c9d5bb578765836e22c454403391f3687684def51614fbd60b0a1aac1c188ab0742ede780cabe1a4c13e2f1",
  "65f3a61b0aa6d74ad7ae225d3ceb49d19408ff5820b148d439d3cb8d8adafc3cd1cb377166d261a475c68d00a34ef768",
  "3bbc5d049540401a003d189658203632e82ae498d157e871540f424e8aa11803d41e0d59067fe6621e64b5c2811f401b",
  "000001a11061c0311b000001a1106f7bd11b000001a11081cb511b000001a110941ad10000d87980ff",
].join("");
/** The delivered result's sha256 that PR-10b submitted for the 18:24 lock (docs/RUNS.md). */
export const RESULT = "454524db2dee12985a879389e61ae2ca3dc61e5b49877e0967bbc0a8b806fef9";
/** Seller A's public payout address on preprod (README): the Masumi seller in LOCK_DATUM. */
export const SELLER_A =
  "addr_test1qp8t7ygtvkhvkgscc0ryv8nrt7fprvrnvudyswh82rtuw4w6776etg5mkl5ufe8c3eexxrnh88jtpxq9hh5zqytuawaqxfywga";
/** tUSDM on preprod, as the SDK and Blockfrost spell the unit (policy and name, no dot). */
export const TUSDM_UNIT =
  "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d";
