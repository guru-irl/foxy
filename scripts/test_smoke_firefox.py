"""Pure-helper tests. No Firefox, network, or real user profile access."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

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


class SmokeSequenceTests(unittest.TestCase):
    def test_second_navigation_waits_for_sync_root_plus_one_second(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        clock = [0.0]
        navigations, root_seen = [], []
        base = "moz-extension://smoke-test/"
        grouped = [False]

        def command(name, params):
            if name == "WebDriver:Navigate":
                navigations.append(clock[0])
            if name == "WebDriver:TakeScreenshot":
                return {"value": "iVBORw0KGgo="}

        def script(source, args=None, *, chrome=False):
            if source == smoke.BOARD_SCRIPT:
                return {"board": True, "fontsReady": True, "clock": True,
                        "columns": ["PINNED", "TABS", "SMOKE"], "url": base + "newtab.html"}
            if source == smoke.PLACES_SCRIPT:
                if clock[0] < 6:
                    return []
                if not root_seen:
                    root_seen.append(clock[0])
                children = [{"title": "📌 Pinned", "type": 2}]
                if grouped[0]:
                    children.append({"title": "🔵 Smoke", "type": 2, "urls": [smoke.SMOKE_URL]})
                return [{"guid": "root", "children": children}]
            if "document.fonts.load" in source:
                return {"sans": True, "mono": True, "loaded": ["Foxy Sans", "Foxy Mono"]}
            if "AboutNewTab" in source:
                return base + "newtab.html"
            if "browser.tabs.create" in source:
                grouped[0] = True
                return {"tabId": 1, "groupId": 1}
            self.fail(f"unexpected script: {source}")

        client = Mock(command=command, script=script)
        output = io.StringIO()
        with tempfile.TemporaryDirectory(prefix="smoke-sequence-", dir=SCRATCH) as directory, \
                patch.object(smoke.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(smoke.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                patch.object(smoke, "check_pin_names", return_value="isolated pin check", create=True), \
                patch.object(smoke, "check_named_inbound", return_value="lazy named pins verified", create=True), \
                contextlib.redirect_stdout(output):
            results = smoke.Results()
            smoke.run_checks(client, smoke.ROOT, Path(directory), results, base)
        self.assertEqual(results.exit_code, 0)
        self.assertIn("PASS named inbound pins", output.getvalue())
        self.assertEqual(len(navigations), 2)
        self.assertGreaterEqual(navigations[1], root_seen[0] + 1)

    def test_override_failure_records_nothing_after_first_fail(self):
        base = "moz-extension://smoke-test/"
        clock = [0.0]

        def script(source, args=None, *, chrome=False):
            if source == smoke.BOARD_SCRIPT:
                return {"board": True, "fontsReady": True, "clock": True,
                        "columns": ["PINNED", "TABS"], "url": base + "newtab.html"}
            if "document.fonts.load" in source:
                return {"sans": True, "mono": True, "loaded": ["Foxy Sans", "Foxy Mono"]}
            if "AboutNewTab" in source:
                raise RuntimeError("override unavailable")
            if source == smoke.PLACES_SCRIPT:
                return [{"guid": "root", "children": [{"title": "📌 Pinned", "type": 2}]}]
            self.fail(f"unexpected script: {source}")

        output = io.StringIO()
        with patch.object(smoke.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(smoke.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                contextlib.redirect_stdout(output):
            results = smoke.Results()
            with self.assertRaisesRegex(smoke.CheckFailed, "newtab override"):
                smoke.run_checks(Mock(script=script), smoke.ROOT, SCRATCH, results, base)
        self.assertEqual(results.outcomes, [True, True, False])
        self.assertEqual(output.getvalue().splitlines()[-1], "FAIL newtab override: override unavailable")

    def test_extension_console_errors_still_fail_the_smoke(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        client = Mock()
        client.script.return_value = [{"level": "ERROR", "message": "Promise rejected after context unloaded",
                                      "source": "moz-extension://smoke-test/newtab.html", "line": 1}]
        with tempfile.TemporaryDirectory(prefix="smoke-console-", dir=SCRATCH) as directory, \
                contextlib.redirect_stdout(io.StringIO()):
            results = smoke.Results()
            with self.assertRaises(smoke.CheckFailed):
                smoke.check_console(client, "moz-extension://smoke-test/", Path(directory), results)
        self.assertEqual(results.exit_code, 1)


class PinNameTests(unittest.TestCase):
    def test_named_inbound_probe_checks_pin_discard_title_and_position(self):
        valid = [{"pinned": True, "discarded": True, "title": "Smoke later", "index": 1},
                 {"pinned": True, "discarded": True, "title": "Smoke first", "index": 0}]
        client = Mock()
        client.script.return_value = ["later-bookmark", "first-bookmark"]
        with patch.object(smoke, "poll", return_value=valid):
            self.assertIn("discarded", smoke.check_named_inbound(client))
        for field, value in [("pinned", False), ("discarded", False), ("title", "Wrong"), ("index", 0)]:
            wrong = [{**valid[0], field: value}, valid[1]]
            with self.subTest(field=field), patch.object(smoke, "poll", return_value=wrong):
                with self.assertRaises(RuntimeError):
                    smoke.check_named_inbound(client)

    def test_pin_names_require_tab_document_and_bookmark_titles_to_match(self):
        state = {"tabTitle": "Smoke pin", "documentTitle": "Smoke pin", "bookmarkTitle": "✏️ Smoke pin"}
        self.assertTrue(smoke.pin_name_matches(state, "Smoke pin", "✏️ Smoke pin"))
        for field in state:
            with self.subTest(field=field):
                self.assertFalse(smoke.pin_name_matches({**state, field: "Wrong"}, "Smoke pin", "✏️ Smoke pin"))
        self.assertFalse(smoke.pin_name_matches({}, "Smoke pin", "✏️ Smoke pin"))


class CleanupTests(unittest.TestCase):
    def test_permission_error_on_term_still_reaps_parent(self):
        process = Mock(pid=987654321)
        with patch.object(smoke.os, "killpg", side_effect=PermissionError) as killpg:
            smoke.quit_firefox(None, process)
        killpg.assert_called_once_with(process.pid, smoke.signal.SIGTERM)
        self.assertEqual(process.wait.call_count, 2)

    def test_permission_error_on_kill_still_reaps_parent(self):
        process = Mock(pid=987654321)
        process.wait.side_effect = [smoke.subprocess.TimeoutExpired("firefox", 5),
                                    smoke.subprocess.TimeoutExpired("firefox", 5), None]
        with patch.object(smoke.os, "killpg", side_effect=[None, PermissionError]) as killpg:
            smoke.quit_firefox(None, process)
        self.assertEqual(killpg.call_args_list, [
            unittest.mock.call(process.pid, smoke.signal.SIGTERM),
            unittest.mock.call(process.pid, smoke.signal.SIGKILL),
        ])
        self.assertEqual(process.wait.call_count, 3)


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
