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
FILES = ('extension/manifest.json', 'package.json', 'test/manifest.test.js', 'README.md')


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
        for name in FILES[:3]:
            path = self.repo / name
            path.write_text(path.read_text().replace(current, '4.0.0'))
        # The release tool must not depend on the wording after the version.
        readme = self.repo / 'README.md'
        text = readme.read_text()
        import re
        readme.write_text(re.sub(r'^Version \d+\.\d+\.\d+\.', 'Version 4.0.0. Different text stays.', text, count=1, flags=re.M))
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
        test = (self.repo / FILES[2]).read_text()
        self.assertIn('manifest.version, "4.1.0"', test)
        self.assertIn('pkg.version, "4.1.0"', test)
        self.assertIn('Version 4.1.0. Different text stays.', (self.repo / 'README.md').read_text())
        self.assertEqual(git(self.repo, 'log', '-1', '--format=%s'), 'Release 4.1.0')
        self.assertEqual(git(self.repo, 'cat-file', '-t', 'v4.1.0'), 'tag')
        self.assertEqual(git(self.repo, 'rev-list', '-n', '1', 'v4.1.0'), git(self.repo, 'rev-parse', 'HEAD'))
        self.assertEqual(git(self.repo, 'status', '--porcelain'), '')
        self.assertEqual(git(self.repo, 'remote'), original_remote)


if __name__ == '__main__':
    unittest.main()
