import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = ROOT / '.spider' / 'scratch'
SCRATCH.mkdir(parents=True, exist_ok=True)
HOST = ROOT / 'agent' / 'foxy_host.py'
CLI = ROOT / 'agent' / 'foxy'
INSTALLER = ROOT / 'scripts' / 'install_agent.py'


def load(path):
    spec = importlib.util.spec_from_file_location('agent_test_module', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def frame(message):
    body = json.dumps(message, ensure_ascii=False).encode()
    return struct.pack('<I', len(body)) + body


def read_frame(stream):
    prefix = stream.read(4)
    if len(prefix) != 4:
        raise EOFError('No native frame')
    return json.loads(stream.read(struct.unpack('<I', prefix)[0]))


def wait_for(predicate, timeout=3):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('Condition not reached')


class HostTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(HOST.exists(), 'native messaging host exists')
        self.directory = tempfile.TemporaryDirectory(prefix='a-', dir=SCRATCH)
        self.addCleanup(self.directory.cleanup)
        self.sock_path = Path(self.directory.name) / 's'
        self.processes = []
        self.addCleanup(self.close_processes)

    def close_processes(self):
        for process in self.processes:
            if not process.stdin.closed:
                process.stdin.close()
            process.wait(timeout=3)
            process.stdout.close()
            process.stderr.close()

    def start(self, timeout=None):
        args = [str(HOST)] if timeout is None else ['python3', '-c',
            f"import sys; sys.path.insert(0,{str(HOST.parent)!r}); import foxy_host; sys.exit(foxy_host.run(reply_timeout={timeout}))"]
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, 'FOXY_AGENT_SOCK': str(self.sock_path), 'TMPDIR': self.directory.name})
        self.processes.append(process)
        return process

    def client(self, request):
        sock = socket.socket(socket.AF_UNIX)
        sock.settimeout(3)
        sock.connect(str(self.sock_path))
        sock.sendall(json.dumps(request).encode() + b'\n')
        self.addCleanup(sock.close)
        return sock

    def test_native_utf8_fragmented_framing_and_truncated_frames(self):
        host = load(HOST)
        class Fragmented(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))
        self.assertEqual(host.read_message(Fragmented(frame({'title': '🟢 café'}))), {'title':'🟢 café'})
        stream = io.BytesIO()
        host.write_message(stream, {'ok':True, 'title':'café'})
        self.assertEqual(read_frame(io.BytesIO(stream.getvalue())), {'ok':True,'title':'café'})
        self.assertIsNone(host.read_message(io.BytesIO()))
        for data in [b'\x01', struct.pack('<I',10)+b'{}', struct.pack('<I',0), struct.pack('<I',2**31)]:
            with self.assertRaises((EOFError,ValueError)):
                host.read_message(io.BytesIO(data))

    def test_relay_correlates_concurrent_clients_and_secures_socket(self):
        process = self.start()
        wait_for(self.sock_path.exists)
        self.assertEqual(stat.S_IMODE(self.sock_path.parent.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE(self.sock_path.stat().st_mode),0o600)
        first = self.client({'command':'groups'})
        request1 = read_frame(process.stdout)
        second = self.client({'command':'tabs','group':'Work'})
        request2 = read_frame(process.stdout)
        self.assertEqual(request1['command'],'groups')
        self.assertEqual(request2['group'],'Work')
        self.assertNotEqual(request1['id'],request2['id'])
        process.stdin.write(frame({'id':request2['id'],'ok':False,'error':'No group'}))
        process.stdin.write(frame({'id':request1['id'],'ok':True,'open':[]}))
        process.stdin.flush()
        self.assertEqual(json.loads(first.makefile('rb').readline()),{'ok':True,'open':[]})
        self.assertEqual(json.loads(second.makefile('rb').readline()),{'ok':False,'error':'No group'})
        process.stdin.close()
        self.assertEqual(process.wait(timeout=3),0)
        self.assertFalse(self.sock_path.exists())

    def test_replaces_stale_socket_but_not_a_live_host(self):
        with socket.socket(socket.AF_UNIX) as stale:
            stale.bind(str(self.sock_path))
        first = self.start()
        wait_for(lambda: self.sock_path.exists() and stat.S_IMODE(self.sock_path.stat().st_mode)==0o600)
        duplicate = self.start()
        self.assertEqual(duplicate.wait(timeout=3),1)
        self.assertTrue(self.sock_path.exists())
        client = self.client({'command':'groups'})
        request=read_frame(first.stdout)
        first.stdin.write(frame({'id':request['id'],'ok':True})); first.stdin.flush()
        self.assertTrue(json.loads(client.makefile('rb').readline())['ok'])

    def test_does_not_unlink_an_unrelated_live_socket_or_regular_file(self):
        with socket.socket(socket.AF_UNIX) as other:
            other.bind(str(self.sock_path)); other.listen()
            inode=self.sock_path.stat().st_ino
            process=self.start()
            self.assertEqual(process.wait(timeout=3),1)
            self.assertEqual(self.sock_path.stat().st_ino,inode)
        self.sock_path.unlink()
        self.sock_path.write_text('keep')
        process=self.start()
        self.assertEqual(process.wait(timeout=3),1)
        self.assertEqual(self.sock_path.read_text(),'keep')

    def test_timeout_and_firefox_pipe_eof_release_waiting_clients(self):
        process=self.start(timeout=.1)
        wait_for(self.sock_path.exists)
        client=self.client({'command':'groups'})
        read_frame(process.stdout)
        reply=json.loads(client.makefile('rb').readline())
        self.assertEqual(reply['ok'],False)
        self.assertTrue(reply['unreachable'])
        second=self.client({'command':'groups'})
        read_frame(process.stdout)
        process.stdin.close()
        reply=json.loads(second.makefile('rb').readline())
        self.assertTrue(reply['unreachable'])
        self.assertEqual(process.wait(timeout=3),0)
        self.assertFalse(self.sock_path.exists())

    def test_malformed_socket_request_refused_without_native_write(self):
        process=self.start()
        wait_for(self.sock_path.exists)
        sock=socket.socket(socket.AF_UNIX); self.addCleanup(sock.close)
        sock.settimeout(3); sock.connect(str(self.sock_path)); sock.sendall(b'[]\n')
        reply=json.loads(sock.makefile('rb').readline())
        self.assertFalse(reply['ok'])
        self.assertIn('object',reply['error'])


class CliTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(CLI.exists(),'executable agent CLI exists')
        self.directory=tempfile.TemporaryDirectory(prefix='c-',dir=SCRATCH)
        self.addCleanup(self.directory.cleanup)
        self.path=Path(self.directory.name)/'s'
        self.env={**os.environ,'FOXY_AGENT_SOCK':str(self.path),'TMPDIR':self.directory.name}

    def invoke(self,args,reply=None):
        requests=[]
        if reply is not None:
            listener=socket.socket(socket.AF_UNIX)
            listener.bind(str(self.path)); listener.listen(); listener.settimeout(3)
            def serve():
                with listener:
                    connection,_=listener.accept()
                    with connection:
                        requests.append(json.loads(connection.makefile('rb').readline()))
                        connection.sendall(json.dumps(reply).encode()+b'\n')
            worker=threading.Thread(target=serve)
            worker.start()
        result=subprocess.run([str(CLI),*args],capture_output=True,text=True,env=self.env,timeout=3)
        if reply is not None:
            worker.join(3); self.path.unlink()
        return result,requests

    def test_every_command_json_and_request_flags(self):
        examples=[(['groups','--json'],{'command':'groups'}),
          (['tabs','Work','--json'],{'command':'tabs','group':'Work'}),
          (['add','Work','https://example.com/','--create','--color','red','--json'],
           {'command':'add','group':'Work','urls':['https://example.com/'],'create':True,'color':'red'}),
          (['new','New','https://example.com/','--json'],{'command':'new','title':'New','urls':['https://example.com/']})]
        for args,want in examples:
            result,requests=self.invoke(args,{'ok':True,'added':1})
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout),{'ok':True,'added':1})
            self.assertEqual(requests,[want])

    def test_refusal_is_exit_one_with_message_in_text_and_json(self):
        for json_flag in [[],['--json']]:
            result,_=self.invoke(['add','Missing','https://example.com/',*json_flag],{'ok':False,'error':'No group. Groups: Work'})
            self.assertEqual(result.returncode,1)
            self.assertIn('No group',result.stdout+result.stderr)
            if json_flag:
                self.assertEqual(json.loads(result.stdout)['ok'],False)

    def test_unreachable_and_host_timeout_are_exit_two(self):
        result,_=self.invoke(['groups','--json'])
        self.assertEqual(result.returncode,2)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertIn('Foxy',result.stdout)
        result,_=self.invoke(['groups'],{'ok':False,'unreachable':True,'error':'Timed out'})
        self.assertEqual(result.returncode,2)

    def test_human_groups_and_tabs_are_readable(self):
        result,_=self.invoke(['groups'],{'ok':True,'windowId':2,'open':[{'title':'Work','color':'red','windowId':2,'collapsed':True,'count':3,'lastFocused':True}],
            'saved':[{'title':'Later','color':'green','count':2}]})
        self.assertEqual(result.returncode,0)
        for text in ['Work','red','window 2','collapsed','3','Later','saved','2']:
            self.assertIn(text,result.stdout)
        result,_=self.invoke(['tabs','Work'],{'ok':True,'tabs':[{'title':'Page','url':'https://example.com/'}]})
        self.assertIn('Page',result.stdout)
        self.assertIn('https://example.com/',result.stdout)

    def test_usage_errors_are_refused_not_unreachable(self):
        result,_=self.invoke(['add','Work'])
        self.assertEqual(result.returncode,1)


