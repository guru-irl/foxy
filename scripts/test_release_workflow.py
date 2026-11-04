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

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / '.github' / 'workflows' / 'release.yml'


def load_workflow():
    # The workflow uses YAML's JSON-compatible flow syntax plus YAML comments.
    source = WORKFLOW.read_text()
    return source, json.loads(re.sub(r'\s+# v[0-9][^\n]*', '', source))


class ReleaseWorkflowTest(unittest.TestCase):
    def test_release_trigger_permissions_environment_and_pins(self):
        source, workflow = load_workflow()
        self.assertEqual(workflow['on'], {'push': {'tags': ['v*']}})
        self.assertEqual(workflow['permissions'], {'contents': 'write'})
        self.assertEqual(set(workflow['jobs']), {'release'})
        job = workflow['jobs']['release']
        self.assertNotIn('needs', job)
        self.assertEqual(job['environment'], 'release')
        uses = [step['uses'] for step in job['steps'] if 'uses' in step]
        self.assertEqual(len(uses), 3)
        for action in uses:
            self.assertRegex(action, r'^actions/[\w.-]+@[0-9a-f]{40}$')
            self.assertRegex(source, re.escape('"uses": "' + action + '"') + r',?\s+# v[0-9]')
        checkout = next(step for step in job['steps'] if step.get('uses', '').startswith('actions/checkout@'))
        self.assertEqual(checkout['with']['fetch-depth'], 0)

    def test_release_step_order_and_credentials(self):
        _, workflow = load_workflow()
        steps = workflow['jobs']['release']['steps']
        run = [step for step in steps if 'run' in step]
        self.assertEqual([step['name'] for step in run], [
            'Check version', 'Test', 'Build', 'Sign', 'Compute SHA-256',
            'Generate update manifest', 'Create release'])
        self.assertIn('manifest.json', run[0]['run'])
        self.assertIn('npm test', run[1]['run'])
        self.assertIn('python3 scripts/build.py', run[2]['run'])
        self.assertIn('python3 scripts/sign.py', run[3]['run'])
        self.assertEqual(run[3]['env'], {
            'AMO_JWT_ISSUER': '${{ secrets.AMO_JWT_ISSUER }}',
            'AMO_JWT_SECRET': '${{ secrets.AMO_JWT_SECRET }}'})
        self.assertIn('sha256sum', run[4]['run'])
        self.assertIn('scripts/update_manifest.py', run[5]['run'])
        self.assertIn('gh release create', run[6]['run'])
        self.assertEqual(run[6]['env']['GH_TOKEN'], '${{ github.token }}')
        self.assertIn('updates.json', run[6]['run'])
        self.assertIn('.xpi', run[6]['run'])
        self.assertIn('--notes-file', run[6]['run'])


class ReleaseGuideTest(unittest.TestCase):
    def test_guide_covers_setup_and_release_commands_in_15_lines(self):
        text = (ROOT / 'docs' / 'releasing.md').read_text()
        self.assertLessEqual(len(text.splitlines()), 15)
        for required in ('release', 'AMO_JWT_ISSUER', 'AMO_JWT_SECRET',
                         'scripts/release.py', 'git push origin', '4.1.0', 'automatically'):
            self.assertIn(required, text)
        self.assertNotIn('liquidfox-newtab/amo.env', text)


