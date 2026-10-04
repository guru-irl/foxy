#!/usr/bin/env python3
"""Firefox native messaging host for the Foxy agent CLI (standard library only)."""

import ctypes
import errno
import fcntl
import json
import os
import re
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import threading
import uuid

MAX_MESSAGE = 1024 * 1024
REPLY_TIMEOUT = 10


class RusageInfoV2(ctypes.Structure):
    # sys/resource.h ABI, RUSAGE_INFO_V2. Sizes and footprint are bytes.
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            'ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups',
            'ri_interrupt_wkups', 'ri_pageins', 'ri_wired_size',
            'ri_resident_size', 'ri_phys_footprint', 'ri_proc_start_abstime',
            'ri_proc_exit_abstime', 'ri_child_user_time', 'ri_child_system_time',
            'ri_child_pkg_idle_wkups', 'ri_child_interrupt_wkups',
            'ri_child_pageins', 'ri_child_elapsed_abstime',
            'ri_diskio_bytesread', 'ri_diskio_byteswritten')]


def mac_footprint(pid):
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    usage = RusageInfoV2()
    if lib.proc_pid_rusage(pid, 2, ctypes.byref(usage)) != 0:
        raise OSError(ctypes.get_errno(), 'Process footprint unavailable')
    return usage.ri_phys_footprint


def mac_process_table():
    text = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,rss='], text=True, timeout=1)
    return {int(pid): (int(parent), int(rss) * 1024)
            for pid, parent, rss in (line.split() for line in text.splitlines() if line.strip())}


def mac_system_memory():
    total = int(subprocess.check_output(['/usr/sbin/sysctl', '-n', 'hw.memsize'], text=True, timeout=1))
    text = subprocess.check_output(['/usr/bin/vm_stat'], text=True, timeout=1)
    page_size = int(re.search(r'page size of (\d+) bytes', text).group(1))
    values = {key: int(value) for key, value in re.findall(r'^([^:\n]+):\s+(\d+)', text, re.M)}
    app = max(0, values['Anonymous pages'] - values.get('Pages purgeable', 0)) \
        if 'Anonymous pages' in values else values['Pages active']
    pages = app + values['Pages wired down'] + values['Pages occupied by compressor']
    return {'total': total, 'used': min(total, pages * page_size)}


def proc_values(path):
    values = {}
    for line in path.read_text().splitlines():
        key, sep, value = line.partition(':')
        parts = value.split()
        if sep and re.fullmatch(r'[A-Za-z_][A-Za-z_()]*', key) and parts and parts[0].isdigit():
            values[key] = int(parts[0])
    return values


def linux_process_table(proc):
    table = {}
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            values = proc_values(path / 'status')
            table[int(path.name)] = (values['PPid'], values.get('VmRSS', 0) * 1024)
        except (OSError, KeyError, ValueError):
            continue
    return table


def measure_memory(*, root_pid=None, host_pid=None, platform=None, proc=Path('/proc')):
    root_pid = os.getppid() if root_pid is None else root_pid
    host_pid = os.getpid() if host_pid is None else host_pid
    platform = sys.platform if platform is None else platform
    if platform == 'darwin':
        table = mac_process_table()
        system = mac_system_memory()
    elif platform.startswith('linux'):
        table = linux_process_table(proc)
        values = proc_values(proc / 'meminfo')
        system = {'total': values['MemTotal'] * 1024,
                  'used': max(0, values['MemTotal'] - values['MemAvailable']) * 1024}
    else:
        raise ValueError('Memory measurement is unavailable on this platform')
    if root_pid not in table:
        raise ValueError('Firefox process tree not found')
    if platform.startswith('linux'):
        # Portals may launch the host outside Firefox's process tree.
        status = (proc / str(root_pid) / 'status').read_text()
        if not re.search(r'^Name:\s+firefox(?:-bin|-esr)?\s*$', status, re.M | re.I):
            raise ValueError('Firefox process tree not found')
    children = {}
    for pid, (parent, _) in table.items():
        children.setdefault(parent, []).append(pid)
    pending, seen, total = [root_pid], set(), 0
    while pending:
        pid = pending.pop()
        # Exclude the helper branch, including temporary measurement commands.
        if pid == host_pid or pid in seen:
            continue
        seen.add(pid)
        pending.extend(children.get(pid, []))
        amount = table[pid][1]
        if platform == 'darwin':
            try:
                amount = mac_footprint(pid)
            except OSError:
                pass
        else:
            try:
                amount = proc_values(proc / str(pid) / 'smaps_rollup')['Pss'] * 1024
            except (OSError, KeyError, ValueError):
                pass  # Restricted smaps or an exiting process: fall back to RSS.
        total += amount
    if not seen:
        raise ValueError('Firefox process tree not found')
    return {'firefox': total, 'processes': len(seen), 'system': system}


def socket_path():
    return Path(os.environ.get('FOXY_AGENT_SOCK', '~/.config/foxy/agent.sock')).expanduser()


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise EOFError('Truncated native message')
        result.extend(part)
    return bytes(result)


class ReplyTooLarge(ValueError):
    pass


def read_message(stream, *, drain_oversized=False):
    first = stream.read(1)
    if not first:
        return None
    size = struct.unpack('<I', first + read_exact(stream, 3))[0]
    if size > MAX_MESSAGE and drain_oversized:
        remaining = size
        while remaining:
            chunk = min(remaining, 65536)
            read_exact(stream, chunk)
            remaining -= chunk
        raise ReplyTooLarge('Reply too large')
    if not 0 < size <= MAX_MESSAGE:
        raise ValueError('Invalid native message length')
    return json.loads(read_exact(stream, size))