class BackgroundLifecycleTests(unittest.TestCase):
    def test_background_module_load_does_not_keep_node_alive_without_native_host(self):
        result = subprocess.run(['node', '--input-type=module', '-e', """
            import { createFirefox } from './test/fakes/firefox.js';
            globalThis.browser = createFirefox().browser;
            await import('./extension/background.js');
            console.log('background loaded');
        """], cwd=ROOT, capture_output=True, text=True, timeout=5,
            env={**os.environ, 'TMPDIR': str(SCRATCH)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('background loaded', result.stdout)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(INSTALLER.exists(),'agent installer exists')
        self.directory=tempfile.TemporaryDirectory(prefix='i-',dir=SCRATCH)
        self.addCleanup(self.directory.cleanup)
        self.home=Path(self.directory.name)

    def test_mac_and_linux_manifests_and_idempotent_uninstall(self):
        installer=load(INSTALLER)
        for platform,relative in [('darwin','Library/Application Support/Mozilla/NativeMessagingHosts/foxy_agent.json'),
          ('linux','.mozilla/native-messaging-hosts/foxy_agent.json')]:
            path=installer.install(HOST,home=self.home,platform=platform)
            self.assertEqual(path,self.home/relative)
            self.assertEqual(json.loads(path.read_text()),{'name':'foxy_agent','description':'Foxy agent bridge','path':str(HOST.resolve()),
                'type':'stdio','allowed_extensions':['{4408f971-7930-41ea-9f93-b01231e40861}']})
            installer.uninstall(home=self.home,platform=platform)
            self.assertFalse(path.exists())
            installer.uninstall(home=self.home,platform=platform)

    def test_command_host_override_and_uninstall_with_isolated_home(self):
        env={**os.environ,'HOME':str(self.home),'TMPDIR':str(self.home)}
        result=subprocess.run(['python3',str(INSTALLER),'--host',str(HOST)],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        paths=list(self.home.rglob('foxy_agent.json'))
        self.assertEqual(len(paths),1)
        self.assertEqual(json.loads(paths[0].read_text())['path'],str(HOST.resolve()))
        result=subprocess.run(['python3',str(INSTALLER),'--uninstall'],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(paths[0].exists())

    def test_missing_host_does_not_install(self):
        installer=load(INSTALLER)
        with self.assertRaises(ValueError):
            installer.install(self.home/'missing',home=self.home,platform='darwin')
        self.assertFalse(list(self.home.rglob('foxy_agent.json')))


if __name__=='__main__':
    unittest.main()
