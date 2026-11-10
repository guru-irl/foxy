import copy
import contextlib
import io
import json
from pathlib import Path
import struct
import sys
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sign

ROOT = Path(__file__).resolve().parent.parent


def png(pixel=b'\x11\x22\x33\xff', extra=False):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
            + (chunk(b'tEXt', b'key\0value') if extra else b'')
            + chunk(b'IDAT', zlib.compress(b'\0' + pixel)) + chunk(b'IEND', b''))


class ListingServer:
    def __init__(self):
        self.addon = {'name': {'en-US': 'Old name'}, 'categories': ['tabs'],
                      'previews': []}
        self.policy = {'privacy_policy': None}
        self.calls = []
        self.images = {}

    def json(self, method, url, payload=None, body=None, content_type=None):
        self.calls.append((method, url, payload, body))
        if url.split('?')[0].endswith('/eula_policy/'):
            if method == 'PATCH':
                self.policy.update(copy.deepcopy(payload))
            return copy.deepcopy(self.policy)
        if method == 'GET':
            return copy.deepcopy(self.addon)
        if method == 'PATCH' and '/previews/' not in url:
            self.addon.update(copy.deepcopy(payload))
            return copy.deepcopy(self.addon)
        if method == 'PATCH':
            preview = next(p for p in self.addon['previews'] if url.endswith(f"/{p['id']}/"))
            preview.update(copy.deepcopy(payload))
            return copy.deepcopy(preview)
        if method == 'POST':
            # Decode real multipart bytes, not a second implementation of listing logic.
            from email.parser import BytesParser
            from email.policy import default
            message = BytesParser(policy=default).parsebytes(
                f'Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n'.encode() + body)
            parts = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                     for part in message.iter_parts()}
            ident = len(self.images) + 1
            image_url = f'https://example.com/preview/{ident}.png'
            self.images[image_url] = parts['image']
            preview = {'id': ident, 'image_url': image_url, 'caption': None,
                       'position': int(parts.get('position', b'0'))}
            self.addon['previews'].append(preview)
            return copy.deepcopy(preview)
        if method == 'DELETE':
            self.addon['previews'] = [p for p in self.addon['previews'] if not url.endswith(f"/{p['id']}/")]
            return {}
        raise AssertionError((method, url))

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, None, None))
        return self.images[url]


class RenderingServer(ListingServer):
    """AMO stores description and privacy policy as rendered HTML (seen live 2026-11-10):
    headings are dropped, lists become <ul>, bold becomes <strong>, links are wrapped."""

    @staticmethod
    def render(text):
        import re
        out, items = [], []
        for line in text.strip().splitlines():
            if line.startswith('#'):
                continue
            line = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', line)
            line = re.sub(r'\[([^\]]+)\]\(([^)]+)\)',
                          lambda m: f'<a href="https://outgoing.example/v1/x/{m.group(2)}" rel="nofollow">{m.group(1)}</a>', line)
            if line.startswith('- '):
                items.append(f'<li>{line[2:]}</li>')
                continue
            if items:
                out.append('<ul>' + ''.join(items) + '</ul>')
                items = []
            out.append(line)
        if items:
            out.append('<ul>' + ''.join(items) + '</ul>')
        return '\n'.join(out)

    def json(self, method, url, payload=None, body=None, content_type=None):
        if method == 'PATCH' and payload:
            payload = {key: ({locale: self.render(text) for locale, text in value.items()}
                             if key in ('description', 'privacy_policy') else value)
                       for key, value in payload.items()}
        return super().json(method, url, payload, body, content_type)


