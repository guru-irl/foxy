import base64
import hashlib
import hmac
import http.client
import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sign  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / ".spider" / "scratch" / "task-1" / "test-sign"


def b64decode(part):
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


class JwtTest(unittest.TestCase):
    def test_token_has_amo_claims_and_verifies_with_the_secret(self):
        token = sign.make_jwt("user:1:2", "s3cret", now=1_700_000_000, jti="abc")
        header, payload, signature = token.split(".")
        self.assertEqual(json.loads(b64decode(header)), {"alg": "HS256", "typ": "JWT"})
        self.assertEqual(
            json.loads(b64decode(payload)),
            {"iss": "user:1:2", "jti": "abc", "iat": 1_700_000_000, "exp": 1_700_000_060},
        )
        expected = hmac.new(b"s3cret", f"{header}.{payload}".encode(), hashlib.sha256).digest()
        self.assertEqual(b64decode(signature), expected)
        self.assertNotIn("=", token)

    def test_each_token_gets_a_fresh_jti(self):
        first = json.loads(b64decode(sign.make_jwt("i", "s").split(".")[1]))["jti"]
        second = json.loads(b64decode(sign.make_jwt("i", "s").split(".")[1]))["jti"]
        self.assertNotEqual(first, second)


class CredentialsTest(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.path = SCRATCH / "amo.env"
        environment = mock.patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def write(self, text, mode=0o600):
        self.path.write_text(text)
        os.chmod(self.path, mode)

    def test_environment_takes_priority_without_reading_file(self):
        with mock.patch.dict(os.environ, {'AMO_JWT_ISSUER': 'env-issuer', 'AMO_JWT_SECRET': 'env-secret'}):
            self.assertEqual(sign.read_credentials(SCRATCH / 'does-not-exist.env'), ('env-issuer', 'env-secret'))

    def test_partial_environment_uses_file_for_missing_value(self):
        self.write('AMO_JWT_ISSUER=file-issuer\nAMO_JWT_SECRET=file-secret\n')
        with mock.patch.dict(os.environ, {'AMO_JWT_ISSUER': 'env-issuer'}):
            self.assertEqual(sign.read_credentials(self.path), ('env-issuer', 'file-secret'))

    def test_reads_issuer_and_secret(self):
        self.write('# AMO\nAMO_JWT_ISSUER=user:1:2\nAMO_JWT_SECRET="abc=def"\n')
        self.assertEqual(sign.read_credentials(self.path), ("user:1:2", "abc=def"))

    def test_refuses_a_file_others_can_read(self):
        self.write("AMO_JWT_ISSUER=a\nAMO_JWT_SECRET=b\n", mode=0o644)
        with self.assertRaises(SystemExit) as ctx:
            sign.read_credentials(self.path)
        self.assertIn("chmod 600", str(ctx.exception))

    def test_reports_missing_keys(self):
        self.write("AMO_JWT_ISSUER=a\n")
        with self.assertRaises(SystemExit) as ctx:
            sign.read_credentials(self.path)
        self.assertIn("AMO_JWT_SECRET", str(ctx.exception))

    def test_reports_a_missing_file(self):
        with self.assertRaises(SystemExit) as ctx:
            sign.read_credentials(SCRATCH / "does-not-exist.env")
        self.assertIn("Missing", str(ctx.exception))


class SecretOutputTest(unittest.TestCase):
    def test_server_error_cannot_echo_credentials_to_output_or_exception(self):
        secret = 'fake-secret-never-print-012345'
        issuer = 'fake-issuer-never-print-012345'
        error = urllib.error.HTTPError('https://example.com/', 400, 'bad', {},
                                       io.BytesIO(f'{issuer} {secret}'.encode()))
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch('urllib.request.urlopen', side_effect=error), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as caught:
                sign.Amo(issuer, secret).request('GET', 'https://example.com/')
        for value in (secret, issuer):
            self.assertNotIn(value, stdout.getvalue() + stderr.getvalue() + str(caught.exception))
        self.assertIn('HTTP 400', str(caught.exception))
        error.close()

    def test_network_error_cannot_echo_credentials(self):
        secret = 'fake-secret-never-print-012345'
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch('urllib.request.urlopen', side_effect=urllib.error.URLError(secret)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(BaseException) as caught:
                sign.Amo('fake-issuer', secret).request('GET', 'https://example.com/')
        self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue() + str(caught.exception))

    def test_validation_messages_cannot_echo_credentials(self):
        secret = 'fake-secret-never-print-012345'
        issuer = 'fake-issuer-never-print-012345'
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            xpi = pathlib.Path(directory) / 'input.zip'
            xpi.write_bytes(b'zip')
            amo = sign.Amo(issuer, secret)
            replies = iter([{'uuid': 'u1'}, {'processed': True, 'valid': False,
                'validation': {'messages': [{'type': 'error', 'message': f'{issuer} {secret}'}]}}])
            stdout, stderr = io.StringIO(), io.StringIO()
            with mock.patch.object(amo, 'json', side_effect=lambda *a, **k: next(replies)), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as caught:
                    sign.sign(amo, xpi, '{abc}', '1.0.0', pathlib.Path(directory) / 'out.xpi')
            for value in (secret, issuer):
                self.assertNotIn(value, stdout.getvalue() + stderr.getvalue() + str(caught.exception))


class DownloadAuthorizationTest(unittest.TestCase):
    def test_api_uses_jwt_but_public_file_download_has_no_authorization(self):
        seen = []
        def transport(request, timeout):
            seen.append(request)
            return contextlib.closing(io.BytesIO(b'{}'))
        with mock.patch('urllib.request.urlopen', side_effect=transport):
            amo = sign.Amo('fake-issuer', 'fake-secret')
            amo.request('GET', sign.API + '/addons/addon/test/')
            amo.request('GET', 'https://addons.mozilla.org/f/1.xpi')
        self.assertTrue(seen[0].get_header('Authorization').startswith('JWT '))
        self.assertIsNone(seen[1].get_header('Authorization'))


class MultipartTest(unittest.TestCase):
    def test_encodes_fields_then_files(self):
        body, content_type = sign.encode_multipart(
            {"channel": "unlisted"},
            {"upload": ("a.zip", b"PK\x03\x04", "application/zip")},
            boundary="XYZ",
        )
        self.assertEqual(content_type, "multipart/form-data; boundary=XYZ")
        self.assertEqual(body, b"\r\n".join([
            b"--XYZ",
            b'Content-Disposition: form-data; name="channel"',
            b"",
            b"unlisted",
            b"--XYZ",
            b'Content-Disposition: form-data; name="upload"; filename="a.zip"',
            b"Content-Type: application/zip",
            b"",
            b"PK\x03\x04",
            b"--XYZ--",
            b"",
        ]))


class FakeAmo:
    def __init__(self, responses, download_error=None):
        self.responses = list(responses)
        self.download_error = download_error
        self.calls = []

    def json(self, method, url, payload=None, body=None, content_type=None):
        self.calls.append((method, url, payload, body, content_type))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    def request(self, method, url, body=None, content_type=None):
        self.calls.append((method, url, None, body, content_type))
        if self.download_error:
            raise self.download_error
        return b"SIGNED"


class SignFlowTest(unittest.TestCase):
    def setUp(self):
        progress = mock.patch("builtins.print")
        progress.start()
        self.addCleanup(progress.stop)
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.xpi = SCRATCH / "foxy-1.0.0.zip"
        self.xpi.write_bytes(b"PK")
        self.out = SCRATCH / "foxy-1.0.0-signed.xpi"
        self.part = self.out.with_suffix(".xpi.part")
        self.out.unlink(missing_ok=True)
        self.part.unlink(missing_ok=True)

    def test_uploads_waits_submits_waits_and_downloads(self):
        amo = FakeAmo([
            {"uuid": "u1", "processed": False},
            {"uuid": "u1", "processed": False},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
            {"file": {"status": "unreviewed"}},
            {"file": {"status": "public", "url": "https://addons.mozilla.org/f/1.xpi"}},
        ])
        sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assertEqual(self.out.read_bytes(), b"SIGNED")
        self.assertFalse(self.part.exists())
        self.assertEqual([c[0] for c in amo.calls], ["POST", "GET", "GET", "POST", "GET", "GET", "GET"])
        self.assertEqual(amo.calls[0][1], "https://addons.mozilla.org/api/v5/addons/upload/")
        upload_body, upload_type = amo.calls[0][3:]
        self.assertTrue(upload_type.startswith("multipart/form-data; boundary="))
        self.assertIn(b'Content-Disposition: form-data; name="channel"\r\n\r\nunlisted\r\n', upload_body)
        self.assertIn(
            b'Content-Disposition: form-data; name="upload"; filename="foxy-1.0.0.zip"\r\n'
            b'Content-Type: application/zip\r\n\r\nPK\r\n',
            upload_body,
        )
        self.assertEqual(amo.calls[1][1], "https://addons.mozilla.org/api/v5/addons/upload/u1/")
        self.assertEqual(amo.calls[3][1], "https://addons.mozilla.org/api/v5/addons/addon/%7Babc%7D/versions/")
        self.assertEqual(amo.calls[3][2], {"upload": "u1", "license": "MIT"})
        self.assertEqual(
            amo.calls[4][1],
            "https://addons.mozilla.org/api/v5/addons/addon/%7Babc%7D/versions/v1.0.0/",
        )
        self.assertEqual(amo.calls[6][1], "https://addons.mozilla.org/f/1.xpi")

    def test_stops_when_validation_fails(self):
        amo = FakeAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": False,
             "validation": {"messages": [{"type": "error", "message": "bad manifest"}]}},
        ])
        with self.assertRaises(SystemExit):
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assertEqual([c[0] for c in amo.calls], ["POST", "GET"])
        self.assertFalse(self.out.exists())

    def assert_submitted_message(self, error):
        message = str(error)
        self.assertIn("already submitted", message)
        self.assertIn("https://addons.mozilla.org/developers/addon/%7Babc%7D/versions", message)
        self.assertIn("version bump", message)
        self.assertFalse(self.out.exists())

    def test_stops_when_amo_disables_the_version(self):
        amo = FakeAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
            {"file": {"status": "disabled"}},
        ])
        with self.assertRaises(SystemExit) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assert_submitted_message(ctx.exception)
        self.assertIn("rejected or disabled", str(ctx.exception))
        self.assertIn("Check why at", str(ctx.exception))
        self.assertNotIn("download", str(ctx.exception).lower())

    def test_timeout_after_submit_explains_how_to_recover(self):
        class PendingAmo(FakeAmo):
            def json(self, method, url, payload=None, body=None, content_type=None):
                if method == "GET" and "/versions/" in url:
                    self.calls.append((method, url, payload, body, content_type))
                    return {"file": {"status": "unreviewed"}}
                return super().json(method, url, payload, body, content_type)

        amo = PendingAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
        ])
        with self.assertRaises(SystemExit) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0, timeout=0)
        self.assert_submitted_message(ctx.exception)
        self.assertIn("Timed out waiting for signing", str(ctx.exception))

    def test_http_error_during_polling_after_submit_explains_how_to_recover(self):
        amo = FakeAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
            SystemExit("GET failed: HTTP 500\nserver broke"),
        ])
        with self.assertRaises(SystemExit) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assert_submitted_message(ctx.exception)
        self.assertIn("HTTP 500\nserver broke", str(ctx.exception))

    def test_http_error_during_download_after_submit_explains_how_to_recover(self):
        amo = FakeAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
            {"file": {"status": "public", "url": "https://addons.mozilla.org/f/1.xpi"}},
        ], download_error=SystemExit("GET failed: HTTP 503"))
        with self.assertRaises(SystemExit) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assert_submitted_message(ctx.exception)
        self.assertIn("GET failed: HTTP 503", str(ctx.exception))

    def test_polling_errors_after_submit_keep_the_cause(self):
        for error in (
            urllib.error.URLError("network down"),
            TimeoutError("poll timed out"),
            ConnectionResetError("peer reset"),
            http.client.RemoteDisconnected("remote disconnected"),
            ValueError("invalid JSON"),
            KeyboardInterrupt("poll interrupted"),
        ):
            with self.subTest(error=type(error).__name__):
                amo = FakeAmo([
                    {"uuid": "u1"},
                    {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
                    {"id": 1},
                    error,
                ])
                with self.assertRaises(BaseException) as ctx:
                    sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
                self.assertIsInstance(ctx.exception, SystemExit)
                self.assert_submitted_message(ctx.exception)
                self.assertIn(str(error), str(ctx.exception))

    def test_bare_keyboard_interrupt_after_submit_names_the_cause(self):
        amo = FakeAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
            KeyboardInterrupt(),
        ])
        with self.assertRaises(SystemExit) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assert_submitted_message(ctx.exception)
        self.assertTrue(str(ctx.exception).startswith("Interrupted (KeyboardInterrupt)\n"))

    def test_partial_write_failure_after_submit_cleans_up_and_keeps_the_cause(self):
        amo = FakeAmo([
            {"uuid": "u1"},
            {"uuid": "u1", "processed": True, "valid": True, "validation": {"messages": []}},
            {"id": 1},
            {"file": {"status": "public", "url": "https://addons.mozilla.org/f/1.xpi"}},
        ])
        real_write_bytes = pathlib.Path.write_bytes

        def fail_after_partial_write(path, data):
            real_write_bytes(path, data[:3])
            raise OSError("disk full")

        with mock.patch.object(pathlib.Path, "write_bytes", fail_after_partial_write):
            with self.assertRaises(SystemExit) as ctx:
                sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assert_submitted_message(ctx.exception)
        self.assertIn("disk full", str(ctx.exception))
        self.assertFalse(self.part.exists(), "a failed write must not leave a partial download")

    def test_pre_submit_error_does_not_claim_submission(self):
        amo = FakeAmo([urllib.error.URLError("upload offline")])
        with self.assertRaises(urllib.error.URLError) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, channel="unlisted", interval=0)
        self.assertIn("upload offline", str(ctx.exception))
        self.assertFalse(self.out.exists())


