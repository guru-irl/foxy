import importlib
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / ".spider" / "scratch"
SCRIPT = ROOT / "scripts" / "check_private.py"
sys.path.insert(0, str(SCRIPT.parent))
PATTERN = r"(?i)secretcorp"


class PrivateCheckTest(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=SCRATCH, prefix="private-check-test-")
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ,
                        GIT_AUTHOR_NAME="Test Author",
                        GIT_AUTHOR_EMAIL="author@example.invalid",
                        GIT_COMMITTER_NAME="Test Committer",
                        GIT_COMMITTER_EMAIL="committer@example.invalid")
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
            self.env.pop(key, None)
        self.git("init", "-b", "main")
        self.git("commit", "--allow-empty", "-m", "Initial commit")
        self.patterns = self.root / "patterns.txt"
        self.patterns.write_text(PATTERN + "\n", encoding="utf-8")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              text=True, capture_output=True, check=True).stdout.strip()

    def track(self, name, content):
        path = self.repo / name
        path.write_bytes(content)
        self.git("add", "--", name)
        return path

    def scan(self):
        scanner = importlib.import_module("check_private")
        return scanner.scan(self.repo, [re.compile(PATTERN)])

    def cli(self, *args, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              cwd=self.repo, env=self.env if env is None else env,
                              text=True, capture_output=True)

    def test_tracked_line_reports_path_line_and_pattern(self):
        self.track("tracked file.txt", b"safe\nSECRETCorp details\n")
        self.assertEqual(self.scan(), [f"tracked file.txt:2: {PATTERN}"])

    def test_untracked_file_is_ignored(self):
        (self.repo / "untracked.txt").write_text("secretcorp\n")
        self.assertEqual(self.scan(), [])

    def test_binary_file_with_nul_in_first_8000_bytes_is_skipped(self):
        self.track("image.bin", b"secretcorp" + b"x" * 7989 + b"\0")
        self.assertEqual(self.scan(), [])

    def test_nul_after_first_8000_bytes_does_not_skip_text(self):
        self.track("late-nul.txt", b"secretcorp" + b"x" * 7991 + b"\0")
        self.assertEqual(self.scan(), [f"late-nul.txt:1: {PATTERN}"])

    def test_commit_message_on_other_branch_is_scanned(self):
        self.git("checkout", "-b", "other")
        self.git("commit", "--allow-empty", "-m", "Safe subject\n\nSecretCorp body")
        sha = self.git("rev-parse", "--short", "HEAD")
        self.git("checkout", "main")
        self.assertEqual(self.scan(), [f"commit {sha}: {PATTERN}"])

    def test_local_and_remote_branch_names_are_scanned(self):
        self.git("branch", "secretcorp-local")
        self.git("update-ref", "refs/remotes/origin/secretcorp-remote", "HEAD")
        self.assertEqual(self.scan(), [
            f"branch secretcorp-local: {PATTERN}",
            f"branch origin/secretcorp-remote: {PATTERN}",
        ])

    def test_unusual_filename_is_not_git_quoted(self):
        self.track('quote"tab\t.txt', b"secretcorp\n")
        self.assertEqual(self.scan(), [f'quote"tab\t.txt:1: {PATTERN}'])

    def test_tracked_symlink_scans_link_text_not_external_target(self):
        outside = self.root / "outside.txt"
        outside.write_text("secretcorp\n")
        (self.repo / "link").symlink_to(outside)
        (self.repo / "dangling").symlink_to("secretcorp-missing")
        self.git("add", "link", "dangling")
        self.assertEqual(self.scan(), [f"dangling:1: {PATTERN}"])

    def test_missing_patterns_file_exits_two(self):
        result = self.cli("--patterns", self.root / "missing.txt")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("patterns", result.stderr.lower())

    def test_clean_repo_exits_zero_and_prints_clean(self):
        result = self.cli("--patterns", self.patterns)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "clean\n")
        self.assertEqual(result.stderr, "")

    def test_cli_hit_exits_one_without_disclosing_pattern_or_content(self):
        self.track("private.txt", b"secretcorp private content\n")
        result = self.cli("--patterns", self.patterns)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("private.txt:1:", result.stdout)
        self.assertNotIn("secretcorp", result.stdout + result.stderr)
        self.assertNotIn("private content", result.stdout + result.stderr)

    def test_blank_lines_and_comments_are_ignored(self):
        self.patterns.write_text("\n# ignored\n  # indented comment\n" + PATTERN + "\n")
        result = self.cli("--patterns", self.patterns)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "clean\n")

    def test_pattern_whitespace_is_preserved(self):
        self.patterns.write_text(" secretcorp \n")
        self.track("spaced.txt", b" secretcorp \n")
        result = self.cli("--patterns", self.patterns)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.track("spaced.txt", b"secretcorp\n")
        result = self.cli("--patterns", self.patterns)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "clean\n")

    def test_default_patterns_path_uses_home_config(self):
        home = self.root / "home"
        config = home / ".config" / "foxy"
        config.mkdir(parents=True)
        (config / "scan-patterns.txt").write_text(PATTERN + "\n")
        result = self.cli(env=dict(self.env, HOME=str(home)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "clean\n")

    def test_invalid_pattern_fails_without_disclosing_it(self):
        self.patterns.write_text("secretcorp[\n")
        result = self.cli("--patterns", self.patterns)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("secretcorp", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
