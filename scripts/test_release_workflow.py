import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PINS = {
    'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
    'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/setup-python': 'a26af69be951a213d495a4c3e4e4022e16d87065',
}
GUID = '{4408f971-7930-41ea-9f93-b01231e40861}'


def load_workflow(name='release'):
    source = (ROOT / '.github/workflows' / f'{name}.yml').read_text()
    return source, json.loads(re.sub(r'\s+# v[0-9][^\n]*', '', source))


class ReleaseWorkflowTest(unittest.TestCase):
    def test_both_workflows_limit_permissions_credentials_and_action_pins(self):
        for name in ['release', 'publish']:
            with self.subTest(workflow=name):
                source, workflow = load_workflow(name)
                self.assertEqual(workflow['permissions'], {'contents': 'read'})
                for job in workflow['jobs'].values():
                    if job.get('permissions', {}).get('contents') == 'write':
                        self.assertTrue(any('gh release' in s.get('run', '') for s in job['steps']))
                    self.assertEqual(job['environment'], 'release')
                    for step in job['steps']:
                        if 'uses' in step:
                            action, pin = step['uses'].split('@')
                            self.assertEqual(PINS[action], pin)
                            if action == 'actions/checkout':
                                self.assertIs(step['with']['persist-credentials'], False)
                                self.assertEqual(step['with']['fetch-depth'], 0)
                            if action == 'actions/setup-node':
                                self.assertEqual(step['with']['node-version'], '24')
                        self.assertNotIn('${{', step.get('run', ''))
                        for value in step.get('env', {}).values():
                            if 'secrets.' in value:
                                self.assertTrue('scripts/sign.py' in step.get('run', '') or
                                                'scripts/amo_listing.py' in step.get('run', ''))
                    self.assertFalse(any('secrets.' in v for v in job.get('env', {}).values()))
                if name == 'release':
                    self.assertEqual(workflow['on'], {'push': {'tags': ['v*']}})
                else:
                    self.assertIn('workflow_dispatch', workflow['on'])
                    self.assertIn('tag', workflow['on']['workflow_dispatch']['inputs'])
                    self.assertEqual(len(workflow['on']['schedule']), 1)


class ReleaseGuideTest(unittest.TestCase):
    def test_guide_covers_release_recovery_and_migration_within_20_lines(self):
        text = (ROOT / 'docs/releasing.md').read_text()
        self.assertLessEqual(len(text.splitlines()), 20)
        for required in ['release', 'AMO_JWT_ISSUER', 'AMO_JWT_SECRET',
                         'scripts/release.py', 'git push origin', '4.1.0', 'automatically',
                         'Vite', 'draft', 'AMO']:
            self.assertIn(required, text)
        self.assertNotIn('liquidfox-newtab/amo.env', text)


