import hashlib
import json
from pathlib import Path
from unittest.mock import patch
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = ROOT / '.spider/scratch/tests'


class SourceArchiveTest(unittest.TestCase):
    def test_archive_uses_tagged_tracked_files_only(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='source-', dir=SCRATCH) as directory:
            repo = Path(directory)
            (repo / 'scripts').mkdir()
            source_script = ROOT / 'scripts/source_archive.py'
            self.assertTrue(source_script.is_file(), 'source archive command is missing')
            (repo / 'scripts/source_archive.py').write_bytes(source_script.read_bytes())
            (repo / 'extension').mkdir()
            (repo / 'extension/manifest.json').write_text(json.dumps({'version': '2.3.4'}))
            (repo / 'docs/amo').mkdir(parents=True)
            (repo / 'docs/amo/BUILD.md').write_text('build instructions')
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            def git(*args):
                return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True)
            git('add', 'extension', 'docs', 'scripts')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
            git('tag', 'v2.3.4')
            (repo / 'docs/amo/BUILD.md').write_text('dirty change')
            (repo / 'untracked').write_text('not in archive')
            result = subprocess.run([sys.executable, str(repo / 'scripts/source_archive.py'), 'v2.3.4'],
                                    cwd=repo, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            archive = repo / 'dist/foxy-2.3.4-source.zip'
            with zipfile.ZipFile(archive) as zf:
                self.assertEqual(zf.read('docs/amo/BUILD.md'), b'build instructions')
                self.assertNotIn('untracked', zf.namelist())
            git('tag', 'v9.9.9')
            wrong = subprocess.run([sys.executable, str(repo / 'scripts/source_archive.py'), 'v9.9.9'],
                                   cwd=repo, capture_output=True, text=True)
            self.assertNotEqual(wrong.returncode, 0)
            self.assertFalse((repo / 'dist/foxy-9.9.9-source.zip').exists())

    def test_build_from_tagged_source_archive_matches_original(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='archive fixture ', dir=SCRATCH) as directory:
            root = Path(directory)
            repo, unpacked = root / 'repo', root / 'unpacked'
            repo.mkdir()
            shutil.copytree(ROOT / 'extension', repo / 'extension')
            (repo / 'scripts').mkdir()
            for name in ('build.py', 'source_archive.py'):
                shutil.copyfile(ROOT / 'scripts' / name, repo / 'scripts' / name)
            (repo / 'docs/amo').mkdir(parents=True)
            shutil.copyfile(ROOT / 'docs/amo/BUILD.md', repo / 'docs/amo/BUILD.md')
            for name in ('package.json', 'package-lock.json', 'vite.config.js'):
                shutil.copyfile(ROOT / name, repo / name)
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            def git(*args):
                subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
            git('add', '.')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
            version = json.loads((repo / 'extension/manifest.json').read_text())['version']
            tag = 'v' + version
            git('tag', tag)
            subprocess.run([sys.executable, str(repo / 'scripts/source_archive.py'), tag],
                           cwd=repo, check=True, capture_output=True)
            with zipfile.ZipFile(repo / f'dist/foxy-{version}-source.zip') as archive:
                archive.extractall(unpacked)
            (unpacked / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            subprocess.run([sys.executable, str(unpacked / 'scripts/build.py')],
                           cwd=unpacked, check=True, capture_output=True)
            rebuilt = (unpacked / f'dist/foxy-{version}.zip').read_bytes()
            (repo / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            real_build = build.build
            def scratch_build(*args, **kwargs):
                project = Path(kwargs.get('root', ROOT))
                self.assertTrue(project.is_relative_to(SCRATCH), 'build must not touch the developer tree')
                return real_build(*args, **kwargs)
            with patch.object(build, 'build', side_effect=scratch_build):
                original = build.build(root=repo, out_dir=root / 'original').read_bytes()
            self.assertEqual(hashlib.sha256(rebuilt).hexdigest(), hashlib.sha256(original).hexdigest())


if __name__ == '__main__':
    unittest.main()
