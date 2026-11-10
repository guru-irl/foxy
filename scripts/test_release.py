import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / '.spider' / 'scratch' / 'release-tests'
FILES = ('extension/manifest.json', 'package.json', 'test/manifest.test.js', 'package-lock.json', 'README.md')


def git(root, *args):
    return subprocess.run(['git', *args], cwd=root, text=True, capture_output=True, check=True).stdout.strip()


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.work = pathlib.Path(self.temp.name)
        self.repo = self.work / 'repo'
        self.repo.mkdir()
        for name in (*FILES, 'scripts/release.py'):
            dest = self.repo / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if name == 'scripts/release.py' and not (ROOT / name).exists():
                continue
            shutil.copyfile(ROOT / name, dest)
        # Use a fixed old version so these tests also pass during a real version bump.
        current = json.loads((self.repo / FILES[0]).read_text())['version']
        for name in FILES[:4]:
            path = self.repo / name
            path.write_text(path.read_text().replace(current, '4.0.0'))
        git(self.repo, 'init', '-q')
        git(self.repo, 'config', 'user.name', 'Test User')
        git(self.repo, 'config', 'user.email', 'test@example.com')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'Initial')
        self.bin = self.work / 'bin'
        self.bin.mkdir()
        npm = self.bin / 'npm'
        npm.write_text('#!/bin/sh\necho "$*" >> "$RELEASE_TEST_NPM_LOG"\nexit "${RELEASE_TEST_NPM_EXIT:-0}"\n')
        npm.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                    'RELEASE_TEST_NPM_LOG': str(self.work / 'npm.log'), 'TMPDIR': str(self.work)}

    def run_release(self, version):
        return subprocess.run([sys.executable, str(self.repo / 'scripts/release.py'), version], cwd=self.repo,
                              env=self.env, text=True, capture_output=True)

    def assert_refused(self, version, phrase):
        before = git(self.repo, 'rev-parse', 'HEAD')
        result = self.run_release(version)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(phrase, (result.stdout + result.stderr).lower())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), before)
        self.assertFalse((self.work / 'npm.log').exists())

    def test_releases_current_repo_files_without_changing_readme(self):
        repo = self.work / 'current-repo'
        repo.mkdir()
        names = git(ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0')
        for name in filter(None, names):
            source, dest = ROOT / name, repo / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                dest.symlink_to(os.readlink(source))
            else:
                shutil.copy2(source, dest)
        readme = (repo / 'README.md').read_bytes()
        current = json.loads((repo / FILES[0]).read_text())['version']
        major, minor, patch = map(int, current.split('.'))
        version = f'{major}.{minor}.{patch + 1}'
        git(repo, 'init', '-q')
        git(repo, 'config', 'user.name', 'Test User')
        git(repo, 'config', 'user.email', 'test@example.com')
        git(repo, 'add', '.')
        git(repo, 'commit', '-qm', 'Initial')
        result = subprocess.run([sys.executable, str(repo / 'scripts/release.py'), version],
                                cwd=repo, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((repo / 'README.md').read_bytes(), readme)
        self.assertEqual(set(git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').splitlines()),
                         set(FILES[:4]))
        self.assertEqual(json.loads((repo / FILES[0]).read_text())['version'], version)
        self.assertEqual(git(repo, 'cat-file', '-t', f'v{version}'), 'tag')
        self.assertEqual((self.work / 'npm.log').read_text(), 'test\n')

    def test_refuses_dirty_tree(self):
        (self.repo / 'untracked').write_text('dirty')
        self.assert_refused('4.1.0', 'dirty')

    def test_refuses_version_not_higher(self):
        for version in ('4.0.0', '3.99.99'):
            with self.subTest(version=version):
                self.assert_refused(version, 'higher')

    def test_refuses_version_lower_than_an_existing_release_tag(self):
        git(self.repo, 'tag', 'v5.0.0')
        self.assert_refused('4.1.0', 'higher')

    def test_ignores_non_release_tags_when_comparing_versions(self):
        git(self.repo, 'tag', 'v99.0.0-rc1')
        result = self.run_release('4.1.0')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_refuses_existing_tag(self):
        git(self.repo, 'tag', 'v4.1.0')
        self.assert_refused('4.1.0', 'tag')

    def test_refuses_bad_version(self):
        for version in ('4.1', 'v4.1.0', '4.1.0-rc1', '04.1.0'):
            with self.subTest(version=version):
                self.assert_refused(version, 'version')

    def test_failed_tests_do_not_commit_or_tag(self):
        self.env['RELEASE_TEST_NPM_EXIT'] = '1'
        before = git(self.repo, 'rev-parse', 'HEAD')
        result = self.run_release('4.1.0')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), before)
        self.assertEqual(git(self.repo, 'tag', '--list'), '')

    def test_updates_version_tests_commits_and_tags_without_pushing(self):
        original_remote = git(self.repo, 'remote')
        result = self.run_release('4.1.0')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.work / 'npm.log').read_text(), 'test\n')
        self.assertEqual(json.loads((self.repo / FILES[0]).read_text())['version'], '4.1.0')
        self.assertEqual(json.loads((self.repo / FILES[1]).read_text())['version'], '4.1.0')
        lock = json.loads((self.repo / 'package-lock.json').read_text())
        self.assertEqual(lock['version'], '4.1.0')
        self.assertEqual(lock['packages']['']['version'], '4.1.0')
        test = (self.repo / FILES[2]).read_text()
        self.assertIn('manifest.version, "4.1.0"', test)
        self.assertIn('pkg.version, "4.1.0"', test)
        self.assertEqual((self.repo / 'README.md').read_text(), (ROOT / 'README.md').read_text())
        self.assertEqual(git(self.repo, 'log', '-1', '--format=%s'), 'Release 4.1.0')
        self.assertEqual(git(self.repo, 'cat-file', '-t', 'v4.1.0'), 'tag')
        self.assertEqual(git(self.repo, 'rev-list', '-n', '1', 'v4.1.0'), git(self.repo, 'rev-parse', 'HEAD'))
        self.assertEqual(git(self.repo, 'status', '--porcelain'), '')
        self.assertEqual(git(self.repo, 'remote'), original_remote)


if __name__ == '__main__':
    unittest.main()
