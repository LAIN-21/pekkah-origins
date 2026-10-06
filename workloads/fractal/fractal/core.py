"""Deterministic escape-time Mandelbrot in int64 fixed point.

Every value is an integer with F fractional bits, so the same params give bit-identical
iteration counts on any CPU (Intel, AMD, Apple Silicon). Nothing here uses floats.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from fractions import Fraction

import numpy as np

F = 28
ONE = 1 << F
FOUR = 4 << F
# Views keep |Re c| and |Im c| at or below this, which keeps |z| below 8 (2^31 in fixed point)
# before every squaring: products stay below 2^62 and never overflow int64.
C_LIMIT = 3 << F


@dataclass(frozen=True)
class View:
    center_re: str
    center_im: str
    span_re: str  # width of the real axis covered by the image


@dataclass(frozen=True)
class Preset:
    width: int
    height: int
    supersample: int
    max_iter: int


# Mirrors packages/protocol FRACTAL_PRESETS (starting values; PR-05 tunes them).
PRESETS: dict[str, Preset] = {
    "tiny": Preset(8, 8, 1, 1),
    "calib": Preset(640, 360, 1, 1500),
    "hd-fast": Preset(1280, 720, 2, 600),
    "hd-heavy": Preset(1920, 1080, 2, 1500),
}

VIEWS: dict[str, View] = {
    "tiny": View("-0.5", "0", "3"),
    "hd-fast": View("-0.7453", "0.1127", "0.0105"),
    "hd-heavy": View("0.2850", "0.0100", "0.0200"),
}

# Calibration challenge views: different regions, so one cached answer passes only one of
# them. They are public, so a dishonest worker could still precompute all 8: the answer check
# catches faulty workers, not cheating ones (PLAN 6.5). Each is 100M to 320M iterations, so
# the timed work dwarfs the container's fixed overhead.
CHALLENGES: list[View] = [
    View("-0.745", "0.113", "0.012"),
    View("0.285", "0.011", "0.020"),
    View("-0.1", "0.65", "0.3"),
    View("-1.25066", "0.02012", "0.0100"),
    View("-0.7453", "0.1127", "0.03"),
    View("0.25", "0.5", "0.4"),
    View("-1.31", "0.0", "0.3"),
    View("-1.7687", "0.0017", "0.0080"),
]

PALETTE_STOPS: dict[str, list[tuple[int, int, int]]] = {
    "ember": [(12, 4, 2), (120, 20, 8), (232, 92, 16), (255, 196, 64), (255, 246, 214), (120, 20, 8)],
    "ocean": [(4, 10, 32), (14, 52, 128), (32, 132, 214), (120, 220, 246), (236, 252, 255), (14, 52, 128)],
    "mint": [(4, 20, 16), (16, 92, 72), (53, 224, 161), (180, 250, 220), (246, 255, 250), (16, 92, 72)],
}


def to_fixed(decimal: str) -> int:
    """Exact decimal string to fixed point (floor), with no float in between."""
    return (Fraction(decimal) * ONE).__floor__()


def view_for(preset_name: str, challenge: int | None) -> View:
    if preset_name == "calib":
        if challenge is None or not 0 <= challenge < len(CHALLENGES):
            raise ValueError("calib needs a challenge 0..7")
        return CHALLENGES[challenge]
    return VIEWS[preset_name]


def sample_grid(view: View, preset: Preset) -> tuple[np.ndarray, np.ndarray, int]:
    """Real parts per sample column and imaginary parts per sample row, in fixed point."""
    cols = preset.width * preset.supersample
    rows = preset.height * preset.supersample
    step = to_fixed(view.span_re) // cols
    if step <= 0:
        raise ValueError("span too small for fixed point")
    left = to_fixed(view.center_re) - (cols * step) // 2 + step // 2
    top = to_fixed(view.center_im) + (rows * step) // 2 - step // 2
    re = left + np.arange(cols, dtype=np.int64) * step
    im = top - np.arange(rows, dtype=np.int64) * step
    for value in (int(re.min()), int(re.max()), int(im.min()), int(im.max())):
        if abs(value) > C_LIMIT:
            raise ValueError("view leaves the safe range |c| <= 3")
    return re, im, step


def iterate(cr: np.ndarray, ci: np.ndarray, max_iter: int) -> np.ndarray:
    """Iteration counts: updates of z = z^2 + c before |z|^2 > 4 (max_iter if never).

    The escape test runs before every update, so only points with |z| <= 2 are squared
    and updated, and |z| stays below 8 (see tests).
    """
    n = cr.size
    counts = np.full(n, max_iter, dtype=np.int64)
    idx = np.arange(n, dtype=np.int64)
    zr = np.zeros(n, dtype=np.int64)
    zi = np.zeros(n, dtype=np.int64)
    a_cr = cr.astype(np.int64, copy=True)
    a_ci = ci.astype(np.int64, copy=True)
    for k in range(max_iter):
        zr2 = (zr * zr) >> F
        zi2 = (zi * zi) >> F
        escaped = (zr2 + zi2) > FOUR
        if escaped.any():
            counts[idx[escaped]] = k
            keep = ~escaped
            idx, zr, zi, zr2, zi2, a_cr, a_ci = (
                idx[keep],
                zr[keep],
                zi[keep],
                zr2[keep],
                zi2[keep],
                a_cr[keep],
                a_ci[keep],
            )
            if idx.size == 0:
                break
        zi = ((zr * zi) >> (F - 1)) + a_ci
        zr = zr2 - zi2 + a_cr
    return counts


def render_rows(params: tuple[str, int | None, int, int]) -> tuple[int, np.ndarray, int]:
    """One tile: pixel rows [start, stop). Returns (start, averaged counts, iterations)."""
    preset_name, challenge, start, stop = params
    preset = PRESETS[preset_name]
    re, im, _ = sample_grid(view_for(preset_name, challenge), preset)
    s = preset.supersample
    rows = im[start * s : stop * s]
    cr = np.tile(re, rows.size)
    ci = np.repeat(rows, re.size)
    counts = iterate(cr, ci, preset.max_iter)
    total = int(counts.sum())
    block = counts.reshape(stop - start, s, preset.width, s).sum(axis=(1, 3)) // (s * s)
    return start, block.astype(np.uint16), total


def palette_lut(name: str) -> np.ndarray:
    """A cyclic 256-entry RGB table, interpolated in integers."""
    stops = PALETTE_STOPS[name]
    segments = len(stops) - 1
    lut = np.zeros((256, 3), dtype=np.uint8)
    for i in range(256):
        pos = i * segments
        seg, frac = divmod(pos, 256)
        a, b = stops[seg], stops[seg + 1]
        lut[i] = [(a[c] * (256 - frac) + b[c] * frac) // 256 for c in range(3)]
    return lut


def colorize(counts: np.ndarray, max_iter: int, palette: str) -> np.ndarray:
    lut = palette_lut(palette)
    rgb = lut[(counts.astype(np.int64) * 6) % 256]
    rgb[counts.astype(np.int64) >= max_iter] = (0, 0, 0)
    return rgb


def encode_png(rgb: np.ndarray) -> bytes:
    """A minimal PNG writer on CPython's zlib, so the bytes are identical on every CPU."""
    height, width, _ = rgb.shape
    raw = np.zeros((height, 1 + width * 3), dtype=np.uint8)
    raw[:, 1:] = rgb.reshape(height, width * 3)  # filter type 0 (None) on every row

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw.tobytes(), 6))
        + chunk(b"IEND", b"")
    )
