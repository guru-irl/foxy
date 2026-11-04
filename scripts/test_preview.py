import json
from pathlib import Path
import subprocess
import tempfile
import struct
import zlib
import unittest
from unittest.mock import patch

import preview
import preview_v40


class ScenarioTests(unittest.TestCase):
    def test_selects_v40_viewports_and_both_schemes(self):
        names = ["v40-2560-dark", "v40-mac-light", "v40-1024-dark", "v40-narrow-light"]
        with patch.object(preview, "build_page"), patch.object(preview, "ensure_profile"), \
                patch.object(preview, "shoot") as shoot:
            preview.main(names)
        self.assertEqual(shoot.call_args_list, [
            unittest.mock.call("v40-2560-dark", "scenario=v40&scheme=dark", 2560, 1440),
            unittest.mock.call("v40-mac-light", "scenario=v40&scheme=light", 1440, 945),
            unittest.mock.call("v40-1024-dark", "scenario=v40&scheme=dark", 1024, 768),
            unittest.mock.call("v40-narrow-light", "scenario=v40-narrow&scheme=light", 640, 1100),
        ])

    def test_selects_saved_and_banner_at_1600_by_1000(self):
        with patch.object(preview, "build_page"), patch.object(preview, "ensure_profile"), \
                patch.object(preview, "shoot") as shoot:
            preview.main(["saved", "banner"])
        self.assertEqual(shoot.call_args_list, [
            unittest.mock.call("saved", "scenario=saved", 1600, 1000),
            unittest.mock.call("banner", "scenario=banner", 1600, 1000),
        ])


class ReadmePreviewTests(unittest.TestCase):
    def test_creates_dark_and_light_images_at_1440_by_900(self):
        scratch = preview.ROOT / ".spider" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="readme-preview-", dir=scratch) as directory:
            root = Path(directory)
            out = root / "docs" / "images"

            def shoot(name, query, width, height):
                def chunk(kind, data):
                    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
                header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
                pixels = (b"\0" + b"\0" * width * 3) * height
                preview.OUT.mkdir(parents=True, exist_ok=True)
                (preview.OUT / f"{name}.png").write_bytes(
                    b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                    + chunk(b"IDAT", zlib.compress(pixels, 0)) + chunk(b"IEND", b""))

            with patch.object(preview, "ROOT", root), patch.object(preview, "OUT", out), \
                    patch.object(preview, "PAGE"), patch.object(preview, "build_page"), \
                    patch.object(preview, "ensure_profile"), patch.object(preview, "shoot", side_effect=shoot):
                preview_v40.main()
            self.assertTrue(out.is_dir(), "README images directory was not created")
            self.assertEqual(sorted(p.name for p in out.iterdir()), ["board-dark.png", "board-light.png"])
            for path in out.iterdir():
                data = path.read_bytes()
                self.assertEqual(struct.unpack(">II", data[16:24]), (1440, 900))
                self.assertLess(len(data), 400_000)
                offset, parts = 8, []
                while offset < len(data):
                    size = struct.unpack(">I", data[offset:offset + 4])[0]
                    kind = data[offset + 4:offset + 8]
                    if kind == b"IDAT":
                        parts.append(data[offset + 8:offset + 8 + size])
                    offset += size + 12
                self.assertEqual(zlib.decompress(b"".join(parts)), (b"\0" + b"\0" * 1440 * 3) * 900)


class IsolationTests(unittest.TestCase):
    def test_reused_profile_drops_persisted_scrollbar_overrides(self):
        scratch = preview.ROOT / ".spider" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="preview-reuse-", dir=scratch) as directory:
            profile = Path(directory)
            stored = profile / "prefs.js"
            stored.write_text('user_pref("ui.useOverlayScrollbars", 0);\n'
                              'user_pref("widget.macos.overlay-scrollbars", 0);\n'
                              'user_pref("browser.startup.page", 0);\n')
            with patch.object(preview, "PROFILE", profile):
                preview.ensure_profile()
            self.assertEqual(stored.read_text(), 'user_pref("browser.startup.page", 0);\n')

    def test_profile_blocks_external_traffic_and_screenshot_uses_scratch_temp(self):
        scratch = preview.ROOT / ".spider" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="preview-unit-", dir=scratch) as directory:
            profile, out = Path(directory) / "profile", Path(directory) / "out"
            with patch.object(preview, "PROFILE", profile), patch.object(preview, "OUT", out):
                preview.ensure_profile()
                prefs = {}
                for line in (profile / "user.js").read_text().splitlines():
                    if line.startswith("user_pref("):
                        key, value = json.loads("[" + line[len("user_pref("):-2] + "]")
                        prefs[key] = value
                self.assertIs(prefs.get("extensions.update.enabled"), False)
                self.assertEqual(prefs.get("network.proxy.type"), 1)
                self.assertEqual(prefs.get("network.proxy.ssl"), "127.0.0.1")
                self.assertIs(prefs.get("network.proxy.failover_direct"), False)
                self.assertIs(prefs["security.fileuri.strict_origin_policy"], False)
                self.assertNotIn("widget.macos.overlay-scrollbars", prefs)
                self.assertNotIn("ui.useOverlayScrollbars", prefs)

                def launch(args, **options):
                    for key in ("TMPDIR", "TMP", "TEMP"):
                        temp = Path(options.get("env", {}).get(key, "/volatile"))
                        self.assertTrue(temp.is_relative_to(scratch))
                        self.assertTrue(temp.is_dir())
                    self.assertIn('FOXY_AGENT_SOCK', options['env'])
                    sock = Path(options['env']['FOXY_AGENT_SOCK'])
                    self.assertTrue(sock.resolve().is_relative_to(profile))
                    self.assertLess(len(str(sock).encode()), 104)
                    self.assertIn("--no-remote", args)
                    self.assertEqual(args[args.index("-profile") + 1], str(profile))
                    (out / "saved.png").write_bytes(b"PNG")
                    return subprocess.CompletedProcess(args, 0, "", "")

                with patch.object(preview.subprocess, "run", side_effect=launch):
                    preview.shoot("saved", "scenario=saved", 1600, 1000)


if __name__ == "__main__":
    unittest.main()
