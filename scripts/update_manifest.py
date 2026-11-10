#!/usr/bin/env python3
"""Write updates.json pointing to a signed XPI at any HTTPS URL."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

ADDON_ID = '{4408f971-7930-41ea-9f93-b01231e40861}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('xpi', type=Path)
    parser.add_argument('update_link', help='HTTPS URL of the signed XPI')
    args = parser.parse_args()
    url = urlsplit(args.update_link)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or any(ord(char) <= 32 for char in args.update_link)):
        parser.error('update_link must be an HTTPS URL without credentials or whitespace')
    digest = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    manifest = {'addons': {ADDON_ID: {'updates': [{
        'version': args.version,
        'update_link': args.update_link,
        'update_hash': f'sha256:{digest}',
    }]}}}
    Path('updates.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
