import { test, assert, fixture, nextFrame } from "./harness.js";
import { createBoardFirefox } from "./controller.js";
import { createController } from "../../extension/src/main.js";

let css;
async function styles() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/extension/newtab.css";
    link.onload = resolve; document.head.append(link);
  });
  await css; await document.fonts.ready;
}
async function flush(ff) { for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); } }
async function setup({ folders = { 1: "one", 2: "two" } } = {}) {
  await styles();
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "Here" }, { id: 2, windowId: 2, title: "There" }],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 11, windowId: 1, pinned: true },
      { id: 20, windowId: 2, groupId: 2 }, { id: 21, windowId: 2, pinned: true }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
      ? { folders, saved: [{ folderId: "closed", title: "Closed" }], missing: [] } : undefined);
  const host = document.createElement("div"), node = document.createElement("div"), pane = document.createElement("aside");
  node.className = "board"; node.style.cssText = "width:1232px;height:600px";
  pane.className = "settings-pane"; pane.hidden = true;
  host.append(node, pane); fixture().append(host);
  const control = createController(node, ff.browser); await control.refresh(); await flush(ff);
  return { ff, node, pane, control };
}
function choice(pane, key, value) { return pane.querySelector(`[data-key="${key}"] [data-value="${value}"]`); }
function toggle(pane, key) { return pane.querySelector(`button[data-key="${key}"]`); }
function writes(ff) { return ff.calls.filter(c => ["storage.sync.set", "storage.local.set"].includes(c.api)); }

// Catches a missing delegated gear handler, focus loss after board replacement,
// or pane content rebuilt on live storage updates.
test("the gear opens a sibling pane and Escape or gear closes it with focus restored", async () => {
  const { ff, node, pane } = await setup();
  const gear = () => node.querySelector(".settings-button");
  assert.equal(gear().getAttribute("aria-expanded"), "false");
  gear().click(); assert.equal(pane.hidden, false);
  assert.equal(gear().getAttribute("aria-expanded"), "true");
  const first = pane.querySelector("button"); assert.equal(document.activeElement, first);
  const box = pane.getBoundingClientRect(); assert.equal(box.width, 360); assert.equal(box.height, innerHeight);
  assert.equal(getComputedStyle(pane).boxShadow, "none"); assert.equal(getComputedStyle(pane).borderTopWidth, "0px");
  assert.equal(pane.querySelectorAll(".setting-caption").length, 2);
  const scroll = pane.querySelector(".settings-scroll"); assert.equal(scroll.tabIndex, -1);
  scroll.scrollTop = 100; scroll.dispatchEvent(new Event("scroll"));
  assert.ok(pane.classList.contains("scroll-start"));
  await ff.browser.storage.sync.set({ settings: { showClock: false } }); await flush(ff);
  assert.equal(pane.querySelector("button"), first); assert.equal(document.activeElement, first);
  assert.equal(gear().getAttribute("aria-expanded"), "true");
  pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(pane.hidden, true); assert.equal(document.activeElement, gear());
  gear().click(); gear().click(); assert.equal(pane.hidden, true); assert.equal(document.activeElement, gear());
});

test("open pane hides only the rail content and uses its own capped alpha in both schemes", async () => {
  const { ff, node, pane } = await setup();
  for (let i = 0; i < 24; i++) await ff.browser.tabs.create({ windowId: 1, url: "about:blank", active: false });
  await flush(ff);
  const rail = node.querySelector(".rail"), width = rail.getBoundingClientRect().width, rows = rail.querySelector(".rows");
  rows.scrollTop = 100;
  node.querySelector(".settings-button").click();
  assert.equal(rows.scrollTop, 100);
  assert.equal(getComputedStyle(rail.querySelector(".column-title")).visibility, "hidden");
  assert.equal(getComputedStyle(rail.querySelector(".rows")).visibility, "hidden");
  assert.equal(getComputedStyle(rail.querySelector(".settings-button")).visibility, "visible");
  assert.equal(rail.getBoundingClientRect().width, width);
  const scheme = document.documentElement.style.colorScheme;
  try {
    for (const [value, dark, light] of [["medium", 0.8, 0.9], ["low", 0.92, 0.92], ["high", 0.65, 0.75]]) {
      choice(pane, "transparency", value).click(); await flush(ff);
      document.documentElement.style.colorScheme = "dark";
      assert.equal(getComputedStyle(pane).backgroundColor, `rgba(22, 22, 24, ${dark})`);
      document.documentElement.style.colorScheme = "light";
      assert.equal(getComputedStyle(pane).backgroundColor, `rgba(246, 246, 247, ${light})`);
    }
  } finally { document.documentElement.style.colorScheme = scheme; }
  node.querySelector(".settings-button").click();
  assert.equal(getComputedStyle(node.querySelector(".rail .column-title")).visibility, "visible");
  assert.equal(getComputedStyle(node.querySelector(".rail .rows")).visibility, "visible");
  assert.equal(node.querySelector(".rail .rows").scrollTop, 100);
});

