#!/usr/bin/env python3
"""Smoke-test the installed Foxy agent host with headless Firefox."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

from firefox_env import firefox_environment
from install_agent import install

from smoke_firefox import (ADDON_ID, FIREFOX, Results, CheckFailed, connect_firefox,
                          write_profile, safe_profile_path, quit_firefox, poll)

ROOT = Path(__file__).resolve().parent.parent


def register_smoke_host(root, scratch, client):
    manifest = install(Path(root) / 'agent/foxy_host.py', home=Path(scratch) / 'home')
    # Override both lookup directories in this disposable Firefox only. Never
    # replace the installed user manifest or accidentally measure its helper.
    client.script("""
      const directory = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
      directory.initWithPath(arguments[0]);
      for (const key of ['XREUserNativeManifests', 'XRESysNativeManifests']) {
        Services.dirsvc.set(key, directory);
      }
    """, [str(manifest.parent.parent)], chrome=True)


def cli(root, env, *args, expected=0):
    result = subprocess.run([str(root / 'agent/foxy'), *args], env=env,
                            capture_output=True, text=True, timeout=15)
    if result.returncode != expected:
        raise RuntimeError(f"foxy {' '.join(args)}: exit {result.returncode}, expected {expected}: "
                           + result.stdout + result.stderr)
    return result


def run(*, root=ROOT, firefox=FIREFOX):
    root = Path(root).resolve()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    scratch = safe_profile_path(root / '.spider/scratch' / ('agent-smoke-' + stamp))
    scratch.mkdir(parents=True)
    with firefox_environment(scratch) as env:
        sock_path = Path(env['FOXY_AGENT_SOCK'])
        process = client = None
        results = Results()
        try:
            with socket.socket() as reserve:
                reserve.bind(('127.0.0.1', 0))
                port = reserve.getsockname()[1]
            profile = scratch / 'profile'
            write_profile(profile, port)
            with (scratch / 'firefox.log').open('wb') as log:
                try:
                    process = subprocess.Popen([str(firefox), '--headless', '--no-remote', '--marionette',
                        '--remote-allow-system-access', '-profile', str(profile), 'about:blank'],
                        env=env, start_new_session=True, stdout=log, stderr=log)
                    client = connect_firefox(process, port)
                    session = client.command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {
                        'timeouts': {'script': 10000, 'pageLoad': 15000, 'implicit': 0}}}})
                    print('Firefox: ' + session['capabilities']['browserVersion'], flush=True)
                    register_smoke_host(root, scratch, client)
                    addon = client.command('Addon:Install', {'path': str(root / 'extension'), 'temporary': True})['value']
                    results.record('install', addon == ADDON_ID, addon)
                    poll('agent socket', lambda: sock_path.exists(), bool)

                    groups = json.loads(cli(root, env, 'groups', '--json').stdout)
                    results.record('groups --json', groups['ok'] and groups['open'] == [], json.dumps(groups))
                    new = json.loads(cli(root, env, 'new', 'Agent smoke', 'https://example.com/agent-a', '--color', 'green', '--json').stdout)
                    results.record('new inactive group', new['ok'] and new['added'] == 1, json.dumps(new))
                    group_id = new['group']['id']
                    # Navigate only the disposable Firefox, into Foxy's page, so browser APIs
                    # can verify selection and bookmark-sync effects of subsequent CLI calls.
                    base = client.script("return WebExtensionPolicy.getByID(arguments[0]).getURL('');", [addon], chrome=True)
                    client.command('Marionette:SetContext', {'value': 'content'})
                    client.command('WebDriver:Navigate', {'url': base + 'newtab.html'})
                    memory = client.script("return await browser.runtime.sendMessage({type:'foxy:memory'});")
                    results.record('memory from worktree helper', isinstance(memory, dict) and
                        memory.get('firefox', 0) > 0 and memory.get('processes', 0) > 0 and
                        memory.get('system', {}).get('total', 0) > 0, json.dumps(memory))
                    total = poll('memory tile renders a number', lambda: client.script(
                        "return document.querySelector('[data-kind=memory] .memory-total')?.textContent;"),
                        lambda text: bool(text) and text.endswith((' MB', ' GB')) and float(text[:-3]) > 0)
                    results.record('memory tile renders a number', True, total)
                    before = client.script("return {active: (await browser.tabs.query({active:true})).map(t=>t.id), win: (await browser.windows.getLastFocused()).id};")
                    add = json.loads(cli(root, env, 'add', ' agent SMOKE ', 'https://example.com/agent-b', 'https://example.com/agent-a#duplicate', '--json').stdout)
                    results.record('add open; duplicate skipped', add['ok'] and add['added'] == 1 and add['skipped'] == 1, json.dumps(add))
                    tabs = json.loads(cli(root, env, 'tabs', 'Agent smoke', '--json').stdout)['tabs']
                    results.record('tabs', [t['url'] for t in tabs] == ['https://example.com/agent-a','https://example.com/agent-b'])
                    after = client.script("return {active: (await browser.tabs.query({active:true})).map(t=>t.id), win: (await browser.windows.getLastFocused()).id};")
                    results.record('no focus or selection change', after == before, json.dumps(after))
                    folder = poll('ordinary sync saves group', lambda: client.script("return await browser.runtime.sendMessage({type:'foxy:saved'});"),
                        lambda reply: str(group_id) in reply['folders'])['folders'][str(group_id)]
                    poll('ordinary sync saves both URLs', lambda: client.script("return (await browser.bookmarks.getChildren(arguments[0])).map(b=>b.url);", [folder]),
                         lambda urls: sorted(urls) == ['https://example.com/agent-a','https://example.com/agent-b'])
                    results.record('normal sync path', True, folder)
                    missing = json.loads(cli(root, env, 'add', 'Missing smoke', 'https://example.com/no', '--json', expected=1).stdout)
                    results.record('missing group exit 1', not missing['ok'] and 'Agent smoke' in missing['error'])

                    cli(root, env, 'add', 'Agent smoke', 'https://example.com/agent-c')
                    poll('three synced bookmarks', lambda: client.script("return (await browser.bookmarks.getChildren(arguments[0])).map(b=>b.url);", [folder]),
                         lambda urls: len(urls) == 3)
                    original_tabs = client.script("return await browser.tabs.query({groupId:arguments[0]});", [group_id])
                    first_id = next(t['id'] for t in original_tabs if t['url'] == 'https://example.com/agent-a')
                    middle = next(t for t in original_tabs if t['url'] == 'https://example.com/agent-b')
                    removed = json.loads(cli(root, env, 'remove', 'Agent smoke', 'https://example.com/agent-b#fragment', '--json').stdout)
                    loose = client.script("return await browser.tabs.get(arguments[0]);", [middle['id']])
                    poll('ungroup removes bookmark', lambda: client.script("return (await browser.bookmarks.getChildren(arguments[0])).map(b=>b.url);", [folder]),
                         lambda urls: sorted(urls) == ['https://example.com/agent-a','https://example.com/agent-c'])
                    results.record('remove ungroups and syncs', removed['removed'] == 1 and loose['groupId'] == -1
                        and loose['windowId'] == middle['windowId'],
                        f"middle tab index {middle['index']} to {loose['index']}")
                    closed = json.loads(cli(root, env, 'remove', 'Agent smoke', 'https://example.com/agent-a', '--close', '--json').stdout)
                    remaining = client.script("return await browser.tabs.query({});")
                    poll('close removes bookmark', lambda: client.script("return (await browser.bookmarks.getChildren(arguments[0])).map(b=>b.url);", [folder]),
                         lambda urls: urls == ['https://example.com/agent-c'])
                    results.record('remove closes and syncs', closed['removed'] == 1 and all(t['id'] != first_id for t in remaining), json.dumps(closed))

                    other = json.loads(cli(root, env, 'new', 'Other smoke', 'https://example.net/other', '--json').stdout)
                    other_id = other['group']['id']
                    other_folder = poll('other group saved', lambda: client.script("return await browser.runtime.sendMessage({type:'foxy:saved'});"),
                        lambda reply: str(other_id) in reply['folders'])['folders'][str(other_id)]
                    deleted = json.loads(cli(root, env, 'delete', 'Agent smoke', '--close-tabs', '--json').stdout)
                    poll('deleted open group stays deleted', lambda: client.script("""
                      const state = await browser.runtime.sendMessage({type:'foxy:saved'});
                      const folders = await browser.bookmarks.search({title:'🟢 Agent smoke'});
                      return {saved:state.saved, folders, open:await browser.tabGroups.query({})};
                    """), lambda value: not value['folders'] and all(g['title'] != 'Agent smoke' for g in value['saved'])
                        and all(g['id'] != group_id for g in value['open']), minimum=3)
                    other_urls = client.script("return (await browser.bookmarks.getChildren(arguments[0])).map(b=>b.url);", [other_folder])
                    results.record('delete open group and keep other group', deleted['closedTabs'] == 1
                        and deleted['deleted']['tabs'][0]['url'] == 'https://example.com/agent-c'
                        and other_urls == ['https://example.net/other'], json.dumps(deleted))

                    saved_group = json.loads(cli(root, env, 'new', 'Saved smoke', 'https://example.com/saved', '--json').stdout)
                    saved_id = saved_group['group']['id']
                    saved_folder = poll('saved smoke synced', lambda: client.script("return await browser.runtime.sendMessage({type:'foxy:saved'});"),
                        lambda reply: str(saved_id) in reply['folders'])['folders'][str(saved_id)]
                    client.script("const tabs = await browser.tabs.query({groupId:arguments[0]}); await browser.tabs.remove(tabs.map(t=>t.id));", [saved_id])
                    poll('saved smoke closed', lambda: client.script("return await browser.runtime.sendMessage({type:'foxy:saved'});"),
                        lambda reply: any(g['folderId'] == saved_folder for g in reply['saved']))
                    deleted = json.loads(cli(root, env, 'delete', 'Saved smoke', '--json').stdout)
                    state = client.script("return await browser.runtime.sendMessage({type:'foxy:saved'});")
                    exists = client.script("try { await browser.bookmarks.get(arguments[0]); return true; } catch { return false; }", [saved_folder])
                    results.record('delete saved group', deleted['closedTabs'] == 0 and not exists
                        and all(g['folderId'] != saved_folder for g in state['saved']
                        ) and deleted['deleted']['tabs'][0]['url'] == 'https://example.com/saved', json.dumps(deleted))
                finally:
                    quit_firefox(client, process)
                    client = process = None
            poll('socket removed on Firefox exit', lambda: sock_path.exists(), lambda exists: not exists)
            results.record('Firefox closed exit 2', cli(root, env, 'groups', expected=2).returncode == 2)
        except CheckFailed:
            pass
        except Exception as error:
            try:
                results.record('harness', False, str(error))
            except CheckFailed:
                pass
        finally:
            quit_firefox(client, process)
            print(f'Scratch: {scratch}', flush=True)
        return results.exit_code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firefox', default=FIREFOX)
    args = parser.parse_args(argv)
    return run(firefox=args.firefox)


if __name__ == '__main__':
    raise SystemExit(main())
