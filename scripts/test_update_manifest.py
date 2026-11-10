import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / '.spider' / 'scratch' / 'release-tests'


class UpdateManifestTest(unittest.TestCase):
    def test_generates_deterministic_manifest_from_signed_xpi(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            work = pathlib.Path(directory)
            xpi = work / 'foxy-4.1.0.xpi'
            xpi.write_bytes(b'known signed XPI bytes')
            args = [sys.executable, str(ROOT / 'scripts/update_manifest.py'),
                    '4.1.0', str(xpi), 'https://addons.mozilla.org/firefox/downloads/file/123/foxy.xpi']
            for _ in range(2):
                result = subprocess.run(args, cwd=work, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = (work / 'updates.json').read_bytes()
                if _ == 0:
                    first = output
                self.assertEqual(output, first)
            self.assertEqual(json.loads(output), {'addons': {
                '{4408f971-7930-41ea-9f93-b01231e40861}': {'updates': [{
                    'version': '4.1.0',
                    'update_link': 'https://addons.mozilla.org/firefox/downloads/file/123/foxy.xpi',
                    'update_hash': 'sha256:' + hashlib.sha256(b'known signed XPI bytes').hexdigest(),
                }]}}})
            self.assertLess(output.index(b'"update_hash"'), output.index(b'"update_link"'))

    def test_refuses_non_https_links_without_writing_a_manifest(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            work = pathlib.Path(directory)
            xpi = work / 'input.xpi'
            xpi.write_bytes(b'zip')
            for url in ['http://example.com/x.xpi', 'file:///x.xpi', 'https:///x',
                        'https://user:password@example.com/x', 'https://example.com/\nheader']:
                with self.subTest(url=url):
                    result = subprocess.run([sys.executable, str(ROOT / 'scripts/update_manifest.py'),
                        '4.1.0', str(xpi), url], cwd=work, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((work / 'updates.json').exists())


if __name__ == '__main__':
    unittest.main()
