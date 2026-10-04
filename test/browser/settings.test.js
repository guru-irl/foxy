import { test, assert, fixture, nextFrame, withPseudoState } from "./harness.js";
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
async function setup({ folders = { 1: "one", 2: "two" }, width = 1232, railCells = 3 } = {}) {
  await styles();
  const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }, { id: 2 }], selfTabId: 99,
    groups: [{ id: 1, windowId: 1, title: "Here" }, { id: 2, windowId: 2, title: "There" }],
    tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 11, windowId: 1, pinned: true },
      { id: 20, windowId: 2, groupId: 2 }, { id: 21, windowId: 2, pinned: true }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
      ? { folders, saved: [{ folderId: "closed", title: "Closed" }], missing: [] } : undefined);
  const host = document.createElement("div"), node = document.createElement("div"), pane = document.createElement("aside");
  host.className = "page"; host.style.cssText = `position:fixed;top:0;right:0;width:${width}px`;
  node.className = "board";
  await ff.browser.storage.sync.set({ settings: { railCells } }); await ff.settle();
  pane.className = "settings-pane"; pane.hidden = true;
  host.append(node, pane); fixture().append(host);
  const control = createController(node, ff.browser); await control.refresh(); await flush(ff);
  return { ff, node, pane, control };
}
function choice(pane, key, value) { return pane.querySelector(`[data-key="${key}"] [data-value="${value}"]`); }
function toggle(pane, key) { return pane.querySelector(`button[data-key="${key}"]`); }
function writes(ff) { return ff.calls.filter(c => ["storage.sync.set", "storage.local.set"].includes(c.api)); }
async function waitForConfirm() { await new Promise(resolve => setTimeout(resolve, 410)); }

// Catches a missing delegated gear handler, focus loss after board replacement,
// or pane content rebuilt on live storage updates.
test("the gear opens a sibling pane and Escape or gear closes it with focus restored", async () => {
  const { ff, node, pane } = await setup();
  const gear = () => node.querySelector(".settings-cell");
  assert.equal(gear().getAttribute("aria-expanded"), "false");
  gear().click(); assert.equal(pane.hidden, false);
  assert.equal(gear().getAttribute("aria-expanded"), "true");
  const first = pane.querySelector("button"); assert.equal(document.activeElement, first);
  const box = pane.getBoundingClientRect(); assert.equal(box.width, 360); assert.equal(box.height, innerHeight - 96);
  assert.equal(getComputedStyle(pane).boxShadow, "none"); assert.equal(getComputedStyle(pane).borderTopWidth, "0px");
  assert.equal(pane.querySelectorAll(".setting-caption").length, 3);
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

// Based on the final reviewer's gear-focus probe. A tab update replaces the
// rail, so restoring only rows and group headers loses the keyboard position.
test("gear keeps focus across a board render after Escape closes the pane", async () => {
  const { ff, node, pane } = await setup();
  const gear = () => node.querySelector(".settings-cell");
  gear().click();
  pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.activeElement, gear());
  const before = gear();
  await ff.browser.tabs.update(10, { url: "https://example.com/focus" }); await flush(ff);
  assert.ok(gear() !== before, "tab event must replace the board");
  assert.equal(document.activeElement, gear(), "focus stays on the replacement gear");
});

// Based on the reviewer's SAVED-row Escape probe, with the confirmation armed.
test("Escape handled by SAVED confirmation leaves the settings pane open", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  node.querySelector(".saved-delete").click(); await flush(ff);
  const row = node.querySelector(".saved-row"); assert.ok(row.classList.contains("confirming"));
  row.querySelector(".saved-delete").focus();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  row.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(pane.hidden, false);
  await flush(ff); assert.equal(node.querySelector(".saved-row").classList.contains("confirming"), false);
  assert.ok(document.activeElement !== node.querySelector(".settings-cell"));
  pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(pane.hidden, true);
});

test("device-only controls describe their captions without describing synced controls", async () => {
  const { node, pane } = await setup(); node.querySelector(".settings-cell").click();
  for (const key of ["cellSize", "density"]) {
    const group = pane.querySelector(`[data-key="${key}"]`), caption = group.parentElement.querySelector(".setting-caption");
    assert.ok(caption.id); assert.equal(group.getAttribute("aria-describedby"), caption.id);
    assert.equal(document.getElementById(group.getAttribute("aria-describedby")), caption);
    assert.equal(caption.textContent, "This device only");
  }
  for (const key of ["timeFormat", "transparency"]) assert.equal(pane.querySelector(`[data-key="${key}"]`).getAttribute("aria-describedby"), null);
});

test("open pane hides only the rail content and uses its own capped alpha in both schemes", async () => {
  const { ff, node, pane } = await setup();
  for (let i = 0; i < 24; i++) await ff.browser.tabs.create({ windowId: 1, url: "about:blank", active: false });
  await flush(ff);
  const rail = node.querySelector(".rail"), width = rail.getBoundingClientRect().width, rows = rail.querySelector(".rows");
  rows.scrollTop = 100;
  node.querySelector(".settings-cell").click();
  assert.equal(rows.scrollTop, 100);
  assert.equal(getComputedStyle(rail.querySelector(".column-title")).visibility, "hidden");
  assert.equal(getComputedStyle(rail.querySelector(".rows")).visibility, "hidden");
  assert.equal(getComputedStyle(node.querySelector(".settings-cell")).visibility, "visible");
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
  node.querySelector(".settings-cell").click();
  assert.equal(getComputedStyle(node.querySelector(".rail .column-title")).visibility, "visible");
  assert.equal(getComputedStyle(node.querySelector(".rail .rows")).visibility, "visible");
  assert.equal(node.querySelector(".rail .rows").scrollTop, 100);
});

