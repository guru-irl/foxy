import { test, assert } from "./harness.js";

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

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
