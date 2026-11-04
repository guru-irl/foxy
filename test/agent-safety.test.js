import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('agent does not bypass sync with bookmarks.removeTree', async () => {
  const source = await readFile(new URL('../extension/src/agent.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bbookmarks\s*\.\s*removeTree\s*\(/);
});
