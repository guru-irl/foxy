import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from firefox_env import firefox_environment

SCRATCH = Path(__file__).resolve().parent.parent / '.spider/scratch'


class FirefoxEnvironmentTests(unittest.TestCase):
    def test_long_run_paths_and_parallel_runs_bind_distinct_scratch_sockets(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='env-', dir=SCRATCH) as directory:
            runs = [Path(directory) / ('long-run-' + 'x' * 60 + str(i)) for i in range(2)]
            with patch.dict(os.environ, {'FOXY_AGENT_SOCK': '/never-use/agent.sock'}), \
                    firefox_environment(runs[0]) as first, firefox_environment(runs[1]) as second:
                self.assertNotEqual(first['FOXY_AGENT_SOCK'], second['FOXY_AGENT_SOCK'])
                for run, env in zip(runs, (first, second)):
                    path = Path(env['FOXY_AGENT_SOCK'])
                    self.assertTrue(path.resolve().is_relative_to(run))
                    self.assertLess(len(str(path).encode()), 104)
                    self.assertEqual(env['TMPDIR'], str(run / 'tmp'))
                    self.assertTrue(Path(env['TMPDIR']).is_dir())
                    with socket.socket(socket.AF_UNIX) as sock:
                        sock.bind(str(path))
                    self.assertTrue((run / 's').exists())
            # Only aliases go away. The run's own data remains for diagnostics.
            self.assertFalse(Path(first['FOXY_AGENT_SOCK']).parent.exists())
            self.assertTrue((runs[0] / 's').exists())

    def test_non_scratch_path_is_refused(self):
        with self.assertRaises(ValueError):
            with firefox_environment(Path.home() / 'not-scratch'):
                self.fail('non-scratch environment was accepted')

    def test_disposable_runs_allow_marionette_system_access(self):
        # Firefox 159 refuses chrome-context Marionette without this, and every
        # harness that drives a throwaway profile needs it.
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='env-', dir=SCRATCH) as directory:
            with firefox_environment(Path(directory) / 'run') as env:
                self.assertEqual(env['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'], '1')


    def test_every_firefox_launcher_uses_the_scratch_environment(self):
        scripts = Path(__file__).resolve().parent
        launchers = [path for path in sorted(scripts.glob('*.py'))
                     if not path.name.startswith('test_') and "--headless" in path.read_text()]
        self.assertTrue(launchers)
        for path in launchers:
            with self.subTest(path.name):
                self.assertIn('firefox_environment(', path.read_text())


if __name__ == '__main__':
    unittest.main()
