#!/usr/bin/env python3
"""Zip extension/ into dist/foxy-<version>.zip.

The zip is unsigned; scripts/sign.py turns it into a signed .xpi. File dates
are fixed so the same sources always give the same bytes.
"""
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCLUDE = ["manifest.json", "newtab.html", "options.html", "newtab.css", "background.js", "src/**/*.js", "fonts/*", "icons/*"]
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def package_files(root=ROOT):
    """Sorted POSIX paths relative to extension/ under the repository root."""
    addon_root = root / "extension"
    found = set()
    for pattern in INCLUDE:
        for path in addon_root.glob(pattern):
            relative = path.relative_to(addon_root)
            if path.is_file() and not any(part.startswith(".") for part in relative.parts):
                found.add(relative.as_posix())
    return sorted(found)


def build(root=ROOT, out_dir=None):
    addon_root = root / "extension"
    version = json.loads((addon_root / "manifest.json").read_text())["version"]
    out_dir = out_dir or root / "dist"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"foxy-{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in package_files(root):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (addon_root / name).read_bytes())
    return out


if __name__ == "__main__":
    print(build())
