#!/usr/bin/env python3
"""Firefox native messaging host for the Foxy agent CLI (standard library only)."""

import errno
import fcntl
import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys
import threading
import uuid

MAX_MESSAGE = 1024 * 1024
REPLY_TIMEOUT = 10


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
