import { test, assert, fixture, nextFrame } from "./harness.js";
import { createFirefox } from "../fakes/firefox.js";
import { createSync } from "../../extension/src/sync/sync.js";
import { createController } from "../../extension/src/main.js";

const config = (open = false) => ({
  selfTabId: 99,
  windows: [{ id: 1, focused: true }, { id: 2 }],
  groups: open ? [{ id: 101, windowId: 1, title: "Dev", color: "red" },
    { id: 201, windowId: 2, title: "Coverage", color: "blue" }] : [],
  tabs: [{ id: 99, windowId: 1, url: "moz-extension://foxy-test/newtab.html", active: true },
    { id: 10, windowId: 1, url: "https://loose.example/", title: "Loose" },
    ...(open ? [{ id: 11, windowId: 1, groupId: 101, url: "https://dev.example/", title: "Dev tab" },
      { id: 21, windowId: 2, groupId: 201, url: "https://coverage.example/", title: "Coverage tab" }] : [])],
  bookmarks: [{ id: "foxy", title: "Foxy", children: [
    { id: "pins", title: "📌 Pinned", children: [] },
    { id: "dev", title: "🔴 Dev", children: [{ id: "dev-tab", title: "Dev tab", url: "https://dev.example/" }] },
    { id: "coverage", title: "🔵 Coverage", children: [{ id: "coverage-tab", title: "Coverage tab", url: "https://coverage.example/" }] },
  ] }],
});

// Same event-page registrations as background.js, without importing/registering
// the real background a second time. Each test gets an independent fake.
async function background(ff) {
  const sync = createSync({ api: ff.browser, settleMs: 0, maxWaitMs: 0, removeDelayMs: 0, quietMs: 0 });
  for (const [name, handler] of Object.entries(sync.handlers)) {
    const [namespace, event] = name.split(".");
    ff.browser[namespace][event].addListener((...args) => handler(...args).catch(() => {}));
  }
  ff.browser.runtime.onMessage.addListener(sync.onMessage);
  await sync.start();
  await ff.settle();
  await sync.idle();
  return sync;
}
function mount(ff) {
  const page = document.createElement("main");
  const root = document.createElement("div");
  root.className = "board";
  root.style.height = "400px";
  page.append(root); fixture().append(page);
  return { page, root, control: createController(root, ff.browser) };
}
async function drain(ff, sync) {
  await ff.settle();
  await sync?.idle();
  await nextFrame(); await nextFrame();
  await ff.settle();
  await sync?.idle();
  await nextFrame();
  assert.deepEqual(ff.errors, [], "fake event handlers must not swallow test errors");
}
async function setup(open = false) {
  const input = config(open), ff = createFirefox(input), sync = await background(ff);
  const view = mount(ff);
  await view.control.refresh();
  await drain(ff, sync);
  if (!open) assert.equal(view.root.querySelectorAll(".saved-row").length, 2, "saved folders must reach the controller board");
  return { input, ff, sync, ...view };
}
const row = (root, id = "dev") => [...root.querySelectorAll(".saved-row")].find(node => node.dataset.folderId === id);
const messages = (ff, type) => ff.calls.filter(call => call.api === "runtime.sendMessage" && call.args[0].type === type);
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function warningsDuring(run) {
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try { await run(warnings); }
  finally { console.warn = warn; }
}

