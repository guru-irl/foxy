import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("manifest replaces the new tab page and the home page with newtab.html", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.chrome_url_overrides, { newtab: "newtab.html" });
  assert.deepEqual(manifest.chrome_settings_overrides, { homepage: "newtab.html" });
});

test("manifest asks only for tabs, tabGroups and sessions and uses a module background page", () => {
  assert.deepEqual(manifest.permissions, ["tabs", "tabGroups", "sessions"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.background, { scripts: ["background.js"], type: "module" });
});

test("the background script exists and imports the forget helper", () => {
  assert.ok(manifest.background, "missing background declaration");
  for (const script of manifest.background.scripts) {
    assert.ok(existsSync(new URL(script, root)), `missing ${script}`);
  }
  const source = read("background.js");
  assert.match(source, /from ["']\.\/src\/forget\.js["']/);
  assert.ok(existsSync(new URL("src/forget.js", root)), "missing src/forget.js");
});

test("manifest has the gecko settings AMO needs", () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.equal(gecko.id, "{4408f971-7930-41ea-9f93-b01231e40861}");
  assert.equal(gecko.strict_min_version, "140.0");
  assert.deepEqual(gecko.data_collection_permissions, { required: ["none"] });
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("every file the page references exists", () => {
  const refs = [
    ...[...read("newtab.html").matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ...[...read("newtab.css").matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]),
  ];
  assert.ok(refs.length >= 4, `expected at least 4 references, found ${refs.length}`);
  for (const ref of refs) assert.ok(existsSync(new URL(ref, root)), `missing ${ref}`);
});

test("fonts ship with their licences", () => {
  for (const file of ["fonts/Danfo-OFL.txt", "fonts/BebasNeue-OFL.txt"]) {
    assert.ok(existsSync(new URL(file, root)), `missing ${file}`);
  }
});

test("the page loads its code as one module, src/main.js", () => {
  assert.match(read("newtab.html"), /<script type="module" src="src\/main\.js"><\/script>/);
});
