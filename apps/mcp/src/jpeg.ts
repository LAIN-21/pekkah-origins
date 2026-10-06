import { encode } from "jpeg-js";
import { PNG } from "pngjs";

// MCP clients drop large tool results: Claude Desktop dropped the 1.7 MB PNG of a 1024²
// image. The tool sends a JPEG instead (a few hundred KB) and links the full PNG, whose
// sha256 is the one in the receipt.

export const JPEG_QUALITY = 85;

/** PNG bytes to JPEG bytes. FLUX images are opaque, so dropping alpha loses nothing. */
export function pngToJpeg(png: Buffer, quality = JPEG_QUALITY): Buffer {
  const image = PNG.sync.read(png);
  return Buffer.from(
    encode({ data: image.data, width: image.width, height: image.height }, quality).data,
  );
}
