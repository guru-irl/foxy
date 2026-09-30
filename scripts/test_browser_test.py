import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import browser_test  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / ".spider" / "scratch" / "test-browser-test"


class ResultsTest(unittest.TestCase):
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

    def launcher(self, post_results=True, ok=True):
        path = self.root / "firefox-test-double"
        path.write_text(f'''#!{sys.executable}
import json, os, pathlib, signal, subprocess, sys, urllib.request
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
    "pid": os.getpid(), "child": child.pid, "mime": mime,
}}))
if {post_results!r}:
    payload = json.dumps({{"results": [{{"name": "module served", "ok": {ok!r}, "error": "broken"}}]}}).encode()
    urllib.request.urlopen(urllib.request.Request(base + "/results", data=payload, headers={{"Content-Type": "application/json"}})).close()
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
        self.assertIn("/test/browser/run.html?files=", launch["args"][-1])
        self.assert_processes_stopped(launch)

    def test_a_failed_browser_test_exits_one(self):
        code, output = self.invoke(self.launcher(ok=False))
        self.assertEqual(code, 1)
        self.assertIn("✗ module served: broken\n0 passed, 1 failed", output)
        self.assert_processes_stopped(json.loads((self.root / "launch.json").read_text()))

    def test_timeout_exits_two_and_stops_children(self):
        code, output = self.invoke(self.launcher(post_results=False), timeout=1)
        self.assertEqual(code, 2)
        self.assertIn("Foxy: browser tests timed out", output)
        self.assert_processes_stopped(json.loads((self.root / "launch.json").read_text()))

    def test_launch_error_exits_two(self):
        code, output = self.invoke(self.root / "does-not-exist")
        self.assertEqual(code, 2)
        self.assertIn("Foxy: could not launch Firefox", output)


if __name__ == "__main__":
    unittest.main()
