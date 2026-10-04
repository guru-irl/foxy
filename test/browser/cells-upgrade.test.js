import { test, assert, fixture, nextFrame } from "./harness.js";
import { createBoardFirefox } from "./controller.js";

async function flush(ff) {
  for (let i = 0; i < 5; i++) { await ff.settle(); await nextFrame(); }
}

async function newtab(ff) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;top:0;left:0;width:1600px;height:1000px;border:0;z-index:10";
  fixture().append(frame);
  try {
    const html = await (await fetch("/extension/newtab.html")).text();
    frame.contentWindow.browser = ff.browser;
    const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
    const doc = frame.contentDocument;
    doc.open(); doc.write(html.replace("<head>", '<head><base href="/extension/">')); doc.close();
    await loaded; await flush(ff); await doc.fonts.ready;
    return frame;
  } catch (error) { frame.remove(); throw error; }
}

// All visible tiles already have places. Loading the old layout must not
// create a new layout, scale its rectangles or eagerly normalize cellSize.
const legacyLayout = {
  clock: { x: 0, y: 0, w: 5, h: 2 }, pinned: { x: 5, y: 0, w: 3, h: 4 },
  "group:one": { x: 8, y: 0, w: 3, h: 4 }, "group:two": { x: 0, y: 2, w: 3, h: 4 },
  saved: { x: 3, y: 4, w: 3, h: 4 },
};

for (const legacy of ["M", "L", "XL"]) {
  test(`a cold ${legacy} device with a per-width layout loads as S without migration writes`, async () => {
    const ff = createBoardFirefox({ windows: [{ id: 1, focused: true }], selfTabId: 99,
      groups: [{ id: 1, windowId: 1, title: "One" }, { id: 2, windowId: 1, title: "Two" }],
      tabs: [{ id: 10, windowId: 1, groupId: 1 }, { id: 11, windowId: 1, pinned: true },
        { id: 20, windowId: 1, groupId: 2 }, { id: 99, windowId: 1 }] },
    message => message.type === "foxy:reconcile" ? { ok: true } : message.type === "foxy:saved"
      ? { folders: { 1: "one", 2: "two" }, saved: [{ folderId: "closed", title: "Closed" }], missing: [] } : undefined);
    const synced = { "layout:13": { t: 1 },
      ...Object.fromEntries(Object.entries(legacyLayout).map(([id, rect]) => [`tile:13:${id}`, rect])) };
    const deviceSettings = { cellSize: legacy, density: "normal" };
    await ff.browser.storage.sync.set(synced);
    await ff.browser.storage.local.set({ deviceSettings });
    await ff.settle(); ff.calls.length = 0;
    const frame = await newtab(ff);
    try {
      // Include delayed first-paint and publish work in the no-write assertion.
      await new Promise(resolve => setTimeout(resolve, 900)); await flush(ff);
      const writes = ff.calls.filter(call => call.api.endsWith(".set") || call.api.endsWith(".remove"));
      assert.deepEqual(writes.filter(call => call.api !== "storage.local.set"), []);
      for (const call of writes) assert.deepEqual(Object.keys(call.args[0]), ["layoutsShown"]);
      assert.deepEqual(await ff.browser.storage.sync.get(null), synced);
      assert.deepEqual((await ff.browser.storage.local.get("deviceSettings")).deviceSettings, deviceSettings);
      const grid = frame.contentDocument.querySelector(".grid");
      const cell = parseFloat(grid.style.getPropertyValue("--cell"));
      assert.ok(cell >= 48 && cell < 64, `expected S cell geometry, got ${cell}`);
      const tiles = [...grid.querySelectorAll(".tile")];
      assert.equal(tiles.length, 5, "all saved tiles must render before checking no migration");
      for (const tile of tiles) {
        const saved = legacyLayout[tile.dataset.tileId];
        assert.ok(saved, `unexpected tile ${tile.dataset.tileId}`);
        const shown = Object.fromEntries(["x", "y", "w", "h"].map(key => [key, Number(tile.style.getPropertyValue(`--${key}`))]));
        assert.deepEqual(shown, saved);
      }
    } finally { frame.remove(); }
  });
}
