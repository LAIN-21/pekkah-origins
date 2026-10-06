import { crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature (8) + IHDR length (4), type (4), data (13) and CRC (4). */
const HEADER_BYTES = 33;

/**
 * Width and height from a PNG's first chunk, which must be an intact IHDR; null when the bytes
 * are not a PNG. The market reads this itself: it never trusts what a worker says it sent.
 */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < HEADER_BYTES || !data.subarray(0, 8).equals(SIGNATURE)) return null;
  if (data.readUInt32BE(8) !== 13 || data.toString("latin1", 12, 16) !== "IHDR") return null;
  if (crc32(data.subarray(12, 29)) !== data.readUInt32BE(29)) return null;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