def write_message(stream, message):
    body = json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if not 0 < len(body) <= MAX_MESSAGE:
        raise ValueError('Native message too large')
    stream.write(struct.pack('<I', len(body)) + body)
    stream.flush()


def unreachable(message):
    return {'ok': False, 'unreachable': True, 'error': message}


class Relay:
    def __init__(self, reader, writer, reply_timeout):
        self.reader, self.writer, self.reply_timeout = reader, writer, reply_timeout
        self.stopping = threading.Event()
        self.pending = {}
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.failed = False

    def read_replies(self):
        try:
            while True:
                try:
                    reply = read_message(self.reader, drain_oversized=True)
                except ReplyTooLarge:
                    # No trustworthy id in a discarded frame. Other clients stay live;
                    # the extension sends the correlated small refusal instead.
                    continue
                if reply is None:
                    break
                if isinstance(reply, dict) and reply.get('type') == 'memory':
                    response = {'type': 'memory', 'rid': reply.get('rid')}
                    try:
                        response.update(measure_memory())
                    except Exception as error:
                        response['error'] = str(error)
                    with self.write_lock:
                        write_message(self.writer, response)
                    continue
                if not isinstance(reply, dict) or not isinstance(reply.get('id'), str):
                    continue
                with self.lock:
                    item = self.pending.get(reply['id'])
                    if item:
                        item['reply'] = {k: v for k, v in reply.items() if k != 'id'}
                        item['event'].set()
        except (OSError, EOFError, ValueError):
            self.failed = True
        finally:
            with self.lock:
                self.stopping.set()
                for item in self.pending.values():
                    item['event'].set()

    def request(self, request):
        if not isinstance(request, dict):
            return {'ok': False, 'error': 'Request must be a JSON object'}
        if request.get('type') == 'memory':
            return {'ok': False, 'error': 'Memory requests are only available to the extension'}
        request_id = uuid.uuid4().hex
        item = {'event': threading.Event()}
        with self.lock:
            if self.stopping.is_set():
                return unreachable('Firefox disconnected')
            self.pending[request_id] = item
        try:
            with self.write_lock:
                write_message(self.writer, {**request, 'id': request_id})
            item['event'].wait(self.reply_timeout)
            return item.get('reply', unreachable('Firefox disconnected' if self.stopping.is_set()
                else 'Foxy did not reply within 10 seconds'))
        except (OSError, ValueError):
            return unreachable('Foxy native pipe is unavailable')
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def client(self, connection):
        with connection:
            connection.settimeout(self.reply_timeout)
            try:
                with connection.makefile('rb') as stream:
                    while not self.stopping.is_set():
                        line = stream.readline(MAX_MESSAGE + 1)
                        if not line:
                            break
                        invalid_length = len(line) > MAX_MESSAGE or not line.endswith(b'\n')
                        try:
                            if invalid_length:
                                raise ValueError('Invalid request length')
                            reply = self.request(json.loads(line))
                        except (ValueError, UnicodeError) as error:
                            reply = {'ok': False, 'error': str(error)}
                        connection.sendall(json.dumps(reply, ensure_ascii=False, separators=(',', ':')).encode() + b'\n')
                        if invalid_length:
                            break
            except OSError:
                pass  # A timed-out or disconnected CLI cannot hold the host open.


def bind_socket(path):
    """Hold a sidecar lock to keep two hosts from racing to replace a stale socket."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    lock_fd = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    listener = None
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.exists() or path.is_symlink():
            if not stat.S_ISSOCK(path.lstat().st_mode):
                raise ValueError('Socket path is not a socket')
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(.2)
                try:
                    probe.connect(str(path))
                except OSError as error:
                    if error.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                        raise
                else:
                    raise ValueError('A Foxy host is already listening')
            path.unlink(missing_ok=True)
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen(16)
        listener.settimeout(.1)
        return listener, lock_fd
    except Exception:
        if listener is not None:
            listener.close()
        os.close(lock_fd)
        raise


def run(*, reply_timeout=REPLY_TIMEOUT):
    path = socket_path()
    try:
        listener, lock_fd = bind_socket(path)
    except (OSError, ValueError) as error:
        print(f'Foxy: could not listen: {error}', file=sys.stderr)
        return 1
    inode = path.stat().st_ino
    relay = Relay(sys.stdin.buffer, sys.stdout.buffer, reply_timeout)
    reader = threading.Thread(target=relay.read_replies, daemon=True)
    reader.start()
    clients = []
    try:
        while not relay.stopping.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            worker = threading.Thread(target=relay.client, args=(connection,), daemon=True)
            clients = [(sock, t) for sock, t in clients if t.is_alive()]
            clients.append((connection, worker))
            worker.start()
    finally:
        relay.stopping.set()
        listener.close()
        for connection, worker in clients:
            try:
                connection.shutdown(socket.SHUT_RD)
            except OSError:
                pass
            worker.join(.5)
        # Do not remove a socket another owner replaced while we were running.
        try:
            if path.lstat().st_ino == inode:
                path.unlink()
        except FileNotFoundError:
            pass
        os.close(lock_fd)
    return 1 if relay.failed else 0


if __name__ == '__main__':
    raise SystemExit(run())
