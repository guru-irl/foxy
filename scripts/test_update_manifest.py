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
                    '4.1.0', 'v4.1.0', str(xpi), 'guru-irl/foxy']
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
                    'update_link': 'https://github.com/guru-irl/foxy/releases/download/v4.1.0/foxy-4.1.0.xpi',
                    'update_hash': 'sha256:' + hashlib.sha256(b'known signed XPI bytes').hexdigest(),
                }]}}})
            self.assertLess(output.index(b'"update_hash"'), output.index(b'"update_link"'))


if __name__ == '__main__':
    unittest.main()
