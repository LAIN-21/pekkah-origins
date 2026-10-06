"""python -m fractal '<params json>'

Writes /out/result.png, or /out/result.bin (uint16 little-endian iteration counts) for
format "raw". Prints `PROGRESS <0..1>` per tile and `RESULT iterations=<n>` at the end.
"""

from __future__ import annotations

import json
import math
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

from .core import PRESETS, colorize, encode_png, render_rows

PALETTES = {"ember", "ocean", "mint"}
FORMATS = {"png", "raw"}


def parse(argv: list[str]) -> dict:
    if len(argv) != 2:
        raise SystemExit("usage: python -m fractal '<params json>'")
    params = json.loads(argv[1])
    if not isinstance(params, dict):
        raise SystemExit("params must be a JSON object")
    unknown = set(params) - {"preset", "challenge", "palette", "format"}
    if unknown:
        raise SystemExit(f"unknown params: {sorted(unknown)}")
    preset = params.get("preset")
    if preset not in PRESETS:
        raise SystemExit("preset must be one of tiny, calib, hd-fast, hd-heavy")
    challenge = params.get("challenge")
    if preset == "calib":
        if not isinstance(challenge, int) or not 0 <= challenge <= 7:
            raise SystemExit("calib needs a challenge 0..7")
    elif challenge is not None:
        raise SystemExit("challenge is calib only")
    palette = params.get("palette", "ember")
    fmt = params.get("format", "png")
    if palette not in PALETTES or fmt not in FORMATS:
        raise SystemExit("bad palette or format")
    return {"preset": preset, "challenge": challenge, "palette": palette, "format": fmt}


def main() -> int:
    params = parse(sys.argv)
    preset = PRESETS[params["preset"]]
    # os.cpu_count() inside a container reports the host's CPUs, not the --cpus quota.
    workers = max(1, math.floor(float(os.environ.get("WORKERS", "1"))))
    out = Path(os.environ.get("OUT_DIR", "/out"))

    tile_rows = max(1, math.ceil(preset.height / 64))
    tiles = [
        (params["preset"], params["challenge"], start, min(start + tile_rows, preset.height))
        for start in range(0, preset.height, tile_rows)
    ]
    counts = np.zeros((preset.height, preset.width), dtype=np.uint16)
    total = 0
    done = 0
    with Pool(processes=min(workers, len(tiles))) as pool:
        for start, block, iterations in pool.imap_unordered(render_rows, tiles):
            counts[start : start + block.shape[0]] = block
            total += iterations
            done += 1
            print(f"PROGRESS {done / len(tiles):.3f}", flush=True)

    if params["format"] == "raw":
        (out / "result.bin").write_bytes(counts.astype("<u2").tobytes())
    else:
        rgb = colorize(counts, preset.max_iter, params["palette"])
        (out / "result.png").write_bytes(encode_png(rgb))
    print(f"RESULT iterations={total}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
