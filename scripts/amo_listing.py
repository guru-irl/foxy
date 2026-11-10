#!/usr/bin/env python3
"""Sync the AMO listing from docs/amo. This command edits the real listing."""
import html
import json
from pathlib import Path
import re
import struct
import sys
import urllib.parse
import zlib

from sign import API, Amo, ROOT, encode_multipart, https_url, read_credentials, redact


# AMO stores these as rendered HTML, even with show_source=true: headings are
# dropped, lists become <ul>, links are wrapped. Compare their words instead.
RICH_TEXT = ('description', 'privacy_policy')


def rich_words(text):
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text or '')
    text = re.sub(r'(?i)</?(?:p|br|li|ul|ol|blockquote|h[1-6]|div)\b[^>]*>', ' ', text)
    text = html.unescape(re.sub(r'<[^>]+>', '', text))
    text = re.sub(r'(?m)^\s*(?:[-*]|\d+\.)\s+', ' ', text)
    return re.sub(r'[*_`#]', '', text).split()


def comparable(value):
    if isinstance(value, dict):
        return {key: comparable(item) for key, item in value.items()}
    if isinstance(value, list):
        return sorted(value)
    return value


def changed_fields(current, desired):
    """Keep other translations; unwrap AMO links and ignore category/tag order."""
    patch = {}
    for key, value in desired.items():
        old = current.get(key)
        if key == 'categories' and isinstance(old, dict):
            old = old.get('firefox', [])
        if key in ('homepage', 'support_url') and isinstance(old, dict) and 'url' in old:
            old = old['url']
            if isinstance(old, str):
                old = {'en-US': old}
        if isinstance(value, dict):
            old = {locale: text.strip() if isinstance(text, str) else text
                   for locale, text in (old or {}).items()}
            value = {**old, **{locale: text.strip() if isinstance(text, str) else text
                               for locale, text in value.items()}}
            if key in RICH_TEXT:
                if {k: rich_words(v) for k, v in value.items()} != {k: rich_words(v) for k, v in old.items()}:
                    patch[key] = value
                continue
        if comparable(value) != comparable(old):
            patch[key] = value
    return patch


def apply_fields(amo, url, current, desired):
    patch = changed_fields(current, desired)
    if patch:
        amo.json('PATCH', url, payload=patch)
        current = amo.json('GET', url + '?show_source=true')
        remaining = changed_fields(current, desired)
        if remaining:
            detail = redact(json.dumps(current)[:2000], amo)
            raise SystemExit(f"AMO did not apply fields: {', '.join(remaining)}. "
                             f"Check docs/amo/MANUAL.md. Response: {detail}")
    return current


def png_pixels(data):
    """Compare full-size RGB/RGBA PNG pixels, not AMO's compression or metadata."""
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise SystemExit('Expected a PNG screenshot from AMO.')
    offset, compressed, header = 8, bytearray(), None
    while offset < len(data):
        size = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b'IHDR':
            header = struct.unpack('>IIBBBBB', chunk)
        elif kind == b'IDAT':
            compressed.extend(chunk)
        offset += size + 12
    if not header:
        raise SystemExit('PNG screenshot has no header.')
    width, height, depth, colour, compression, filtering, interlace = header
    if depth != 8 or colour not in (2, 6) or compression or filtering or interlace:
        raise SystemExit('Screenshot must be a non-interlaced 8-bit RGB or RGBA PNG.')
    bpp = 4 if colour == 6 else 3
    stride = width * bpp
    raw = zlib.decompress(compressed)
    if len(raw) != (stride + 1) * height:
        raise SystemExit('PNG screenshot has invalid scanlines.')
    previous, pixels = bytearray(stride), bytearray()
    for y in range(height):
        start = y * (stride + 1)
        mode = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        if mode > 4:
            raise SystemExit('PNG screenshot has an invalid filter.')
        if mode:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                up = previous[x]
                corner = previous[x - bpp] if x >= bpp else 0
                if mode == 1:
                    prediction = left
                elif mode == 2:
                    prediction = up
                elif mode == 3:
                    prediction = (left + up) // 2
                else:
                    p = left + up - corner
                    distances = (abs(p - left), abs(p - up), abs(p - corner))
                    prediction = (left, up, corner)[distances.index(min(distances))]
                row[x] = (row[x] + prediction) & 255
        if bpp == 3:
            for x in range(0, stride, 3):
                pixels.extend(row[x:x + 3] + b'\xff')
        else:
            pixels.extend(row)
        previous = row
    return width, height, bytes(pixels)


def sync_listing(amo, guid, listing, privacy, read_image=None):
    base = f'{API}/addons/addon/{urllib.parse.quote(guid, safe="@")}/'
    current = amo.json('GET', base + '?show_source=true')
    fields = {k: v for k, v in listing.items() if k not in ('screenshots', 'license')}
    if 'tags' in fields:
        allowed = set(json.loads((ROOT / 'docs/amo/allowed-tags.json').read_text()))
        for tag in fields['tags']:
            if tag not in allowed:
                print(f'Warning: skipping unsupported AMO tag: {tag}', file=sys.stderr)
        fields['tags'] = [tag for tag in fields['tags'] if tag in allowed]
    current = apply_fields(amo, base, current, fields)
    # The license belongs to a version, not an add-on. sign.py sends it with source.
    policy_url = base + 'eula_policy/'
    policy = amo.json('GET', policy_url + '?show_source=true')
    apply_fields(amo, policy_url, policy, {'privacy_policy': {'en-US': privacy}})

    read_image = read_image or (lambda path: (ROOT / path).read_bytes())
    remaining = list(current.get('previews') or [])
    # Fetch and decode each existing image once. No auth is sent to image hosts.
    existing = {p['id']: png_pixels(amo.request('GET', https_url(p['image_url'])))
                for p in remaining}
    for position, image in enumerate(listing.get('screenshots', [])):
        data = read_image(image['path'])
        pixels = png_pixels(data)
        preview = next((p for p in remaining if existing[p['id']] == pixels), None)
        if preview is None:
            body, content_type = encode_multipart({}, {
                'image': (Path(image['path']).name, data, 'image/png')})
            preview = amo.json('POST', base + 'previews/', body=body, content_type=content_type)
        else:
            remaining.remove(preview)
        patch = changed_fields(preview, {'caption': image['caption'], 'position': position})
        if patch:
            amo.json('PATCH', base + f"previews/{preview['id']}/", payload=patch)
    # New previews are complete before old ones are removed. A retry finds their pixels.
    for preview in remaining:
        amo.json('DELETE', base + f"previews/{preview['id']}/")


def main():
    listing = json.loads((ROOT / 'docs/amo/listing.json').read_text())
    privacy = (ROOT / 'docs/amo/privacy.md').read_text()
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    issuer, secret = read_credentials()
    sync_listing(Amo(issuer, secret), manifest['browser_specific_settings']['gecko']['id'], listing, privacy)
    print('AMO listing is up to date.')


if __name__ == '__main__':
    main()
