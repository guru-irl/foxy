#!/usr/bin/env python3
"""Check a generated update manifest in headless Firefox without external traffic."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading

from firefox_env import firefox_environment
from smoke_firefox import (ADDON_ID, FIREFOX, connect_firefox, quit_firefox,
                           safe_profile_path, write_profile)

ROOT = Path(__file__).resolve().parent.parent


def main():
    scratch = safe_profile_path(ROOT / '.spider' / 'scratch')
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='update-checker-', dir=scratch) as directory:
        work = Path(directory)
        asset = work / 'foxy-4.1.0.xpi'
        asset.write_bytes(b'local test asset')
        subprocess.run([sys.executable, str(ROOT / 'scripts/update_manifest.py'), '4.1.0',
                        'v4.1.0', str(asset), 'guru-irl/foxy'], cwd=work, check=True)
        manifest = (work / 'updates.json').read_bytes()
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append(self.path)
                if self.path == '/latest':
                    self.send_response(302)
                    self.send_header('Location', '/updates.json')
                    self.end_headers()
                elif self.path == '/updates.json':
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(len(manifest)))
                    self.end_headers()
                    self.wfile.write(manifest)
                else:
                    self.send_error(404)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        process = client = None
        try:
            with socket.socket() as reserved:
                reserved.bind(('127.0.0.1', 0))
                port = reserved.getsockname()[1]
            write_profile(work / 'profile', port)
            (work / 'tmp').mkdir()
            with firefox_environment(work) as env, (work / 'firefox.log').open('wb') as log:
                process = subprocess.Popen([str(FIREFOX), '--headless', '--no-remote', '--marionette',
                    '--remote-allow-system-access', '-profile', str(work / 'profile'), 'about:blank'],
                    env=env, start_new_session=True, stdout=log, stderr=log)
                client = connect_firefox(process, port)
                session = client.command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {
                    'acceptInsecureCerts': False, 'timeouts': {'script': 10000, 'pageLoad': 15000, 'implicit': 0}}}})
                result = client.script('''
                    const {AddonUpdateChecker} = ChromeUtils.importESModule(
                        "resource://gre/modules/addons/AddonUpdateChecker.sys.mjs");
                    return await new Promise((resolve, reject) => {
                        AddonUpdateChecker.checkForUpdates(arguments[0], arguments[1], {
                            onUpdateCheckComplete: updates => resolve(updates),
                            onUpdateCheckError: code => reject(new Error(`update check error ${code}`)),
                        });
                    });
                ''', [ADDON_ID, f'http://127.0.0.1:{server.server_port}/latest'], chrome=True)
                expected_hash = 'sha256:' + hashlib.sha256(b'local test asset').hexdigest()
                assert requests == ['/latest', '/updates.json'], requests
                assert len(result) == 1, result
                assert result[0]['version'] == '4.1.0', result
                assert result[0]['updateURL'] == 'https://github.com/guru-irl/foxy/releases/download/v4.1.0/foxy-4.1.0.xpi', result
                assert result[0]['updateHash'] == expected_hash, result
                print(f"Firefox {session['capabilities']['browserVersion']}: redirect and application/octet-stream update manifest passed")
        finally:
            quit_firefox(client, process)
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    main()
