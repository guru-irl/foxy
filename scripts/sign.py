#!/usr/bin/env python3
"""Sign the add-on as an unlisted addons.mozilla.org add-on and download the .xpi.

Needs ~/.config/liquidfox-newtab/amo.env, readable only by you (chmod 600):

    AMO_JWT_ISSUER=user:12345:67
    AMO_JWT_SECRET=...

Create the key and secret at https://addons.mozilla.org/developers/addon/api/key/.

Usage: python3 scripts/build.py && python3 scripts/sign.py
Output: dist/foxy-<version>-signed.xpi
"""
import base64
import hashlib
import hmac
import http.client
import json
import pathlib
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://addons.mozilla.org/api/v5"
CREDENTIALS = pathlib.Path.home() / ".config" / "liquidfox-newtab" / "amo.env"
USER_AGENT = "foxy-sign/1.0"


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(issuer, secret, now=None, jti=None):
    """An HS256 JWT with the claims AMO wants: iss, jti, iat and exp (60 s later)."""
    now = int(time.time()) if now is None else now
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"iss": issuer, "jti": jti or str(uuid.uuid4()), "iat": now, "exp": now + 60}
    signing_input = ".".join(
        b64url(json.dumps(part, separators=(",", ":")).encode()) for part in (header, payload)
    )
    signature = hmac.new(secret.encode(), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(signature)}"


def read_credentials(path=CREDENTIALS):
    """AMO_JWT_ISSUER and AMO_JWT_SECRET from a KEY=VALUE file only its owner can read."""
    if not path.exists():
        raise SystemExit(
            f"Missing {path}. Create it with AMO_JWT_ISSUER=... and AMO_JWT_SECRET=... (chmod 600)."
        )
    if path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit(f"{path} is readable by other users. Run: chmod 600 '{path}'")
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    missing = [key for key in ("AMO_JWT_ISSUER", "AMO_JWT_SECRET") if not values.get(key)]
    if missing:
        raise SystemExit(f"{path} is missing {', '.join(missing)}")
    return values["AMO_JWT_ISSUER"], values["AMO_JWT_SECRET"]


def encode_multipart(fields, files, boundary=None):
    """fields {name: str}, files {name: (filename, bytes, content_type)} -> (body, content_type)."""
    boundary = boundary or uuid.uuid4().hex
    lines = []
    for name, value in fields.items():
        lines += [
            f"--{boundary}".encode(),
            f'Content-Disposition: form-data; name="{name}"'.encode(),
            b"",
            value.encode(),
        ]
    for name, (filename, data, content_type) in files.items():
        lines += [
            f"--{boundary}".encode(),
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'.encode(),
            f"Content-Type: {content_type}".encode(),
            b"",
            data,
        ]
    lines += [f"--{boundary}--".encode(), b""]
    return b"\r\n".join(lines), f"multipart/form-data; boundary={boundary}"


class Amo:
    """Minimal AMO v5 client; every request carries a fresh JWT."""

    def __init__(self, issuer, secret):
        self.issuer = issuer
        self.secret = secret

    def request(self, method, url, body=None, content_type=None):
        headers = {
            "Authorization": f"JWT {make_jwt(self.issuer, self.secret)}",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        }
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:2000]
            raise SystemExit(f"{method} {url} failed: HTTP {err.code}\n{detail}")

    def json(self, method, url, payload=None, body=None, content_type=None):
        if payload is not None:
            body, content_type = json.dumps(payload).encode(), "application/json"
        return json.loads(self.request(method, url, body, content_type) or b"{}")


def wait(check, what, interval, timeout=900):
    """Call check() until it returns something other than None."""
    deadline = time.monotonic() + timeout
    while True:
        result = check()
        if result is not None:
            return result
        if time.monotonic() > deadline:
            raise SystemExit(f"Timed out waiting for {what}.")
        print(f"  waiting for {what}...")
        time.sleep(interval)


def sign(amo, xpi, guid, version, out, interval=5, timeout=900):
    """Upload (unlisted), wait for validation, submit, wait for signing, download."""
    guid_path = urllib.parse.quote(guid, safe="@")

    print(f"Uploading {xpi.name} (unlisted)...")
    body, content_type = encode_multipart(
        {"channel": "unlisted"},
        {"upload": (xpi.name, xpi.read_bytes(), "application/zip")},
    )
    upload = amo.json("POST", f"{API}/addons/upload/", body=body, content_type=content_type)
    upload_url = f"{API}/addons/upload/{upload['uuid']}/"

    def validated():
        current = amo.json("GET", upload_url)
        return current if current.get("processed") else None

    upload = wait(validated, "validation", interval)
    for message in (upload.get("validation") or {}).get("messages", []):
        print(f"  {message.get('type', '?')}: {message.get('message', '')}")
    if not upload.get("valid"):
        raise SystemExit("AMO validation failed; see the messages above.")

    print("Submitting the version...")
    amo.json("PUT", f"{API}/addons/addon/{guid_path}/", payload={"version": {"upload": upload["uuid"]}})
    version_url = f"{API}/addons/addon/{guid_path}/versions/v{version}/"

    def signed():
        file = amo.json("GET", version_url).get("file") or {}
        if file.get("status") == "disabled":
            raise SystemExit("AMO rejected or disabled this version.")
        return file if file.get("status") == "public" and file.get("url") else None

    part = out.with_suffix(".xpi.part")
    try:
        file = wait(signed, "signing", interval, timeout=timeout)
        part.write_bytes(amo.request("GET", file["url"]))
        part.replace(out)
    except (SystemExit, OSError, http.client.HTTPException, ValueError, KeyboardInterrupt) as err:
        part.unlink(missing_ok=True)
        cause = err.code if isinstance(err, SystemExit) and isinstance(err.code, str) else str(err)
        if not cause:
            cause = f"Interrupted ({type(err).__name__})"
        rejected = cause == "AMO rejected or disabled this version."
        summary = (
            "The version was already submitted. " if rejected else
            "Signing or download failed after the version was already submitted. "
        )
        recovery = "Check why at " if rejected else "Get the signed file at "
        raise SystemExit(
            f"{cause}\n{summary}"
            f"{recovery}https://addons.mozilla.org/developers/addon/{guid_path}/versions. "
            "Submitting again needs a version bump."
        ) from None
    print(f"Signed: {out}")


def main():
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text())
    version = manifest["version"]
    guid = manifest["browser_specific_settings"]["gecko"]["id"]
    xpi = ROOT / "dist" / f"foxy-{version}.zip"
    if not xpi.exists():
        raise SystemExit(f"Missing {xpi}. Run: python3 scripts/build.py")
    issuer, secret = read_credentials()
    sign(Amo(issuer, secret), xpi, guid, version, ROOT / "dist" / f"foxy-{version}-signed.xpi")


if __name__ == "__main__":
    main()