// Missing handlers, wrong window IDs or gating saved replies on `ok` fail here.
test("integration: a saved folder opens unloaded in the current window and leaves SAVED", async () => {
  const { ff, sync, root } = await setup();
  assert.equal(row(root).querySelector(".row-label").textContent, "Dev");
  assert.equal(row(root).querySelector(".row-open").getAttribute("aria-label"), "Open saved group: Dev, 1 bookmark");
  row(root).querySelector(".row-open").click();
  await drain(ff, sync);
  const groups = await ff.browser.tabGroups.query({});
  assert.equal(groups.length, 1); assert.equal(groups[0].windowId, 1);
  assert.equal(groups[0].title, "Dev"); assert.equal(groups[0].color, "red");
  const tabs = await ff.browser.tabs.query({ groupId: groups[0].id });
  assert.equal(tabs.length, 1); assert.equal(tabs[0].url, "https://dev.example/");
  assert.equal(tabs[0].discarded, true); assert.equal(tabs[0].active, false);
  assert.equal(ff.layout(1), "| 99 10 [1: 100]");
  assert.equal(row(root), undefined); assert.ok(row(root, "coverage"));
  assert.deepEqual(messages(ff, "foxy:open-saved")[0].args[0], { type: "foxy:open-saved", folderId: "dev", windowId: 1 });
  assert.ok(await ff.browser.tabs.get(99), "SAVED must never close the page");
});

test("integration: busy saved entry publishes immediately and ignores two quick clicks", async () => {
  const { ff, sync, root, control } = await setup();
  const send = ff.browser.runtime.sendMessage, held = gate();
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    if (message.type === "foxy:open-saved") await held.promise;
    return reply;
  };
  try {
    row(root).querySelector(".row-open").focus();
    row(root).querySelector(".row-open").click();
    assert.ok(control.ui.busy.has("dev"));
    assert.ok(row(root).classList.contains("busy"), "busy must be visible before the reply");
    assert.equal(document.activeElement, row(root).querySelector(".row-open"));
    row(root).querySelector(".row-open").click();
    control.handlers.onOpenSaved("dev");
    assert.equal(messages(ff, "foxy:open-saved").length, 1);
  } finally { held.release(); ff.browser.runtime.sendMessage = send; }
  await drain(ff, sync);
  assert.equal(control.ui.busy.size, 0); assert.equal(row(root), undefined);
  assert.equal(ff.calls.filter(call => call.api === "tabs.create").length, 1);
});

test("integration: delete requires confirmation, survives refresh, and removes the bookmark folder", async () => {
  const { ff, sync, root, control } = await setup();
  await control.handlers.onDeleteSaved("dev");
  assert.equal(messages(ff, "foxy:delete-saved").length, 0);
  row(root).querySelector(".saved-delete").click();
  assert.equal(row(root).querySelector(".saved-delete").textContent, "DELETE?");
  await control.refresh(); await drain(ff, sync);
  assert.equal(row(root).querySelector(".saved-delete").textContent, "DELETE?");
  row(root).querySelector(".saved-delete").click();
  await drain(ff, sync);
  assert.equal(row(root), undefined);
  await assert.rejects(ff.browser.bookmarks.get("dev"), /Invalid bookmark ID/);
  assert.deepEqual(messages(ff, "foxy:delete-saved")[0].args[0], { type: "foxy:delete-saved", folderId: "dev" });
  assert.equal(control.ui.confirmFolderId, null); assert.equal(control.ui.busy.size, 0);
  assert.ok(await ff.browser.tabs.get(99));
});

for (const departure of ["mouseleave", "blur", "Escape"]) {
  test(`integration: ${departure} cancels saved delete without removing bookmarks`, async () => {
    const { ff, sync, root, control } = await setup();
    row(root).querySelector(".row-open").focus();
    row(root).querySelector(".saved-delete").click();
    if (departure === "mouseleave") row(root).dispatchEvent(new MouseEvent("mouseleave"));
    else if (departure === "blur") {
      // Inactive headless Firefox updates activeElement without native focusout.
      row(root).dispatchEvent(new FocusEvent("focusout", { bubbles: true,
        relatedTarget: row(root, "coverage").querySelector(".row-open") }));
    }
    else row(root).querySelector(".saved-delete").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(control.ui.confirmFolderId, null);
    row(root).querySelector(".saved-delete").click();
    await drain(ff, sync);
    assert.equal(messages(ff, "foxy:delete-saved").length, 0);
    assert.equal((await ff.browser.bookmarks.get("dev"))[0].title, "🔴 Dev");
  });
}