# These stubs replace only external tools and the other worker's build contract.
# The workflow's actual shell, git operations, version checks, and update script run.
TOOL = r'''#!PYTHON
import hashlib, json, os, pathlib, shutil, subprocess, sys, zipfile
root = pathlib.Path.cwd()
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
capture = pathlib.Path(os.environ['CAPTURE'])
with (capture / 'calls.jsonl').open('a') as f:
    f.write(json.dumps([name, str(root), args]) + '\n')
def signed(version, bad=False):
    manifest = {'version': '9.9.9' if bad else version,
                'browser_specific_settings': {'gecko': {'id': 'GUID'}}}
    target = root / 'dist' / f'foxy-{version}-signed.xpi'
    with zipfile.ZipFile(target, 'w') as archive:
        archive.writestr('manifest.json', json.dumps(manifest))
if name == 'npm':
    assert args in [['ci'], ['test']], args
elif name == 'python3':
    if args[0] == 'scripts/build.py':
        version = json.loads((root / 'extension/manifest.json').read_text())['version']
        (root / 'dist').mkdir(exist_ok=True)
        content = 'different' if os.environ.get('BAD_REBUILD') and root.name == 'source-rebuild' else 'zip'
        (root / 'dist' / f'foxy-{version}.zip').write_bytes(content.encode())
    elif args[0] == 'scripts/source_archive.py':
        assert len(args) == 2 and args[1].startswith('v'), args
        version = args[1][1:]
        (root / 'dist').mkdir(exist_ok=True)
        with (root / 'dist' / f'foxy-{version}-source.zip').open('wb') as f:
            subprocess.run(['git', 'archive', '--format=zip', args[1]], stdout=f, check=True)
    elif args[0] == 'scripts/amo_listing.py':
        assert os.environ.get('AMO_JWT_SECRET') == 'fake-secret'
    elif args[0] == 'scripts/sign.py':
        assert os.environ.get('AMO_JWT_SECRET') == 'fake-secret'
        assert '--channel' in args and args[args.index('--channel')+1] == 'listed'
        version = args[args.index('--version')+1] if '--version' in args else json.loads((root / 'extension/manifest.json').read_text())['version']
        if '--fetch-only' in args:
            assert '--source' not in args
        else:
            assert args[args.index('--source')+1] == f'dist/foxy-{version}-source.zip'
            assert (root / args[args.index('--source')+1]).is_file()
        states = json.loads(os.environ.get('AMO_STATES', '{}'))
        state = states.get(version, 'signed')
        (root / 'dist').mkdir(exist_ok=True)
        result = {'status': state, 'version': version, 'channel': 'listed'}
        if state == 'signed':
            signed(version, bool(os.environ.get('BAD_XPI')))
            result['url'] = f'https://addons.mozilla.org/firefox/downloads/file/123/foxy-{version}.xpi'
        (root / 'dist' / f'foxy-{version}-status.json').write_text(json.dumps(result))
        if state == 'rejected':
            sys.exit('AMO rejected this version')
    else:
        os.execv('PYTHON', ['PYTHON', *args])
elif name == 'gh':
    state_file = capture / 'releases.json'
    releases = json.loads(state_file.read_text())
    if args[:1] == ['api']:
        assert '--paginate' in args and '--slurp' in args, args
        print(json.dumps([[{'tag_name': tag, 'draft': value['draft']} for tag, value in releases.items()]]))
    elif args[:2] in [['release', 'create'], ['release', 'upload']]:
        tag = args[2]
        creating = args[1] == 'create'
        if creating:
            assert tag not in releases, tag
            assert '--verify-tag' in args
            releases[tag] = {'draft': '--draft' in args}
        else:
            assert tag in releases
        assets = []
        i = 3
        while i < len(args):
            arg = args[i]
            if arg in ['--title', '--notes-file']:
                if arg == '--notes-file':
                    destination = capture / tag / 'notes.txt'
                    destination.parent.mkdir(exist_ok=True)
                    shutil.copyfile(args[i+1], destination)
                i += 2
            elif arg.startswith('--'):
                i += 1
            else:
                path = pathlib.Path(arg)
                assert path.is_file(), arg
                destination = capture / tag / path.name
                destination.parent.mkdir(exist_ok=True)
                shutil.copyfile(path, destination)
                assets.append(path.name)
                i += 1
        releases[tag]['assets'] = sorted(set(releases[tag].get('assets', []) + assets))
    elif args[:2] == ['release', 'edit']:
        assert '--draft=false' in args, args
        releases[args[2]]['draft'] = False
    else:
        raise AssertionError(args)
    state_file.write_text(json.dumps(releases))
else:
    raise AssertionError(name)
'''.replace('PYTHON', sys.executable).replace('GUID', GUID)