// Each row catches a wrong storage scope/key/value or missing live board apply.
for (const [key, value, scope, apply] of [
  ["cellSize", "S", "device", node => assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), "48px")],
  ["cellSize", "L", "device", node => assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), "112px")],
  ["cellSize", "XL", "device", node => assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), "144px")],
  ["density", "compact", "device", node => assert.equal(node.style.getPropertyValue("--row"), "24px")],
  ["timeFormat", "12", "synced", node => assert.ok(/AM|PM/.test(node.querySelector(".clock-time").textContent))],
  ["transparency", "low", "synced", node => assert.equal(node.style.getPropertyValue("--card-alpha-dark"), "0.75")],
]) {
  test(`${key}=${value} writes once to ${scope} and applies through storage changes`, async () => {
    const { ff, node, pane } = await setup(); node.querySelector(".settings-button").click();
    const before = writes(ff).length; choice(pane, key, value).click(); await flush(ff);
    const changes = writes(ff).slice(before); assert.equal(changes.length, 1);
    assert.equal(changes[0].api, scope === "device" ? "storage.local.set" : "storage.sync.set");
    const stored = await ff.browser.storage[scope === "device" ? "local" : "sync"].get(null);
    assert.equal(stored[scope === "device" ? "deviceSettings" : "settings"][key], value);
    assert.equal(choice(pane, key, value).getAttribute("aria-pressed"), "true"); apply(node);
  });
}
for (const key of ["showClock", "showPinned", "showSaved", "showDate", "otherWindows", "pinsMoveHere"]) {
  test(`${key} toggle writes once and applies live`, async () => {
    const { ff, node, pane, control } = await setup(); node.querySelector(".settings-button").click();
    const before = writes(ff).length; toggle(pane, key).click(); await flush(ff);
    assert.equal(writes(ff).length - before, 1);
    assert.equal((await ff.browser.storage.sync.get("settings")).settings[key], false);
    assert.equal(toggle(pane, key).getAttribute("aria-checked"), "false");
    if (["showClock", "showPinned", "showSaved"].includes(key)) {
      assert.equal(node.querySelector(`[data-kind="${key.slice(4).toLowerCase()}"]`), null);
    } else if (key === "showDate") assert.equal(node.querySelector(".clock-date").hidden, true);
    else if (key === "otherWindows") assert.equal(node.querySelector('[data-tile-id="group:two"]'), null);
    else {
      await control.handlers.onOpen({ id: 21 }); await flush(ff);
      assert.equal((await ff.browser.tabs.get(21)).windowId, 2);
      assert.equal((await ff.browser.windows.getLastFocused()).id, 2);
      assert.ok(await ff.browser.tabs.get(99));
    }
  });
}
test("custom cell validates integer bounds and rail stepper stays within whole-cell limits", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-button").click();
  choice(pane, "cellSize", "custom").click(); await flush(ff);
  const field = pane.querySelector('input[data-key="customCell"]'); assert.equal(field.hidden, false);
  for (const value of ["39", "241", "80.5", ""]) {
    const before = writes(ff).length; field.value = value; field.dispatchEvent(new Event("change")); await flush(ff);
    assert.equal(writes(ff).length, before); assert.equal(field.value, "80");
  }
  const before = writes(ff).length; field.value = "40"; field.dispatchEvent(new Event("change")); await flush(ff);
  assert.equal(writes(ff).length - before, 1);
  assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), "40px");
  const minus = pane.querySelector('[data-rail="minus"]'), plus = pane.querySelector('[data-rail="plus"]');
  minus.click(); await flush(ff); assert.equal(minus.disabled, true);
  assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 2);
  for (let i = 0; i < 12; i++) { plus.click(); await flush(ff); }
  assert.equal(plus.disabled, true);
  assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 11);
  choice(pane, "cellSize", "XL").click(); await flush(ff);
  assert.equal(pane.querySelector('[data-rail="value"]').textContent, "3");
  assert.equal(plus.disabled, true); assert.equal(field.hidden, true);
});
test("a failed save restores the stored control, logs Foxy and never applies to board", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-button").click();
  const set = ff.browser.storage.sync.set, warn = console.warn, warnings = [];
  ff.browser.storage.sync.set = async () => { throw new Error("quota"); };
  console.warn = (...args) => warnings.push(args);
  try {
    toggle(pane, "showClock").click(); await flush(ff);
    assert.equal(toggle(pane, "showClock").getAttribute("aria-checked"), "true");
    assert.ok(node.querySelector('[data-kind="clock"]')); assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.sync.set = set; console.warn = warn; }
});
test("a failed device save restores its selected segment and keeps row density", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-button").click();
  const set = ff.browser.storage.local.set, warn = console.warn, warnings = [];
  ff.browser.storage.local.set = async () => { throw new Error("unavailable"); }; console.warn = (...args) => warnings.push(args);
  try {
    choice(pane, "density", "compact").click(); await flush(ff);
    assert.equal(choice(pane, "density", "normal").getAttribute("aria-pressed"), "true");
    assert.equal(node.style.getPropertyValue("--row"), "32px");
    assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.local.set = set; console.warn = warn; }
});
test("a failed reset logs and keeps tile keys, with the reset button usable again", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-button").click();
  const before = await ff.browser.storage.sync.get(null), remove = ff.browser.storage.sync.remove, warn = console.warn, warnings = [];
  ff.browser.storage.sync.remove = async () => { throw new Error("unavailable"); }; console.warn = (...args) => warnings.push(args);
  try {
    const reset = pane.querySelector(".settings-reset"); reset.click(); reset.click(); await flush(ff);
    assert.deepEqual(await ff.browser.storage.sync.get(null), before); assert.equal(reset.disabled, false);
    assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.sync.remove = remove; console.warn = warn; }
});
test("reset removes only tile keys once, and an open board places visible tiles in spec order", async () => {
  const { ff, node, pane } = await setup();
  await ff.browser.storage.sync.set({ "tile:hidden": { x: 0, y: 70, w: 3, h: 4 }, keep: 7,
    settings: { showPinned: false }, "tile:clock": { x: 0, y: 70, w: 5, h: 2 } }); await flush(ff);
  node.querySelector(".settings-button").click(); const reset = pane.querySelector(".settings-reset");
  const before = ff.calls.length; reset.click(); assert.equal(reset.textContent, "Confirm reset");
  assert.equal(ff.calls.slice(before).filter(c => c.api === "storage.sync.remove").length, 0);
  reset.click(); await flush(ff);
  const removals = ff.calls.slice(before).filter(c => c.api === "storage.sync.remove"); assert.equal(removals.length, 1);
  assert.ok(removals[0].args[0].includes("tile:hidden")); assert.ok(removals[0].args[0].every(key => key.startsWith("tile:")));
  const stored = await ff.browser.storage.sync.get(null);
  assert.equal(stored.keep, 7); assert.equal(stored.settings.showPinned, false); assert.equal(stored["tile:hidden"], undefined);
  assert.deepEqual(stored["tile:clock"], { x: 0, y: 0, w: 5, h: 2 });
  assert.deepEqual(stored["tile:group:one"], { x: 5, y: 0, w: 3, h: 4 });
  assert.deepEqual(stored["tile:group:two"], { x: 0, y: 2, w: 3, h: 4 });
  assert.deepEqual(stored["tile:saved"], { x: 3, y: 4, w: 3, h: 4 });
  assert.equal(reset.textContent, "Reset layout");
});
test("reset clears this page's unmapped pending placements", async () => {
  const folders = { 2: "two" }, { ff, pane, node, control } = await setup({ folders });
  await control.handlers.onTabDrop(11, { zone: "cell", rect: { x: 0, y: 30, w: 3, h: 4 } }); await flush(ff);
  node.querySelector(".settings-button").click(); pane.querySelector(".settings-reset").click(); pane.querySelector(".settings-reset").click(); await flush(ff);
  const local = control.view.tiles.find(t => t.id.startsWith("local:") && t.group.id !== 1);
  assert.ok(local);
  control.handlers.onEditEnd(local.group.id); await flush(ff);
  assert.ok(control.view.tiles.find(t => t.id === local.id).y < 30, "reset must discard the pending drop rectangle");
});
test("reset confirmation expires after three seconds", async () => {
  const { node, pane } = await setup(); node.querySelector(".settings-button").click();
  const reset = pane.querySelector(".settings-reset"); reset.click();
  await new Promise(resolve => setTimeout(resolve, 3050)); assert.equal(reset.textContent, "Reset layout");
});

