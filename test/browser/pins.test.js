import { test, assert, fixture, nextFrame, withPseudoState } from "./harness.js";
import { createFirefox } from "../fakes/firefox.js";
import { buildBoard } from "../../extension/src/board/model.js";
import { renderBoard } from "./view.js";

let css;
async function root() {
  css ??= new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "/extension/newtab.css"; link.onload = resolve;
    document.head.append(link);
  });
  await css;
  const node = document.createElement("div");
  node.className = "board"; node.style.width = "1600px"; node.style.height = "500px";
  fixture().append(node);
  return node;
}
const setup = requestGranted => ({ requestGranted, selfTabId: 99,
  windows: [{ id: 1, focused: true }, { id: 2 }],
  groups: [{ id: 10, windowId: 1, title: "Group", color: "blue" }],
  tabs: [
    { id: 11, windowId: 1, pinned: true, title: "Page", url: "https://example.com/a" },
    { id: 21, windowId: 2, pinned: true, title: "Remote page", url: "https://remote.com/a" },
    { id: 12, windowId: 1, title: "Group page", url: "https://group.com/", groupId: 10 },
    { id: 99, windowId: 1, url: location.href, active: true },
  ] });
const info = () => ({ 21: { name: "Home", origin: "https://remote.com/*", allowed: false } });
const row = (node, id) => node.querySelector(`[data-tab-id="${id}"]`);
const tip = (node, id) => node.querySelector(`[data-pin-tooltip="${id}"]`);
const rename = pin => pin.querySelector(".row-open").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const key = (node, value) => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
async function flush(ff) { await ff.settle(); await nextFrame(); await nextFrame(); }
async function controller(requestGranted = true, options = {}) {
  const ff = createFirefox({ ...setup(requestGranted), ...options }), node = await root(), pins = info();
  ff.browser.runtime.onMessage.addListener(async message => {
    if (message.type === "foxy:reconcile") return { ok: true };
    if (message.type === "foxy:saved") return { saved: [], missing: [] };
    if (message.type === "foxy:pins") {
      for (const pin of Object.values(pins)) pin.allowed = await ff.browser.permissions.contains({ origins: [pin.origin] });
      return { pins };
    }
    if (message.type === "foxy:rename-pin") {
      if (message.name === null) delete pins[message.tabId];
      else {
        const tab = await ff.browser.tabs.get(message.tabId);
        pins[message.tabId] = { name: message.name, origin: `${new URL(tab.url).protocol}//${new URL(tab.url).hostname}/*`, allowed: false };
      }
      return { ok: true };
    }
  });
  const { createController } = await import("../../extension/src/main.js");
  const control = createController(node, ff.browser);
  await control.refresh(); await flush(ff);
  return { ff, node, control };
}

test("pin icons use names in tooltips, expose ALLOW only without access, and reveal close on hover and focus", async () => {
  const ff = createFirefox(setup()), node = await root();
  const board = buildBoard({ windows: await ff.browser.windows.getAll(), tabs: await ff.browser.tabs.query({}),
    groups: await ff.browser.tabGroups.query({}), currentWindowId: 1, selfTabId: 99, pins: info() });
  renderBoard(node, board, {}, {});
  assert.equal(tip(node, 21).querySelector(".pin-tooltip-name").textContent, "Home");
  assert.equal(row(node, 21).querySelector(".row-open").getAttribute("aria-label"), "Home");
  assert.equal(tip(node, 11).querySelector(".pin-allow"), null);
  const allow = tip(node, 21).querySelector(".pin-allow");
  assert.ok(allow); assert.equal(allow.textContent, "ALLOW");
  const style = getComputedStyle(allow);
  assert.equal(style.fontSize, "14px"); assert.equal(style.fontWeight, "700"); assert.equal(style.fontStretch, "80%");
  for (const id of [11, 21]) {
    const pinRow = row(node, id), close = pinRow.querySelector(".row-close");
    assert.equal(pinRow.querySelector(".row-rename"), null, "renaming is contextual, not a second hover action");
    assert.equal(getComputedStyle(close).width, "16px"); assert.equal(getComputedStyle(close).height, "16px");
    assert.equal(getComputedStyle(close).opacity, "0");
    withPseudoState([pinRow], "hover", () => assert.equal(getComputedStyle(close).opacity, "1"));
    withPseudoState([pinRow], "focus-within", () => assert.equal(getComputedStyle(close).opacity, "1"));
  }
  assert.equal(row(node, 12).querySelector(".row-rename"), null);
});

