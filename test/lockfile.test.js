import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('lockfile packages use public npm tarballs and SHA-512 integrity', () => {
  const packages = Object.entries(lock.packages).filter(([name]) => name);
  assert.ok(packages.length > 0);
  for (const [name, entry] of packages) {
    assert.equal(new URL(entry.resolved).origin, 'https://registry.npmjs.org', name);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, name);
  }
});
