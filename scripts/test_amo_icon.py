from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent


class AmoIconTest(unittest.TestCase):
    def setUp(self):
        import amo_icon
        import amo_listing
        self.icon = amo_icon
        self.pixels = amo_listing.png_pixels

    def test_committed_icon_is_the_current_logo_render(self):
        self.assertEqual((ROOT / 'docs/amo/icon.png').read_bytes(), self.icon.render(),
                         'Run: python3 scripts/amo_icon.py')

    def test_icon_is_128_square_with_transparent_corners_and_logo_colours(self):
        width, height, rows = self.decode(self.icon.render())
        self.assertEqual((width, height), (128, 128))
        self.assertEqual(rows[0][0][3], 0)
        self.assertEqual(rows[127][127][3], 0)
        # Just inside the rounded corners: bottom left is purple, top right is gold.
        self.assertClose(rows[110][18][:3], (0x90, 0x43, 0xDF), 40)
        self.assertClose(rows[18][110][:3], (0xFF, 0xC2, 0x43), 40)
        self.assertEqual(rows[110][18][3], 255)
        self.assertEqual(rows[64][64][3], 255)

    def decode(self, data):
        width, height, raw = self.pixels(data)
        rows = [[tuple(raw[(y * width + x) * 4:(y * width + x) * 4 + 4]) for x in range(width)]
                for y in range(height)]
        return width, height, rows

    def assertClose(self, actual, expected, tolerance):
        for a, e in zip(actual, expected):
            self.assertLessEqual(abs(a - e), tolerance, (actual, expected))


if __name__ == '__main__':
    unittest.main()
