#!/usr/bin/env python3
"""Install Foxy's native messaging host manifest on macOS or Linux."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def manifest_path(*, home=None, platform=None):
    home = Path.home() if home is None else Path(home)
    platform = sys.platform if platform is None else platform
    if platform == 'darwin':
        return home / 'Library/Application Support/Mozilla/NativeMessagingHosts/foxy_agent.json'
    if platform.startswith('linux'):
        return home / '.mozilla/native-messaging-hosts/foxy_agent.json'
    raise ValueError('The agent bridge supports macOS and Linux')


def install(host, *, home=None, platform=None):
    host = Path(host).expanduser().resolve()
    if not host.is_file() or not os.access(host, os.X_OK):
        raise ValueError(f'Host must be an executable file: {host}')
    extension_id = json.loads((ROOT / 'extension/manifest.json').read_text())['browser_specific_settings']['gecko']['id']
    manifest = {'name': 'foxy_agent', 'description': 'Foxy agent bridge', 'path': str(host),
        'type': 'stdio', 'allowed_extensions': [extension_id]}
    path = manifest_path(home=home, platform=platform)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replacement avoids a partially written manifest at browser startup.
    staged = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.foxy-', delete=False) as stream:
            staged = Path(stream.name)
            json.dump(manifest, stream, indent=2)
            stream.write('\n')
        staged.replace(path)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
    return path


def uninstall(*, home=None, platform=None):
    path = manifest_path(home=home, platform=platform)
    path.unlink(missing_ok=True)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', type=Path, default=ROOT / 'agent/foxy_host.py')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args(argv)
    try:
        path = uninstall() if args.uninstall else install(args.host)
        print(('Removed: ' if args.uninstall else 'Installed: ') + str(path))
        return 0
    except (OSError, ValueError) as error:
        print(f'Foxy: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
