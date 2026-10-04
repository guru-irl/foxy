import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_agent import SCRATCH, ROOT
import smoke_agent


class SmokeMemoryTests(unittest.TestCase):
    def test_smoke_registers_only_a_worktree_host_in_throwaway_manifest_directories(self):
        self.assertTrue(hasattr(smoke_agent, 'register_smoke_host'), 'isolated native registration exists')
        calls = []
        class Client:
            def script(self, code, args, *, chrome=False):
                calls.append((code, args, chrome))
        with tempfile.TemporaryDirectory(prefix='memory-smoke-unit-', dir=SCRATCH) as directory:
            scratch = Path(directory)
            for platform in ['darwin', 'linux']:
                with patch('install_agent.sys.platform', platform):
                    smoke_agent.register_smoke_host(ROOT, scratch, Client())
                slug = 'NativeMessagingHosts' if platform == 'darwin' else 'native-messaging-hosts'
                manifests = list(scratch.rglob(slug + '/foxy_agent.json'))
                self.assertEqual(len(manifests), 1)
                manifest = json.loads(manifests[0].read_text())
                self.assertEqual(manifest['path'], str(ROOT / 'agent/foxy_host.py'))
                self.assertEqual(manifest['allowed_extensions'], [smoke_agent.ADDON_ID])
                self.assertEqual(calls[-1][1], [str(manifests[0].parent.parent)])
                self.assertTrue(calls[-1][2])
                self.assertIn('XREUserNativeManifests', calls[-1][0])
                self.assertIn('XRESysNativeManifests', calls[-1][0])
