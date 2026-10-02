#!/usr/bin/env python3
"""Smoke-test the unpacked extension in real Firefox, never a user's profile."""

import argparse
import base64
from datetime import datetime, timezone
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import time
import threading

ROOT = Path(__file__).resolve().parent.parent
FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
ADDON_ID = "{4408f971-7930-41ea-9f93-b01231e40861}"
SMOKE_URL = "https://example.com/"
WAIT_SECONDS = 25
MAX_FRAME = 64 * 1024 * 1024


def encode_message(message):
    """Marionette lengths count UTF-8 bytes, not Unicode characters."""
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return str(len(body)).encode("ascii") + b":" + body


def decode_message(stream):
    """Read exactly one length-prefixed JSON frame, allowing fragmented reads."""
    prefix = bytearray()
    while True:
        byte = stream.read(1)
        if not byte:
            raise EOFError("Marionette closed connection before frame header")
        if byte == b":":
            break
        if not b"0" <= byte <= b"9" or len(prefix) >= 9:
            raise ValueError("invalid Marionette frame length")
        prefix.extend(byte)
    if not prefix or not 0 < int(prefix) <= MAX_FRAME:
        raise ValueError("invalid Marionette frame length")
    remaining = int(prefix)
    body = bytearray()
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("Marionette closed connection during frame body")
        body.extend(chunk)
        remaining -= len(chunk)
    return json.loads(body)


def safe_profile_path(path, *, home=None):
    """Refuse real Firefox directories and volatile scratch, including symlinks."""
    path = Path(path).expanduser().resolve()
    home = Path.home() if home is None else Path(home)
    forbidden = [home / "Library" / "Application Support" / "Firefox",
                 home / ".mozilla" / "firefox", home / "AppData" / "Roaming" / "Mozilla" / "Firefox",
                 Path("/tmp"), Path("/var/tmp"), Path("/private/tmp"), Path("/private/var/tmp")]
    for directory in forbidden:
        directory = directory.resolve()
        if path == directory or directory in path.parents:
            raise ValueError(f"refusing profile/scratch path inside {directory}")
    return path


def profile_prefs(port):
    if type(port) is not int or not 0 < port < 65536:
        raise ValueError("Marionette port must be an integer from 1 to 65535")
    return {
        "marionette.port": port,
        "browser.shell.checkDefaultBrowser": False,
        "browser.startup.page": 0,
        "browser.startup.homepage": "about:blank",
        "browser.startup.homepage_override.mstone": "ignore",
        "startup.homepage_welcome_url": "",
        "startup.homepage_welcome_url.additional": "",
        "browser.aboutwelcome.enabled": False,
        "browser.sessionstore.resume_from_crash": False,
        "toolkit.telemetry.enabled": False,
        "toolkit.telemetry.unified": False,
        "datareporting.healthreport.uploadEnabled": False,
        "datareporting.policy.dataSubmissionEnabled": False,
        "extensions.autoDisableScopes": 0,
        "browser.tabs.groups.enabled": True,
        "toolkit.legacyUserProfileCustomizations.stylesheets": False,
        "extensions.update.enabled": False,
        "extensions.systemAddon.update.enabled": False,
        "extensions.getAddons.cache.enabled": False,
        "extensions.htmlaboutaddons.recommendations.enabled": False,
        "browser.discovery.enabled": False,
        # No external traffic, including AMO. A URL can sync without loading.
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": 9,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": 9,
        "network.proxy.no_proxies_on": "127.0.0.1,localhost",
        "network.proxy.failover_direct": False,
        "network.trr.mode": 5,
    }


def write_profile(profile, port):
    profile = safe_profile_path(profile)
    prefs = profile_prefs(port)
    profile.mkdir(parents=True, exist_ok=False)
    (profile / "user.js").write_text("".join(
        f"user_pref({json.dumps(key)}, {json.dumps(value)});\n"
        for key, value in prefs.items()), encoding="utf-8")


class CheckFailed(RuntimeError):
    pass