test("integration: closing a group keeps its folder and moves it to SAVED", async () => {
  const { ff, sync, root } = await setup(true);
  assert.equal(row(root), undefined);
  root.querySelector('[data-group-id="101"] .column-close').click();
  await drain(ff, sync);
  assert.equal(root.querySelector('[data-group-id="101"]'), null);
  assert.equal(row(root).querySelector(".row-label").textContent, "Dev");
  assert.equal((await ff.browser.bookmarks.getChildren("dev")).length, 1);
  assert.ok(await ff.browser.tabs.get(99));
});

async function restarted() {
  const first = await setup(true);
  await drain(first.ff, first.sync);
  first.ff.restart({ restore: false });
  first.page.remove();
  first.input.selfTabId = (await first.ff.browser.tabs.query({}))[0].id;
  await first.ff.browser.tabs.update(first.input.selfTabId, { url: "moz-extension://foxy-test/newtab.html" });
  const sync = await background(first.ff), view = mount(first.ff);
  await view.control.refresh(); await drain(first.ff, sync);
  return { ff: first.ff, sync, selfId: first.input.selfTabId, ...view };
}

for (const [action, type] of [["restore", "foxy:restore-all"], ["dismiss", "foxy:dismiss-missing"]]) {
  test(`integration: failed session restore shows two missing groups and ${action} clears the banner`, async () => {
    const { ff, sync, page, root, control, selfId } = await restarted();
    assert.equal(page.querySelector(".banner-text").textContent, "2 GROUPS DIDN'T COME BACK");
    assert.equal(root.querySelectorAll(".saved-row").length, 2);
    const send = ff.browser.runtime.sendMessage, held = gate();
    ff.browser.runtime.sendMessage = async message => {
      const reply = await send(message);
      if (message.type === type) await held.promise;
      return reply;
    };
    try {
      page.querySelector(`.banner-${action}`).click();
      assert.ok(page.querySelector(".banner").classList.contains("busy"));
      assert.equal(page.querySelector(".banner").hasAttribute("aria-busy"), false, "status node must not suppress the busy announcement");
      for (const button of page.querySelectorAll(".banner button")) assert.equal(button.getAttribute("aria-busy"), "true");
      page.querySelector(`.banner-${action}`).click();
      page.querySelector(action === "restore" ? ".banner-dismiss" : ".banner-restore").click();
      assert.equal(messages(ff, type).length, 1);
    } finally { held.release(); ff.browser.runtime.sendMessage = send; }
    await drain(ff, sync);
    assert.equal(page.querySelector(".banner"), null); assert.equal(control.ui.busy.size, 0);
    assert.equal((await ff.browser.tabGroups.query({})).length, action === "restore" ? 2 : 0);
    assert.equal(root.querySelectorAll(".saved-row").length, action === "restore" ? 0 : 2);
    const payload = messages(ff, type)[0].args[0];
    assert.deepEqual(payload, action === "restore" ? { type, windowId: 1 } : { type });
    assert.ok(await ff.browser.tabs.get(selfId));
    assert.equal((await ff.browser.bookmarks.getChildren("foxy")).length, 3);
  });
}

