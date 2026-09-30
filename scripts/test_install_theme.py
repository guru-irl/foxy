import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import install_theme  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / ".spider" / "scratch"
NOW = datetime(2026, 10, 1, 2, 3, 4)


class ThemeTestCase(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=SCRATCH, prefix="install-theme-test-")
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.firefox = self.root / "Firefox"
        self.firefox.mkdir()
        self.profile = self.firefox / "Profiles" / "abc.default-release"
        self.profile.mkdir(parents=True)
        self.repo = self.root / "repo"
        (self.repo / "theme").mkdir(parents=True)
        (self.repo / "extension" / "fonts").mkdir(parents=True)
        for name in ["userChrome.css", "userContent.css", "user.js"]:
            (self.repo / "theme" / name).write_text(f"new {name}\n")
        self.links = [
            (self.profile / "chrome" / "userChrome.css", self.repo / "theme" / "userChrome.css"),
            (self.profile / "chrome" / "userContent.css", self.repo / "theme" / "userContent.css"),
            (self.profile / "chrome" / "fonts", self.repo / "extension" / "fonts"),
            (self.profile / "user.js", self.repo / "theme" / "user.js"),
        ]

    def write_ini(self, text):
        (self.firefox / "profiles.ini").write_text(text)

    def assert_links(self, links=None):
        for source, target in self.links if links is None else links:
            self.assertTrue(source.is_symlink(), source)
            self.assertEqual(os.readlink(source), str(target))
            self.assertTrue(pathlib.Path(os.readlink(source)).is_absolute())

    def make_old_files(self):
        chrome = self.profile / "chrome"
        chrome.mkdir()
        (chrome / "userChrome.css").write_bytes(b"old chrome\r\n")
        (chrome / "userContent.css").write_bytes(b"old content\n")
        (chrome / "fonts").mkdir()
        (chrome / "fonts" / "old.ttf").write_bytes(b"old font")
        (self.profile / "user.js").write_bytes(b"old prefs\n")


class FindProfileTest(ThemeTestCase):
    def test_prefers_install_default_over_profile_default(self):
        self.write_ini(
            "[Profile0]\nDefault=1\nIsRelative=1\nPath=Profiles/other\n"
            "[InstallABC]\nDefault=Profiles/abc.default-release\nLocked=1\n"
        )
        self.assertEqual(install_theme.find_profile(self.firefox), self.profile)

    def test_install_default_can_be_absolute(self):
        self.write_ini(f"[InstallABC]\nDefault={self.profile}\n")
        self.assertEqual(install_theme.find_profile(self.firefox), self.profile)

    def test_profile_default_honours_absolute_path(self):
        absolute = self.root / "custom profile"
        absolute.mkdir()
        self.write_ini(
            "[Profile0]\nIsRelative=1\nPath=Profiles/not-default\n"
            f"[Profile1]\nDefault=1\nIsRelative=0\nPath={absolute}\n"
        )
        self.assertEqual(install_theme.find_profile(self.firefox), absolute)

    def test_profile_default_honours_relative_path(self):
        self.write_ini(
            "[Profile0]\nDefault=1\nIsRelative=1\nPath=Profiles/abc.default-release\n"
        )
        self.assertEqual(install_theme.find_profile(self.firefox), self.profile)

    def test_missing_profiles_ini_names_the_file(self):
        with self.assertRaises(SystemExit) as ctx:
            install_theme.find_profile(self.firefox)
        self.assertIn(str(self.firefox / "profiles.ini"), str(ctx.exception))

    def test_no_default_profile_reports_how_to_choose_one(self):
        self.write_ini("[Profile0]\nIsRelative=1\nPath=Profiles/abc.default-release\n")
        with self.assertRaises(SystemExit) as ctx:
            install_theme.find_profile(self.firefox)
        self.assertIn("--profile", str(ctx.exception))