// Catches focus fills that are identical to a toggle or selected segment's
// resting fill. Check every enabled pill, including unselected segments.
test("settings buttons have distinct neutral focus fills in both schemes without outlines or shadows", async () => {
  const { node, pane } = await setup(); node.querySelector(".settings-cell").click();
  document.activeElement?.blur();
  const scheme = document.documentElement.style.colorScheme;
  // Other test modules each load this sheet. The pseudo-state helper rewrites
  // one copy, so disable duplicates for this probe as on the real page.
  const sheets = [...document.styleSheets].filter(sheet => sheet.href?.endsWith("/extension/newtab.css"));
  const disabled = sheets.map(sheet => sheet.disabled);
  try {
    sheets.slice(1).forEach(sheet => { sheet.disabled = true; });
    for (const value of ["dark", "light"]) {
      document.documentElement.style.colorScheme = value;
      const buttons = [...pane.querySelectorAll("button:not(:disabled)")];
      const resting = buttons.map(button => getComputedStyle(button).backgroundColor);
      const selected = getComputedStyle(choice(pane, "timeFormat", "24")).backgroundColor;
      withPseudoState(buttons, "focus-visible", () => {
        buttons.forEach((button, i) => {
          const css = getComputedStyle(button);
          assert.ok(css.backgroundColor !== resting[i], `${button.dataset.key || button.textContent}: focus must differ from rest (${resting[i]}, ${css.backgroundColor}; ${document.styleSheets.length} sheets)`);
          assert.ok(css.backgroundColor !== selected, "focus must differ from selected fill");
          const [r, g, b] = css.backgroundColor.match(/[\d.]+/g).map(Number);
          assert.equal(r, g); assert.equal(g, b);
          assert.equal(css.outlineStyle, "none"); assert.equal(css.borderTopWidth, "0px"); assert.equal(css.boxShadow, "none");
        });
      });
    }
  } finally {
    document.documentElement.style.colorScheme = scheme;
    sheets.forEach((sheet, i) => { sheet.disabled = disabled[i]; });
  }
});

// Each row catches a wrong storage scope/key/value or missing live board apply.
for (const [key, value, scope, apply] of [
  ["cellSize", "S", "device", node => assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), `${1248 / 19 - 16}px`)],
  ["cellSize", "L", "device", node => assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), "122.66666666666666px")],
  ["cellSize", "XL", "device", node => assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), `${1248 / 7 - 16}px`)],
  ["density", "compact", "device", node => assert.equal(node.style.getPropertyValue("--row"), "24px")],
  ["timeFormat", "12", "synced", node => assert.ok(/AM|PM/.test(node.querySelector(".clock-time").textContent))],
  ["transparency", "low", "synced", node => assert.equal(node.style.getPropertyValue("--card-alpha-dark"), "0.75")],
]) {
  test(`${key}=${value} writes once to ${scope} and applies through storage changes`, async () => {
    const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
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
    const { ff, node, pane, control } = await setup(); node.querySelector(".settings-cell").click();
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
// Based on the reviewer's rapid-toggle probe. Pin immediate visible state
// as well as the serialised values persisted by the real settings store.
for (const key of ["showClock", "showPinned", "showSaved", "showDate", "otherWindows", "pinsMoveHere"]) {
  test(`two quick ${key} clicks flip from the shown value and save off then on`, async () => {
    const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
    const button = toggle(pane, key), start = ff.calls.length;
    button.click(); assert.equal(button.getAttribute("aria-checked"), "false");
    button.click(); assert.equal(button.getAttribute("aria-checked"), "true");
    await flush(ff);
    const values = ff.calls.slice(start).filter(c => c.api === "storage.sync.set" && c.args[0].settings)
      .map(c => c.args[0].settings[key]);
    assert.deepEqual(values, [false, true]);
    assert.equal((await ff.browser.storage.sync.get("settings")).settings[key], true);
    assert.equal(button.getAttribute("aria-checked"), "true");
  });
}
// Based on the final reviewer's quick-stepper probe. Steps must use the
// shown value, not the stored value while serialised saves are in flight.
test("two quick rail plus clicks show and save 4 then 5", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const plus = pane.querySelector('[data-rail="plus"]'), count = pane.querySelector('[data-rail="value"]');
  const start = ff.calls.length;
  plus.click(); assert.equal(count.textContent, "4");
  plus.click(); assert.equal(count.textContent, "5");
  await flush(ff);
  const values = ff.calls.slice(start).filter(c => c.api === "storage.sync.set" && c.args[0].settings)
    .map(c => c.args[0].settings.railCells);
  assert.deepEqual(values, [4, 5]);
  assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 5);
  assert.equal(count.textContent, "5");
  plus.click(); plus.click(); assert.equal(plus.disabled, true); await flush(ff);
  assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 6);
  const minus = pane.querySelector('[data-rail="minus"]');
  for (let i = 0; i < 6; i++) minus.click();
  assert.equal(count.textContent, "2"); assert.equal(minus.disabled, true); await flush(ff);
  assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 2);
});

