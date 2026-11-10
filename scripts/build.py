#!/usr/bin/env python3
"""Build the extension and zip it with fixed timestamps."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def package_files(root=ROOT):
    addon = root / 'build' / 'extension'
    return sorted(path.relative_to(addon).as_posix() for path in addon.rglob('*') if path.is_file())


def build(root=ROOT, out_dir=None):
    root = Path(root)
    vite = root / 'node_modules' / '.bin' / 'vite'
    if not vite.is_file():
        raise RuntimeError('Run `npm ci` first')
    source = root / 'extension'
    addon = root / 'build' / 'extension'
    marker = root / 'build' / '.built'
    marker.unlink(missing_ok=True)
    subprocess.run([str(vite), 'build', '--config', str(root / 'vite.config.js')], cwd=root, check=True)
    shutil.copyfile(source / 'manifest.json', addon / 'manifest.json')
    for name in ('fonts', 'icons'):
        shutil.copytree(source / name, addon / name, dirs_exist_ok=True)
    version = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))['version']
    out_dir = Path(out_dir) if out_dir is not None else root / 'dist'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f'foxy-{version}.zip'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name in package_files(root):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (addon / name).read_bytes())
    marker.write_text(json.dumps(package_files(root)), encoding='utf-8')
    return out


def ensure_built(root=ROOT):
    root = Path(root)
    addon = root / 'build' / 'extension'
    marker = root / 'build' / '.built'
    required = ('manifest.json', 'newtab.html', 'options.html', 'newtab.js',
                'options.js', 'background.js', 'newtab.css')
    inputs = [root / 'scripts/build.py', root / 'vite.config.js', root / 'package.json',
              root / 'package-lock.json', root / 'node_modules/vite/package.json']
    extension = root / 'extension'
    inputs.extend([extension, *extension.rglob('*')])
    try:
        outputs = json.loads(marker.read_text(encoding='utf-8'))
        valid = isinstance(outputs, list) and all(isinstance(name, str) for name in outputs)
    except (OSError, ValueError):
        outputs, valid = [], False
    if (not valid or any(not (addon / name).is_file() for name in (*required, *outputs))
            or any(not path.exists() or path.stat().st_mtime_ns > marker.stat().st_mtime_ns for path in inputs)):
        build(root)
    return addon


if __name__ == '__main__':
    try:
        print(build())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
