import { describe, expect, it } from "vitest";
import { pngSize } from "./png.js";
import { testPng } from "./test-support/png.js";

describe("the market's PNG check", () => {
  it("reads the size from the IHDR", () => {
    expect(pngSize(testPng(1024, 1024))).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(testPng(768, 512))).toEqual({ width: 768, height: 512 });
  });

  it("refuses bytes that are not an intact PNG header", () => {
    expect(pngSize(Buffer.from("png bytes"))).toBeNull();
    const png = testPng(1024, 1024);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), png.subarray(4)]);
    expect(pngSize(jpeg)).toBeNull();
    const truncated = png.subarray(0, 30);
    expect(pngSize(truncated)).toBeNull();
    // A size edited after the fact no longer matches the chunk's CRC.
    const edited = Buffer.from(png);
    edited.writeUInt32BE(768, 16);
    expect(pngSize(edited)).toBeNull();
    expect(pngSize(testPng(0, 1024))).toBeNull();
  });
});