test("a completed rail save cannot replace the shown value of a later in-flight step", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const set = ff.browser.storage.sync.set, releases = [];
  ff.browser.storage.sync.set = async values => {
    await new Promise(resolve => releases.push(resolve)); await set(values);
  };
  const plus = pane.querySelector('[data-rail="plus"]'), count = pane.querySelector('[data-rail="value"]');
  try {
    plus.click(); plus.click(); await flush(ff);
    assert.equal(count.textContent, "5"); assert.equal(releases.length, 1);
    releases[0](); await flush(ff);
    assert.equal(releases.length, 2);
    assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 4);
    assert.equal(count.textContent, "5", "the later step is still the shown value");
    releases[1](); await flush(ff);
    assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 5);
    assert.equal(count.textContent, "5");
  } finally { ff.browser.storage.sync.set = set; releases.forEach(release => release()); }
});

test("failed rail steps roll back only after the last in-flight save", async () => {
  const { ff, node, pane } = await setup();
  await ff.browser.storage.sync.set({ settings: { railCells: 4 } }); await flush(ff);
  node.querySelector(".settings-cell").click();
  const set = ff.browser.storage.sync.set, warn = console.warn, releases = [], warnings = [];
  ff.browser.storage.sync.set = async () => {
    await new Promise(resolve => releases.push(resolve)); throw new Error("quota");
  };
  console.warn = (...args) => warnings.push(args);
  const plus = pane.querySelector('[data-rail="plus"]'), count = pane.querySelector('[data-rail="value"]');
  try {
    plus.click(); plus.click(); await flush(ff); assert.equal(count.textContent, "6");
    releases[0](); await flush(ff);
    assert.equal(count.textContent, "6", "first failure must not erase the later step");
    releases[1](); await flush(ff);
    assert.equal(count.textContent, "4"); assert.equal(plus.disabled, false);
    assert.equal((await ff.browser.storage.sync.get("settings")).settings.railCells, 4);
    assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.sync.set = set; console.warn = warn; releases.forEach(release => release()); }
});

