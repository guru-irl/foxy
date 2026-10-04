#!/usr/bin/env python3
"""Check external-link duplicate switching in headless, throwaway Firefox."""

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

import smoke_firefox as smoke

ROOT = Path(__file__).resolve().parent.parent

OPEN_EXTERNAL = """
    const command = Cu.createCommandLine(["-url", arguments[0]],
        Services.dirsvc.get("CurWorkD", Ci.nsIFile), Ci.nsICommandLine.STATE_REMOTE_EXPLICIT);
    Cc["@mozilla.org/browser/final-clh;1"].createInstance(Ci.nsICommandLineHandler).handle(command);
"""

STATE = """
    return {background: WebExtensionPolicy.getByID(arguments[0]).extension.backgroundState,
        events: window.__switchEvents,
        tabs: gBrowser.tabs.map(tab => ({panel: tab.linkedPanel,
            url: tab.linkedBrowser.currentURI.spec, selected: tab.selected,
            collapsed: tab.group?.collapsed ?? null}))};
"""


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/slow"):
            time.sleep(2)
        body = b"<title>Switch smoke</title><p>Local switch regression</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def check_link(client, url, *, suspend, scratch, label):
    panel = client.script("""
        const tab = gBrowser.addTab(arguments[0], {inBackground: true,
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
        const group = gBrowser.addTabGroup([tab], {label: 'Switch smoke'});
        group.collapsed = true;
        return tab.linkedPanel;
    """, [url], chrome=True)
    smoke.poll("match loaded", lambda: client.script("""
        const tab = gBrowser.tabs.find(tab => tab.linkedPanel === arguments[0]);
        return tab.linkedBrowser.currentURI.spec === arguments[1]
            && !tab.linkedBrowser.webProgress.isLoadingDocument;
    """, [panel, url], chrome=True), bool)
    if suspend:
        smoke.poll("background suspended", lambda: client.script(STATE, [smoke.ADDON_ID], chrome=True),
                   lambda state: state["background"] == "stopped")
    else:
        # Wake explicitly for the awake case, without affecting session start.
        client.script("""
            const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
            await extension.wakeupBackground();
        """, [smoke.ADDON_ID], chrome=True)
    before = client.script(STATE, [smoke.ADDON_ID], chrome=True)["background"]
    client.script("window.__switchEvents.length = 0;", chrome=True)
    client.script(OPEN_EXTERNAL, [url], chrome=True)
    state = smoke.poll("external duplicate closed", lambda: client.script(STATE, [smoke.ADDON_ID], chrome=True),
                       lambda state: any(event["type"] == "TabClose" for event in state["events"]))
    (scratch / (label + ".json")).write_text(json.dumps(state, indent=2), encoding="utf-8")
    opens = [event["panel"] for event in state["events"] if event["type"] == "TabOpen"]
    closes = [event["panel"] for event in state["events"] if event["type"] == "TabClose"]
    match = next(tab for tab in state["tabs"] if tab["panel"] == panel)
    if len(opens) != 1 or closes != opens or any(tab["panel"] == opens[0] for tab in state["tabs"]):
        raise RuntimeError(f"wrong duplicate close: {state!r}")
    if not match["selected"] or match["collapsed"] is not False:
        raise RuntimeError(f"match not active and expanded: {state!r}")
    ordered = [event["type"] for event in state["events"]
               if event["type"] in ["TabGroupExpand", "TabSelect", "TabClose"]
               and (event["type"] == "TabGroupExpand" or event["panel"] in [panel, opens[0]])]
    # Initial TabSelect selects the external tab. Expansion must then precede
    # selection of the match, and its duplicate must be the only closed tab.
    expand = ordered.index("TabGroupExpand")
    if ordered[expand:] != ["TabGroupExpand", "TabSelect", "TabClose"]:
        raise RuntimeError(f"wrong switch order: {ordered!r}")
    return f"background {before}; expanded and selected match; closed only external duplicate"


def run(root=ROOT):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    scratch = smoke.safe_profile_path(Path(root) / ".spider" / "scratch" / ("switch-smoke-" + stamp))
    scratch.mkdir(parents=True)
    results = smoke.Results()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = process = base = None
    try:
        profile = scratch / "profile"
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        smoke.write_profile(profile, port)
        with (profile / "user.js").open("a") as prefs:
            prefs.write('user_pref("extensions.background.idle.timeout", 3000);\n')
        temp = scratch / "tmp"
        temp.mkdir()
        with (scratch / "firefox.log").open("wb") as log:
            process = subprocess.Popen([smoke.FIREFOX, "--headless", "--no-remote", "--marionette",
                "--remote-allow-system-access", "-profile", str(profile), "about:blank"],
                env={**os.environ, "TMPDIR": str(temp), "TMP": str(temp), "TEMP": str(temp)},
                start_new_session=True, stdout=log, stderr=log)
            client = smoke.connect_firefox(process, port)
            client.command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"timeouts": {"script": 10000}}}})
            client.command("Addon:Install", {"path": str(Path(root) / "extension"), "temporary": True})
            installed = time.monotonic()
            base = client.script("return WebExtensionPolicy.getByID(arguments[0]).getURL('');",
                                 [smoke.ADDON_ID], chrome=True)
            client.script("""
                window.__switchEvents = [];
                const panels = new WeakMap();
                for (const type of ['TabOpen', 'TabSelect', 'TabClose', 'TabGroupExpand']) {
                    gBrowser.tabContainer.addEventListener(type, event => {
                        if (event.target.linkedPanel) panels.set(event.target, event.target.linkedPanel);
                        window.__switchEvents.push({type, panel: panels.get(event.target) ?? null});
                    });
                }
            """, chrome=True)
            # Startup exclusion is a real browser-session rule, not a test override.
            smoke.poll("startup window elapsed", lambda: time.monotonic() - installed,
                       lambda elapsed: elapsed >= 16)
            origin = f"http://127.0.0.1:{server.server_address[1]}"
            results.check("external link into collapsed group", lambda: check_link(client, origin + "/fast",
                          suspend=False, scratch=scratch, label="awake"))
            results.check("external link after idle wake (slow commit)", lambda: check_link(client, origin + "/slow",
                          suspend=True, scratch=scratch, label="idle"))
    except smoke.CheckFailed:
        pass
    except Exception as error:
        try:
            results.record("harness", False, str(error))
        except smoke.CheckFailed:
            pass
    finally:
        try:
            if client is not None and base is not None:
                smoke.check_console(client, base, scratch, results)
        finally:
            smoke.quit_firefox(client, process)
            server.shutdown()
            server.server_close()
            print(f"Scratch: {scratch}", flush=True)
    return results.exit_code


if __name__ == "__main__":
    sys.exit(run())