// Bookmark-only storms must not re-read tabs; omitting any subscription fails.
for (const event of ["onCreated", "onChanged", "onMoved", "onRemoved"]) {
  test(`integration: bookmarks.${event} coalesces saved reads without tab reads`, async () => {
    const { ff, sync, root } = await setup();
    ff.calls.length = 0;
    let titles;
    if (event === "onCreated") {
      await ff.applyRemoteBookmarks([{ id: "new", parentId: "foxy", index: 3, title: "🟢 New" }]);
      titles = ["Dev", "Coverage", "New"];
    } else if (event === "onRemoved") {
      await ff.applyRemoteBookmarks([{ id: "dev", deleted: true }]);
      titles = ["Coverage"];
    } else if (event === "onMoved") {
      await ff.applyRemoteBookmarks([{ id: "coverage", parentId: "foxy", index: 1, title: "🔵 Coverage" }]);
      titles = ["Coverage", "Dev"];
    } else {
      await ff.applyRemoteBookmarks([{ id: "dev", parentId: "foxy", index: 1, title: "🔴 Renamed" }]);
      titles = ["Renamed", "Coverage"];
    }
    for (let i = 0; i < 10; i++) ff.fire(`bookmarks.${event}`, "unrelated", { parentId: "unfiled_____" });
    await drain(ff, sync);
    assert.deepEqual([...root.querySelectorAll(".saved-row .row-label")].map(node => node.textContent), titles);
    assert.equal(messages(ff, "foxy:saved").length, 1);
    assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 0);
    assert.equal(ff.calls.filter(call => call.api === "tabs.getCurrent").length, 0);
  });
}

for (const hold of ["drag", "edit"]) {
  test(`integration: saved bookmark refresh waits for ${hold} without requesting a tab snapshot`, async () => {
    const { ff, sync, root, control } = await setup();
    if (hold === "drag") control.handlers.onDragState(true);
    else control.handlers.onEditState(true);
    ff.calls.length = 0;
    await ff.applyRemoteBookmarks([{ id: "dev", parentId: "foxy", index: 1, title: "🔴 Held rename" }]);
    await drain(ff, sync);
    assert.equal(row(root).querySelector(".row-label").textContent, "Dev");
    assert.equal(messages(ff, "foxy:saved").length, 0);
    if (hold === "drag") control.handlers.onDragState(false);
    else control.handlers.onEditEnd();
    await drain(ff, sync);
    assert.equal(row(root).querySelector(".row-label").textContent, "Held rename");
    assert.equal(messages(ff, "foxy:saved").length, 1);
    assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 0);
  });
}

test("integration: slow saved and reconcile replies never block the first tab render", async () => {
  const ff = createFirefox(config()), sync = await background(ff);
  const send = ff.browser.runtime.sendMessage, held = gate();
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    if (["foxy:saved", "foxy:reconcile"].includes(message.type)) await held.promise;
    return reply;
  };
  const { root, control } = mount(ff);
  try {
    await control.refresh();
    assert.ok(root.querySelector('[data-tab-id="10"]'), "tabs must render while both messages are pending");
    assert.equal(root.querySelector(".saved"), null);
    assert.equal(messages(ff, "foxy:reconcile").length, 1);
    assert.ok(messages(ff, "foxy:saved").length > 0);
  } finally { held.release(); ff.browser.runtime.sendMessage = send; }
  await drain(ff, sync);
  assert.ok(row(root));
  await control.refresh(); await drain(ff, sync);
  assert.equal(messages(ff, "foxy:reconcile").length, 1, "reconcile is once per controller load, not per refresh");
});

test("integration: a stale saved reply cannot overwrite a newer bookmark snapshot", async () => {
  const { ff, sync, root, control } = await setup();
  const send = ff.browser.runtime.sendMessage, held = gate(), started = gate();
  let first = true;
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    if (message.type === "foxy:saved" && first) { first = false; started.release(); await held.promise; }
    return reply;
  };
  try {
    await control.refresh();
    assert.ok(messages(ff, "foxy:saved").length > 0, "refresh must request saved data");
    await started.promise;
    await ff.applyRemoteBookmarks([{ id: "dev", parentId: "foxy", index: 1, title: "🔴 Newest" }]);
    await drain(ff, sync);
    assert.equal(row(root).querySelector(".row-label").textContent, "Newest");
    held.release(); await drain(ff, sync);
    assert.equal(row(root).querySelector(".row-label").textContent, "Newest");
  } finally { held.release(); ff.browser.runtime.sendMessage = send; await drain(ff, sync); }
});

