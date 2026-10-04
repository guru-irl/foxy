import ctypes
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_agent import HOST, SCRATCH, load, frame, read_frame


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.host = load(HOST)

    def test_tree_sums_descendants_not_unrelated_processes_or_helper(self):
        self.assertTrue(hasattr(self.host, 'measure_memory'), 'memory measurement exists')
        table = {10: (1, 100), 11: (10, 200), 12: (11, 300), 20: (10, 900),
                 21: (20, 800), 30: (1, 700)}
        with patch.object(self.host, 'mac_process_table', return_value=table), \
             patch.object(self.host, 'mac_footprint', side_effect=lambda pid: {10: 101, 11: 201, 12: 301}[pid]), \
             patch.object(self.host, 'mac_system_memory', return_value={'total': 4000, 'used': 2500}):
            reply = self.host.measure_memory(root_pid=10, host_pid=20, platform='darwin')
        self.assertEqual(reply, {'firefox': 603, 'processes': 3, 'system': {'total': 4000, 'used': 2500}})

    def test_mac_uses_rss_when_footprint_is_unavailable_for_a_process(self):
        self.assertTrue(hasattr(self.host, 'measure_memory'), 'memory measurement exists')
        with patch.object(self.host, 'mac_process_table', return_value={10: (1, 100), 11: (10, 200)}), \
             patch.object(self.host, 'mac_footprint', side_effect=[101, OSError('gone')]), \
             patch.object(self.host, 'mac_system_memory', return_value={'total': 1000, 'used': 500}):
            self.assertEqual(self.host.measure_memory(root_pid=10, host_pid=20, platform='darwin')['firefox'], 301)

    def test_mac_reads_physical_footprint_from_rusage_v2(self):
        self.assertTrue(hasattr(self.host, 'mac_footprint'), 'physical footprint reader exists')
        class Lib:
            def proc_pid_rusage(self, pid, flavor, pointer):
                self.args = (pid, flavor)
                # OS ABI: UUID (16 bytes), then seven uint64s before footprint.
                ctypes.cast(pointer, ctypes.POINTER(ctypes.c_uint64))[9] = 123456
                return 0
        lib = Lib()
        with patch.object(self.host.ctypes, 'CDLL', return_value=lib):
            self.assertEqual(self.host.mac_footprint(42), 123456)
        self.assertEqual(lib.args, (42, 2))

    def test_mac_ps_and_system_commands_use_argv_and_convert_pages_and_kib(self):
        self.assertTrue(hasattr(self.host, 'mac_process_table'), 'mac process reader exists')
        outputs = ['10 1 3\n11 10 7\n', '36000000000\n',
                   'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 100.\nPages wired down: 20.\nPages occupied by compressor: 30.\nPages free: 999.\n']
        with patch.object(self.host.subprocess, 'check_output', side_effect=outputs) as run:
            self.assertEqual(self.host.mac_process_table(), {10: (1, 3072), 11: (10, 7168)})
            self.assertEqual(self.host.mac_system_memory(), {'total': 36000000000, 'used': 2457600})
        for call in run.call_args_list:
            self.assertIsInstance(call.args[0], list)
            self.assertFalse(call.kwargs.get('shell', False))
            self.assertLessEqual(call.kwargs['timeout'], 1)

    def test_linux_reads_pss_else_rss_and_ignores_exited_or_unreadable_processes(self):
        self.assertTrue(hasattr(self.host, 'measure_memory'), 'memory measurement exists')
        with tempfile.TemporaryDirectory(prefix='memory-', dir=SCRATCH) as directory:
            proc = Path(directory)
            for pid, parent, rss, pss in [(10, 1, 100, 70), (11, 10, 200, None), (12, 11, 300, 50), (20, 10, 900, 900), (30, 1, 700, 700)]:
                entry = proc / str(pid); entry.mkdir()
                (entry / 'status').write_text(f'Name:\tFirefox\nPPid:\t{parent}\nVmRSS:\t{rss} kB\n')
                if pss is not None: (entry / 'smaps_rollup').write_text(f'Rss: {rss} kB\nPss: {pss} kB\n')
            (proc / '99').mkdir()
            (proc / 'meminfo').write_text('MemTotal: 1000 kB\nMemAvailable: 350 kB\nMemFree: 10 kB\n')
            paths = []
            original = self.host.proc_values
            def read_values(path):
                paths.append(path)
                return original(path)
            with patch.object(self.host, 'proc_values', side_effect=read_values):
                reply = self.host.measure_memory(root_pid=10, host_pid=20, platform='linux', proc=proc)
            self.assertNotIn(proc / '30' / 'smaps_rollup', paths, 'unrelated PSS is never read')
            self.assertNotIn(proc / '20' / 'smaps_rollup', paths, 'helper PSS is never read')
        self.assertEqual(reply, {'firefox': 327680, 'processes': 3, 'system': {'total': 1024000, 'used': 665600}})

    def test_missing_firefox_root_or_unsupported_platform_fails(self):
        self.assertTrue(hasattr(self.host, 'measure_memory'), 'memory measurement exists')
        with patch.object(self.host, 'mac_process_table', return_value={11: (10, 100)}):
            with self.assertRaises(ValueError): self.host.measure_memory(root_pid=10, host_pid=20, platform='darwin')
        with self.assertRaises(ValueError): self.host.measure_memory(platform='win32')

    def test_native_memory_request_replies_without_cli_relay_or_pending_id(self):
        host = self.host
        reader = io.BytesIO(frame({'type': 'memory', 'rid': 'r1'}))
        writer = io.BytesIO()
        relay = host.Relay(reader, writer, 1)
        self.assertTrue(hasattr(host, 'measure_memory'), 'memory measurement exists')
        with patch.object(host, 'measure_memory', return_value={'firefox': 100, 'processes': 2, 'system': {'total': 1000, 'used': 600}}):
            relay.read_replies()
        self.assertEqual(read_frame(io.BytesIO(writer.getvalue())), {'type': 'memory', 'rid': 'r1', 'firefox': 100, 'processes': 2, 'system': {'total': 1000, 'used': 600}})
        self.assertFalse(relay.failed)

    def test_measurement_error_replies_with_rid_and_does_not_break_following_request(self):
        host = self.host
        self.assertTrue(hasattr(host, 'measure_memory'), 'memory measurement exists')
        writer = io.BytesIO()
        relay = host.Relay(io.BytesIO(frame({'type': 'memory', 'rid': 'bad'}) + frame({'type': 'memory', 'rid': 'next'})), writer, 1)
        with patch.object(host, 'measure_memory', side_effect=[OSError('denied'), {'firefox': 100}]):
            relay.read_replies()
        replies = io.BytesIO(writer.getvalue())
        self.assertEqual(read_frame(replies), {'type': 'memory', 'rid': 'bad', 'error': 'denied'})
        self.assertEqual(read_frame(replies), {'type': 'memory', 'rid': 'next', 'firefox': 100})


if __name__ == '__main__':
    unittest.main()