test("custom cell validates integer bounds and rail stepper stays within whole-cell limits", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  choice(pane, "cellSize", "custom").click(); await flush(ff);
  const field = pane.querySelector('input[data-key="customCell"]'); assert.equal(field.hidden, false);
  for (const value of ["39", "241", "80.5", ""]) {
    const before = writes(ff).length; field.value = value; field.dispatchEvent(new Event("change")); await flush(ff);
    assert.equal(writes(ff).length, before); assert.equal(field.value, "80");
  }
  const before = writes(ff).length; field.value = "40"; field.dispatchEvent(new Event("change")); await flush(ff);
  assert.equal(writes(ff).length - before, 1);
  assert.equal(node.querySelector(".grid").style.getPropertyValue("--cell"), `${1248 / 22 - 16}px`);
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
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
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
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const set = ff.browser.storage.local.set, warn = console.warn, warnings = [];
  ff.browser.storage.local.set = async () => { throw new Error("unavailable"); }; console.warn = (...args) => warnings.push(args);
  try {
    choice(pane, "density", "compact").click(); await flush(ff);
    assert.equal(choice(pane, "density", "normal").getAttribute("aria-pressed"), "true");
    assert.equal(node.style.getPropertyValue("--row"), "32px");
    assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.local.set = set; console.warn = warn; }
});
// A failed write must not re-read storage: a second unavailable read would
// substitute defaults for the non-default value the user was looking at.
for (const [scope, key, before, after] of [["sync", "showDate", false, true], ["local", "density", "compact", "normal"]]) {
  test(`failed ${key} save restores the shown value without a rollback read`, async () => {
    const { ff, node, pane } = await setup();
    const storageKey = scope === "sync" ? "settings" : "deviceSettings";
    await ff.browser.storage[scope].set({ [storageKey]: { [key]: before } }); await flush(ff);
    node.querySelector(".settings-cell").click();
    const area = ff.browser.storage[scope], get = area.get, set = area.set, warn = console.warn, warnings = [];
    let reads = 0;
    area.get = async (...args) => { if (++reads > 1) throw new Error("read unavailable"); return get(...args); };
    area.set = async () => { throw new Error("write unavailable"); }; console.warn = (...args) => warnings.push(args);
    try {
      if (scope === "sync") toggle(pane, key).click(); else choice(pane, key, after).click();
      await flush(ff);
      assert.equal(reads, 1);
      if (scope === "sync") assert.equal(toggle(pane, key).getAttribute("aria-checked"), String(before));
      else assert.equal(choice(pane, key, before).getAttribute("aria-pressed"), "true");
      assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
    } finally { area.get = get; area.set = set; console.warn = warn; }
  });
}
test("two failed toggle clicks end showing the stored value", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const set = ff.browser.storage.sync.set, warn = console.warn, warnings = [];
  ff.browser.storage.sync.set = async () => { throw new Error("write unavailable"); }; console.warn = (...args) => warnings.push(args);
  try {
    const button = toggle(pane, "showDate");
    button.click(); assert.equal(button.getAttribute("aria-checked"), "false");
    button.click(); assert.equal(button.getAttribute("aria-checked"), "true");
    await flush(ff);
    assert.equal(button.getAttribute("aria-checked"), "true", "stored showDate is still true");
    assert.equal(node.querySelector(".clock-date").hidden, false, "rollback changes no board state");
    assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.sync.set = set; console.warn = warn; }
});
test("a failed reset logs and keeps tile keys, with the reset button usable again", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const before = await ff.browser.storage.sync.get(null), remove = ff.browser.storage.sync.remove, warn = console.warn, warnings = [];
  ff.browser.storage.sync.remove = async () => { throw new Error("unavailable"); }; console.warn = (...args) => warnings.push(args);
  try {
    const reset = pane.querySelector(".settings-reset"); reset.click(); await waitForConfirm(); reset.click(); await flush(ff);
    assert.deepEqual(await ff.browser.storage.sync.get(null), before); assert.equal(reset.disabled, false);
    assert.ok(warnings.some(args => String(args[0]).startsWith("Foxy:")));
  } finally { ff.browser.storage.sync.remove = remove; console.warn = warn; }
});
test("reset removes tile keys and layouts once, and an open board places visible tiles in spec order", async () => {
  const { ff, node, pane } = await setup();
  await ff.browser.storage.sync.set({ "tile:10:hidden": { x: 0, y: 70, w: 3, h: 4 }, keep: 7,
    settings: { showPinned: false }, "tile:10:clock": { x: 0, y: 70, w: 5, h: 2 } }); await flush(ff);
  node.querySelector(".settings-cell").click(); const reset = pane.querySelector(".settings-reset");
  const before = ff.calls.length; reset.click(); assert.equal(reset.textContent, "Confirm reset");
  assert.equal(ff.calls.slice(before).filter(c => c.api === "storage.sync.remove").length, 0);
  await waitForConfirm(); reset.click(); await flush(ff);
  const removals = ff.calls.slice(before).filter(c => c.api === "storage.sync.remove"); assert.equal(removals.length, 1);
  assert.ok(removals[0].args[0].includes("tile:10:hidden")); assert.ok(removals[0].args[0].every(key => key.startsWith("tile:") || key.startsWith("layout:") || key === "layouts"));
  const stored = await ff.browser.storage.sync.get(null);
  assert.equal(stored.keep, 7); assert.equal(stored.settings.showPinned, false); assert.equal(stored["tile:10:hidden"], undefined);
  assert.deepEqual(stored["tile:10:clock"], { x: 0, y: 0, w: 5, h: 2 });
  assert.deepEqual(stored["tile:10:group:one"], { x: 5, y: 0, w: 3, h: 4 });
  assert.deepEqual(stored["tile:10:group:two"], { x: 0, y: 2, w: 3, h: 4 });
  assert.deepEqual(stored["tile:10:saved"], { x: 3, y: 4, w: 3, h: 4 });
  assert.equal(reset.textContent, "Reset layout");
});
test("reset clears this page's unmapped pending placements", async () => {
  const folders = { 2: "two" }, { ff, pane, node, control } = await setup({ folders });
  await control.handlers.onTabDrop(11, { zone: "cell", rect: { x: 0, y: 30, w: 3, h: 4 } }); await flush(ff);
  node.querySelector(".settings-cell").click(); pane.querySelector(".settings-reset").click(); await waitForConfirm(); pane.querySelector(".settings-reset").click(); await flush(ff);
  const local = control.view.tiles.find(t => t.id.startsWith("local:") && t.group.id !== 1);
  assert.ok(local);
  control.handlers.onEditEnd(local.group.id); await flush(ff);
  assert.ok(control.view.tiles.find(t => t.id === local.id).y < 30, "reset must discard the pending drop rectangle");
});
// Based on the reviewer's detail-1/detail-2 probe. A later detail-2 click
// also checks the event guard independently of the 400 ms delay.
test("a double click cannot confirm Reset layout even after the arming delay", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const reset = pane.querySelector(".settings-reset"), before = await ff.browser.storage.sync.get(null), start = ff.calls.length;
  reset.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  reset.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })); await flush(ff);
  assert.equal(ff.calls.slice(start).filter(c => c.api === "storage.sync.remove").length, 0);
  assert.deepEqual(await ff.browser.storage.sync.get(null), before);
  assert.equal(reset.textContent, "Confirm reset");
  await waitForConfirm(); reset.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })); await flush(ff);
  assert.equal(ff.calls.slice(start).filter(c => c.api === "storage.sync.remove").length, 0);
  assert.deepEqual(await ff.browser.storage.sync.get(null), before);
});
test("a second activation inside 400 ms leaves Reset layout armed without removing tiles", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const reset = pane.querySelector(".settings-reset"), before = await ff.browser.storage.sync.get(null), start = ff.calls.length;
  reset.click(); reset.click(); await flush(ff);
  assert.equal(ff.calls.slice(start).filter(c => c.api === "storage.sync.remove").length, 0);
  assert.deepEqual(await ff.browser.storage.sync.get(null), before);
  assert.equal(reset.textContent, "Confirm reset");
});
// Native repeat clicks are a browser default action. Check that keydown
// cancels that action, including repeats later than the arming delay.
test("held Enter or Space cannot confirm Reset layout after 400 ms", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const reset = pane.querySelector(".settings-reset"), before = await ff.browser.storage.sync.get(null);
  reset.focus(); reset.click(); await waitForConfirm();
  for (const key of ["Enter", " "]) {
    const repeat = new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true });
    reset.dispatchEvent(repeat); assert.equal(repeat.defaultPrevented, true);
  }
  await flush(ff); assert.deepEqual(await ff.browser.storage.sync.get(null), before);
  assert.equal(reset.textContent, "Confirm reset");
});
test("reset confirmation expires after three seconds", async () => {
  const { node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const reset = pane.querySelector(".settings-reset"); reset.click();
  await new Promise(resolve => setTimeout(resolve, 3050)); assert.equal(reset.textContent, "Reset layout");
});

async function options(ff, height = 720) {
  // Load the actual HTML and module in a separate document with the fake API at
  // the WebExtension boundary, before its module executes.
  const frame = document.createElement("iframe"); frame.width = "500"; frame.height = String(height); fixture().append(frame);
  const html = await (await fetch("/extension/options.html")).text();
  frame.contentWindow.browser = ff.browser;
  Object.defineProperty(frame.contentWindow.screen, "availWidth", { value: 640, configurable: true });
  const doc = frame.contentDocument; doc.open();
  doc.write(html.replace('<head>', '<head><base href="/extension/">')); doc.close();
  await new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
  await flush(ff); await frame.contentDocument.fonts.ready;
  return frame;
}
// Catches viewport-sized content that prevents about:addons growing its frame.
test("options content sets the document height in a 250 px frame without an inner scroller", async () => {
  const { ff } = await setup(), frame = await options(ff, 250);
  const doc = frame.contentDocument, scroll = doc.querySelector(".settings-scroll");
  const contentHeight = scroll.scrollHeight;
  assert.ok(contentHeight > 250);
  assert.equal(doc.body.scrollHeight, contentHeight);
  assert.equal(scroll.clientHeight, contentHeight);
  assert.equal(frame.contentWindow.getComputedStyle(scroll).overflowY, "visible");
  frame.height = "1200"; await nextFrame(); await nextFrame();
  assert.equal(doc.body.scrollHeight, contentHeight);
  assert.equal(scroll.clientHeight, contentHeight);
});
test("options.html renders the shared pane, saves and resets tile keys and layouts", async () => {
  const { ff, node } = await setup();
  await ff.browser.storage.sync.set({ "tile:10:orphan": { x: 0, y: 20, w: 3, h: 4 }, keep: 7, settings: { transparency: "high" } }); await flush(ff);
  const frame = await options(ff), doc = frame.contentDocument, pane = doc.querySelector(".settings-pane");
  assert.ok(pane); assert.equal(pane.hidden, false); assert.equal(doc.querySelector(".settings-cell"), null);
  assert.equal(pane.querySelector('[data-rail="value"]').textContent, "2");
  assert.equal(pane.querySelector('[data-rail="plus"]').disabled, true);
  assert.equal(pane.style.getPropertyValue("--card-alpha-dark"), "0.45");
  assert.equal(pane.style.getPropertyValue("--card-alpha-light"), "0.55");
  assert.deepEqual([...pane.querySelectorAll("h2")].map(n => n.textContent), ["Grid", "Tiles", "Clock", "Weather", "Cards", "Windows", "Pins"]);
  const before = writes(ff).length; choice(pane, "density", "compact").click(); await flush(ff);
  assert.equal(writes(ff).length - before, 1); assert.equal(node.style.getPropertyValue("--row"), "24px");
  const reset = pane.querySelector(".settings-reset"), start = ff.calls.length; reset.click(); await waitForConfirm(); reset.click(); await flush(ff);
  const removals = ff.calls.slice(start).filter(c => c.api === "storage.sync.remove"); assert.equal(removals.length, 1);
  assert.ok(removals[0].args[0].every(key => key.startsWith("tile:") || key.startsWith("layout:") || key === "layouts"));
  const stored = await ff.browser.storage.sync.get(null); assert.equal(stored.keep, 7);
  assert.deepEqual(stored.settings, { transparency: "high" });
  assert.equal(stored["tile:10:orphan"], undefined); assert.equal((await ff.browser.storage.local.get("deviceSettings")).deviceSettings.density, "compact");
  for (const scheme of ["light", "dark"]) {
    doc.documentElement.style.colorScheme = scheme;
    const css = frame.contentWindow.getComputedStyle(pane);
    assert.equal(css.borderTopWidth, "0px"); assert.equal(css.boxShadow, "none");
    assert.ok(css.backgroundColor !== "rgba(0, 0, 0, 0)");
    assert.equal(frame.contentWindow.getComputedStyle(pane.querySelector("h2")).fontStyle, "normal");
  }
});

test("the open pane meets the top and right edges and leaves a gap above the gear", async () => {
  const { node, pane } = await setup();
  try {
    node.querySelector(".settings-cell").click(); await nextFrame(); await nextFrame();
    pane.getAnimations().forEach(animation => animation.finish());
    const style = getComputedStyle(pane);
    for (const side of ["top", "right"]) assert.equal(style[side], "0px", side);
    assert.equal(style.bottom, "96px");
    const box = pane.getBoundingClientRect(), gear = node.querySelector(".settings-cell").getBoundingClientRect();
    assert.ok(Math.abs(box.bottom + 16 - gear.top) < 0.5);
    assert.ok(Math.abs(box.right - gear.right) < 0.5);
    assert.equal(style.borderRadius, "12px");
  } finally { pane.hidden = true; }
});

test("a failed toggle save followed by a successful one shows the saved value", async () => {
  const { ff, node, pane } = await setup(); node.querySelector(".settings-cell").click();
  const set = ff.browser.storage.sync.set, warn = console.warn;
  let fail = true;
  ff.browser.storage.sync.set = async (...args) => {
    if (fail) { fail = false; throw new Error("write unavailable"); }
    return set(...args);
  };
  console.warn = () => {};
  try {
    const button = toggle(pane, "showDate");
    button.click(); button.click(); button.click();
    await flush(ff);
    assert.equal((await ff.browser.storage.sync.get("settings")).settings.showDate, false);
    assert.equal(button.getAttribute("aria-checked"), "false");
  } finally { ff.browser.storage.sync.set = set; console.warn = warn; }
});

// Catches oversize panes, a rail reaching under the gear, or a gear whose
// fractional dimensions no longer follow the grid after a device-size change.
for (const width of [401, 301]) {
  test(`gear and pane fit a ${width}px page with a two-cell rail`, async () => {
    const { ff, node, pane } = await setup({ width, railCells: 2 });
    const check = () => {
      const board = node.getBoundingClientRect(), rail = node.querySelector(".rail").getBoundingClientRect();
      const gear = node.querySelector(".settings-cell").getBoundingClientRect(), box = pane.getBoundingClientRect();
      const cell = width === 401 ? 88.25 : 89.66666666666667;
      for (const size of [gear.width, gear.height]) assert.ok(Math.abs(size - cell) < 0.5);
      assert.ok(Math.abs(gear.bottom - board.bottom) < 0.5);
      assert.ok(Math.abs(gear.right - board.right) < 0.5);
      assert.ok(Math.abs(rail.bottom + 16 - gear.top) < 0.5);
      assert.ok(Math.abs(box.bottom - rail.bottom) < 0.5);
      assert.ok(Math.abs(box.top - board.top) < 0.5);
      assert.ok(Math.abs(box.right - board.right) < 0.5);
      assert.ok(box.left >= board.left - 0.5);
      assert.ok(Math.abs(box.width - Math.min(360, width)) < 0.5);
      const grid = node.querySelector(".grid").getBoundingClientRect();
      assert.ok(Math.abs(grid.right + 16 - rail.left) < 0.5);
    };
    node.querySelector(".settings-cell").click(); await nextFrame(); await nextFrame();
    pane.getAnimations().forEach(animation => animation.finish());
    assert.equal(pane.hidden, false); check();
    const stored = await ff.browser.storage.sync.get(null);
    node.querySelector(".settings-cell").click(); assert.equal(pane.hidden, true);
    assert.deepEqual(await ff.browser.storage.sync.get(null), stored, "gear never writes layouts");
  });
}

async function newtab(ff, width, height = 720) {
  const frame = document.createElement("iframe");
  frame.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:${height}px;border:0;z-index:10`;
  fixture().append(frame);
  const html = await (await fetch("/extension/newtab.html")).text();
  frame.contentWindow.browser = ff.browser;
  const doc = frame.contentDocument; doc.open();
  doc.write(html.replace("<head>", '<head><base href="/extension/">')); doc.close();
  await new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
  await flush(ff); await doc.fonts.ready;
  return frame;
}

// The controller must persist target-setting defaults, not viewport-dependent
// stretched defaults, when the same group is first mapped on a new device.
test("new groups save the same XL default size at 1600 and 1000 px", async () => {
  const sizes = [];
  for (const width of [1600, 1000]) {
    const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], selfTabId: 99,
      groups: [{ id: 1, windowId: 1, title: "New group" }],
      tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 99, windowId: 1 }] },
      message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
        ? { folders: { 1: "one" }, saved: [], missing: [] } : undefined);
    await ff.browser.storage.local.set({ deviceSettings: { cellSize: "XL" } });
    const frame = await newtab(ff, width);
    try {
      const k = Math.floor((width + 16) / 160) - 3;
      const stored = await ff.browser.storage.sync.get(`tile:${k}:group:one`);
      const group = stored[`tile:${k}:group:one`];
      assert.ok(group, "a mapped group has a saved placement");
      sizes.push([group.w, group.h]);
    } finally { frame.remove(); }
  }
  assert.deepEqual(sizes, [[2, 3], [2, 3]]);
});

// Keeping the old page minimum while measuring makes a second narrow resize
// reuse the previous overflow floor instead of the new viewport width.
test("XL narrowing from 401 to 300 px matches a fresh 300 px render", async () => {
  const makeFirefox = async () => {
    const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], selfTabId: 99,
      groups: [], tabs: [{ id: 99, windowId: 1 }] },
      message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
        ? { folders: {}, saved: [], missing: [] } : undefined);
    await ff.browser.storage.local.set({ deviceSettings: { cellSize: "XL" } });
    return ff;
  };
  const ff = await makeFirefox(), frame = await newtab(ff, 401);
  let fresh;
  const geometry = frame => {
    const board = frame.contentDocument.querySelector(".board");
    return { width: board.getBoundingClientRect().width,
      cell: parseFloat(frame.contentWindow.getComputedStyle(board).getPropertyValue("--cell")) };
  };
  try {
    assert.equal(geometry(frame).cell, 192.5, "initial XL stretch at 401 px");
    const before = await ff.browser.storage.sync.get(null);
    frame.style.width = "300px"; await flush(ff); await flush(ff);
    const freshFirefox = await makeFirefox();
    fresh = await newtab(freshFirefox, 300);
    assert.deepEqual(geometry(frame), geometry(fresh),
      `narrowing measures the viewport, not the old floor: resized ${JSON.stringify(geometry(frame))}, fresh ${JSON.stringify(geometry(fresh))}`);
    assert.deepEqual(geometry(fresh), { width: 932, cell: 300 });
    assert.deepEqual(await ff.browser.storage.sync.get(null), before, "display fit does not rewrite saved layouts");
  } finally { frame.remove(); fresh?.remove(); }
});

async function missingNewtab(width, height) {
  const { ff } = await setup(), send = ff.browser.runtime.sendMessage;
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    return message.type === "foxy:saved" ? { ...reply, missing: [{ folderId: "missing" }] } : reply;
  };
  return newtab(ff, width, height);
}

// The rail's border-box padding has a floor even when its height resolves to zero.
test("a 700 by 140 newtab with a missing banner scrolls to an intact gear below the rail", async () => {
  const frame = await missingNewtab(700, 140), doc = frame.contentDocument, win = frame.contentWindow;
  try {
    assert.ok(doc.querySelector(".banner"));
    const rail = doc.querySelector(".rail").getBoundingClientRect();
    const gear = doc.querySelector(".settings-cell"), box = gear.getBoundingClientRect();
    const cell = parseFloat(win.getComputedStyle(gear).width);
    assert.ok(rail.height >= 0, "rail height cannot be negative");
    assert.ok(Math.abs(rail.bottom + 16 - box.top) < 0.5,
      `rail must stop one gap above the gear: ${rail.bottom} vs ${box.top}`);
    assert.ok(Math.abs(box.height - cell) < 0.5, "gear keeps its full square cell");
    assert.ok(doc.scrollingElement.scrollHeight > doc.scrollingElement.clientHeight,
      "a short window scrolls vertically instead of shrinking the gear area");
    gear.scrollIntoView({ block: "end", inline: "nearest" });
    await nextFrame(); await nextFrame();
    const visible = gear.getBoundingClientRect();
    assert.ok(visible.top >= -0.5 && visible.bottom <= win.innerHeight + 0.5,
      `the full gear is visible after scrolling: ${visible.top}..${visible.bottom}, viewport ${win.innerHeight}, scroll ${win.scrollY}/${win.scrollMaxY}`);
    const hit = doc.elementFromPoint((visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2);
    assert.ok(hit === gear || gear.contains(hit), "the visible gear is reachable");
  } finally { frame.remove(); }
});

// A wide banner must use the board width rather than reserving removed margins.
test("a long missing-groups banner can fill the edge-to-edge board width", async () => {
  const frame = await missingNewtab(700, 720), doc = frame.contentDocument;
  try {
    const banner = doc.querySelector(".banner");
    banner.querySelector(".banner-text").textContent = "Missing group ".repeat(100);
    const box = banner.getBoundingClientRect(), board = doc.querySelector(".board").getBoundingClientRect();
    assert.ok(Math.abs(box.width - board.width) < 0.5,
      `banner uses the board width: ${box.width} vs ${board.width}`);
  } finally { frame.remove(); }
});

// An absolute pane translated beyond the page must not add classic scrollbars
// or cause the resulting ResizeObserver feedback loop on first open.
for (const width of [1600, 401]) {
  test(`real newtab pane slide at ${width}px has no document overflow or window errors`, async () => {
    const { ff } = await setup(), frame = await newtab(ff, width);
    const doc = frame.contentDocument, win = frame.contentWindow, errors = [], samples = [];
    const onError = event => errors.push(event.message);
    win.addEventListener("error", onError);
    try {
      await flush(ff);
      doc.querySelector(".settings-cell").click();
      for (let i = 0; i < 24; i++) {
        await nextFrame();
        const scroll = doc.scrollingElement;
        samples.push([scroll.scrollWidth - scroll.clientWidth, win.scrollMaxX,
          scroll.scrollHeight - scroll.clientHeight]);
      }
      assert.ok(samples.every(sample => sample.every(value => value === 0)),
        `slide must not overflow: ${JSON.stringify(samples)}; errors: ${JSON.stringify(errors)}`);
      assert.deepEqual(errors, [], "opening the real pane must not log a window error");
    } finally { win.removeEventListener("error", onError); frame.remove(); }
  });
}

// Accepted minimum-column ruling: the board may overflow horizontally, but
// it must not centre tiles off the left edge or strand its gear/pane controls.
for (const width of [175, 240]) {
  test(`below three target columns (${width}px) tiles do not overlap and gear/pane remain reachable`, async () => {
    const { ff } = await setup();
    // The weather tile would be a new tile here; this test pins the existing ones.
    await ff.browser.storage.sync.set({ settings: { railCells: 3, showWeather: false } }); await flush(ff);
    const before = await ff.browser.storage.sync.get(null);
    const frame = await newtab(ff, width), doc = frame.contentDocument, win = frame.contentWindow;
    const root = doc.querySelector(".board"), grid = root.querySelector(".grid"), rail = root.querySelector(".rail"), gear = root.querySelector(".settings-cell"), pane = doc.querySelector(".settings-pane");
    const box = root.getBoundingClientRect(), page = doc.querySelector(".page").getBoundingClientRect();
    assert.ok(page.width > win.innerWidth, "minimum columns widen the page without changing the cell target");
    assert.ok(Math.abs(box.width - page.width) < 0.5, "board fills the widened page");
    assert.ok(Math.abs(box.left - page.left) < 0.5, "overflow starts at the left edge");
    assert.ok(Math.abs(grid.getBoundingClientRect().right + 16 - rail.getBoundingClientRect().left) < 0.5);
    assert.ok(gear.getBoundingClientRect().left >= grid.getBoundingClientRect().right + 16 - 0.5);
    assert.ok(Math.abs(rail.getBoundingClientRect().bottom + 16 - gear.getBoundingClientRect().top) < 0.5);
    win.scrollTo(doc.scrollingElement.scrollWidth, doc.scrollingElement.scrollHeight);
    await nextFrame(); await nextFrame();
    const reachable = element => {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = element.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      const hit = doc.elementFromPoint(x, y);
      assert.ok(hit === element || element.contains(hit), `${element.getAttribute("aria-label") || element.textContent} is reachable`);
    };
    reachable(gear); gear.click(); await nextFrame(); await nextFrame();
    pane.getAnimations().forEach(animation => animation.finish());
    assert.equal(pane.hidden, false);
    assert.ok(Math.abs(pane.getBoundingClientRect().right - gear.getBoundingClientRect().right) < 0.5);
    assert.ok(Math.abs(pane.getBoundingClientRect().bottom + 16 - gear.getBoundingClientRect().top) < 0.5);
    const controls = [...pane.querySelectorAll("button:not(:disabled)")];
    assert.ok(controls.length >= 15, "the real settings controls are rendered before testing reachability");
    for (const button of controls) reachable(button);
    reachable(gear); gear.click(); assert.equal(pane.hidden, true);
    await flush(ff);
    assert.deepEqual(await ff.browser.storage.sync.get(null), before, "overflow remains display-only");
    frame.style.width = "700px"; await flush(ff); await flush(ff);
    const widePage = doc.querySelector(".page").getBoundingClientRect(), wideBoard = root.getBoundingClientRect();
    assert.ok(Math.abs(wideBoard.width - widePage.width) < 0.5, "widening clears the overflow floor");
    const wideGrid = root.querySelector(".grid").getBoundingClientRect(), wideRail = root.querySelector(".rail").getBoundingClientRect();
    assert.ok(Math.abs(wideGrid.width + 16 + wideRail.width - widePage.width) < 0.5,
      `widened cells meet the page edge: ${wideGrid.width} + 16 + ${wideRail.width} vs ${widePage.width}`);
    assert.deepEqual(await ff.browser.storage.sync.get(null), before);
  });
}

// Catches a missing shared control, wrong scope, or stale values after Sync.
for (const page of ["board", "options"]) {
  test(`${page} WINDOWS pane syncs the duplicate-switch toggle and follows remote changes`, async () => {
    const f = await setup();
    let pane = f.pane;
    if (page === "board") f.node.querySelector(".settings-cell").click();
    else pane = (await options(f.ff)).contentDocument.querySelector(".settings-pane");
    const control = toggle(pane, "switchToOpenTab");
    assert.ok(control, "duplicate-switch setting is present");
    assert.equal(control.closest("section").querySelector("h2").textContent, "Windows");
    assert.equal(control.ownerDocument.getElementById(control.getAttribute("aria-labelledby")).textContent,
      "Switch to an open tab instead of opening a duplicate");
    assert.equal(control.getAttribute("aria-checked"), "true");
    const before = writes(f.ff).length;
    control.click(); await flush(f.ff);
    assert.equal(writes(f.ff).length - before, 1);
    assert.equal(writes(f.ff).at(-1).api, "storage.sync.set");
    assert.equal((await f.ff.browser.storage.sync.get("settings")).settings.switchToOpenTab, false);
    assert.equal(control.getAttribute("aria-checked"), "false");
    await f.ff.browser.storage.sync.set({ settings: { switchToOpenTab: true } }); await flush(f.ff);
    assert.equal(control.getAttribute("aria-checked"), "true");
    control.click(); control.click(); await flush(f.ff);
    assert.equal((await f.ff.browser.storage.sync.get("settings")).settings.switchToOpenTab, true);
    assert.equal(control.getAttribute("aria-checked"), "true");
  });
}