for (const answer of ["reject", "undefined", "malformed"]) {
  test(`integration: unavailable saved background (${answer}) renders tabs and warns only once per load`, async () => {
    const ff = createFirefox(config()); // Deliberately no background listener.
    const send = ff.browser.runtime.sendMessage;
    ff.browser.runtime.sendMessage = async message => {
      const reply = await send(message);
      if (message.type === "foxy:saved" && answer === "reject") throw new Error("No background");
      if (message.type === "foxy:saved" && answer === "malformed") return { saved: [], missing: null };
      return message.type === "foxy:reconcile" ? { ok: true } : reply;
    };
    await warningsDuring(async warnings => {
      const { root, control, page } = mount(ff);
      await control.refresh(); await drain(ff);
      for (let i = 0; i < 3; i++) { await control.refresh(); await drain(ff); }
      assert.ok(root.querySelector('[data-tab-id="10"]'));
      assert.equal(root.querySelector(".saved"), null); assert.equal(page.querySelector(".banner"), null);
      assert.equal(warnings.length, 1); assert.ok(warnings[0][0].startsWith("Foxy:"));
      assert.equal(control.ui.busy.size, 0);
    });
  });
}

for (const [handler, type, id] of [["onOpenSaved", "foxy:open-saved", "dev"],
  ["onDeleteSaved", "foxy:delete-saved", "dev"], ["onRestoreAll", "foxy:restore-all", "banner"],
  ["onDismissMissing", "foxy:dismiss-missing", "banner"]]) {
  for (const failure of ["reject", "false"]) {
    test(`integration: ${type} ${failure} warns, clears busy and re-reads without closing the page`, async () => {
      const { ff, sync, root, control } = await setup();
      const send = ff.browser.runtime.sendMessage;
      ff.browser.runtime.sendMessage = async message => {
        if (message.type === type) {
          if (failure === "reject") throw new Error("stale folder");
          return { ok: false };
        }
        return send(message);
      };
      try {
        await warningsDuring(async warnings => {
          if (handler === "onDeleteSaved") control.handlers.onConfirmDelete(id);
          ff.calls.length = 0;
          const running = control.handlers[handler](handler.endsWith("Saved") ? id : undefined);
          assert.ok(control.ui.busy.has(id));
          if (id !== "banner") assert.ok(row(root).classList.contains("busy"));
          await running; await drain(ff, sync);
          assert.equal(control.ui.busy.size, 0);
          assert.equal(warnings.length, 1); assert.ok(warnings[0][0].startsWith("Foxy:"));
          assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
          assert.equal(messages(ff, "foxy:saved").length, 1);
          assert.ok(row(root)); assert.ok(await ff.browser.tabs.get(99));
          if (handler === "onDeleteSaved") assert.equal(control.ui.confirmFolderId, null);
        });
      } finally { ff.browser.runtime.sendMessage = send; }
    });
  }
}

test("integration: a folder deleted remotely between render and open logs and refreshes", async () => {
  const { ff, sync, root, control } = await setup();
  await ff.browser.bookmarks.removeTree("dev"); // Do not deliver its event yet.
  await warningsDuring(async warnings => {
    await control.handlers.onOpenSaved("dev"); await drain(ff, sync);
    assert.equal(row(root), undefined);
    assert.equal(control.ui.busy.size, 0);
    assert.ok(warnings.some(args => args[0].startsWith("Foxy:")));
  });
});


