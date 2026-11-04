#!/usr/bin/env python3
"""Render the README board images with offline fixtures and a throwaway profile."""
import struct
import zlib

import preview


def optimise_png(path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'not a PNG: {path}')
    chunks = []
    offset = 8
    while offset < len(data):
        size = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        chunks.append((kind, data[offset + 8:offset + 8 + size]))
        offset += size + 12
    compressed = b''.join(payload for kind, payload in chunks if kind == b'IDAT')
    recompressed = zlib.compress(zlib.decompress(compressed), 9)
    if len(recompressed) >= len(compressed):
        return
    result, written = bytearray(data[:8]), False
    for kind, payload in chunks:
        if kind == b'IDAT':
            if written:
                continue
            payload, written = recompressed, True
        result.extend(struct.pack('>I', len(payload)) + kind + payload
                      + struct.pack('>I', zlib.crc32(kind + payload)))
    path.write_bytes(result)


def main():
    preview.OUT = preview.ROOT / 'docs' / 'images'
    preview.build_page()
    preview.ensure_profile()
    for scheme in ('dark', 'light'):
        preview.shoot(f'board-{scheme}', f'scenario=v40&scheme={scheme}', 1440, 900)
        optimise_png(preview.OUT / f'board-{scheme}.png')


if __name__ == '__main__':
    main()