class ListedSignTest(unittest.TestCase):
    setUp = SignFlowTest.setUp
    def test_listed_creates_version_with_source_and_review_notes(self):
        source = SCRATCH / 'source.zip'
        source.write_bytes(b'SOURCE')
        amo = FakeAmo([
            {'uuid': 'u1'}, {'uuid': 'u1', 'processed': True, 'valid': True},
            {'id': 42}, {},
            {'version': '1.0.0', 'channel': 'listed', 'file': {
                'status': 'public', 'url': 'https://addons.mozilla.org/f/1.xpi'}},
        ])
        result = sign.sign(amo, self.xpi, '{abc}', '1.0.0', self.out,
                           source=source, notes='No account needed.', interval=0)
        self.assertIn(b'\r\nlisted\r\n', amo.calls[0][3])
        create = amo.calls[2]
        self.assertEqual(create[:2], ('POST', sign.API + '/addons/addon/%7Babc%7D/versions/'))
        for field in [b'name="source"; filename="source.zip"', b'SOURCE',
                      b'name="upload"\r\n\r\nu1', b'name="license"\r\n\r\nMIT']:
            self.assertIn(field, create[3])
        self.assertEqual(amo.calls[3][2], {'approval_notes': 'No account needed.'})
        self.assertEqual(result['status'], 'signed')
        self.assertEqual(result['url'], 'https://addons.mozilla.org/f/1.xpi')
        self.assertEqual(json.loads(self.out.with_name('foxy-1.0.0-status.json').read_text()), result)

    def test_listed_pending_is_success_and_leaves_no_signed_asset(self):
        amo = FakeAmo([{'uuid': 'u1'}, {'uuid': 'u1', 'processed': True, 'valid': True},
                       {'id': 42}, {'version': '1.0.0', 'channel': 'listed',
                                   'file': {'status': 'unreviewed'}}])
        result = sign.sign(amo, self.xpi, '{abc}', '1.0.0', self.out,
                           timeout=0, interval=0)
        self.assertEqual(result['status'], 'pending')
        self.assertFalse(self.out.exists())
        self.assertEqual(json.loads(self.out.with_name('foxy-1.0.0-status.json').read_text())['status'], 'pending')

    def test_disabled_writes_rejected_status(self):
        amo = FakeAmo([{'uuid': 'u1'}, {'uuid': 'u1', 'processed': True, 'valid': True},
                       {'id': 42}, {'file': {'status': 'disabled'}}])
        with self.assertRaises(SystemExit):
            sign.sign(amo, self.xpi, '{abc}', '1.0.0', self.out, timeout=0)
        self.assertEqual(json.loads(self.out.with_name('foxy-1.0.0-status.json').read_text())['status'], 'rejected')

    def test_fetch_only_never_uploads_or_submits(self):
        amo = FakeAmo([{'version': '1.0.0', 'channel': 'listed', 'file': {
            'status': 'public', 'url': 'https://addons.mozilla.org/f/1.xpi'}}])
        result = sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)
        self.assertEqual(result['status'], 'signed')
        self.assertEqual([c[0] for c in amo.calls], ['GET', 'GET'])

    def test_fetch_only_skips_unlisted_versions(self):
        amo = FakeAmo([{'version': '1.0.0', 'channel': 'unlisted', 'file': {
            'status': 'public', 'url': 'https://addons.mozilla.org/f/1.xpi'}}])
        result = sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)
        self.assertEqual(result['status'], 'pending')
        self.assertFalse(self.out.exists())

    def test_fetch_only_missing_version_is_pending(self):
        amo = FakeAmo([sign.AmoError(404, 'Not found.')])
        self.assertEqual(sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)['status'], 'pending')

    def test_new_version_404_is_polled_until_public_within_wait(self):
        amo = FakeAmo([sign.AmoError(404, 'Not visible yet.'),
            {'version': '1.0.0', 'channel': 'listed', 'file': {
                'status': 'public', 'url': 'https://addons.mozilla.org/f/1.xpi'}}])
        result = sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, interval=0, timeout=1)
        self.assertEqual(result['status'], 'signed')
        self.assertEqual(self.out.read_bytes(), b'SIGNED')

    def test_fetch_only_http_errors_other_than_404_are_not_pending(self):
        amo = FakeAmo([sign.AmoError(403, 'Not allowed.')])
        with self.assertRaises(SystemExit) as caught:
            sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)
        self.assertIn('Not allowed.', str(caught.exception))

    def test_failed_fetch_does_not_leave_stale_success_status(self):
        path = self.out.with_name('foxy-1.0.0-status.json')
        path.write_text('{"status":"signed"}')
        amo = FakeAmo([sign.AmoError(500, 'Server down')])
        with self.assertRaises(SystemExit):
            sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)
        self.assertFalse(path.exists())

    def test_a_public_response_without_listed_channel_cannot_be_published(self):
        amo = FakeAmo([{'version': '1.0.0', 'file': {
            'status': 'public', 'url': 'https://example.com/foxy.xpi'}}])
        self.assertEqual(sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)['status'], 'pending')
        self.assertFalse(self.out.exists())

    def test_public_download_rejects_an_insecure_url(self):
        amo = FakeAmo([{'version': '1.0.0', 'channel': 'listed', 'file': {
            'status': 'public', 'url': 'http://example.com/unsigned.xpi'}}])
        with self.assertRaises(SystemExit):
            sign.fetch_signed(amo, '{abc}', '1.0.0', self.out, timeout=0)
        self.assertFalse(self.out.exists())


