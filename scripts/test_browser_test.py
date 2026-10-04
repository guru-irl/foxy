import contextlib
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import browser_test  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / ".spider" / "scratch" / "test-browser-test"


class ResultsTest(unittest.TestCase):
    def test_profile_disables_geolocation(self):
        self.assertIn('user_pref("geo.enabled", false);', browser_test.PROFILE_PREFS.splitlines())

    def test_formats_passes_and_failures_in_order(self):
        self.assertEqual(
            browser_test.parse_results(
                b'{"results":[{"name":"a","ok":true},{"name":"b","ok":false,"error":"x"}]}'
            ),
            (1, 1, ["✓ a", "✗ b: x"]),
        )

    def test_exit_status_distinguishes_failures_and_timeout(self):
        self.assertEqual(browser_test.exit_code(passed=3, failed=0, timed_out=False), 0)
        self.assertEqual(browser_test.exit_code(3, 1, False), 1)
        self.assertEqual(browser_test.exit_code(0, 0, True), 2)


class DiscoveryTest(unittest.TestCase):
    def test_discovers_only_browser_test_modules_as_sorted_url_paths(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = pathlib.Path(directory)
            tests = root / "test" / "browser"
            tests.mkdir(parents=True)
            for name in ["z.test.js", "a.test.js", "harness.js", "run.html"]:
                (tests / name).write_text("")
            nested = tests / "nested"
            nested.mkdir()
            (nested / "ignored.test.js").write_text("")
            self.assertEqual(
                browser_test.test_files(root),
                ["/test/browser/a.test.js", "/test/browser/z.test.js"],
            )


class ArgumentsTest(unittest.TestCase):
    def test_absolute_file_outside_worktree_is_rejected_without_launching(self):
        output = io.StringIO()
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGHUP)}
        with contextlib.redirect_stdout(output):
            code = browser_test.main(
                [str(ROOT.parent / "other-worktree" / "outside.test.js")],
                firefox=SCRATCH / "never-real-firefox",
            )
        self.assertEqual(code, 2)
        self.assertIn("Foxy: test file is outside the worktree", output.getvalue())
        for sig, handler in previous.items():
            self.assertEqual(signal.getsignal(sig), handler)


class CleanupTest(unittest.TestCase):
    def test_permission_error_for_zombie_group_still_reaps_parent(self):
        process = Mock(pid=987654321)
        with patch.object(browser_test.os, "killpg", side_effect=PermissionError) as killpg:
            browser_test.terminate_firefox(process)
        self.assertEqual(killpg.call_args_list, [
            unittest.mock.call(process.pid, signal.SIGTERM),
            unittest.mock.call(process.pid, signal.SIGKILL),
        ])
        self.assertEqual(process.wait.call_args_list, [
            unittest.mock.call(timeout=5), unittest.mock.call(),
        ])


