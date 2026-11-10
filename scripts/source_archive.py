#!/usr/bin/env python3
"""Write a source zip from a release tag."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def archive(tag):
    if not tag.startswith('v') or not tag[1:] or '/' in tag or tag.startswith('-'):
        raise ValueError('Expected a release tag such as v1.2.3')
    manifest = subprocess.check_output(
        ['git', 'show', f'{tag}:extension/manifest.json'], cwd=ROOT, text=True)
    version = json.loads(manifest)['version']
    if tag != f'v{version}':
        raise ValueError('Tag does not match the manifest version')
    out = ROOT / 'dist' / f'foxy-{version}-source.zip'
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', 'archive', '--format=zip', f'--output={out}', tag], cwd=ROOT, check=True)
    return out


def main():
    if len(sys.argv) != 2:
        print('Usage: source_archive.py <tag>', file=sys.stderr)
        return 2
    try:
        print(archive(sys.argv[1]))
    except (ValueError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
