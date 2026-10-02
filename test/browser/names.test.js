import { test, assert, fixture } from "./harness.js";

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test("title keeper normalizes A  B without mistaking the collapsed name for a page edit", async () => {
  const { keepPinTitle } = await import("../../extension/src/sync/names.js");
  const old = document.title;
  try {
    document.title = "Original";
    keepPinTitle("A  B");
    document.head.append(document.createElement("meta"));
    await turn();
    assert.equal(document.title, "A B");
    assert.equal(keepPinTitle(null), "Original");
  } finally { keepPinTitle(null); document.title = old; }
});

test("title keeper restores the latest page title after edits, replacement, reinjection and removal", async () => {
  const { keepPinTitle } = await import("../../extension/src/sync/names.js");
  const old = document.title;
  const serialized = (0, eval)(`(${keepPinTitle.toString()})`);
  try {
    document.title = "Original";
    serialized("Work");
    assert.equal(document.title, "Work");
    document.title = "Unread (2)";
    await turn();
    assert.equal(document.title, "Work");
    const replacement = document.createElement("title");
    replacement.textContent = "Replacement";
    document.querySelector("title").replaceWith(replacement);
    await turn();
    assert.equal(document.title, "Work");
    document.querySelector("title").firstChild.data = "Latest (3)";
    await turn();
    assert.equal(document.title, "Work");
    serialized("Home");
    assert.equal(document.title, "Home");
    await turn();
    assert.equal(document.title, "Home", "a second observer must not fight the updated name");
    assert.equal(serialized(null), "Latest (3)");
    assert.equal(document.title, "Latest (3)");
    document.title = "Unwatched";
    await turn();
    assert.equal(document.title, "Unwatched");
    serialized(null);
    assert.equal(document.title, "Unwatched");
  } finally { serialized(null); document.title = old; }
});

test("title keeper ignores body mutations and reattaches when the head is replaced", async () => {
  const { keepPinTitle } = await import("../../extension/src/sync/names.js");
  const oldHead = document.head, oldTitle = document.title, Observer = window.MutationObserver;
  const node = document.createElement("div");
  let callbacks = 0;
  window.MutationObserver = class extends Observer {
    constructor(callback) { super((...args) => { callbacks++; callback(...args); }); }
  };
  try {
    document.title = "Original";
    keepPinTitle("Work");
    document.body.append(node);
    node.textContent = "Busy body";
    await turn();
    assert.equal(callbacks, 0, "body changes must not wake the keeper");
    const head = document.createElement("head");
    head.innerHTML = "<title>Work</title>";
    oldHead.replaceWith(head);
    await turn();
    head.querySelector("title").textContent = "New head page title";
    await turn();
    assert.equal(document.title, "Work");
    assert.equal(keepPinTitle(null), "New head page title");
  } finally {
    keepPinTitle(null);
    if (document.head !== oldHead) document.head.replaceWith(oldHead);
    document.title = oldTitle;
    node.remove();
    window.MutationObserver = Observer;
  }
});

for (const replacement of ["replaceChild", "document.open/write"]) {
  test(`title keeper reattaches after iframe root replacement by ${replacement}`, async () => {
    const { keepPinTitle } = await import("../../extension/src/sync/names.js");
    const frame = document.createElement("iframe");
    const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
    frame.srcdoc = "<!doctype html><html><head><title>Original</title></head><body></body></html>";
    fixture().append(frame);
    await loaded;
    const d = frame.contentDocument;
    const serialized = frame.contentWindow.eval(`(${keepPinTitle.toString()})`);
    try {
      serialized("Work");
      const html = "<head><title>Work</title></head><body></body>";
      if (replacement === "replaceChild") {
        const root = d.createElement("html");
        root.innerHTML = html;
        d.replaceChild(root, d.documentElement);
      } else {
        d.open(); d.write(`<!doctype html><html>${html}</html>`); d.close();
      }
      await turn();
      assert.equal(d.title, "Work");
      d.title = "Later page edit";
      await turn();
      assert.equal(d.title, "Work", "the new head must remain watched even when its initial title matches the name");
      assert.equal(serialized(null), "Later page edit");
      assert.equal(d.title, "Later page edit");
      d.title = "Unwatched";
      await turn();
      assert.equal(d.title, "Unwatched");
    } finally { serialized(null); frame.remove(); }
  });
}

test("title keeper handles title removal/addition and a pending page mutation when stopped", async () => {
  const { keepPinTitle } = await import("../../extension/src/sync/names.js");
  const old = document.title;
  try {
    document.title = "Original";
    keepPinTitle("Work");
    document.querySelector("title").remove();
    await turn();
    assert.equal(document.title, "Work");
    document.title = "Pending latest";
    keepPinTitle(null);
    assert.equal(document.title, "Pending latest");
    await turn();
    assert.equal(document.title, "Pending latest");
  } finally { keepPinTitle(null); document.title = old; }
});
