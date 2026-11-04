import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = path => new URL(`../${path}`, import.meta.url);

test("README links to the project and third-party licence files", () => {
  const markdown = readFileSync(file("README.md"), "utf8");
  const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  for (const path of ["LICENSE", "theme/LICENSE", "extension/fonts/GoogleSansFlex-OFL.txt",
    "extension/fonts/GoogleSansFlex-TRADEMARKS.md", "extension/fonts/CascadiaMono-OFL.txt", "extension/fonts/EBGaramond-OFL.txt"]) {
    assert.ok(links.includes(path), `README does not link to ${path}`);
  }
  for (const path of links.filter(link => !link.includes(":") && /(?:LICENSE|OFL|TRADEMARKS)/.test(link))) {
    assert.ok(existsSync(file(path)), `README licence link does not exist: ${path}`);
  }
});

test("tracked text has no absolute home paths or old design paths", () => {
  const patterns = [["", "Users", ""].join("/"), ["docs", "superpowers"].join("/")];
  const result = spawnSync("git", ["grep", "-nI", ...patterns.flatMap(p => ["-e", p]), "--", "."], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.status === 0 ? result.stdout : result.stderr);
});
