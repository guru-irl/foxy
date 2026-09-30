#!/usr/bin/env python3
"""Run DOM tests in headless Firefox without dependencies or a real profile."""

import functools
import http.server
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parent.parent
FIREFOX = Path("/Applications/Firefox.app/Contents/MacOS/firefox")

PROFILE_PREFS = '''\
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_resumed_crashes", 0);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.systemAddon.update.enabled", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("extensions.htmlaboutaddons.recommendations.enabled", false);
user_pref("browser.discovery.enabled", false);
// Only the local HTTP harness bypasses an intentionally unreachable proxy.
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "127.0.0.1");
user_pref("network.proxy.http_port", 9);
user_pref("network.proxy.ssl", "127.0.0.1");
user_pref("network.proxy.ssl_port", 9);
user_pref("network.proxy.no_proxies_on", "127.0.0.1");
user_pref("network.proxy.allow_hijacking_localhost", true);
user_pref("network.proxy.failover_direct", false);
user_pref("network.trr.mode", 5);
'''


def parse_results(body):
    """Validate the page's result payload and format its ordered test results."""
    payload = json.loads(body)
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("expected a results array")
    passed, failed, lines = 0, 0, []
    for result in payload["results"]:
        if (not isinstance(result, dict) or not isinstance(result.get("name"), str)
                or type(result.get("ok")) is not bool
                or not isinstance(result.get("error", ""), str)):
            raise ValueError("expected name, boolean ok, and optional string error")
        if result["ok"]:
            passed += 1
            lines.append(f"✓ {result['name']}")
        else:
            failed += 1
            lines.append(f"✗ {result['name']}: {result.get('error', '')}")
    return passed, failed, lines


def exit_code(passed, failed, timed_out):
    if timed_out:
        return 2
    return 1 if failed else 0


def test_files(root):
    root = Path(root)
    return ["/" + path.relative_to(root).as_posix()
            for path in sorted((root / "test" / "browser").glob("*.test.js"))]


class ResultsHandler(http.server.SimpleHTTPRequestHandler):
    # Some hosts serve .js as application/octet-stream, which modules reject.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript"}

    def log_message(self, *args):
        pass

    def do_POST(self):
        if urlsplit(self.path).path != "/results":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 2_000_000:
                raise ValueError("invalid result size")
            parsed = parse_results(self.rfile.read(size))
        except (ValueError, UnicodeError) as error:
            self.send_error(400, str(error))
            return
        self.send_response(204)
        self.end_headers()
        # Only the first valid report belongs to this run.
        try:
            self.server.results.put_nowait(parsed)
        except queue.Full:
            pass


def terminate_firefox(process):
    """Signal the whole isolated group, even if the Firefox parent has exited."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # A child can outlive its parent or ignore SIGTERM.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run(root, files, *, firefox=FIREFOX, timeout=120):
    root = Path(root).resolve()
    scratch = root / ".spider" / "scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(ResultsHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.results = queue.Queue(maxsize=1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix="browser-test-", dir=scratch) as directory:
            directory = Path(directory)
            profile = directory / "browser-test-profile"
            profile.mkdir()
            (profile / "user.js").write_text(PROFILE_PREFS)
            temp = directory / "tmp"
            temp.mkdir()
            url = (f"http://127.0.0.1:{server.server_port}/test/browser/run.html?"
                   + urlencode({"files": ",".join(files)}))
            try:
                process = subprocess.Popen(
                    [str(firefox), "--headless", "--no-remote", "-profile", str(profile), url],
                    env={**os.environ, "TMPDIR": str(temp)},
                    start_new_session=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except OSError as error:
                print(f"Foxy: could not launch Firefox: {error}")
                return 2
            try:
                passed, failed, lines = server.results.get(timeout=timeout)
            except queue.Empty:
                print(f"Foxy: browser tests timed out after {timeout:g} s")
                return exit_code(0, 0, True)
            finally:
                # Kill before deleting the profile and TMPDIR, on every exit path.
                terminate_firefox(process)
                process = None
            for line in lines:
                print(line)
            print(f"{passed} passed, {failed} failed")
            return exit_code(passed, failed, False)
    finally:
        if process is not None:
            terminate_firefox(process)
        server.shutdown()
        server.server_close()
        thread.join()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    files = []
    for name in argv:
        path = Path(name)
        # Accept repo-relative paths, absolute filesystem paths and root URL paths.
        if name.startswith("/test/browser/"):
            path = ROOT / name.lstrip("/")
        elif not path.is_absolute():
            path = ROOT / path
        try:
            files.append("/" + path.resolve().relative_to(ROOT).as_posix())
        except ValueError:
            print(f"Foxy: test file is outside the worktree: {name}")
            return 2
    return run(ROOT, files if argv else test_files(ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
