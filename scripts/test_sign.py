import base64
import hashlib
import hmac
import http.client
import json
import os
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sign  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / "dist" / "test-sign"


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

    def write(self, text, mode=0o600):
        self.path.write_text(text)
        os.chmod(self.path, mode)

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
        self.xpi = SCRATCH / "x.zip"
        self.xpi.write_bytes(b"PK")
        self.out = SCRATCH / "x-signed.xpi"
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
        sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
        self.assertEqual(self.out.read_bytes(), b"SIGNED")
        self.assertFalse(self.part.exists())
        self.assertEqual([c[0] for c in amo.calls], ["POST", "GET", "GET", "PUT", "GET", "GET", "GET"])
        self.assertEqual(amo.calls[0][1], "https://addons.mozilla.org/api/v5/addons/upload/")
        upload_body, upload_type = amo.calls[0][3:]
        self.assertTrue(upload_type.startswith("multipart/form-data; boundary="))
        self.assertIn(b'Content-Disposition: form-data; name="channel"\r\n\r\nunlisted\r\n', upload_body)
        self.assertIn(
            b'Content-Disposition: form-data; name="upload"; filename="x.zip"\r\n'
            b'Content-Type: application/zip\r\n\r\nPK\r\n',
            upload_body,
        )
        self.assertEqual(amo.calls[1][1], "https://addons.mozilla.org/api/v5/addons/upload/u1/")
        self.assertEqual(amo.calls[3][1], "https://addons.mozilla.org/api/v5/addons/addon/%7Babc%7D/")
        self.assertEqual(amo.calls[3][2], {"version": {"upload": "u1"}})
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
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
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
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
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
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0, timeout=0)
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
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
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
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
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
                    sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
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
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
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
                sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
        self.assert_submitted_message(ctx.exception)
        self.assertIn("disk full", str(ctx.exception))
        self.assertFalse(self.part.exists(), "a failed write must not leave a partial download")

    def test_pre_submit_error_does_not_claim_submission(self):
        amo = FakeAmo([urllib.error.URLError("upload offline")])
        with self.assertRaises(urllib.error.URLError) as ctx:
            sign.sign(amo, self.xpi, "{abc}", "1.0.0", self.out, interval=0)
        self.assertIn("upload offline", str(ctx.exception))
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
