import assert from "node:assert/strict";
import { createSync } from "../../extension/src/sync/sync.js";

const registrations = new WeakMap();

export function unwire(ff) {
  for (const [event, listener] of registrations.get(ff) ?? []) event.removeListener(listener);
  registrations.delete(ff);
}

export function wire(ff, options = {}) {
  unwire(ff);
  const listeners = [];
  const sync = createSync({ api: ff.browser, settleMs: 0, maxWaitMs: 20,
    removeDelayMs: 0, quietMs: 0, ...options });
  for (const [name, handler] of Object.entries(sync.handlers)) {
    const [namespace, event] = name.split(".");
    const source = ff.browser[namespace][event];
    const listener = (...args) => handler(...args).catch(() => {});
    source.addListener(listener);
    listeners.push([source, listener]);
  }
  const onMessage = (message, sender) => sync.onMessage(message, sender);
  ff.browser.runtime.onMessage.addListener(onMessage);
  listeners.push([ff.browser.runtime.onMessage, onMessage]);
  registrations.set(ff, listeners);
  return sync;
}

export async function drain(ff, sync) {
  await sync.start();
  await ff.settle();
  await sync.idle();
  await ff.settle();
  assert.deepEqual(ff.errors, []);
}

export const localSetup = {
  groups: [{ id: 11, windowId: 1, title: "Work", color: "red" },
    { id: 12, windowId: 1, title: "Read", color: "blue" }],
  tabs: [{ id: 1, windowId: 1, url: "about:home", active: true },
    { id: 2, windowId: 1, url: "https://pin-a/", pinned: true },
    { id: 3, windowId: 1, url: "https://pin-b/", pinned: true },
    { id: 4, windowId: 1, url: "https://work/", groupId: 11 },
    { id: 5, windowId: 1, url: "https://read/", groupId: 12 }],
};

export const sharedTree = [{ title: "Foxy", children: [
  { title: "📌 Pinned", children: [{ url: "https://pin-a/" }, { url: "https://pin-b/" }] },
  { title: "🔴 Work", children: [{ url: "https://work/" }, { url: "https://extra/" }, { url: "file:///private" }] },
  { title: "🔵 Read", children: [{ url: "https://read/" }] },
] }];

export const mutations = ff => ff.calls.filter(call => /^(?:tabs|tabGroups|bookmarks)\.(?:create|update|move|remove|removeTree|group|ungroup|discard)$/.test(call.api));
