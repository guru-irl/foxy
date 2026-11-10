#!/usr/bin/env python3
"""Submit a listed or unlisted AMO version and download it when public.

Reads AMO_JWT_ISSUER and AMO_JWT_SECRET from the environment, then falls back
to ~/.config/liquidfox-newtab/amo.env, readable only by you (chmod 600):

    AMO_JWT_ISSUER=user:12345:67
    AMO_JWT_SECRET=...

Create the key and secret at https://addons.mozilla.org/developers/addon/api/key/.

Usage: python3 scripts/sign.py --source dist/foxy-<version>-source.zip --wait 15
The default channel is listed; --fetch-only reads a version without submitting it.
Output: dist/foxy-<version>-signed.xpi and dist/foxy-<version>-status.json.
Status fields: status (signed, pending, rejected), version, channel, and url when signed.
"""
import argparse
import base64
import hashlib
import hmac
import http.client
import json
import math
import re
import os
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
    """Read AMO credentials from the environment, then the owner-only file."""
    keys = ("AMO_JWT_ISSUER", "AMO_JWT_SECRET")
    values = {key: os.environ.get(key, "") for key in keys}
    if all(values.values()):
        return values[keys[0]], values[keys[1]]
    if not path.exists():
        raise SystemExit(f"Missing AMO_JWT_ISSUER or AMO_JWT_SECRET in the environment or {path} (chmod 600).")
    if path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit(f"{path} is readable by other users. Run: chmod 600 '{path}'")
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in keys and not values[key]:
            values[key] = value.strip().strip("\"'")
    missing = [key for key in keys if not values[key]]
    if missing:
        raise SystemExit(f"{path} and the environment are missing {', '.join(missing)}")
    return values[keys[0]], values[keys[1]]


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


def redact(text, amo):
    text = str(text)
    for value in (getattr(amo, "issuer", ""), getattr(amo, "secret", "")):
        if value:
            text = text.replace(value, "[redacted]")
    return text


class AmoError(SystemExit):
    """An AMO HTTP error with a status code and a redacted response body."""

    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def https_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or any(ord(char) <= 32 for char in url)):
        raise SystemExit("Expected an HTTPS URL without credentials or whitespace.")
    return url


class Amo:
    """AMO v5 client. Only API requests carry a fresh JWT."""

    def __init__(self, issuer, secret):
        self.issuer = issuer
        self.secret = secret

    def request(self, method, url, body=None, content_type=None):
        token = make_jwt(self.issuer, self.secret)
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        }
        if url.startswith(API + "/"):
            headers["Authorization"] = f"JWT {token}"
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:2000]
            raise AmoError(err.code, redact(f"{method} {url} failed: HTTP {err.code}\n{detail}", self).replace(token, "[redacted]")) from None
        except (OSError, http.client.HTTPException) as err:
            raise SystemExit(redact(f"{method} {url} failed: {err}", self)) from None

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


