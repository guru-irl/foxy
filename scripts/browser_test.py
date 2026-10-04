#!/usr/bin/env python3
"""Run DOM tests in headless Firefox without dependencies or a real profile."""

import functools
import http.server
import json
import os
from pathlib import Path
import queue
import signal
import shutil
import subprocess
import sys

from firefox_env import firefox_environment
import tempfile
import threading
import time
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
user_pref("widget.macos.overlay-scrollbars", 0);
user_pref("ui.useOverlayScrollbars", 0);
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
        route = urlsplit(self.path).path
        if route not in ("/results", "/progress"):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 2_000_000:
                raise ValueError("invalid result size")
            body = self.rfile.read(size)
            if route == "/progress":
                progress = json.loads(body)
                if not isinstance(progress, dict) or not isinstance(progress.get("name"), str):
                    raise ValueError("expected a progress test name")
                self.server.last_test = progress["name"]
                self.send_response(204)
                self.end_headers()
                return
            parsed = parse_results(body)
        except (ValueError, UnicodeError) as error:
            self.send_error(400, str(error))
            if route == "/results":
                self.report(str(error))
            return
        self.send_response(204)
        self.end_headers()
        self.report(parsed)

    def report(self, outcome):
        # The first report, including an invalid payload, completes the run.
        try:
            self.server.results.put_nowait(outcome)
        except queue.Full:
            pass


def terminate_firefox(process):
    """Signal the isolated group even after parent exit; tolerate zombie-only EPERM."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # A child can outlive its parent or ignore SIGTERM.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        process.wait()


def run(root, files, *, firefox=FIREFOX, timeout=120):
    root = Path(root).resolve()
    scratch = root / ".spider" / "scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(ResultsHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.results = queue.Queue(maxsize=1)
    server.last_test = None
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
            log_path = directory / "firefox.log"
            retain_log = False
            try:
                with firefox_environment(directory) as env, log_path.open("wb") as log:
                    try:
                        process = subprocess.Popen(
                            [str(firefox), "--headless", "--no-remote", "-profile", str(profile), url],
                            env=env,
                            start_new_session=True, stdout=log, stderr=log,
                        )
                    except OSError as error:
                        retain_log = True
                        print(f"Foxy: could not launch Firefox: {error}")
                        return 2
                    try:
                        deadline = time.monotonic() + timeout
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                retain_log = True
                                detail = f"; last test started: {server.last_test}" if server.last_test else ""
                                print(f"Foxy: browser tests timed out after {timeout:g} s{detail}")
                                return 2
                            try:
                                outcome = server.results.get(timeout=min(0.1, remaining))
                                break
                            except queue.Empty:
                                if process.poll() is not None:
                                    retain_log = True
                                    print(f"Foxy: Firefox exited before reporting results (exit {process.returncode})")
                                    return 2
                        if isinstance(outcome, str):
                            retain_log = True
                            print(f"Foxy: invalid browser results: {outcome}")
                            return 2
                        passed, failed, lines = outcome
                        if files and passed + failed == 0:
                            failed, lines = 1, ["✗ browser test discovery: no tests registered"]
                        for line in lines:
                            print(line)
                        print(f"{passed} passed, {failed} failed")
                        return exit_code(passed, failed, False)
                    finally:
                        # Kill before deleting the profile and TMPDIR, on every exit path.
                        terminate_firefox(process)
                        process = None
            finally:
                if retain_log:
                    saved_log = scratch / (directory.name + ".log")
                    shutil.copyfile(log_path, saved_log)
                    print(f"Foxy: Firefox log: {saved_log}")
    finally:
        if process is not None:
            terminate_firefox(process)
        server.shutdown()
        server.server_close()
        thread.join()


def _main(argv, firefox):
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
    return run(ROOT, files if argv else test_files(ROOT), firefox=firefox)


def main(argv=None, *, firefox=FIREFOX):
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGHUP)}

    def interrupted(sig, frame):
        # A second termination signal must not interrupt cleanup.
        for handled in previous:
            signal.signal(handled, signal.SIG_IGN)
        raise SystemExit(128 + sig)

    try:
        for sig in previous:
            signal.signal(sig, interrupted)
        return _main(argv, firefox)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