class ListingSyncTest(unittest.TestCase):
    def setUp(self):
        import amo_listing
        self.listing = amo_listing
        self.server = ListingServer()
        self.desired = {'name': {'en-US': 'Foxy Board'}, 'summary': {'en-US': 'A tab board.'},
                        'categories': ['tabs', 'bookmarks'],
                        'support_url': {'en-US': 'https://example.com/issues'},
                        'screenshots': [{'path': 'dark.png', 'caption': {'en-US': 'Dark board'}}],
                        'license': 'MIT'}
        self.files = {'dark.png': png()}

    def sync(self):
        self.listing.sync_listing(self.server, '{abc}', self.desired, 'No data collected.',
                                  read_image=lambda path: self.files[path])

    def test_first_run_sets_only_changed_fields_policy_and_screenshot(self):
        self.sync()
        patches = [c for c in self.server.calls if c[0] == 'PATCH']
        self.assertEqual(patches[0][2], {k: v for k, v in self.desired.items()
                                       if k not in ('screenshots', 'license')})
        self.assertEqual(self.server.policy['privacy_policy'], {'en-US': 'No data collected.'})
        self.assertEqual(self.server.addon['previews'][0]['caption'], {'en-US': 'Dark board'})
        self.assertEqual(self.server.addon['previews'][0]['position'], 0)
        self.assertEqual(self.server.images['https://example.com/preview/1.png'], png())

    def test_second_run_is_read_only_even_if_amo_rewrites_png_metadata(self):
        self.sync()
        self.server.images['https://example.com/preview/1.png'] = png(extra=True)
        self.server.calls.clear()
        self.sync()
        self.assertTrue(all(c[0] == 'GET' for c in self.server.calls), self.server.calls)

    def test_metadata_change_does_not_reupload_unchanged_screenshot(self):
        self.sync()
        self.server.calls.clear()
        self.desired['summary'] = {'en-US': 'Changed summary'}
        self.sync()
        mutations = [c for c in self.server.calls if c[0] != 'GET']
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0][2], {'summary': {'en-US': 'Changed summary'}})

    def test_changed_pixels_replace_screenshot_and_remove_old_copy(self):
        self.sync()
        self.files['dark.png'] = png(b'\xff\0\0\xff')
        self.server.calls.clear()
        self.sync()
        self.assertEqual(len(self.server.addon['previews']), 1)
        self.assertEqual(self.server.addon['previews'][0]['id'], 2)
        self.assertEqual([c[0] for c in self.server.calls if c[0] != 'GET'], ['POST', 'PATCH', 'DELETE'])

    def test_retry_after_caption_patch_failed_does_not_duplicate_image(self):
        self.sync()
        self.server.addon['previews'][0]['caption'] = None
        self.server.calls.clear()
        self.sync()
        self.assertEqual([c[0] for c in self.server.calls if c[0] != 'GET'], ['PATCH'])
        self.assertEqual(len(self.server.addon['previews']), 1)

    def test_translations_not_managed_by_listing_are_preserved(self):
        self.sync()
        self.server.addon['summary']['fr'] = 'Tableau'
        self.server.calls.clear()
        self.sync()
        self.assertTrue(all(c[0] == 'GET' for c in self.server.calls))

    def test_outgoing_link_wrappers_and_category_order_do_not_trigger_writes(self):
        self.sync()
        self.server.addon['categories'].reverse()
        self.server.addon['support_url'] = {
            'url': {'en-US': 'https://example.com/issues'},
            'outgoing': {'en-US': 'https://example.net/wrapped'}}
        self.server.calls.clear()
        self.sync()
        self.assertTrue(all(c[0] == 'GET' for c in self.server.calls), self.server.calls)

    def test_v5_flat_categories_are_patched_and_stay_read_only_on_repeat(self):
        data = json.loads((ROOT / 'docs/amo/listing.json').read_text())
        self.assertEqual(data['categories'], ['tabs', 'bookmarks'])
        self.sync()
        self.assertEqual(self.server.addon['categories'], ['tabs', 'bookmarks'])
        self.server.calls.clear()
        self.sync()
        self.assertTrue(all(call[0] == 'GET' for call in self.server.calls))

    def test_translations_with_source_whitespace_sync_once_to_trimming_amo(self):
        class TrimmingServer(ListingServer):
            def json(self, method, url, payload=None, body=None, content_type=None):
                if method == 'PATCH' and payload:
                    payload = {key: ({locale: text.strip() for locale, text in value.items()}
                                     if key in ('name', 'summary', 'description', 'privacy_policy', 'caption')
                                     and isinstance(value, dict) else value)
                               for key, value in payload.items()}
                return super().json(method, url, payload, body, content_type)
        self.server = TrimmingServer()
        source = json.loads((ROOT / 'docs/amo/listing.json').read_text())
        self.desired['description'] = source['description']
        self.desired['summary'] = {'en-US': ' A tab board.\n'}
        self.desired['screenshots'][0]['caption'] = {'en-US': ' Dark board\n'}
        privacy = (ROOT / 'docs/amo/privacy.md').read_text()
        self.assertTrue(privacy.endswith('\n'))
        self.assertTrue(source['description']['en-US'].endswith('\n'))
        self.listing.sync_listing(self.server, '{abc}', self.desired, privacy,
                                  read_image=lambda path: self.files[path])
        self.assertEqual(self.server.policy['privacy_policy']['en-US'], privacy.strip())
        self.assertEqual(self.server.addon['previews'][0]['caption'], {'en-US': 'Dark board'})
        for method, url, payload, _ in self.server.calls:
            if method == 'PATCH':
                for key in ('name', 'summary', 'description', 'privacy_policy', 'caption'):
                    for value in (payload.get(key) or {}).values():
                        self.assertEqual(value, value.strip())
        self.server.calls.clear()
        self.listing.sync_listing(self.server, '{abc}', self.desired, privacy,
                                  read_image=lambda path: self.files[path])
        self.assertTrue(all(call[0] == 'GET' for call in self.server.calls))

    def test_rendering_amo_accepts_supported_markdown_and_repeat_sync_is_read_only(self):
        self.server = RenderingServer()
        source = json.loads((ROOT / 'docs/amo/listing.json').read_text())
        privacy = (ROOT / 'docs/amo/privacy.md').read_text()
        self.desired['description'] = source['description']
        self.listing.sync_listing(self.server, '{abc}', self.desired, privacy,
                                  read_image=lambda path: self.files[path])
        self.assertIn('<li>', self.server.addon['description']['en-US'])
        self.server.calls.clear()
        self.listing.sync_listing(self.server, '{abc}', self.desired, privacy,
                                  read_image=lambda path: self.files[path])
        self.assertTrue(all(call[0] == 'GET' for call in self.server.calls))

    def test_rendering_amo_that_drops_a_heading_fails_loudly(self):
        self.server = RenderingServer()
        self.desired['description'] = {'en-US': '## Lost heading\n\nKept **text** with a [link](https://example.com/a).\n'}
        with self.assertRaises(SystemExit) as caught:
            self.sync()
        self.assertIn('AMO did not apply fields: description', str(caught.exception))

    def test_store_text_uses_only_markdown_that_amo_keeps(self):
        source = json.loads((ROOT / 'docs/amo/listing.json').read_text())
        for name, text in (('description', source['description']['en-US']),
                           ('privacy', (ROOT / 'docs/amo/privacy.md').read_text())):
            headings = [line for line in text.splitlines() if line.lstrip().startswith('#')]
            self.assertEqual(headings, [], f'{name}: AMO drops Markdown headings; use **bold** lines')

    def test_invalid_tags_are_warned_and_never_sent(self):
        self.desired['tags'] = ['dark mode', 'invented tag']
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.sync()
        self.assertIn('invented tag', stderr.getvalue())
        self.assertEqual(self.server.addon['tags'], ['dark mode'])
        self.desired['tags'] = ['another invalid tag']
        with contextlib.redirect_stderr(io.StringIO()):
            self.sync()
        self.assertEqual(self.server.addon['tags'], [])

    def test_an_ignored_listing_patch_fails_loudly_instead_of_claiming_success(self):
        class IgnoringServer(ListingServer):
            def json(self, method, url, **kwargs):
                if method == 'PATCH' and '/previews/' not in url:
                    return copy.deepcopy(self.addon)
                return super().json(method, url, **kwargs)
        self.server = IgnoringServer()
        with self.assertRaises(SystemExit) as caught:
            self.sync()
        self.assertIn('AMO did not apply', str(caught.exception))
        self.assertIn('name', str(caught.exception))

    def test_store_config_uses_existing_images_and_valid_summary(self):
        data = json.loads((ROOT / 'docs/amo/listing.json').read_text())
        self.assertEqual(data['name'], {'en-US': 'Foxy Board'})
        self.assertLessEqual(len(data['summary']['en-US']), 250)
        for image in data['screenshots']:
            self.assertTrue((ROOT / image['path']).is_file())
        self.assertEqual(data['license'], 'MIT')