class Results:
    def __init__(self, keep_going=False):
        self.keep_going = keep_going
        self.outcomes = []

    def record(self, name, ok, detail=""):
        self.outcomes.append(bool(ok))
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f": {detail}" if detail else ""), flush=True)
        if not ok and not self.keep_going:
            raise CheckFailed(name)

    @property
    def exit_code(self):
        return 0 if self.outcomes and all(self.outcomes) else 1

    def check(self, name, action):
        try:
            detail = action()
        except Exception as error:
            self.record(name, False, str(error))
        else:
            self.record(name, True, detail or "")


class Marionette:
    def __init__(self, sock):
        self.sock = sock
        self.stream = sock.makefile("rb")
        self.counter = 0
        self.handshake = decode_message(self.stream)

    def command(self, name, params=None):
        self.counter += 1
        self.sock.sendall(encode_message([0, self.counter, name, params or {}]))
        response = decode_message(self.stream)
        if not isinstance(response, list) or len(response) != 4 or response[:2] != [1, self.counter]:
            raise RuntimeError(f"unexpected Marionette response: {response!r}")
        if response[2] is not None:
            raise RuntimeError(f"{name}: {json.dumps(response[2], ensure_ascii=False)}")
        return response[3]

    def script(self, source, args=None, *, chrome=False):
        self.command("Marionette:SetContext", {"value": "chrome" if chrome else "content"})
        # Content must execute in the extension page's realm, not a sandbox
        # lacking its real browser namespaces. Chrome gets a fresh sandbox.
        script = """
            const done = arguments[arguments.length - 1];
            (async () => { SOURCE })().then(
                value => done({ok: true, value: value ?? null}),
                error => done({ok: false, error: String(error), stack: error.stack || ""}));
        """.replace("SOURCE", source)
        result = self.command("WebDriver:ExecuteAsyncScript", {
            "script": script, "args": args or [], "newSandbox": True,
            "sandbox": "default" if chrome else None,
        })["value"]
        if not result["ok"]:
            raise RuntimeError(result["error"] + ("\n" + result["stack"] if result["stack"] else ""))
        return result["value"]

    def close(self):
        self.stream.close()
        self.sock.close()


def connect_firefox(process, port):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Firefox exited before Marionette started (exit {process.returncode})")
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=1)
        except OSError:
            time.sleep(0.1)
            continue
        sock.settimeout(35)
        try:
            return Marionette(sock)
        except Exception:
            sock.close()
            raise
    raise TimeoutError("Marionette did not start within 30 s; see firefox.log")


def poll(label, read, ready, timeout=WAIT_SECONDS, minimum=0):
    started = time.monotonic()
    last = None
    while time.monotonic() - started < timeout:
        last = read()
        if ready(last) and time.monotonic() - started >= minimum:
            return last
        time.sleep(0.25)
    raise TimeoutError(f"{label} not ready after {timeout:g} s; last={json.dumps(last, ensure_ascii=False)}")


BOARD_SCRIPT = """
    const columns = [...document.querySelectorAll('#board .column')].map(column =>
        (column.querySelector('.column-title, .group-name')?.textContent || '').trim());
    return {board: !!document.querySelector('#board'), columns,
            clock: !!document.querySelector('#time')?.textContent.trim(),
            fontsReady: document.fonts.status === 'loaded', url: location.href};
"""

PLACES_SCRIPT = """
    const {PlacesUtils} = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
    const roots = [];
    await PlacesUtils.bookmarks.fetch({parentGuid: PlacesUtils.bookmarks.unfiledGuid}, item => {
        if (item.type === PlacesUtils.bookmarks.TYPE_FOLDER && item.title === 'Foxy') roots.push(item);
    });
    const result = [];
    for (const root of roots) {
        const children = [];
        await PlacesUtils.bookmarks.fetch({parentGuid: root.guid}, item => {
            children.push({guid: item.guid, title: item.title, type: item.type});
        });
        for (const child of children) {
            if (child.type !== PlacesUtils.bookmarks.TYPE_FOLDER) continue;
            child.urls = [];
            await PlacesUtils.bookmarks.fetch({parentGuid: child.guid}, item => {
                if (item.type === PlacesUtils.bookmarks.TYPE_BOOKMARK) child.urls.push(item.url.href);
            });
        }
        result.push({guid: root.guid, children});
    }
    return result;
"""