class WorkflowExecutionTest(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / '.spider/scratch/release-tests'
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.work = pathlib.Path(self.temp.name)
        self.repo = self.work / 'repo'
        (self.repo / 'extension').mkdir(parents=True)
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/build.py').write_text('# build contract stub\n')
        shutil.copyfile(ROOT / 'scripts/update_manifest.py', self.repo / 'scripts/update_manifest.py')
        self.manifest('4.2.0')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test User')
        self.git('config', 'user.email', 'test@example.com')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial commit')
        self.git('tag', '-a', 'v4.2.0', '-m', 'Notes for 4.2.0')
        self.git('remote', 'add', 'origin', str(self.repo))
        self.bin = self.work / 'bin'
        self.bin.mkdir()
        for name in ['npm', 'python3', 'gh']:
            path = self.bin / name
            path.write_text(TOOL)
            path.chmod(0o755)
        self.capture = self.work / 'capture'
        self.capture.mkdir()
        (self.capture / 'releases.json').write_text('{}')
        self.env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                    'TAG': 'v4.2.0', 'REQUESTED_TAG': '', 'GITHUB_REPOSITORY': 'guru-irl/foxy',
                    'CAPTURE': str(self.capture), 'TMPDIR': str(self.work),
                    'GITHUB_STEP_SUMMARY': str(self.work / 'summary'),
                    'GIT_ALLOW_PROTOCOL': 'file', 'HOME': str(self.work / 'home')}
        self.env.pop('AMO_JWT_ISSUER', None)
        self.env.pop('AMO_JWT_SECRET', None)

    def manifest(self, version):
        (self.repo / 'extension/manifest.json').write_text(json.dumps({'version': version,
            'browser_specific_settings': {'gecko': {'id': GUID}}}))

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, capture_output=True, text=True, check=True)

    def run_step(self, step):
        env = dict(self.env)
        for key in step.get('env', {}):
            if key == 'AMO_JWT_ISSUER':
                env[key] = 'fake-issuer'
            elif key == 'AMO_JWT_SECRET':
                env[key] = 'fake-secret'
            elif key == 'GH_TOKEN':
                env[key] = 'fake-gh-token'
        return subprocess.run(['/bin/bash', '-euo', 'pipefail', '-c', step['run']], cwd=self.repo,
                              env=env, capture_output=True, text=True, timeout=30)

    def execute(self, name='release', fail_at=None):
        _, workflow = load_workflow(name)
        for job in workflow['jobs'].values():
            for step in job['steps']:
                if 'run' not in step:
                    continue
                result = self.run_step(step)
                if step['name'] == fail_at:
                    self.assertNotEqual(result.returncode, 0, step['name'])
                    return result
                self.assertEqual(result.returncode, 0, f"{step['name']}: {result.stdout} {result.stderr}")
        self.assertIsNone(fail_at, f'No step named {fail_at}')

    def releases(self):
        return json.loads((self.capture / 'releases.json').read_text())

    def calls(self):
        return [json.loads(line) for line in (self.capture / 'calls.jsonl').read_text().splitlines()]

    def assert_assets(self, tag):
        assets = self.capture / tag
        version = tag[1:]
        self.assertEqual(self.releases()[tag]['assets'], sorted([
            f'foxy-{version}.xpi', f'foxy-{version}-source.zip', 'updates.json']))
        update = json.loads((assets / 'updates.json').read_text())['addons'][GUID]['updates'][0]
        self.assertEqual(update['version'], version)
        self.assertEqual(update['update_link'], f'https://addons.mozilla.org/firefox/downloads/file/123/foxy-{version}.xpi')
        digest = hashlib.sha256((assets / f'foxy-{version}.xpi').read_bytes()).hexdigest()
        self.assertEqual(update['update_hash'], 'sha256:' + digest)
        self.assertFalse(self.releases()[tag]['draft'])

    def test_release_builds_rebuilds_and_publishes_all_assets(self):
        self.execute()
        self.assert_assets('v4.2.0')
        calls = self.calls()
        self.assertEqual(len([c for c in calls if c[0] == 'npm' and c[2] == ['ci']]), 2)
        self.assertEqual(len([c for c in calls if c[2] == ['scripts/build.py']]), 2)
        self.assertEqual((self.capture / 'v4.2.0/notes.txt').read_text(),
                         'Notes for 4.2.0\n\nChanges:\n- Initial commit\n')

    def test_pending_release_creates_draft_with_source_only_and_succeeds(self):
        self.env['AMO_STATES'] = '{"4.2.0":"pending"}'
        self.execute()
        self.assertEqual(self.releases()['v4.2.0'], {'draft': True, 'assets': ['foxy-4.2.0-source.zip']})
        self.assertIn('Waiting for AMO review', (self.work / 'summary').read_text())
        self.assertFalse((self.repo / 'updates.json').exists())

    def test_tag_mismatch_stops_before_install_build_or_amo(self):
        self.env['TAG'] = 'v9.9.9'
        result = self.execute(fail_at='Check version')
        self.assertIn('Tag does not match', result.stderr)
        self.assertTrue(all(c[0] == 'python3' and c[2] == ['-'] for c in self.calls()))

    def test_source_rebuild_mismatch_stops_before_amo(self):
        self.env['BAD_REBUILD'] = '1'
        result = self.execute(fail_at='Verify source rebuild')
        self.assertIn('rebuild', result.stderr.lower())
        self.assertFalse(any('scripts/sign.py' in c[2] for c in self.calls()))

    def test_wrong_signed_xpi_version_is_never_published(self):
        self.env['BAD_XPI'] = '1'
        self.execute(fail_at='Create release')
        self.assertEqual(self.releases(), {})

    def test_rejected_version_fails_without_creating_a_release(self):
        self.env['AMO_STATES'] = '{"4.2.0":"rejected"}'
        self.execute(fail_at='Submit listed version')
        self.assertEqual(self.releases(), {})

    def test_publish_completes_existing_draft_without_uploading_to_amo(self):
        (self.capture / 'releases.json').write_text('{"v4.2.0":{"draft":true}}')
        self.execute('publish')
        self.assert_assets('v4.2.0')
        signing = [c[2] for c in self.calls() if c[0] == 'python3' and c[2][0] == 'scripts/sign.py']
        self.assertEqual(len(signing), 1)
        self.assertIn('--fetch-only', signing[0])
        self.assertIn('--version', signing[0])
        self.assertFalse(any(c[2] == ['scripts/amo_listing.py'] for c in self.calls()))
        before = len(signing)
        self.execute('publish')
        self.assertEqual(len([c for c in self.calls() if c[0] == 'python3' and c[2][0] == 'scripts/sign.py']), before)

    def test_publish_creates_missing_release_and_keeps_pending_versions_unpublished(self):
        self.manifest('4.3.0')
        self.git('add', 'extension/manifest.json')
        self.git('commit', '-qm', 'Next version')
        self.git('tag', '-a', 'v4.3.0', '-m', 'Next release')
        self.env['AMO_STATES'] = '{"4.2.0":"pending"}'
        self.execute('publish')
        self.assertEqual(set(self.releases()), {'v4.3.0'})
        self.assert_assets('v4.3.0')

    def test_publish_skips_rejected_version_and_publishes_next_approved_tag(self):
        self.manifest('4.3.0')
        self.git('add', 'extension/manifest.json')
        self.git('commit', '-qm', 'Next version')
        self.git('tag', 'v4.3.0')
        self.env['AMO_STATES'] = '{"4.2.0":"rejected"}'
        self.execute('publish')
        self.assertEqual(set(self.releases()), {'v4.3.0'})
        self.assert_assets('v4.3.0')

    def test_publishing_an_older_approval_does_not_replace_latest(self):
        (self.capture / 'releases.json').write_text('{"v5.0.0":{"draft":false}}')
        self.execute('publish')
        create = next(c[2] for c in self.calls() if c[0] == 'gh' and c[2][:2] == ['release', 'create'])
        self.assertIn('--latest=false', create)

    def test_dispatch_only_checks_the_requested_tag(self):
        self.env['REQUESTED_TAG'] = 'v4.2.0'
        self.execute('publish')
        self.assert_assets('v4.2.0')

    def test_dispatch_rejects_unknown_or_unsafe_tag_before_amo(self):
        for tag in ['v9.9.9', 'v4.2.0; touch nope']:
            self.env['REQUESTED_TAG'] = tag
            self.execute('publish', fail_at='Find unpublished tags')
        self.assertEqual(self.releases(), {})
        self.assertFalse((self.repo / 'nope').exists())

    def test_publish_rejects_mismatched_download_before_github_mutations(self):
        self.env['BAD_XPI'] = '1'
        self.execute('publish', fail_at='Publish approved versions')
        self.assertEqual(self.releases(), {})

    def test_lightweight_tag_keeps_changes_since_the_previous_release(self):
        self.git('tag', '-d', 'v4.2.0')
        self.git('tag', 'v4.1.0')
        for message in ['Add feature', 'Fix feature']:
            (self.repo / 'change').write_text(message)
            self.git('add', 'change')
            self.git('commit', '-qm', message)
        self.git('tag', 'v4.2.0')
        dist = self.repo / 'dist'
        dist.mkdir()
        (dist / 'foxy-4.2.0-source.zip').write_bytes(b'source')
        with zipfile.ZipFile(dist / 'foxy-4.2.0-signed.xpi', 'w') as archive:
            archive.write(self.repo / 'extension/manifest.json', 'manifest.json')
        (dist / 'foxy-4.2.0-status.json').write_text(json.dumps({'status': 'signed',
            'url': 'https://addons.mozilla.org/firefox/downloads/file/123/foxy-4.2.0.xpi'}))
        step = next(s for s in load_workflow()[1]['jobs']['release']['steps']
                    if s.get('name') == 'Create release')
        result = self.run_step(step)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.capture / 'v4.2.0/notes.txt').read_text(),
                         'Changes since v4.1.0:\n- Fix feature\n- Add feature\n')

    def test_checkout_lightweight_tag_still_gets_origin_annotation(self):
        self.git('tag', '-d', 'v4.2.0')
        self.git('tag', 'v4.1.0')
        (self.repo / 'change').write_text('new')
        self.git('add', 'change')
        self.git('commit', '-qm', 'Add feature')
        self.git('tag', '-a', 'v4.2.0', '-m', 'Notes for 4.2.0')
        origin = self.work / 'origin.git'
        subprocess.run(['git', 'clone', '-q', '--bare', str(self.repo), str(origin)], check=True)
        self.git('tag', '-d', 'v4.2.0')
        self.git('tag', 'v4.2.0')
        self.git('remote', 'set-url', 'origin', str(origin))
        self.execute()
        self.assertEqual((self.capture / 'v4.2.0/notes.txt').read_text(),
                         'Notes for 4.2.0\n\nChanges since v4.1.0:\n- Add feature\n')


if __name__ == '__main__':
    unittest.main()
