#!/usr/bin/env python3
"""Render Foxy 4.0 at the specified page widths, in both schemes, offline.

All images, the contact sheet and its HTML live in .spider/scratch/renders/.
The MacBook capture is the 1440px page inside a 1512px window with a sidebar.
"""
import html

import preview


def main():
    preview.OUT = preview.ROOT / '.spider' / 'scratch' / 'renders'
    names = [f'v40-{size}-{scheme}' for scheme in ('dark', 'light')
             for size in ('2560', 'mac', '1024', 'narrow')]
    preview.main(names)
    figures = []
    for name in names:
        _, width, height = preview.SCENARIOS[name]
        label = f'{name}: {width} x {height}'
        figures.append(f'<figure><img src="{name}.png"><figcaption>{html.escape(label)}</figcaption></figure>')
    sheet = preview.OUT / 'contact-sheet.html'
    sheet.write_text('''<!doctype html><meta charset="utf-8"><title>Foxy 4.0 renders</title>
<style>
html{background:#161618;color:#eee;font:16px system-ui}body{margin:16px;display:grid;grid-template-columns:repeat(4,504px);gap:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:12px;background:#262628;border-radius:12px;padding:8px;box-sizing:border-box}
img{width:488px;height:360px;object-fit:contain;object-position:top}figcaption{height:24px}
</style>''' + ''.join(figures))
    preview.PAGE = sheet
    preview.shoot('contact-sheet', '', 2096, 840)


if __name__ == '__main__':
    main()
