"""Pure-helper tests. No Firefox, network, or real user profile access."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import smoke_firefox as smoke


SCRATCH = Path(__file__).resolve().parent.parent / ".spider" / "scratch"


class FragmentedReader(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2) if size >= 0 else 2)


class FramingTests(unittest.TestCase):
    def test_encode_counts_utf8_bytes_not_characters(self):
        self.assertEqual(smoke.encode_message({"x": "📌"}),
                         b'12:{"x":"\xf0\x9f\x93\x8c"}')

    def test_decode_handles_partial_reads_and_leaves_next_frame(self):
        stream = FragmentedReader(b'12:{"x":"\xf0\x9f\x93\x8c"}4:null')
        self.assertEqual(smoke.decode_message(stream), {"x": "📌"})
        self.assertIsNone(smoke.decode_message(stream))

    def test_command_array_round_trip(self):
        message = [0, 9, "Addon:Install", {"path": "/local/extension", "temporary": True}]
        self.assertEqual(smoke.decode_message(io.BytesIO(smoke.encode_message(message))), message)

    def test_rejects_invalid_or_unbounded_prefix(self):
        for frame in (b':{}', b'-1:{}', b'1x:{}', b'0:', b'999999999999999999999:{}'):
            with self.subTest(frame=frame), self.assertRaises(ValueError):
                smoke.decode_message(io.BytesIO(frame))

    def test_truncated_frame_is_an_error(self):
        for frame in (b'', b'12', b'5:null'):
            with self.subTest(frame=frame), self.assertRaises(EOFError):
                smoke.decode_message(io.BytesIO(frame))

    def test_invalid_json_is_an_error(self):
        with self.assertRaises(ValueError):
            smoke.decode_message(io.BytesIO(b'3:bad'))


class ProfileTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="smoke-unit-", dir=SCRATCH)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_writes_parseable_prefs_to_throwaway_profile(self):
        profile = self.root / "profile"
        smoke.write_profile(profile, 28289)
        values = {}
        for line in (profile / "user.js").read_text().splitlines():
            if line.startswith("user_pref("):
                key, value = json.loads("[" + line[len("user_pref("):-2] + "]")
                values[key] = value
        self.assertEqual(values["marionette.port"], 28289)
        self.assertIs(values["browser.shell.checkDefaultBrowser"], False)
        self.assertIs(values["datareporting.policy.dataSubmissionEnabled"], False)
        self.assertIs(values["toolkit.telemetry.enabled"], False)
        self.assertEqual(values["browser.startup.homepage_override.mstone"], "ignore")
        self.assertEqual(values["extensions.autoDisableScopes"], 0)
        self.assertIs(values["browser.tabs.groups.enabled"], True)
        self.assertIs(values["toolkit.legacyUserProfileCustomizations.stylesheets"], False)
        # External requests, including add-on/signature updates, must not reach AMO.
        self.assertIs(values["extensions.update.enabled"], False)
        self.assertEqual(values["network.proxy.ssl"], "127.0.0.1")
        self.assertIs(values["network.proxy.failover_direct"], False)

    def test_invalid_port_does_not_create_profile(self):
        for port in (0, 65536, True, "2828"):
            profile = self.root / str(port)
            with self.subTest(port=port), self.assertRaises(ValueError):
                smoke.write_profile(profile, port)
            self.assertFalse(profile.exists())

    def test_refuses_real_firefox_root_and_descendants(self):
        home = self.root / "home"
        real = home / "Library" / "Application Support" / "Firefox"
        for profile in (real, real / "Profiles" / "default", real / ".." / "Firefox" / "x"):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                smoke.safe_profile_path(profile, home=home)
        self.assertFalse(home.exists())

    def test_refuses_symlink_into_real_profile(self):
        home = self.root / "home"
        real = home / "Library" / "Application Support" / "Firefox"
        alias = self.root / "alias"
        alias.symlink_to(real, target_is_directory=True)
        with self.assertRaises(ValueError):
            smoke.safe_profile_path(alias / "Profiles" / "default", home=home)
        self.assertFalse(home.exists())

    def test_accepts_resolved_scratch_profile(self):
        profile = self.root / "profile"
        self.assertEqual(smoke.safe_profile_path(profile), profile.resolve())

    def test_refuses_volatile_scratch_paths(self):
        for path in ("/tmp/smoke/profile", "/var/tmp/smoke/profile", "/private/tmp/smoke/profile"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                smoke.safe_profile_path(path)


class ResultTests(unittest.TestCase):
    def test_success_results_print_pass_and_exit_zero(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            results = smoke.Results()
            results.record("board", True, "PINNED, TABS")
            results.record("fonts", True)
        self.assertEqual(output.getvalue(), "PASS board: PINNED, TABS\nPASS fonts\n")
        self.assertEqual(results.exit_code, 0)

    def test_default_failure_stops_and_exit_is_one(self):
        with contextlib.redirect_stdout(io.StringIO()):
            results = smoke.Results()
            with self.assertRaises(smoke.CheckFailed):
                results.record("sync", False, "no Foxy root")
        self.assertEqual(results.exit_code, 1)

    def test_keep_going_preserves_failure_after_later_pass(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            results = smoke.Results(keep_going=True)
            results.record("sync", False, "no Foxy root")
            results.record("screenshot", True)
        self.assertEqual(results.exit_code, 1)
        self.assertEqual(output.getvalue(), "FAIL sync: no Foxy root\nPASS screenshot\n")

    def test_no_results_is_not_success(self):
        self.assertEqual(smoke.Results().exit_code, 1)


if __name__ == "__main__":
    unittest.main()
