import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../extension/", import.meta.url);
const css = readFileSync(new URL("newtab.css", root), "utf8");
const fontFiles = [
  "CascadiaMono-OFL.txt",
  "CascadiaMono.ttf",
  "EBGaramond-OFL.txt",
  "EBGaramond.ttf",
  "GoogleSansFlex-OFL.txt",
  "GoogleSansFlex-TRADEMARKS.md",
  "GoogleSansFlex.ttf",
];

function declarations(block) {
  return Object.fromEntries(
    block.replace(/\/\*[\s\S]*?\*\//g, "").split(";").filter((part) => part.trim()).map((part) => {
      const colon = part.indexOf(":");
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
    }),
  );
}

function rule(selector) {
  const matches = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim()
      .split(",").some(part => part.trim() === selector));
  assert.ok(matches.length, `missing ${selector} rule`);
  return Object.assign({}, ...matches.map(match => declarations(match[2])));
}

function face(family) {
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => declarations(match[1]));
  const found = faces.find((entry) => entry["font-family"] === `"${family}"`);
  assert.ok(found, `missing ${family} font face`);
  return found;
}

test("the add-on bundles exactly the three fonts and their licence notices", () => {
  assert.deepEqual(readdirSync(new URL("fonts/", root)).sort(), fontFiles);
});

for (const [file, sha256] of [
  ["GoogleSansFlex.ttf", "c31a482fbecbf2e07e6890134d20078723aadf732c9b9c6c9a44f86f8265b6fe"],
  ["CascadiaMono.ttf", "78864a1b4d03767a44731454a6f24c6b7d6e93fb5f62932860eb02e409cd50cb"],
]) {
  test(`${file} is the verified staged font`, () => {
    const bytes = readFileSync(new URL(`fonts/${file}`, root));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  });
}

test("Foxy Sans exposes the full weight, width and oblique ranges without synthesis", () => {
  const sans = face("Foxy Sans");
  assert.equal(sans.src, 'url("fonts/GoogleSansFlex.ttf") format("truetype")');
  assert.equal(sans["font-weight"], "1 1000");
  assert.equal(sans["font-stretch"], "25% 151%");
  assert.equal(sans["font-style"], "oblique 0deg 10deg");
});

test("Foxy Mono exposes the bundled variable weight range", () => {
  const mono = face("Foxy Mono");
  assert.equal(mono.src, 'url("fonts/CascadiaMono.ttf") format("truetype")');
  assert.equal(mono["font-weight"], "200 700");
});

test("no add-on file retains a reference to a removed font", () => {
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) visit(path);
      else assert.doesNotMatch(readFileSync(path).toString("latin1"), /Danfo|Bebas/i, path.pathname);
    }
  }
  visit(root);
});

test("default text uses Foxy Sans at weight 400", () => {
  assert.equal(rule("body").font, '400 13px "Foxy Sans", system-ui, sans-serif');
});

test("Foxy Serif exposes EB Garamond's upright variable weight range", () => {
  const serif = face("Foxy Serif");
  assert.equal(serif.src, 'url("fonts/EBGaramond.ttf") format("truetype")');
  assert.equal(serif["font-weight"], "400 800");
  assert.equal(serif["font-style"], "normal");
});

test("group titles are heavy, condensed, slanted capitals without extra letter spacing", () => {
  const title = rule(".column-header");
  assert.equal(title["font-family"], '"Foxy Sans", system-ui, sans-serif');
  assert.equal(title["font-weight"], "700");
  assert.equal(title["font-stretch"], "50%");
  assert.equal(title["font-style"], "oblique 10deg");
  assert.equal(title["text-transform"], "uppercase");
  assert.equal(title["letter-spacing"], "0");
});

test("the 12px group dot keeps the sidebar's original glow", () => {
  const dot = rule(".dot");
  assert.equal(dot.width, "12px");
  assert.equal(dot.height, "12px");
  assert.equal(dot["box-shadow"], "0 0 6px color-mix(in oklab, var(--g2) 50%, transparent)");
});

test("no typography role overrides the default zero roundness or sets a slant axis", () => {
  for (const selector of ["body", ".clock-time", ".clock-date", ".column-header"]) {
    const settings = rule(selector)["font-variation-settings"] ?? "";
    for (const match of settings.matchAll(/"ROND"\s+(-?\d*\.?\d+)/gi)) {
      assert.equal(Number(match[1]), 0, `${selector} roundness must stay zero`);
    }
    assert.doesNotMatch(settings, /"slnt"/i);
  }
});

test("only group titles have oblique or italic styling in any style rule", () => {
  const slanted = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    // Font-face descriptors expose available styles, not styles applied to text.
    if (selector.startsWith("@")) continue;
    const styles = declarations(match[2]);
    if (/\b(?:oblique|italic)\b/i.test(`${styles["font-style"] ?? ""} ${styles.font ?? ""}`)) {
      slanted.push(...selector.split(",").map((part) => part.trim()));
    }
  }
  assert.deepEqual(slanted, [".column-header"]);
});