for (const hold of ["drag", "edit"]) {
  test(`integration: in-flight saved reply is deferred by ${hold} and replaced on release`, async () => {
    const { ff, sync, root, control } = await setup();
    const send = ff.browser.runtime.sendMessage, held = gate(), started = gate();
    let first = true;
    ff.browser.runtime.sendMessage = async message => {
      const reply = await send(message);
      if (message.type === "foxy:saved" && first) { first = false; started.release(); await held.promise; }
      return reply;
    };
    try {
      await ff.applyRemoteBookmarks([{ id: "dev", parentId: "foxy", index: 1, title: "🔴 In flight" }]);
      await drain(ff, sync); await started.promise;
      if (hold === "drag") control.handlers.onDragState(true);
      else control.handlers.onEditState(true);
      held.release(); await drain(ff, sync);
      assert.equal(row(root).querySelector(".row-label").textContent, "Dev", "an in-flight reply must not replace a held board");
      ff.calls.length = 0;
      if (hold === "drag") control.handlers.onDragState(false);
      else control.handlers.onEditEnd();
      await drain(ff, sync);
      assert.equal(row(root).querySelector(".row-label").textContent, "In flight");
      assert.equal(messages(ff, "foxy:saved").length, 1);
      assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 0);
    } finally { held.release(); ff.browser.runtime.sendMessage = send; }
  });

  test(`integration: saved busy UI publishes even during a ${hold} hold`, async () => {
    const { ff, sync, root, control } = await setup();
    if (hold === "drag") control.handlers.onDragState(true);
    else control.handlers.onEditState(true);
    const running = control.handlers.onOpenSaved("dev");
    assert.ok(row(root).classList.contains("busy"));
    assert.ok(control.ui.busy.has("dev"));
    await running; await drain(ff, sync);
    assert.equal(control.ui.busy.size, 0);
    if (hold === "drag") control.handlers.onDragState(false);
    else control.handlers.onEditEnd();
    await drain(ff, sync);
    assert.equal(row(root), undefined);
    assert.ok(await ff.browser.tabs.get(99));
  });
}

test("integration: delete publishes busy and ignores a second confirmed submit", async () => {
  const { ff, sync, root, control } = await setup();
  const send = ff.browser.runtime.sendMessage, held = gate();
  ff.browser.runtime.sendMessage = async message => {
    const reply = await send(message);
    if (message.type === "foxy:delete-saved") await held.promise;
    return reply;
  };
  let running;
  try {
    control.handlers.onConfirmDelete("dev");
    running = control.handlers.onDeleteSaved("dev");
    assert.ok(row(root).classList.contains("busy"));
    control.handlers.onDeleteSaved("dev");
    row(root).querySelector(".saved-delete").click();
    assert.equal(messages(ff, "foxy:delete-saved").length, 1);
  } finally { held.release(); ff.browser.runtime.sendMessage = send; await running; }
  await drain(ff, sync);
  assert.equal(control.ui.busy.size, 0); assert.equal(control.ui.confirmFolderId, null);
  assert.equal(row(root), undefined);
});

for (const failure of ["reject", "false"]) {
  test(`integration: reconcile ${failure} is logged and re-reads tabs only once after completion`, async () => {
    const ff = createFirefox(config()), sync = await background(ff);
    const send = ff.browser.runtime.sendMessage, held = gate();
    ff.browser.runtime.sendMessage = async message => {
      const reply = await send(message);
      if (message.type === "foxy:reconcile") {
        await held.promise;
        if (failure === "reject") throw new Error("Reconcile interrupted");
        return { ok: false };
      }
      return reply;
    };
    await warningsDuring(async warnings => {
      const { root, control } = mount(ff);
      try {
        await control.refresh();
        assert.ok(root.querySelector('[data-tab-id="10"]'));
        ff.calls.length = 0;
        held.release(); await drain(ff, sync);
        assert.equal(warnings.length, 1); assert.ok(warnings[0][0].startsWith("Foxy:"));
        assert.equal(ff.calls.filter(call => call.api === "windows.getAll").length, 1);
        assert.equal(messages(ff, "foxy:reconcile").length, 0, "completion must not reconcile again");
        assert.ok(row(root));
      } finally { held.release(); ff.browser.runtime.sendMessage = send; }
    });
  });
}
