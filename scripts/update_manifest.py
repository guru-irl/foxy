#!/usr/bin/env python3
"""Write updates.json for one signed GitHub release asset."""
import argparse
import hashlib
import json
from pathlib import Path

ADDON_ID = '{4408f971-7930-41ea-9f93-b01231e40861}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('tag')
    parser.add_argument('xpi', type=Path)
    parser.add_argument('repository', help='GitHub owner/repo')
    args = parser.parse_args()
    digest = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    manifest = {'addons': {ADDON_ID: {'updates': [{
        'version': args.version,
        'update_link': f'https://github.com/{args.repository}/releases/download/{args.tag}/{args.xpi.name}',
        'update_hash': f'sha256:{digest}',
    }]}}}
    Path('updates.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