CONSOLE_SCRIPT = """
    const base = arguments[0];
    return Services.console.getMessageArray().flatMap(entry => {
        let level;
        try {
            // QueryInterface exposes sourceName/errorMessage as well as flags.
            entry = entry.QueryInterface(Ci.nsIScriptError);
            if (entry.flags & Ci.nsIScriptError.infoFlag) return [];
            level = entry.flags & Ci.nsIScriptError.warningFlag ? 'WARNING' : 'ERROR';
        } catch (_) {
            if (!['error', 'warn', 'warning'].includes(entry.level)) return [];
            level = entry.level === 'error' ? 'ERROR' : 'WARNING';
        }
        const message = entry.errorMessage || entry.message || String(entry);
        const source = entry.sourceName || '';
        if (!source.includes(base) && !message.includes(base) && !message.includes('Foxy:')) return [];
        return [{level, message, source, line: entry.lineNumber || 0}];
    });
"""


def pinned_title(root):
    # Read the canonical exported title rather than duplicating its emoji.
    source = (root / "extension" / "src" / "sync" / "codec.js").read_text(encoding="utf-8")
    match = re.search(r'export\s+const\s+PINNED_TITLE\s*=\s*("(?:[^"\\]|\\.)*")\s*;', source)
    if not match:
        raise ValueError("could not read PINNED_TITLE from extension/src/sync/codec.js")
    return json.loads(match[1])


PIN_STATE_SCRIPT = """
    const tabId = arguments[0];
    const tab = await browser.tabs.get(tabId);
    const {foxySync} = await browser.storage.local.get('foxySync');
    const mapped = foxySync?.tabs?.[tabId];
    const bookmark = mapped ? (await browser.bookmarks.get(mapped.bookmarkId))[0] : null;
    const [page] = await browser.scripting.executeScript({target: {tabId, frameIds: [0]},
        func: () => ({title: document.title, latest: document.body.dataset.latestTitle})});
    return {tabTitle: tab.title, documentTitle: page.result.title,
            bookmarkTitle: bookmark?.title, latest: page.result.latest};
"""


def pin_name_matches(state, title, bookmark_title):
    return (state.get("tabTitle") == title and state.get("documentTitle") == title
            and state.get("bookmarkTitle") == bookmark_title)