for (const id of [11, 21]) {
  for (const start of ["context", "F2"]) {
    test(`${start} edits pin ${id} in place and Enter requests synchronously then sends a trimmed name`, async () => {
      const { ff, node, control } = await controller();
      const pinRow = row(node, id);
      if (start === "context") rename(pinRow);
      else { pinRow.querySelector(".row-open").focus(); key(document.activeElement, "F2"); }
      const input = node.querySelector(".name-editor");
      assert.ok(input); assert.equal(pinRow.querySelector('.row-open').draggable, false);
      assert.equal(input.value, id === 11 ? "Page" : "Home");
      assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length);
      input.value = "  New name  "; ff.calls.length = 0;
      ff.withUserInput(() => key(input, "Enter"));
      assert.equal(ff.calls[0].api, "permissions.request", "request must run in the key event, before any await");
      await flush(ff);
      const origin = id === 11 ? "https://example.com/*" : "https://remote.com/*";
      assert.deepEqual(ff.calls.find(c => c.api === "permissions.request").args, [{ origins: [origin] }]);
      assert.deepEqual(ff.calls.find(c => c.api === "runtime.sendMessage" && c.args[0].type === "foxy:rename-pin").args,
        [{ type: "foxy:rename-pin", tabId: id, name: "New name" }]);
      assert.equal(tip(node, id).querySelector(".pin-tooltip-name").textContent, "New name");
      assert.equal(row(node, id).querySelector(".row-open").draggable, true); assert.equal(control.ui.editing, false);
      assert.equal(await ff.browser.permissions.contains({ origins: [origin] }), true);
      assert.equal(ff.calls.some(c => c.api === "tabs.update" || c.args[0]?.type === "close-newtab"), false);
    });
  }
}

for (const ending of ["Escape", "empty", "blur", "denied"]) {
  test(`pin rename ${ending} keeps completion single-shot and preserves the save/cancel contract`, async () => {
    const { ff, node } = await controller(ending !== "denied");
    rename(row(node, 21));
    const input = node.querySelector(".name-editor");
    assert.ok(input); input.value = ending === "empty" ? "  " : "Renamed"; ff.calls.length = 0;
    if (ending === "blur") input.dispatchEvent(new FocusEvent("blur"));
    else ff.withUserInput(() => key(input, ending === "Escape" ? "Escape" : "Enter"));
    input.dispatchEvent(new FocusEvent("blur")); key(input, "Enter"); await flush(ff);
    const sent = ff.calls.filter(c => c.api === "runtime.sendMessage" && c.args[0].type === "foxy:rename-pin");
    assert.equal(sent.length, ending === "Escape" ? 0 : 1);
    if (ending !== "Escape") assert.equal(sent[0].args[0].name, ending === "empty" ? null : "Renamed");
    else assert.equal(ff.calls.filter(c => c.api === "permissions.request").length, 0);
    assert.equal(row(node, 21).querySelector(".row-open").draggable, true);
    if (ending === "blur") {
      assert.equal(await ff.browser.permissions.contains({ origins: ["https://remote.com/*"] }), false,
        "blur outside user input must refuse site access while still saving the name");
      assert.equal(tip(node, 21).querySelector(".pin-tooltip-name").textContent, "Renamed");
    }
    if (ending === "denied") assert.ok(tip(node, 21).querySelector(".pin-allow"));
  });
}

test("named pins without an origin never offer ALLOW", async () => {
  const ff = createFirefox(setup()), node = await root();
  const board = buildBoard({ windows: await ff.browser.windows.getAll(), tabs: await ff.browser.tabs.query({}),
    groups: await ff.browser.tabGroups.query({}), currentWindowId: 1, selfTabId: 99,
    pins: { 21: { name: "Settings", origin: null, allowed: false } } });
  renderBoard(node, board, {}, {});
  assert.equal(tip(node, 21).querySelector(".pin-allow"), null);
  assert.equal(tip(node, 21).querySelector(".pin-tooltip-name").textContent, "Settings");
});