class RunnerTest(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        tests = self.root / "test" / "browser"
        tests.mkdir(parents=True)
        (tests / "smoke.test.js").write_text("export const smoke = true;")
        (tests / "run.html").write_text("<!doctype html>")

    def launcher(self, post_results=True, ok=True, payload=None, early_exit=False, progress=False):
        path = self.root / "firefox-test-double"
        path.write_text(f'''#!{sys.executable}
import json, os, pathlib, signal, subprocess, sys, urllib.error, urllib.request
from urllib.parse import urlsplit
root = pathlib.Path(__file__).parent
child = subprocess.Popen([sys.executable, "-c", "import signal; signal.pause()"])
def stop(*args):
    child.wait(timeout=3)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
url = sys.argv[-1]
parts = urlsplit(url)
base = f"{{parts.scheme}}://{{parts.netloc}}"
with urllib.request.urlopen(base + "/test/browser/smoke.test.js") as response:
    mime = response.headers.get_content_type()
(root / "launch.json").write_text(json.dumps({{
    "args": sys.argv[1:], "tmpdir": os.environ["TMPDIR"],
    "agent_sock": os.environ.get("FOXY_AGENT_SOCK"),
    "agent_resolved": str(pathlib.Path(os.environ.get("FOXY_AGENT_SOCK", "missing")).resolve()),
    "pid": os.getpid(), "child": child.pid, "mime": mime,
}}))
print("stand-in Firefox diagnostic", flush=True)
if {progress!r}:
    try:
        urllib.request.urlopen(urllib.request.Request(base + "/progress", data=b'{{"name":"stuck test"}}')).close()
    except urllib.error.HTTPError:
        pass
if {post_results!r}:
    payload = {payload!r}
    if payload is None:
        payload = json.dumps({{"results": [{{"name": "module served", "ok": {ok!r}, "error": "broken"}}]}}).encode()
    try:
        urllib.request.urlopen(urllib.request.Request(base + "/results", data=payload, headers={{"Content-Type": "application/json"}})).close()
    except urllib.error.HTTPError:
        pass
if {early_exit!r}:
    child.terminate()
    child.wait()
    sys.exit(7)
signal.pause()
''')
        path.chmod(0o700)
        return path

    def invoke(self, firefox, timeout=5):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = browser_test.run(
                self.root, ["/test/browser/smoke.test.js"], firefox=firefox, timeout=timeout
            )
        return code, output.getvalue()

    def assert_processes_stopped(self, launch):
        for key in ["pid", "child"]:
            with self.assertRaises(ProcessLookupError):
                os.kill(launch[key], 0)

    def test_serves_modules_posts_results_and_stops_the_process_group(self):
        code, output = self.invoke(self.launcher())
        self.assertEqual(code, 0)
        self.assertIn("✓ module served\n1 passed, 0 failed", output)
        launch = json.loads((self.root / "launch.json").read_text())
        self.assertEqual(launch["mime"], "text/javascript")
        self.assertEqual(launch["args"][:3], ["--headless", "--no-remote", "-profile"])
        profile = pathlib.Path(launch["args"][3])
        scratch = self.root / ".spider" / "scratch"
        self.assertTrue(profile.is_relative_to(scratch))
        self.assertTrue(pathlib.Path(launch["tmpdir"]).is_relative_to(scratch))
        self.assertIsNotNone(launch['agent_sock'])
        self.assertTrue(pathlib.Path(launch['agent_resolved']).is_relative_to(profile.parent))
        self.assertLess(len(launch['agent_sock'].encode()), 104)
        self.assertIn("/test/browser/run.html?files=", launch["args"][-1])
        self.assert_processes_stopped(launch)

    def test_a_failed_browser_test_exits_one(self):
        code, output = self.invoke(self.launcher(ok=False))
        self.assertEqual(code, 1)
        self.assertIn("✗ module served: broken\n0 passed, 1 failed", output)
        self.assert_processes_stopped(json.loads((self.root / "launch.json").read_text()))

    def test_timeout_exits_two_and_stops_children(self):
        code, output = self.invoke(self.launcher(post_results=False), timeout=3)
        self.assertEqual(code, 2)
        self.assertIn("Foxy: browser tests timed out", output)
        self.assert_processes_stopped(json.loads((self.root / "launch.json").read_text()))

    def test_invalid_results_fail_fast_with_validation_reason(self):
        started = time.monotonic()
        code, output = self.invoke(self.launcher(payload=b'{"results":"wrong"}'), timeout=3)
        self.assertEqual(code, 2)
        self.assertIn("expected a results array", output)
        self.assertLess(time.monotonic() - started, 2.5)
        self.assert_processes_stopped(json.loads((self.root / "launch.json").read_text()))

    def test_early_browser_exit_fails_fast(self):
        started = time.monotonic()
        code, output = self.invoke(self.launcher(post_results=False, early_exit=True), timeout=3)
        self.assertEqual(code, 2)
        self.assertIn("Firefox exited before reporting results (exit 7)", output)
        self.assertLess(time.monotonic() - started, 2.5)

    def test_empty_results_are_a_failure(self):
        code, output = self.invoke(self.launcher(payload=b'{"results":[]}'))
        self.assertEqual(code, 1)
        self.assertIn("no tests registered", output)

    def test_timeout_names_last_started_test_and_preserves_log(self):
        code, output = self.invoke(self.launcher(post_results=False, progress=True), timeout=3)
        self.assertEqual(code, 2)
        self.assertIn("last test started: stuck test", output)
        log_line = next((line for line in output.splitlines() if line.startswith("Foxy: Firefox log: ")), None)
        self.assertIsNotNone(log_line, output)
        log = pathlib.Path(log_line.removeprefix("Foxy: Firefox log: "))
        self.assertTrue(log.is_relative_to(self.root / ".spider" / "scratch"))
        self.assertIn("stand-in Firefox diagnostic", log.read_text())

    def test_sigterm_and_sighup_clean_up_firefox_and_restore_handlers(self):
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sig):
                launcher = self.launcher(post_results=False)
                wrapper = (
                    f"import sys, functools; sys.path.insert(0, {str(ROOT / 'scripts')!r}); "
                    "import browser_test; "
                    f"browser_test.ROOT = browser_test.Path({str(self.root)!r}); "
                    "browser_test.run = functools.partial(browser_test.run, timeout=30); "
                    f"raise SystemExit(browser_test.main(['test/browser/smoke.test.js'], firefox={str(launcher)!r}))"
                )
                launched = self.root / "launch.json"
                launched.unlink(missing_ok=True)
                runner = subprocess.Popen([sys.executable, "-c", wrapper], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                launch = None
                try:
                    deadline = time.monotonic() + 5
                    while not launched.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(launched.exists(), "stand-in did not start")
                    launch = json.loads(launched.read_text())
                    runner.send_signal(sig)
                    stdout, stderr = runner.communicate(timeout=8)
                    self.assertEqual(runner.returncode, 128 + sig, (stdout, stderr))
                    self.assert_processes_stopped(launch)
                    self.assertEqual(list((self.root / ".spider" / "scratch").glob("browser-test-*/")), [])
                finally:
                    if runner.poll() is None:
                        runner.kill()
                    runner.communicate()
                    # RED runs lack the signal handlers, so explicitly stop their orphan group.
                    if launch:
                        try:
                            os.killpg(launch["pid"], signal.SIGTERM)
                        except ProcessLookupError:
                            pass

    def test_launch_error_exits_two(self):
        code, output = self.invoke(self.root / "does-not-exist")
        self.assertEqual(code, 2)
        self.assertIn("Foxy: could not launch Firefox", output)
        log_line = next((line for line in output.splitlines() if line.startswith("Foxy: Firefox log: ")), None)
        self.assertIsNotNone(log_line, output)
        self.assertTrue(pathlib.Path(log_line.removeprefix("Foxy: Firefox log: ")).exists())


if __name__ == "__main__":
    unittest.main()