class MainTest(unittest.TestCase):
    def test_main_signs_the_foxy_zip_using_the_extension_manifest(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = pathlib.Path(directory)
            (root / "extension").mkdir()
            (root / "extension" / "manifest.json").write_text(json.dumps({
                "version": "2.3.4",
                "browser_specific_settings": {"gecko": {"id": "{abc}"}},
            }))
            (root / "dist").mkdir()
            xpi = root / "dist" / "foxy-2.3.4.zip"
            xpi.write_bytes(b"PK")
            with (
                mock.patch.object(sign, "ROOT", root),
                mock.patch.object(sign, "read_credentials", return_value=("issuer", "test-secret")) as credentials,
                mock.patch.object(sign, "Amo") as client,
                mock.patch.object(sign, "sign") as sign_addon,
            ):
                sign.main(["--channel", "unlisted"])
            credentials.assert_called_once_with()
            client.assert_called_once_with("issuer", "test-secret")
            sign_addon.assert_called_once_with(
                client.return_value, xpi, "{abc}", "2.3.4",
                root / "dist" / "foxy-2.3.4-signed.xpi", channel="unlisted", source=None, timeout=900,
                notes=None,
            )
            self.assertEqual(
                sign.CREDENTIALS,
                pathlib.Path.home() / ".config" / "liquidfox-newtab" / "amo.env",
            )


class ListedCliTest(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        for path in ['extension', 'dist', 'docs/amo']:
            (self.root / path).mkdir(parents=True)
        (self.root / 'extension/manifest.json').write_text(json.dumps({'version': '2.3.4',
            'browser_specific_settings': {'gecko': {'id': '{abc}'}}}))
        (self.root / 'dist/foxy-2.3.4.zip').write_bytes(b'zip')
        self.source = self.root / 'source.zip'
        self.source.write_bytes(b'source')
        (self.root / 'docs/amo/review-notes.md').write_text('No account needed.')

    def test_default_is_listed_with_source_notes_and_wait_in_minutes(self):
        with mock.patch.object(sign, 'ROOT', self.root), \
             mock.patch.object(sign, 'read_credentials', return_value=('issuer', 'fake-secret')), \
             mock.patch.object(sign, 'Amo') as client, mock.patch.object(sign, 'sign') as submit:
            sign.main(['--source', str(self.source), '--wait', '1.5'])
        self.assertEqual(submit.call_args.kwargs, {'channel': 'listed', 'source': self.source,
                         'timeout': 90, 'notes': 'No account needed.'})

    def test_missing_source_and_invalid_wait_fail_before_credentials_or_network(self):
        for args in [[], ['--source', str(self.source), '--wait', '-1'],
                     ['--source', str(self.source), '--wait', 'nan']]:
            with self.subTest(args=args), mock.patch.object(sign, 'ROOT', self.root), \
                 mock.patch.object(sign, 'read_credentials') as credentials, \
                 contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                sign.main(args)
            credentials.assert_not_called()

    def test_fetch_only_uses_requested_version_without_a_build(self):
        with mock.patch.object(sign, 'ROOT', self.root), \
             mock.patch.object(sign, 'read_credentials', return_value=('issuer', 'fake-secret')), \
             mock.patch.object(sign, 'fetch_signed') as fetch:
            sign.main(['--fetch-only', '--version', '1.2.3', '--wait', '0'])
        self.assertEqual(fetch.call_args.args[1:], ('{abc}', '1.2.3',
                         self.root / 'dist/foxy-1.2.3-signed.xpi'))
        self.assertEqual(fetch.call_args.kwargs, {'channel': 'listed', 'timeout': 0})


if __name__ == "__main__":
    unittest.main()