class ScreenshotTest(unittest.TestCase):
    def test_full_size_store_screenshots_decode_to_different_pixels(self):
        from amo_listing import png_pixels
        dark = png_pixels((ROOT / 'docs/images/board-dark.png').read_bytes())
        light = png_pixels((ROOT / 'docs/images/board-light.png').read_bytes())
        self.assertEqual(dark[:2], (1440, 900))
        self.assertEqual(light[:2], (1440, 900))
        self.assertNotEqual(dark[2], light[2])

    def test_all_png_filters_produce_the_same_known_pixels(self):
        from amo_listing import png_pixels
        # One RGBA pixel in two rows. Expected rows are both (17,34,51,255).
        for mode, second in [(0, b'\x11\x22\x33\xff'), (1, b'\x11\x22\x33\xff'),
                             (2, b'\0\0\0\0'), (3, b'\x09\x11\x1a\x80'),
                             (4, b'\0\0\0\0')]:
            with self.subTest(filter=mode):
                def chunk(kind, data):
                    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
                data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 2, 8, 6, 0, 0, 0))
                        + chunk(b'IDAT', zlib.compress(b'\0\x11\x22\x33\xff' + bytes([mode]) + second))
                        + chunk(b'IEND', b''))
                self.assertEqual(png_pixels(data), (1, 2, b'\x11\x22\x33\xff' * 2))


if __name__ == '__main__':
    unittest.main()