def write_status(out, version, channel, status, url=None):
    result = {"status": status, "version": version, "channel": channel}
    if url:
        result["url"] = url
    path = out.with_name(f"foxy-{version}-status.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".json.part")
    part.write_text(json.dumps(result, indent=2) + "\n")
    part.replace(path)
    return result


def fetch_signed(amo, guid, version, out, channel="listed", interval=5, timeout=900):
    """Only read an existing version. Pending review is a successful result."""
    guid_path = urllib.parse.quote(guid, safe="@")
    version_url = f"{API}/addons/addon/{guid_path}/versions/v{version}/"
    deadline = time.monotonic() + timeout
    part = out.with_suffix(".xpi.part")
    # Never leave a stale success from a previous run at this path.
    out.with_name(f"foxy-{version}-status.json").unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    part.unlink(missing_ok=True)
    try:
        while True:
            try:
                current = amo.json("GET", version_url)
            except AmoError as err:
                if err.status != 404:
                    raise
                current = {}
            file = current.get("file") or {}
            if current.get("version", version) != version:
                raise SystemExit("AMO returned a different version.")
            if current.get("is_disabled") or file.get("status") == "disabled":
                write_status(out, version, channel, "rejected")
                raise SystemExit("AMO rejected or disabled this version.")
            if current and current.get("channel", "unlisted") != channel:
                return write_status(out, version, channel, "pending")
            if file.get("status") == "public" and file.get("url"):
                url = https_url(file["url"])
                part.write_bytes(amo.request("GET", url))
                part.replace(out)
                print(f"Signed: {out}")
                return write_status(out, version, channel, "signed", url)
            if time.monotonic() >= deadline:
                return write_status(out, version, channel, "pending")
            print("  waiting for signing and publication...")
            time.sleep(min(interval, max(0, deadline - time.monotonic())))
    finally:
        part.unlink(missing_ok=True)


def sign(amo, xpi, guid, version, out, interval=5, timeout=900,
         channel="listed", source=None, notes=None):
    """Validate an upload, create its version with source, and wait for publication."""
    guid_path = urllib.parse.quote(guid, safe="@")
    status_path = out.with_name(f"foxy-{version}-status.json")
    status_path.unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    print(f"Uploading {xpi.name} ({channel})...")
    body, content_type = encode_multipart(
        {"channel": channel}, {"upload": (xpi.name, xpi.read_bytes(), "application/zip")})
    upload = amo.json("POST", f"{API}/addons/upload/", body=body, content_type=content_type)
    upload_url = f"{API}/addons/upload/{upload['uuid']}/"

    def validated():
        current = amo.json("GET", upload_url)
        return current if current.get("processed") else None

    upload = wait(validated, "validation", interval, timeout=timeout)
    for message in (upload.get("validation") or {}).get("messages", []):
        print(redact(f"  {message.get('type', '?')}: {message.get('message', '')}", amo))
    if not upload.get("valid"):
        write_status(out, version, channel, "rejected")
        raise SystemExit("AMO validation failed; see the messages above.")

    print("Submitting the version...")
    version_url = f"{API}/addons/addon/{guid_path}/versions/"
    fields = {"upload": upload["uuid"], "license": "MIT"}
    if source:
        body, content_type = encode_multipart(fields, {
            "source": (source.name, source.read_bytes(), "application/zip")})
        amo.json("POST", version_url, body=body, content_type=content_type)
    else:
        amo.json("POST", version_url, payload=fields)
    try:
        if notes:
            amo.json("PATCH", f"{version_url}v{version}/", payload={"approval_notes": notes})
        result = fetch_signed(amo, guid, version, out, channel, interval, timeout)
        if channel == "unlisted" and result["status"] == "pending":
            raise SystemExit("Timed out waiting for signing.")
        return result
    except (SystemExit, OSError, http.client.HTTPException, ValueError, KeyboardInterrupt) as err:
        cause = redact(err.code if isinstance(err, SystemExit) and isinstance(err.code, str) else str(err), amo)
        if not cause:
            cause = f"Interrupted ({type(err).__name__})"
        rejected = cause == "AMO rejected or disabled this version."
        summary = ("The version was already submitted. " if rejected else
                   "Signing or download failed after the version was already submitted. ")
        recovery = "Check why at " if rejected else "Get the signed file at "
        raise SystemExit(f"{cause}\n{summary}{recovery}"
            f"https://addons.mozilla.org/developers/addon/{guid_path}/versions. "
            "Submitting again needs a version bump.") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", choices=("listed", "unlisted"), default="listed")
    parser.add_argument("--source", type=pathlib.Path)
    parser.add_argument("--wait", type=float, default=15, metavar="MINUTES")
    parser.add_argument("--fetch-only", action="store_true", help="Read an existing version; never upload")
    parser.add_argument("--version", help="Version to read with --fetch-only")
    args = parser.parse_args(argv)
    if args.wait < 0 or not math.isfinite(args.wait):
        parser.error("--wait must be a finite non-negative number of minutes")
    if args.version and (not args.fetch_only or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version)):
        parser.error("--version requires --fetch-only and a version X.Y.Z")
    if not args.fetch_only and args.channel == "listed" and not args.source:
        parser.error("listed submissions require --source")
    if args.source and not args.source.is_file():
        parser.error("--source must be an existing file")
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text())
    version = args.version or manifest["version"]
    guid = manifest["browser_specific_settings"]["gecko"]["id"]
    out = ROOT / "dist" / f"foxy-{version}-signed.xpi"
    out.parent.mkdir(parents=True, exist_ok=True)
    xpi = ROOT / "dist" / f"foxy-{version}.zip"
    if not args.fetch_only and not xpi.exists():
        raise SystemExit(f"Missing {xpi}. Run: python3 scripts/build.py")
    issuer, secret = read_credentials()
    amo = Amo(issuer, secret)
    if args.fetch_only:
        fetch_signed(amo, guid, version, out, channel=args.channel, timeout=args.wait * 60)
    else:
        notes = (ROOT / "docs/amo/review-notes.md").read_text() if args.channel == "listed" else None
        sign(amo, xpi, guid, version, out, channel=args.channel, source=args.source,
             timeout=args.wait * 60, notes=notes)


if __name__ == "__main__":
    main()
