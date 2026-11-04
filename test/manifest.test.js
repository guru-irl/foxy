import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../extension/", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("manifest and package name the add-on Foxy 4.1.0", () => {
  assert.equal(manifest.name, "Foxy");
  assert.equal(manifest.version, "4.1.0");
  assert.equal(manifest.description, "A board of your tabs, tab groups and pinned tabs, saved as bookmarks and synced across devices.");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", root), "utf8"));
  assert.equal(pkg.version, "4.1.0");
});

test("manifest replaces the new tab page and the home page with newtab.html", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.chrome_url_overrides, { newtab: "newtab.html" });
  assert.deepEqual(manifest.chrome_settings_overrides, { homepage: "newtab.html" });
});

test("manifest asks for tabs, tabGroups, bookmarks, storage, scripting and nativeMessaging, geolocation only as optional, and uses a module event page", () => {
  assert.deepEqual(manifest.permissions, ["tabs", "tabGroups", "bookmarks", "storage", "scripting", "nativeMessaging"]);
  assert.deepEqual(manifest.optional_permissions, ["geolocation"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["*://*/*"]);
  assert.deepEqual(manifest.background, { scripts: ["background.js"], type: "module" });
});

test("the background script exists and imports the close helper", () => {
  assert.ok(manifest.background, "missing background declaration");
  for (const script of manifest.background.scripts) {
    assert.ok(existsSync(new URL(script, root)), `missing ${script}`);
  }
  const source = read("background.js");
  assert.match(source, /from ["']\.\/src\/close\.js["']/);
  assert.ok(existsSync(new URL("src/close.js", root)), "missing src/close.js");
});

test("manifest registers the embedded options page and its references exist", () => {
  assert.deepEqual(manifest.options_ui, { page: "options.html" });
  for (const ref of [...read("options.html").matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])) {
    assert.ok(existsSync(new URL(ref, root)), `missing ${ref}`);
  }
});

test("manifest has the gecko settings AMO needs", () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.equal(gecko.id, "{4408f971-7930-41ea-9f93-b01231e40861}");
  assert.equal(gecko.strict_min_version, "140.0");
  assert.equal(gecko.update_url, "https://github.com/guru-irl/foxy/releases/latest/download/updates.json");
  assert.deepEqual(gecko.data_collection_permissions, { required: ["none"], optional: ["locationInfo"] });
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
  for (const file of ["fonts/GoogleSansFlex-OFL.txt", "fonts/GoogleSansFlex-TRADEMARKS.md", "fonts/CascadiaMono-OFL.txt", "fonts/EBGaramond-OFL.txt"]) {
    assert.ok(existsSync(new URL(file, root)), `missing ${file}`);
  }
});

test("the page loads its code as one module, src/main.js", () => {
  assert.match(read("newtab.html"), /<script type="module" src="src\/main\.js"><\/script>/);
});