class InstallTest(ThemeTestCase):
    def test_backs_up_files_and_fonts_then_makes_absolute_links(self):
        self.make_old_files()
        lines = install_theme.install(self.repo, self.profile, NOW)
        backup = self.profile / "chrome" / "backup-20261001-020304"
        self.assertEqual((backup / "userChrome.css").read_bytes(), b"old chrome\r\n")
        self.assertEqual((backup / "userContent.css").read_bytes(), b"old content\n")
        self.assertEqual((backup / "fonts" / "old.ttf").read_bytes(), b"old font")
        self.assertEqual((backup / "user.js").read_bytes(), b"old prefs\n")
        self.assertEqual(sorted(p.name for p in backup.iterdir()), [
            "fonts", "user.js", "userChrome.css", "userContent.css",
        ])
        self.assert_links()
        self.assertEqual(len(lines), 8)
        for source, target in self.links:
            self.assertEqual(sum(str(backup / source.name) in line for line in lines), 1)
            self.assertEqual(sum(str(target) in line for line in lines), 1)
        self.assertTrue(all(isinstance(line, str) and "\n" not in line for line in lines))

    def test_second_install_changes_nothing_and_creates_no_backup(self):
        self.make_old_files()
        install_theme.install(self.repo, self.profile, NOW)
        before = {source: source.lstat() for source, _ in self.links}
        backup = self.profile / "chrome" / "backup-20261001-020304"
        result = install_theme.install(self.repo, self.profile, datetime(2026, 10, 2))
        self.assertEqual(result, [])
        self.assert_links()
        self.assertEqual({source: source.lstat() for source, _ in self.links}, before)
        self.assertEqual(list((self.profile / "chrome").glob("backup-*")), [backup])

    def test_missing_chrome_is_created_without_backup(self):
        self.assertFalse((self.profile / "chrome").exists())
        lines = install_theme.install(self.repo, self.profile, NOW)
        self.assert_links()
        self.assertEqual(len(lines), 4)
        self.assertEqual(list((self.profile / "chrome").glob("backup-*")), [])

    def test_wrong_dangling_symlink_is_backed_up_as_a_symlink(self):
        (self.profile / "chrome").mkdir()
        source = self.profile / "chrome" / "userChrome.css"
        source.symlink_to("missing-old-theme.css")
        lines = install_theme.install(self.repo, self.profile, NOW)
        saved = self.profile / "chrome" / "backup-20261001-020304" / "userChrome.css"
        self.assertTrue(saved.is_symlink())
        self.assertEqual(os.readlink(saved), "missing-old-theme.css")
        self.assert_links()
        self.assertEqual(len(lines), 5)

    def test_correct_dangling_links_remain_unchanged(self):
        (self.repo / "extension" / "fonts").rmdir()
        install_theme.install(self.repo, self.profile, NOW)
        self.assertFalse((self.profile / "chrome" / "fonts").exists())
        before = (self.profile / "chrome" / "fonts").lstat()
        self.assertEqual(install_theme.install(self.repo, self.profile, NOW), [])
        self.assertEqual((self.profile / "chrome" / "fonts").lstat(), before)
        self.assert_links()
        self.assertEqual(list((self.profile / "chrome").glob("backup-*")), [])

    def test_existing_backup_is_never_overwritten(self):
        self.make_old_files()
        install_theme.install(self.repo, self.profile, NOW)
        first = self.profile / "chrome" / "backup-20261001-020304"
        source = self.profile / "chrome" / "userChrome.css"
        source.unlink()
        source.write_bytes(b"another version\n")
        lines = install_theme.install(self.repo, self.profile, NOW)
        self.assertEqual((first / "userChrome.css").read_bytes(), b"old chrome\r\n")
        backups = list((self.profile / "chrome").glob("backup-*"))
        self.assertEqual(len(backups), 2)
        second = next(p for p in backups if p != first)
        self.assertEqual((second / "userChrome.css").read_bytes(), b"another version\n")
        self.assertEqual(len(lines), 2)
        self.assert_links()

    def test_relative_repo_still_produces_absolute_targets(self):
        repo = pathlib.Path(os.path.relpath(self.repo))
        install_theme.install(repo, self.profile, NOW)
        self.assert_links()

    def test_missing_profile_is_rejected_without_creating_it(self):
        missing = self.firefox / "Profiles" / "does-not-exist"
        with self.assertRaises(SystemExit) as ctx:
            install_theme.install(self.repo, missing, NOW)
        self.assertIn(str(missing), str(ctx.exception))
        self.assertFalse(missing.exists())


class CliTest(ThemeTestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "install_theme.py"), *map(str, args)],
            cwd=self.root, text=True, capture_output=True,
        )

    def repo_links(self):
        return [
            (self.profile / "chrome" / "userChrome.css", ROOT / "theme" / "userChrome.css"),
            (self.profile / "chrome" / "userContent.css", ROOT / "theme" / "userContent.css"),
            (self.profile / "chrome" / "fonts", ROOT / "extension" / "fonts"),
            (self.profile / "user.js", ROOT / "theme" / "user.js"),
        ]

    def test_firefox_dir_selects_profile_and_prints_actions_and_restart(self):
        self.write_ini("[InstallABC]\nDefault=Profiles/abc.default-release\n")
        result = self.run_cli("--firefox-dir", self.firefox)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_links(self.repo_links())
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 5)
        self.assertEqual(lines[-1], "Restart Firefox (quit with Cmd+Q and reopen) to load the theme.")
        self.assertEqual(result.stderr, "")

    def test_profile_override_does_not_need_profiles_ini(self):
        result = self.run_cli("--profile", self.profile, "--firefox-dir", self.firefox)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_links(self.repo_links())


if __name__ == "__main__":
    unittest.main()
