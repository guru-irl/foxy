#!/usr/bin/env python3
"""Prepare a tested release commit and annotated tag. This script never pushes."""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
FILES = ('extension/manifest.json', 'package.json', 'test/manifest.test.js')


def git(*args, check=True):
    return subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=True, check=check)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    version = parser.parse_args().version
    match = VERSION.fullmatch(version)
    if not match:
        raise SystemExit('Version must be X.Y.Z with no leading zeroes.')
    if git('status', '--porcelain', '--untracked-files=normal').stdout:
        raise SystemExit('Refusing to release from a dirty tree.')
    texts = {name: (ROOT / name).read_text() for name in FILES}
    current = json.loads(texts[FILES[0]])['version']
    old = VERSION.fullmatch(current)
    if not old or tuple(map(int, match.groups())) <= tuple(map(int, old.groups())):
        raise SystemExit('The new version must be higher than the current version.')
    if json.loads(texts[FILES[1]])['version'] != current:
        raise SystemExit('Package and manifest versions differ.')
    tag = f'v{version}'
    if git('show-ref', '--verify', '--quiet', f'refs/tags/{tag}', check=False).returncode == 0:
        raise SystemExit(f'Tag {tag} already exists.')
    for existing in git('tag', '--list', 'v*').stdout.splitlines():
        tagged = VERSION.fullmatch(existing[1:])
        if tagged and tuple(map(int, match.groups())) <= tuple(map(int, tagged.groups())):
            raise SystemExit(f'The new version must be higher than tag {existing}.')
    for name in FILES[:2]:
        pattern = rf'^(\s*"version"\s*:\s*)"{re.escape(current)}"'
        texts[name], count = re.subn(pattern, lambda m: m.group(1) + json.dumps(version), texts[name], count=1, flags=re.MULTILINE)
        if count != 1:
            raise SystemExit(f'Cannot find the current version in {name}.')
    name = FILES[2]
    for target in ('manifest.version', 'pkg.version'):
        pattern = rf'({re.escape(target)},\s*)"{re.escape(current)}"'
        texts[name], count = re.subn(pattern, lambda m: m.group(1) + json.dumps(version), texts[name])
        if count != 1:
            raise SystemExit(f'Cannot find {target} in {name}.')
    texts[name] = texts[name].replace(f'Foxy {current}', f'Foxy {version}')
    for name, text in texts.items():
        (ROOT / name).write_text(text)
    subprocess.run(['npm', 'test'], cwd=ROOT, check=True)
    git('add', '--', *FILES)
    git('commit', '-m', f'Release {version}')
    git('tag', '-a', tag, '-m', f'Release {version}')
    print(f'Created release commit and annotated tag {tag}. Nothing was pushed.')


if __name__ == '__main__':
    main()
