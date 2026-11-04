import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const file = path => new URL(`../${path}`, import.meta.url);
const manifest = JSON.parse(readFileSync(file("extension/manifest.json"), "utf8"));

test("Firefox uses the Foxy SVG for both add-on icon sizes", () => {
  assert.deepEqual(manifest.icons, { "48": "icons/foxy.svg", "96": "icons/foxy.svg" });
  assert.ok(existsSync(file("extension/icons/foxy.svg")));
});

test("the logo is valid SVG with the specified gradient stops", () => {
  assert.ok(existsSync(file("extension/icons/foxy.svg")), "missing logo SVG");
  const parser = `import json,sys,xml.etree.ElementTree as ET\nr=ET.parse(sys.argv[1]).getroot()\nn={'s':'http://www.w3.org/2000/svg'}\nprint(json.dumps([[s.get('offset'),s.get('stop-color')] for s in r.findall('.//s:linearGradient/s:stop',n)]))`;
  const stops = JSON.parse(execFileSync("python3", ["-c", parser, fileURLToPath(file("extension/icons/foxy.svg"))], { encoding: "utf8" }));
  assert.deepEqual(stops, [["0%", "#9043DF"], ["25%", "#C61FA4"], ["40%", "#EB2F76"], ["52%", "#FA385B"], ["72%", "#FF7449"], ["100%", "#FFC243"]]);
});

test("project and theme carry their MIT licences", () => {
  assert.ok(existsSync(file("LICENSE")), "missing project licence");
  assert.ok(existsSync(file("theme/LICENSE")), "missing theme licence");
  assert.match(readFileSync(file("theme/LICENSE"), "utf8"), /Copyright \(c\) 2025 Milosz/);
});
