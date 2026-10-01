#!/usr/bin/env python3
"""Explicit real-Firefox runner regressions; never discovered by npm test.

Run: python3 test/browser/check_runner.py
Deliberate failure fixtures are .js (not *.test.js), so default discovery stays green.
"""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import browser_test  # noqa: E402


class BrowserRunnerTest(unittest.TestCase):
    def invoke(self, name, *, root=ROOT, timeout=8):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = browser_test.run(root, [name], timeout=timeout)
        text = output.getvalue()
        print(text, end="")
        return code, text

    def test_event_errors_rejections_and_import_errors_are_reported(self):
        code, text = self.invoke("/test/browser/fixtures/errors.js")
        self.assertEqual(code, 1, text)
        self.assertIn("✗ throwing drag handler: Error: drag handler exploded", text)
        self.assertIn("✗ rejecting async handler: Error: async handler exploded", text)
        self.assertIn("✓ tests continue after handler errors", text)
        self.assertIn("import rejection exploded", text)
        self.assertIn("1 passed, 3 failed", text)

    def test_errors_after_tests_are_separate_failures(self):
        code, text = self.invoke("/test/browser/fixtures/after-run.js")
        self.assertEqual(code, 1, text)
        self.assertIn("✓ schedules an error after its completion", text)
        self.assertIn("✗ uncaught error outside a test: Error: after run exploded", text)
        self.assertIn("1 passed, 1 failed", text)

    def test_timeouts_continue_with_default_and_override(self):
        code, text = self.invoke("/test/browser/fixtures/timeouts.js")
        self.assertEqual(code, 1, text)
        self.assertIn("✗ overridden hanging test: Error: timed out after 30 ms", text)
        self.assertIn("✗ default hanging test: Error: timed out after 5000 ms", text)
        self.assertIn("✓ tests continue after timeouts", text)
        self.assertIn("1 passed, 2 failed", text)

    def test_runner_timeout_names_last_test_started_by_the_page(self):
        code, text = self.invoke("/test/browser/fixtures/runner-timeout.js", timeout=6)
        self.assertEqual(code, 2, text)
        self.assertIn("last test started: last started browser test", text)
        self.assertIn("Foxy: Firefox log:", text)

    def test_empty_selected_module_fails(self):
        code, text = self.invoke("/test/browser/fixtures/empty.js")
        self.assertEqual(code, 1, text)
        self.assertIn("no tests registered", text)

    def test_classic_fallback_reports_broken_module_graph(self):
        scratch = ROOT / ".spider" / "scratch" / "task-1-r1"
        scratch.mkdir(parents=True, exist_ok=True)
        for mode in ("missing harness", "syntax error in harness", "syntax error in inline module"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=scratch) as directory:
                root = Path(directory)
                tests = root / "test" / "browser"
                tests.mkdir(parents=True)
                page = (ROOT / "test" / "browser" / "run.html").read_text()
                if mode == "syntax error in inline module":
                    page = page.replace('import { test, runTests }', 'import { !!! }')
                    (tests / "harness.js").write_text((ROOT / "test" / "browser" / "harness.js").read_text())
                elif mode == "syntax error in harness":
                    (tests / "harness.js").write_text("export const invalid = ;")
                (tests / "run.html").write_text(page)
                (tests / "empty.js").write_text("export const empty = true;")
                code, text = self.invoke("/test/browser/empty.js", root=root)
                self.assertEqual(code, 1, text)
                self.assertIn("browser module startup", text)
                self.assertNotIn("timed out", text)


if __name__ == "__main__":
    unittest.main()
