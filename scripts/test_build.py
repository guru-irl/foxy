import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = ROOT / '.spider' / 'scratch' / 'tests'


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.scripts.append(dict(attrs))


class BuildIsolationTest(unittest.TestCase):
    def test_build_test_setup_uses_a_scratch_project_root(self):
        with patch.object(build, 'build', return_value=Path('fixture.zip')) as run:
            try:
                BuildTest.setUpClass()
                root = Path(run.call_args.kwargs.get('root', ROOT))
                self.assertNotEqual(root, ROOT)
                self.assertTrue(root.is_relative_to(SCRATCH))
            finally:
                BuildTest.tearDownClass()


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        cls.directory = tempfile.TemporaryDirectory(prefix='build-', dir=SCRATCH)
        cls.root = Path(cls.directory.name)
        (cls.root / 'extension').symlink_to(ROOT / 'extension', target_is_directory=True)
        (cls.root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        shutil.copyfile(ROOT / 'vite.config.js', cls.root / 'vite.config.js')
        cls.out_dir = cls.root / 'dist'
        cls.archive = build.build(root=cls.root, out_dir=cls.out_dir)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_build_packages_bundles_and_unchanged_assets(self):
        with zipfile.ZipFile(self.archive) as zf:
            names = set(zf.namelist())
            self.assertTrue({'manifest.json', 'newtab.html', 'options.html', 'newtab.css',
                             'newtab.js', 'options.js', 'background.js',
                             'fonts/GoogleSansFlex-OFL.txt', 'icons/globe.svg'} <= names)
            self.assertFalse(any(name.startswith('src/') or name.endswith('.map') for name in names))
            for page, module in [('newtab.html', 'newtab.js'), ('options.html', 'options.js')]:
                scripts = Scripts()
                scripts.feed(zf.read(page).decode())
                self.assertEqual(len(scripts.scripts), 1)
                self.assertEqual(scripts.scripts[0].get('type'), 'module')
                self.assertEqual(scripts.scripts[0].get('src', '').removeprefix('./'), module)
            self.assertEqual(zf.read('manifest.json'), (ROOT / 'extension/manifest.json').read_bytes())
            for path in (ROOT / 'extension/fonts').iterdir():
                if path.is_file():
                    self.assertEqual(zf.read('fonts/' + path.name), path.read_bytes())
            for path in (ROOT / 'extension/icons').iterdir():
                if path.is_file():
                    self.assertEqual(zf.read('icons/' + path.name), path.read_bytes())
            self.assertLess(len(zf.read('newtab.css')), (ROOT / 'extension/newtab.css').stat().st_size)
            built = self.root / 'build/extension'
            self.assertEqual(names, {p.relative_to(built).as_posix() for p in built.rglob('*') if p.is_file()})
            for name in names:
                self.assertEqual(zf.read(name), (built / name).read_bytes())

    def test_zip_is_reproducible(self):
        first = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        second = hashlib.sha256(build.build(root=self.root, out_dir=self.out_dir).read_bytes()).hexdigest()
        self.assertEqual(first, second)

    def test_smoke_build_is_created_when_missing_or_stale(self):
        self.assertTrue(callable(getattr(build, 'ensure_built', None)), 'smoke build helper is missing')
        with tempfile.TemporaryDirectory(prefix='freshness-', dir=SCRATCH) as directory:
            root = Path(directory)
            sources = [root / 'extension/src/main.js', root / 'scripts/build.py',
                       root / 'vite.config.js', root / 'package.json', root / 'package-lock.json',
                       root / 'node_modules/vite/package.json']
            outputs = [root / 'build/extension' / name for name in
                       ('manifest.json', 'newtab.html', 'options.html', 'newtab.js',
                        'options.js', 'background.js', 'newtab.css', 'chunks/shared.js')]
            for path in sources + outputs:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            marker = root / 'build/.built'
            def run_build(root):
                marker.write_text(json.dumps([path.relative_to(root / 'build/extension').as_posix() for path in outputs]))
            with patch.object(build, 'build', side_effect=run_build) as run:
                self.assertEqual(build.ensure_built(root), root / 'build/extension')
                self.assertEqual(run.call_count, 1)
                for path in sources:
                    os.utime(path, ns=(1_000_000_000, 1_000_000_000))
                # Directories are inputs too, so deletion or creation marks a build stale.
                for path in [root / 'extension', root / 'extension/src']:
                    os.utime(path, ns=(1_000_000_000, 1_000_000_000))
                marker.touch()
                build.ensure_built(root)
                self.assertEqual(run.call_count, 1)
                for index, path in enumerate(sources):
                    marker.touch()
                    ns = marker.stat().st_mtime_ns + 2_000_000_000
                    os.utime(path, ns=(ns, ns))
                    build.ensure_built(root)
                    self.assertEqual(run.call_count, 2 + index, str(path))
                    os.utime(path, ns=(1_000_000_000, 1_000_000_000))
                outputs[-1].unlink()
                build.ensure_built(root)
                self.assertEqual(run.call_count, 2 + len(sources))

    def test_missing_dependencies_explain_how_to_install(self):
        with tempfile.TemporaryDirectory(prefix='missing-', dir=SCRATCH) as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/build.py', root / 'scripts/build.py')
            result = subprocess.run([sys.executable, str(root / 'scripts/build.py')],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Run `npm ci` first', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