def check_pin_names(client):
    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"""<!doctype html><title>Original page title</title><body>
                <script>window.addEventListener('message', event => {
                    if (event.data !== 'smoke-change-title') return;
                    document.title = 'Latest page title';
                    document.body.dataset.latestTitle = 'Latest page title';
                });</script></body>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Page) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        tab_id = None
        try:
            page_url = f"http://127.0.0.1:{server.server_port}/pin-names"
            tab_id = client.script("""
                return (await browser.tabs.create({url: arguments[0], pinned: true, active: false})).id;
            """, [page_url])
            poll("local pin loaded", lambda: client.script("return await browser.tabs.get(arguments[0]);", [tab_id]),
                 lambda tab: tab["status"] == "complete" and tab["title"] == "Original page title")
            # Verified in Firefox 157's ExtensionPermissions.sys.mjs. Pass the
            # extension emitter so its live host access and onAdded listeners update.
            client.script("""
                const {ExtensionPermissions} = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
                const policy = WebExtensionPolicy.getByID(arguments[0]);
                await ExtensionPermissions.add(arguments[0], {
                    permissions: [], origins: ['http://127.0.0.1/*'], data_collection: []
                }, policy.extension);
            """, [ADDON_ID], chrome=True)
            reply = client.script("""
                return await browser.runtime.sendMessage({type: 'foxy:rename-pin', tabId: arguments[0], name: 'Smoke pin'});
            """, [tab_id])
            if reply != {"ok": True}:
                raise RuntimeError(f"rename failed: {reply!r}")
            read = lambda: client.script(PIN_STATE_SCRIPT, [tab_id])
            poll("pin name applied", read, lambda state: pin_name_matches(state, "Smoke pin", "✏️ Smoke pin"))
            client.script("""
                await browser.scripting.executeScript({target: {tabId: arguments[0], frameIds: [0]},
                    func: () => window.postMessage('smoke-change-title', '*')});
            """, [tab_id])
            poll("page title reverted", read, lambda state: state.get("latest") == "Latest page title"
                 and pin_name_matches(state, "Smoke pin", "✏️ Smoke pin"))
            reply = client.script("""
                return await browser.runtime.sendMessage({type: 'foxy:rename-pin', tabId: arguments[0], name: null});
            """, [tab_id])
            if reply != {"ok": True}:
                raise RuntimeError(f"unname failed: {reply!r}")
            poll("page title and bookmark restored", read,
                 lambda state: pin_name_matches(state, "Latest page title", "Latest page title"))
            return "name applied, page edits reverted, pencil bookmark saved, latest page title restored"
        finally:
            try:
                if tab_id is not None:
                    client.script("await browser.tabs.remove(arguments[0]);", [tab_id])
            finally:
                server.shutdown()
                thread.join(timeout=5)


def check_pin_history(client):
    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            title = "A page" if self.path == "/a" else "B page"
            body = f"""<!doctype html><title>{title}</title><body>
                <a id="next" href="/b">Next page</a>
                <script>addEventListener('pageshow', event => {{
                    document.body.dataset.restored = String(event.persisted);
                }});</script></body>""".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Page) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        tab_id = None
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            # check_pin_names granted this host in the same throwaway extension.
            tab_id = client.script("""
                return (await browser.tabs.create({url: arguments[0], pinned: true, active: false})).id;
            """, [base + "/a"])
            poll("history pin initially loaded", lambda: client.script("return await browser.tabs.get(arguments[0]);", [tab_id]),
                 lambda tab: tab["url"] == base + "/a" and tab["status"] == "complete" and tab["title"] == "A page")

            def read():
                return client.script("""
                    const tabId = arguments[0], tab = await browser.tabs.get(tabId);
                    const {foxySync} = await browser.storage.local.get('foxySync');
                    const mapped = foxySync?.tabs?.[tabId];
                    const bookmark = mapped ? (await browser.bookmarks.get(mapped.bookmarkId))[0] : null;
                    const [page] = await browser.scripting.executeScript({target: {tabId, frameIds: [0]},
                        func: () => ({title: document.title, restored: document.body.dataset.restored,
                            keeper: !!globalThis.__foxyPinTitle})});
                    return {url: tab.url, status: tab.status, tabTitle: tab.title,
                        documentTitle: page.result.title, restored: page.result.restored,
                        keeper: page.result.keeper, bookmarkTitle: bookmark?.title};
                """, [tab_id])

            def rename(name):
                reply = client.script("""
                    return await browser.runtime.sendMessage({type: 'foxy:rename-pin', tabId: arguments[0], name: arguments[1]});
                """, [tab_id, name])
                if reply != {"ok": True}:
                    raise RuntimeError(f"history pin rename failed: {reply!r}")

            def follow_link():
                client.script("""
                    await browser.scripting.executeScript({target: {tabId: arguments[0], frameIds: [0]},
                        func: () => document.querySelector('#next').click()});
                """, [tab_id])
                poll("named B loaded", read, lambda s: s["url"] == base + "/b" and s["status"] == "complete"
                     and s["keeper"] and pin_name_matches(s, "Work", "✏️ Work"))

            def back():
                # Register, collect and clean up in one realm/evaluation. Also watch
                # bookmark titles so a transient bare-name write cannot pass unnoticed.
                return client.script("""
                    const tabId = arguments[0], events = [], titles = [];
                    const {foxySync} = await browser.storage.local.get('foxySync');
                    const bookmarkId = foxySync.tabs[tabId].bookmarkId;
                    let listener, timer;
                    const complete = new Promise((resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Back did not complete')), 6000);
                        listener = (id, change) => {
                            if (id !== tabId) return;
                            events.push(change);
                            if (change.status === 'complete') resolve();
                        };
                    });
                    const changed = (id, change) => {
                        if (id === bookmarkId && change.title !== undefined) titles.push(change.title);
                    };
                    browser.tabs.onUpdated.addListener(listener);
                    browser.bookmarks.onChanged.addListener(changed);
                    try {
                        await browser.scripting.executeScript({target: {tabId, frameIds: [0]}, func: () => history.back()});
                        await complete;
                        await browser.runtime.sendMessage({type: 'foxy:pins'});
                        return {events, titles};
                    } finally {
                        clearTimeout(timer);
                        browser.tabs.onUpdated.removeListener(listener);
                        browser.bookmarks.onChanged.removeListener(changed);
                    }
                """, [tab_id])

            poll("A loaded and mapped", read, lambda s: s["status"] == "complete"
                 and pin_name_matches(s, "A page", "A page"))
            rename("Work")
            poll("named A", read, lambda s: s["keeper"] and pin_name_matches(s, "Work", "✏️ Work"))
            follow_link()
            rename(None)
            poll("unnamed B", read, lambda s: not s["keeper"] and pin_name_matches(s, "B page", "B page"))
            unnamed_back = back()
            if "Work" in unnamed_back["titles"]:
                raise RuntimeError(f"Back published the bare name: {unnamed_back!r}")
            unnamed = poll("unnamed A restored from bfcache", read, lambda s: s["url"] == base + "/a"
                           and s["status"] == "complete" and s["restored"] == "true" and not s["keeper"]
                           and pin_name_matches(s, "A page", "A page"))
            rename("Work")
            poll("A named again", read, lambda s: s["keeper"] and pin_name_matches(s, "Work", "✏️ Work"))
            follow_link()
            named_back = back()
            named = poll("named A restored and reapplied on complete", read, lambda s: s["url"] == base + "/a"
                         and s["status"] == "complete" and s["restored"] == "true" and s["keeper"]
                         and pin_name_matches(s, "Work", "✏️ Work"))
            return "unname then Back stays unnamed; still-named Back reapplies on complete; " + json.dumps(
                {"unnamedBack": unnamed_back, "unnamed": unnamed, "namedBack": named_back, "named": named}, ensure_ascii=False)
        finally:
            try:
                if tab_id is not None:
                    client.script("await browser.tabs.remove(arguments[0]);", [tab_id])
            finally:
                server.shutdown()
                thread.join(timeout=5)


def check_named_inbound(client):
    bookmarks = client.script("""
        const {foxySync} = await browser.storage.local.get('foxySync');
        const later = await browser.bookmarks.create({parentId: foxySync.pinnedId, index: 0,
            url: 'https://example.com/smoke-later', title: '✏️ Smoke later'});
        const first = await browser.bookmarks.create({parentId: foxySync.pinnedId, index: 0,
            url: 'https://example.com/smoke-first', title: '✏️ Smoke first'});
        return [later.id, first.id];
    """)
    try:
        state = poll("named inbound pins", lambda: client.script("""
            const {foxySync} = await browser.storage.local.get('foxySync');
            return await Promise.all(arguments[0].map(async bookmarkId => {
                const mapped = Object.entries(foxySync.tabs).find(([, entry]) => entry.bookmarkId === bookmarkId);
                return mapped ? await browser.tabs.get(Number(mapped[0])) : null;
            }));
        """, [bookmarks]), lambda tabs: all(tab is not None for tab in tabs)
            and [tab['index'] for tab in tabs] == [1, 0])
        for tab, title, index in zip(state, ['Smoke later', 'Smoke first'], [1, 0]):
            if (tab.get('pinned') is not True or tab.get('discarded') is not True
                    or tab.get('title') != title or tab.get('index') != index):
                raise RuntimeError(f"named inbound pin lost its unloaded name or position: {tab!r}")
        return "pinned, discarded, decoded titles retained, bookmark order at pin positions 0 and 1"
    finally:
        client.script("""
            for (const id of arguments[0]) await browser.bookmarks.remove(id);
        """, [bookmarks])


def run_checks(client, root, scratch, results, base):
    url = base + "newtab.html"
    client.command("Marionette:SetContext", {"value": "content"})
    client.command("WebDriver:Navigate", {"url": url})

    def board():
        state = poll("board and fonts", lambda: client.script(BOARD_SCRIPT),
                     lambda s: s["board"] and s["fontsReady"] and s["clock"] and
                     {"PINNED", "TABS"}.issubset({title.upper() for title in s["columns"]}), minimum=3)
        return ", ".join(state["columns"]) + "; clock rendered; fonts ready"
    results.check("board", board)

    def fonts():
        state = client.script("""
            await document.fonts.ready;
            await document.fonts.load('800 16px "Foxy Sans"');
            await document.fonts.load('400 16px "Foxy Mono"');
            return {sans: document.fonts.check('800 16px "Foxy Sans"'),
                    mono: document.fonts.check('400 16px "Foxy Mono"'),
                    loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family)};
        """)
        if not state["sans"] or not state["mono"] or not all(
                any(family.strip('"\'') == expected for family in state["loaded"])
                for expected in ("Foxy Sans", "Foxy Mono")):
            raise RuntimeError(json.dumps(state))
        return "Foxy Sans and Foxy Mono loaded from the extension"
    results.check("fonts", fonts)

    def override():
        # Direct navigation to about:newtab still opens Firefox's builtin page.
        # The New Tab command uses AboutNewTab.newTabURL instead.
        target = poll("newtab override", lambda: client.script("""
            const {AboutNewTab} = ChromeUtils.importESModule('resource:///modules/AboutNewTab.sys.mjs');
            return AboutNewTab.newTabURL;
        """, chrome=True), lambda value: value == url)
        return target

    def sync_started():
        title = pinned_title(root)
        state = poll("sync root and pinned folder", lambda: client.script(PLACES_SCRIPT, chrome=True),
                     lambda roots: any(any(c["title"] == title and c["type"] == 2
                                           for c in r["children"]) for r in roots))
        return "Foxy under Other Bookmarks, with " + title + "; " + json.dumps(state, ensure_ascii=False)

    try:
        results.check("newtab override", override)
    finally:
        # Let queued startup messages finish before unloading the first board.
        # Keep checking the console: context-unloaded errors must not be hidden.
        sync_started()
        time.sleep(1)
        # Subsequent checks must run in the extension even if the override fails.
        client.command("Marionette:SetContext", {"value": "content"})
        client.command("WebDriver:Navigate", {"url": url})
    results.check("sync started", sync_started)

    def round_trip():
        state = client.script("""
            const tab = await browser.tabs.create({url: arguments[0], active: false});
            const groupId = await browser.tabs.group({tabIds: [tab.id]});
            await browser.tabGroups.update(groupId, {title: 'Smoke'});
            return {tabId: tab.id, groupId};
        """, [SMOKE_URL])
        poll("Smoke bookmark folder", lambda: client.script(PLACES_SCRIPT, chrome=True),
             lambda roots: any(any("Smoke" in c["title"] and SMOKE_URL in c.get("urls", [])
                                   for c in r["children"]) for r in roots))
        return "Smoke folder contains " + SMOKE_URL + "; " + json.dumps(state)
    results.check("sync round-trip", round_trip)

    def smoke_column():
        state = poll("SMOKE board column", lambda: client.script(BOARD_SCRIPT),
                     lambda s: any(title.upper() == "SMOKE" for title in s["columns"]))
        return ", ".join(state["columns"])
    results.check("SMOKE column", smoke_column)
    results.check("pin names", lambda: check_pin_names(client))
    results.check("pin history", lambda: check_pin_history(client))
    results.check("named inbound pins", lambda: check_named_inbound(client))

    def screenshot():
        client.command("Marionette:SetContext", {"value": "content"})
        data = client.command("WebDriver:TakeScreenshot", {"full": True})["value"]
        image = base64.b64decode(data, validate=True)
        if not image.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("Firefox returned a non-PNG screenshot")
        path = scratch / "board.png"
        path.write_bytes(image)
        return str(path)
    results.check("screenshot", screenshot)


def check_console(client, base, scratch, results):
    def console():
        entries = client.script(CONSOLE_SCRIPT, [base], chrome=True)
        (scratch / "console.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        for entry in entries:
            print(f"CONSOLE {entry['level']}: {entry['message']} ({entry['source']}:{entry['line']})", flush=True)
        errors = [entry for entry in entries if entry["level"] == "ERROR"]
        if errors:
            raise RuntimeError(f"{len(errors)} extension error(s); see console.json")
        return f"no extension errors; {len(entries)} warning(s)"
    results.check("console", console)


def quit_firefox(client, process):
    try:
        if client is not None:
            try:
                client.command("Marionette:Quit", {"flags": ["eForceQuit"]})
            except (OSError, EOFError, RuntimeError, ValueError):
                pass
            finally:
                client.close()
    finally:
        if process is not None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            # Only this launch's isolated process group, never existing Firefox.
            # macOS may return EPERM when the group contains only zombies.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                process.wait(timeout=5)


def run(*, firefox=FIREFOX, keep_going=False, root=ROOT):
    root = Path(root).resolve()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    scratch = safe_profile_path(root / ".spider" / "scratch" / ("smoke-" + stamp))
    scratch.mkdir(parents=True, exist_ok=False)
    results = Results(keep_going)
    process = client = base = None
    try:
        profile = scratch / "profile"
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        write_profile(profile, port)
        temp = scratch / "tmp"
        temp.mkdir()
        with (scratch / "firefox.log").open("wb") as log:
            try:
                process = subprocess.Popen([
                    str(firefox), "--headless", "--no-remote", "--marionette",
                    # Firefox 138+ requires explicit opt-in to chrome context.
                    "--remote-allow-system-access", "-profile", str(profile), "about:blank",
                ], env={**os.environ, "TMPDIR": str(temp), "TMP": str(temp), "TEMP": str(temp)},
                    start_new_session=True, stdout=log, stderr=log)
                client = connect_firefox(process, port)
                session = client.command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {
                    "acceptInsecureCerts": False,
                    "timeouts": {"script": 10000, "pageLoad": 15000, "implicit": 0},
                }}})
                print("Firefox: " + session["capabilities"]["browserVersion"], flush=True)
                addon_id = client.command("Addon:Install", {
                    "path": str((root / "extension").resolve()), "temporary": True,
                })["value"]
                results.record("install", addon_id == ADDON_ID, addon_id)
                base = client.script("return WebExtensionPolicy.getByID(arguments[0]).getURL('');",
                                     [addon_id], chrome=True)
                if not isinstance(base, str) or not base.startswith("moz-extension://"):
                    raise RuntimeError(f"invalid extension base URL: {base!r}")
                try:
                    run_checks(client, root, scratch, results, base)
                finally:
                    # Also inspect console when fail-fast stops a dependent check.
                    check_console(client, base, scratch, results)
            finally:
                quit_firefox(client, process)
                client = process = None
    except CheckFailed:
        pass
    except Exception as error:
        # Setup/transport failures cannot safely continue, regardless of flag.
        try:
            results.record("harness", False, str(error))
        except CheckFailed:
            pass
    finally:
        quit_firefox(client, process)
        print(f"Scratch: {scratch}", flush=True)
    return results.exit_code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firefox", default=FIREFOX, metavar="PATH", help="Firefox executable")
    parser.add_argument("--keep-going", action="store_true", help="report all checks after a failure")
    args = parser.parse_args(argv)
    try:
        return run(firefox=args.firefox, keep_going=args.keep_going)
    except (OSError, ValueError) as error:
        print(f"FAIL harness: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
