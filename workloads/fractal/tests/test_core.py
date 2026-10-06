import struct
import unittest
import zlib

import numpy as np

from fractal.core import (
    CHALLENGES,
    C_LIMIT,
    F,
    FOUR,
    PRESETS,
    VIEWS,
    colorize,
    encode_png,
    iterate,
    render_rows,
    sample_grid,
    to_fixed,
    view_for,
)


def iterate_tracking_magnitude(cr: np.ndarray, ci: np.ndarray, max_iter: int) -> int:
    """Same loop as iterate(), recording the largest |zr| or |zi| ever squared."""
    zr = np.zeros(cr.size, dtype=np.int64)
    zi = np.zeros(cr.size, dtype=np.int64)
    worst = 0
    for _ in range(max_iter):
        worst = max(worst, int(np.abs(zr).max(initial=0)), int(np.abs(zi).max(initial=0)))
        zr2 = (zr * zr) >> F
        zi2 = (zi * zi) >> F
        keep = (zr2 + zi2) <= FOUR
        zr, zi, zr2, zi2, cr, ci = zr[keep], zi[keep], zr2[keep], zi2[keep], cr[keep], ci[keep]
        if zr.size == 0:
            break
        zi = ((zr * zi) >> (F - 1)) + ci
        zr = zr2 - zi2 + cr
    return worst


class FixedPoint(unittest.TestCase):
    def test_magnitudes_stay_below_2_pow_31_before_squaring(self):
        rng = np.random.default_rng(7)
        cr = rng.integers(-C_LIMIT, C_LIMIT + 1, size=200_000, dtype=np.int64)
        ci = rng.integers(-C_LIMIT, C_LIMIT + 1, size=200_000, dtype=np.int64)
        # Include the corners, where |c| is largest.
        cr[:4] = [C_LIMIT, -C_LIMIT, C_LIMIT, -C_LIMIT]
        ci[:4] = [C_LIMIT, C_LIMIT, -C_LIMIT, -C_LIMIT]
        self.assertLess(iterate_tracking_magnitude(cr, ci, 300), 1 << 31)

    def test_known_points(self):
        c = np.array([0, to_fixed("2"), to_fixed("-2"), to_fixed("0.26")], dtype=np.int64)
        counts = iterate(c, np.zeros(4, dtype=np.int64), 100)
        self.assertEqual(counts[0], 100)  # 0 is in the set
        self.assertEqual(counts[1], 2)  # 0 -> 2 -> 6: |z|^2 = 36 > 4 after two updates
        self.assertEqual(counts[2], 100)  # -2 is in the set
        self.assertLess(counts[3], 100)  # 0.26 is just outside

    def test_counts_equal_iterations(self):
        re, im, _ = sample_grid(VIEWS["tiny"], PRESETS["tiny"])
        start, block, total = render_rows(("tiny", None, 0, 8))
        self.assertEqual(start, 0)
        self.assertEqual(block.shape, (8, 8))
        self.assertEqual(total, int(block.astype(np.int64).sum()))

    def test_every_view_stays_in_the_safe_range(self):
        for name in ("tiny", "hd-fast", "hd-heavy"):
            sample_grid(view_for(name, None), PRESETS[name])
        for challenge in range(len(CHALLENGES)):
            sample_grid(view_for("calib", challenge), PRESETS["calib"])

    def test_supersampling_averages_in_integers(self):
        start, block, total = render_rows(("hd-fast", None, 0, 1))
        self.assertEqual(block.shape, (1, PRESETS["hd-fast"].width))
        self.assertGreater(total, 0)

    def test_render_is_deterministic(self):
        a = render_rows(("calib", 3, 100, 102))
        b = render_rows(("calib", 3, 100, 102))
        self.assertTrue(np.array_equal(a[1], b[1]))
        self.assertEqual(a[2], b[2])


class Png(unittest.TestCase):
    def test_encodes_a_valid_png(self):
        counts = np.array([[0, 5], [10, 1500]], dtype=np.uint16)
        rgb = colorize(counts, 1500, "ember")
        self.assertEqual(tuple(rgb[1, 1]), (0, 0, 0))  # inside the set is black
        png = encode_png(rgb)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        length, kind = struct.unpack(">I4s", png[8:16])
        self.assertEqual((length, kind), (13, b"IHDR"))
        self.assertEqual(struct.unpack(">II", png[16:24]), (2, 2))
        idat_len = struct.unpack(">I", png[33:37])[0]
        raw = zlib.decompress(png[41 : 41 + idat_len])
        self.assertEqual(len(raw), 2 * (1 + 2 * 3))
        self.assertEqual(encode_png(rgb), png)


if __name__ == "__main__":
    unittest.main()