test("ALLOW requests the remote pin origin in its click handler, updates access, and never opens or renames the tab", async () => {
  const { ff, node } = await controller();
  const allow = tip(node, 21).querySelector(".pin-allow");
  assert.ok(allow); ff.calls.length = 0;
  ff.withUserInput(() => allow.click());
  assert.equal(ff.calls[0].api, "permissions.request");
  await flush(ff);
  assert.deepEqual(ff.calls[0].args, [{ origins: ["https://remote.com/*"] }]);
  assert.equal(tip(node, 21).querySelector(".pin-allow"), null);
  assert.equal(ff.calls.some(c => c.args[0]?.type === "foxy:rename-pin" || c.api === "tabs.update"), false);
});

test("pin editor bounds input at 200 characters without bounding group names", async () => {
  const { ff, node } = await controller();
  rename(row(node, 11));
  const input = node.querySelector(".name-editor");
  assert.equal(input.maxLength, 200);
  input.value = "A".repeat(200);
  ff.withUserInput(() => key(input, "Enter"));
  await flush(ff);
  assert.equal(tip(node, 11).querySelector(".pin-tooltip-name").textContent, "A".repeat(200));
  node.querySelector(".group-name").click();
  assert.equal(node.querySelector(".name-editor").maxLength, -1);
  key(node.querySelector(".name-editor"), "Escape");
});

test("pin editor clips a normalized 300-character title so deleting one character sends a rename", async () => {
  const options = setup(true);
  options.tabs[0].title = `  ${"A".repeat(150)}\t\t${"B".repeat(149)}  `;
  const { ff, node } = await controller(true, options);
  rename(row(node, 11));
  const input = node.querySelector(".name-editor");
  assert.equal(input.value, `${"A".repeat(150)} ${"B".repeat(49)}`);
  assert.equal(input.value.length, 200);
  input.setSelectionRange(199, 200);
  input.setRangeText("", 199, 200, "end");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  ff.calls.length = 0;
  ff.withUserInput(() => key(input, "Enter"));
  await flush(ff);
  const sent = ff.calls.filter(c => c.args[0]?.type === "foxy:rename-pin");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args[0].name, `${"A".repeat(150)} ${"B".repeat(48)}`);
  assert.equal(tip(node, 11).querySelector(".pin-tooltip-name").textContent, sent[0].args[0].name);
});

for (const ending of ["Enter", "blur"]) {
  test(`untouched long pin title ${ending} cancels rather than naming it with the clipped value`, async () => {
    const options = setup(true);
    options.tabs[0].title = "A".repeat(300);
    const { ff, node, control } = await controller(true, options);
    rename(row(node, 11));
    const input = node.querySelector(".name-editor");
    assert.equal(input.value, "A".repeat(200));
    ff.calls.length = 0;
    if (ending === "blur") input.dispatchEvent(new FocusEvent("blur"));
    else ff.withUserInput(() => key(input, "Enter"));
    await flush(ff);
    assert.equal(ff.calls.some(c => c.api === "permissions.request" || c.args[0]?.type === "foxy:rename-pin"), false);
    assert.equal(tip(node, 11).querySelector(".pin-tooltip-name").textContent, "A".repeat(300));
    assert.equal(control.ui.editing, false);
    assert.equal(row(node, 11).querySelector(".row-open").draggable, true);
  });
}

test("pin editor normalizes whitespace before requesting and sending a rename", async () => {
  const { ff, node } = await controller();
  rename(row(node, 11));
  const input = node.querySelector(".name-editor");
  input.value = "  A  B\t C  ";
  ff.calls.length = 0;
  ff.withUserInput(() => key(input, "Enter"));
  await flush(ff);
  const sent = ff.calls.find(c => c.args[0]?.type === "foxy:rename-pin");
  assert.equal(sent.args[0].name, "A B C");
});

for (const id of [11, 21]) for (const ending of ["Enter", "blur"]) {
  test(`unchanged ${id === 11 ? "unnamed" : "named"} pin ${ending} cancels without requesting or sending`, async () => {
    const { ff, node, control } = await controller();
    rename(row(node, id));
    const input = node.querySelector(".name-editor");
    input.value = `  ${input.value}  `;
    ff.calls.length = 0;
    if (ending === "blur") input.dispatchEvent(new FocusEvent("blur"));
    else ff.withUserInput(() => key(input, "Enter"));
    await flush(ff);
    assert.equal(ff.calls.some(c => c.api === "permissions.request" || c.args[0]?.type === "foxy:rename-pin"), false);
    assert.equal(tip(node, id).querySelector(".pin-tooltip-name").textContent, id === 11 ? "Page" : "Home");
    assert.equal(control.ui.editing, false);
    assert.equal(row(node, id).querySelector(".row-open").draggable, true);
  });
}