async function options(ff) {
  // Load the actual HTML and module in a separate document with the fake API at
  // the WebExtension boundary, before its module executes.
  const frame = document.createElement("iframe"); frame.width = "500"; frame.height = "720"; fixture().append(frame);
  const html = await (await fetch("/extension/options.html")).text();
  frame.contentWindow.browser = ff.browser;
  Object.defineProperty(frame.contentWindow.screen, "availWidth", { value: 640, configurable: true });
  const doc = frame.contentDocument; doc.open();
  doc.write(html.replace('<head>', '<head><base href="/extension/">')); doc.close();
  await new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
  await flush(ff); await frame.contentDocument.fonts.ready;
  return frame;
}
test("options.html renders the shared pane, saves and resets only tile keys", async () => {
  const { ff, node } = await setup();
  await ff.browser.storage.sync.set({ "tile:orphan": { x: 0, y: 20, w: 3, h: 4 }, keep: 7, settings: { transparency: "high" } }); await flush(ff);
  const frame = await options(ff), doc = frame.contentDocument, pane = doc.querySelector(".settings-pane");
  assert.ok(pane); assert.equal(pane.hidden, false); assert.equal(doc.querySelector(".settings-button"), null);
  assert.equal(pane.querySelector('[data-rail="value"]').textContent, "2");
  assert.equal(pane.querySelector('[data-rail="plus"]').disabled, true);
  assert.equal(pane.style.getPropertyValue("--card-alpha-dark"), "0.45");
  assert.equal(pane.style.getPropertyValue("--card-alpha-light"), "0.55");
  assert.deepEqual([...pane.querySelectorAll("h2")].map(n => n.textContent), ["Grid", "Tiles", "Clock", "Cards", "Windows", "Pins"]);
  const before = writes(ff).length; choice(pane, "density", "compact").click(); await flush(ff);
  assert.equal(writes(ff).length - before, 1); assert.equal(node.style.getPropertyValue("--row"), "24px");
  const reset = pane.querySelector(".settings-reset"), start = ff.calls.length; reset.click(); reset.click(); await flush(ff);
  const removals = ff.calls.slice(start).filter(c => c.api === "storage.sync.remove"); assert.equal(removals.length, 1);
  assert.ok(removals[0].args[0].every(key => key.startsWith("tile:")));
  const stored = await ff.browser.storage.sync.get(null); assert.equal(stored.keep, 7);
  assert.deepEqual(stored.settings, { transparency: "high" });
  assert.equal(stored["tile:orphan"], undefined); assert.equal((await ff.browser.storage.local.get("deviceSettings")).deviceSettings.density, "compact");
  for (const scheme of ["light", "dark"]) {
    doc.documentElement.style.colorScheme = scheme;
    const css = frame.contentWindow.getComputedStyle(pane);
    assert.equal(css.borderTopWidth, "0px"); assert.equal(css.boxShadow, "none");
    assert.ok(css.backgroundColor !== "rgba(0, 0, 0, 0)");
    assert.equal(frame.contentWindow.getComputedStyle(pane.querySelector("h2")).fontStyle, "normal");
  }
});