class WorkflowExecutionTest(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / '.spider' / 'scratch' / 'release-tests'
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.work = pathlib.Path(self.temp.name)
        self.repo = self.work / 'repo'
        (self.repo / 'extension').mkdir(parents=True)
        (self.repo / 'scripts').mkdir()
        (self.repo / 'extension' / 'manifest.json').write_text('{"version": "4.1.0"}')
        shutil.copyfile(ROOT / 'scripts/update_manifest.py', self.repo / 'scripts/update_manifest.py')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test User')
        self.git('config', 'user.email', 'test@example.com')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial commit')
        self.bin = self.work / 'bin'
        self.bin.mkdir()
        self.executable('npm', '#!/bin/sh\n[ "$1" = test ]\n')
        self.executable('python3', '#!/bin/sh\ncase "$1" in\n'
                        'scripts/build.py) mkdir -p dist; printf zip > dist/foxy-4.1.0.zip ;;\n'
                        'scripts/sign.py) test -f dist/foxy-4.1.0.zip && test -n "$AMO_JWT_SECRET" && printf signed > dist/foxy-4.1.0-signed.xpi ;;\n'
                        f'*) exec "{sys.executable}" "$@" ;;\nesac\n')
        self.executable('sha256sum', f'#!/bin/sh\nexec "{sys.executable}" -c '
                        '\'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest(), sys.argv[1])\' "$1"\n')
        self.executable('gh', '#!/bin/sh\nprintf "%s\\n" "$@" > "$WORKFLOW_CAPTURE"\n')
        self.env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                    'TAG': 'v4.1.0', 'GITHUB_REPOSITORY': 'guru-irl/foxy',
                    'AMO_JWT_ISSUER': 'fake-issuer', 'AMO_JWT_SECRET': 'fake-secret',
                    'WORKFLOW_CAPTURE': str(self.work / 'gh-args'), 'TMPDIR': str(self.work)}
        self.steps = [s for s in load_workflow()[1]['jobs']['release']['steps'] if 'run' in s]

    def executable(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, capture_output=True, text=True, check=True)

    def run_step(self, step):
        return subprocess.run(['/bin/bash', '-e', '-c', step['run']], cwd=self.repo,
                              env=self.env, capture_output=True, text=True)

    def test_tag_mismatch_fails_before_build_or_publish(self):
        self.env['TAG'] = 'v9.9.9'
        result = self.run_step(self.steps[0])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Tag does not match', result.stderr)
        self.assertFalse((self.work / 'gh-args').exists())

    def test_steps_publish_generated_assets_and_annotated_notes(self):
        self.git('tag', 'v4.0.0')
        (self.repo / 'change').write_text('new')
        self.git('add', 'change')
        self.git('commit', '-qm', 'Add feature')
        (self.repo / 'change').write_text('newer')
        self.git('add', 'change')
        self.git('commit', '-qm', 'Fix feature')
        self.git('tag', '-a', 'v4.1.0', '-m', 'Notes for 4.1.0')
        for step in self.steps:
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f"{step['name']}: {result.stdout} {result.stderr}")
        asset = self.repo / 'foxy-4.1.0.xpi'
        self.assertEqual(asset.read_bytes(), b'signed')
        updates = json.loads((self.repo / 'updates.json').read_text())
        update = updates['addons']['{4408f971-7930-41ea-9f93-b01231e40861}']['updates'][0]
        self.assertEqual(update['update_hash'], 'sha256:' + hashlib.sha256(b'signed').hexdigest())
        self.assertEqual(update['update_link'], 'https://github.com/guru-irl/foxy/releases/download/v4.1.0/foxy-4.1.0.xpi')
        self.assertEqual((self.repo / 'release-notes.txt').read_text(),
                         'Notes for 4.1.0\n\nChanges since v4.0.0:\n- Fix feature\n- Add feature\n')
        args = (self.work / 'gh-args').read_text().splitlines()
        self.assertEqual(args[:5], ['release', 'create', 'v4.1.0', 'foxy-4.1.0.xpi', 'updates.json'])
        self.assertEqual(args[-2:], ['--notes-file', 'release-notes.txt'])

    def test_lightweight_tag_falls_back_to_changes_since_previous_tag(self):
        self.git('tag', 'v4.0.0')
        (self.repo / 'change').write_text('new')
        self.git('add', 'change')
        self.git('commit', '-qm', 'Add feature')
        (self.repo / 'change').write_text('newer')
        self.git('add', 'change')
        self.git('commit', '-qm', 'Fix feature')
        self.git('tag', 'v4.1.0')
        result = self.run_step(self.steps[-1])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.repo / 'release-notes.txt').read_text(),
                         'Changes since v4.0.0:\n- Fix feature\n- Add feature\n')

    def test_first_release_lists_commits_after_the_annotation(self):
        self.git('tag', '-a', 'v4.1.0', '-m', 'First release')
        result = self.run_step(self.steps[-1])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.repo / 'release-notes.txt').read_text(),
                         'First release\n\nChanges:\n- Initial commit\n')


if __name__ == '__main__':
    unittest.main()