for (const action of ["rename", "ALLOW"]) {
  test(`pending permission on ${action} does not hold board refresh or saving`, async () => {
    const { ff, node, control } = await controller(true, { requestPending: true });
    ff.calls.length = 0;
    ff.withUserInput(() => {
      if (action === "ALLOW") tip(node, 21).querySelector(".pin-allow").click();
      else {
        rename(row(node, 11));
        const input = node.querySelector(".name-editor");
        input.value = "Saved now";
        key(input, "Enter");
      }
    });
    assert.equal(ff.calls[0].api, "permissions.request");
    await flush(ff);
    assert.equal(control.ui.editing, false);
    if (action === "rename") {
      assert.ok(ff.calls.some(c => c.args[0]?.type === "foxy:rename-pin"));
      assert.equal(tip(node, 11).querySelector(".pin-tooltip-name").textContent, "Saved now");
    }
    await ff.browser.tabs.update(12, { url: "https://group.com/changed" });
    await flush(ff);
    assert.equal(row(node, 12).querySelector(".row-label").textContent, "https://group.com/changed");
  });
}

test("a vanished editing pin releases its hold, while title events do not destroy the input", async () => {
  const { ff, node, control } = await controller();
  rename(row(node, 21));
  const input = node.querySelector(".name-editor"); assert.ok(input);
  await ff.browser.tabs.update(11, { url: "https://example.com/new" }); await flush(ff);
  assert.equal(node.querySelector(".name-editor"), input);
  await ff.browser.tabs.remove(21); await flush(ff);
  assert.equal(node.querySelector(".name-editor"), null); assert.equal(control.ui.editing, false);
  assert.equal(row(node, 21), null);
});


for (const movesHere of [true, false]) {
  test(`clicking a remote pinned icon respects pinsMoveHere=${movesHere}`, async () => {
    const { ff, node } = await controller();
    await ff.browser.storage.sync.set({ settings: { pinsMoveHere: movesHere } }); await flush(ff);
    row(node, 21).querySelector(".row-open").click();
    for (let i = 0; i < 5; i++) await flush(ff);
    const pin = await ff.browser.tabs.get(21);
    assert.equal(pin.windowId, movesHere ? 1 : 2); assert.equal(pin.active, true); assert.equal(pin.pinned, true);
    assert.equal((await ff.browser.windows.getAll()).find(win => win.id === (movesHere ? 1 : 2)).focused, true);
    assert.equal(tip(node, 21).querySelector(".pin-tooltip-name").textContent, "Home");
    assert.deepEqual(ff.errors, []);
  });
}

test("closing a pinned icon removes only that tab", async () => {
  const { ff, node } = await controller();
  row(node, 11).querySelector(".row-close").click(); await flush(ff);
  assert.equal((await ff.browser.tabs.query({})).some(tab => tab.id === 11), false);
  assert.ok(await ff.browser.tabs.get(21)); assert.ok(await ff.browser.tabs.get(99));
  assert.equal(row(node, 11), null); assert.deepEqual(ff.errors, []);
});


test("a named pin's ALLOW action remains keyboard reachable beside its icon and close action", async () => {
  const { node } = await controller();
  const pin = row(node, 21), open = pin.querySelector('.row-open'), close = pin.querySelector('.row-close');
  const allow = tip(node, 21).querySelector('.pin-allow');
  const tab = (target, shiftKey = false) => target.dispatchEvent(new KeyboardEvent('keydown', {
    key:'Tab', shiftKey, bubbles:true, cancelable:true }));
  open.focus();
  assert.equal(document.activeElement, open);
  // Inactive headless Firefox can change activeElement without native focusin.
  open.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  assert.equal(tip(node, 21).hidden, false, 'focusing the icon exposes ALLOW');
  const prevented = !tab(open);
  assert.ok(prevented, 'icon Tab routing must prevent the native focus step');
  assert.equal(document.activeElement, allow, `active=${document.activeElement.className}, hidden=${tip(node, 21).hidden}, connected=${allow.isConnected}`);
  assert.equal(tip(node, 21).hidden, false, 'the focused external action stays visible');
  tab(allow, true); assert.equal(document.activeElement, open);
  tab(open); tab(allow); assert.equal(document.activeElement, close);
  tab(close, true); assert.equal(document.activeElement, allow);
});
