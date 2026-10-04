import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import preview


class ScenarioTests(unittest.TestCase):
    def test_selects_grid_sizes_narrow_fit_and_both_settings_schemes(self):
        with patch.object(preview, "build_page"), patch.object(preview, "ensure_profile"), \
                patch.object(preview, "shoot") as shoot:
            preview.main(["grid-custom-80", "grid-custom-144", "grid-narrow", "settings-open", "settings-open-light"])
        self.assertEqual(shoot.call_args_list, [
            unittest.mock.call("grid-custom-80", "scenario=grid-custom-80", 1600, 1000),
            unittest.mock.call("grid-custom-144", "scenario=grid-custom-144", 1600, 1000),
            unittest.mock.call("grid-narrow", "scenario=grid-narrow", 700, 1000),
            unittest.mock.call("settings-open", "scenario=settings-open&settings=open", 1600, 1000),
            unittest.mock.call("settings-open-light", "scenario=settings-open&settings=open&scheme=light", 1600, 1000),
        ])

    def test_selects_saved_and_banner_at_1600_by_1000(self):
        with patch.object(preview, "build_page"), patch.object(preview, "ensure_profile"), \
                patch.object(preview, "shoot") as shoot:
            preview.main(["saved", "banner"])
        self.assertEqual(shoot.call_args_list, [
            unittest.mock.call("saved", "scenario=saved", 1600, 1000),
            unittest.mock.call("banner", "scenario=banner", 1600, 1000),
        ])


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
