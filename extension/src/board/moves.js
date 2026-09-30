import { activateTab } from "../actions.js";

// All results, including failures, let the controller re-read real state.
// A null target was suppressed by the pure resolver and must not touch the API.
export async function dropTab(api, tabId, target) {
  if (target == null) return { ok: true };
  try {
    let tab = await api.tabs.get(tabId);
    if (target.kind === "pinned") {
      return { ok: await dropPinned(api, tab, target) };
    }
    if (tab.pinned) {
      await api.tabs.update(tabId, { pinned: false });
      tab = await api.tabs.get(tabId);
    }
    if (target.kind === "new-group") {
      const groupId = await api.tabs.group({ tabIds: [tabId], createProperties: { windowId: target.windowId } });
      return { ok: true, groupId };
    }
    if (target.kind === "group") {
      await dropIntoGroup(api, tab, target);
    } else if (target.kind === "tabs") {
      await dropIntoTabs(api, tab, target);
    } else {
      throw new Error(`Unknown tab target: ${target.kind}`);
    }
    return { ok: true };
  } catch (error) {
    console.warn("Foxy: could not drop tab", tabId, error);
    return { ok: false };
  }
}

function indexBefore(tab, before) {
  return before.index - (tab.windowId === before.windowId && tab.index < before.index ? 1 : 0);
}
async function orderedTabs(api, query) {
  return (await api.tabs.query(query)).sort((a, b) => a.index - b.index);
}
async function pinnedCount(api, windowId) {
  return (await api.tabs.query({ windowId, pinned: true })).length;
}

async function dropIntoGroup(api, tab, target) {
  const group = await api.tabGroups.get(target.groupId);
  if (tab.windowId !== group.windowId) {
    // Firefox's moveTabsBefore is undefined across windows. Adopt at the end
    // first, so tabs.group cannot select its cross-window before-group branch.
    await api.tabs.move(tab.id, { windowId: group.windowId, index: -1 });
    tab = await api.tabs.get(tab.id);
  }
  if (tab.groupId !== group.id) {
    await api.tabs.group({ tabIds: [tab.id], groupId: group.id });
  }
  if (target.beforeTabId != null && target.beforeTabId !== tab.id) {
    tab = await api.tabs.get(tab.id);
    const before = await api.tabs.get(target.beforeTabId);
    if (before.groupId === group.id) {
      await api.tabs.move(tab.id, { index: indexBefore(tab, before) });
    }
  } else if (target.beforeTabId == null) {
    const last = (await orderedTabs(api, { groupId: group.id })).at(-1);
    if (last && last.id !== tab.id) await api.tabs.move(tab.id, { index: last.index });
  }
  tab = await api.tabs.get(tab.id);
  if (tab.groupId !== group.id) {
    await api.tabs.group({ tabIds: [tab.id], groupId: group.id });
  }
}

async function dropIntoTabs(api, tab, target) {
  if (tab.groupId !== -1) await api.tabs.ungroup([tab.id]);
  tab = await api.tabs.get(tab.id);
  if (target.beforeTabId != null) {
    const before = await api.tabs.get(target.beforeTabId);
    if (before.id !== tab.id) {
      await api.tabs.move(tab.id, { windowId: before.windowId, index: indexBefore(tab, before) });
    }
  } else {
    // The dragged tab becomes loose during preparation, but is not an
    // insertion anchor. Without this filter an empty TABS section is not empty.
    const last = (await orderedTabs(api, { windowId: target.windowId, pinned: false, groupId: -1 }))
      .filter(candidate => candidate.id !== tab.id).at(-1);
    const forward = last && tab.windowId === target.windowId && tab.index < last.index;
    const index = last ? last.index + (forward ? 0 : 1) : -1;
    await api.tabs.move(tab.id, { windowId: target.windowId, index });
  }
  tab = await api.tabs.get(tab.id);
  if (tab.groupId !== -1) await api.tabs.ungroup([tab.id]);
}

async function dropPinned(api, tab, target) {
  if (tab.windowId !== target.windowId) {
    const index = tab.pinned ? await pinnedCount(api, target.windowId) : -1;
    await api.tabs.move(tab.id, { windowId: target.windowId, index });
  }
  if (!tab.pinned) await api.tabs.update(tab.id, { pinned: true });
  tab = await api.tabs.get(tab.id);
  if (target.beforeTabId != null && target.beforeTabId !== tab.id) {
    const before = await api.tabs.get(target.beforeTabId);
    await api.tabs.move(tab.id, { index: indexBefore(tab, before) });
  } else if (target.beforeTabId == null && tab.windowId === target.windowId) {
    const lastIndex = await pinnedCount(api, target.windowId) - 1;
    if (tab.index !== lastIndex) await api.tabs.move(tab.id, { index: lastIndex });
  }
  tab = await api.tabs.get(tab.id);
  if (!tab.pinned || tab.windowId !== target.windowId) {
    console.warn("Foxy: pinned drop did not reach the target window", tab.id, target.windowId);
    return false;
  }
  return true;
}

/** Execute a group column target. Null means a resolver-detected no-op. */
export async function dropGroup(api, groupId, target) {
  if (target == null) return true;
  return attempt("could not drop group", async () => {
    let index = -1;
    if (target.beforeGroupId != null) {
      const group = await api.tabGroups.get(groupId);
      const members = await orderedTabs(api, { groupId });
      const first = (await orderedTabs(api, { groupId: target.beforeGroupId }))[0];
      if (!first) throw new Error(`No tabs in before group: ${target.beforeGroupId}`);
      const forward = group.windowId === first.windowId && members[0].index < first.index;
      index = first.index - (forward ? members.length : 0);
    }
    await api.tabGroups.move(groupId, { windowId: target.windowId, index });
  });
}

export async function bringGroupHere(api, groupId, windowId) {
  return attempt("could not bring group here", () => api.tabGroups.move(groupId, { windowId, index: -1 }));
}

/** Activate via the existing close protocol. Only pins follow across windows. */
export async function openTab(api, row, self, { close = true } = {}) {
  try {
    const tab = await api.tabs.get(row.id);
    if (tab.pinned && tab.windowId !== self.windowId) {
      await api.tabs.move(tab.id, { windowId: self.windowId, index: await pinnedCount(api, self.windowId) });
    }
    const opened = await activateTab(api, tab.id, self.id, { close });
    if (!opened) return false;
    if (!tab.pinned && tab.windowId !== self.windowId) {
      await api.windows.update(tab.windowId, { focused: true });
    }
    return true;
  } catch (error) {
    console.warn("Foxy: could not open tab", row.id, error);
    return false;
  }
}

export async function closeTabs(api, tabIds) {
  return attempt("could not close tabs", async () => {
    if (tabIds.length) await api.tabs.remove(tabIds);
  });
}

export async function closeGroup(api, groupId) {
  return attempt("could not close group", async () => {
    // query alone returns [] for a stale ID. Validate it so the caller sees a
    // failure rather than a successful close of a group that no longer exists.
    await api.tabGroups.get(groupId);
    const tabs = await orderedTabs(api, { groupId });
    if (tabs.length) await api.tabs.remove(tabs.map(tab => tab.id));
  });
}

export async function renameGroup(api, groupId, title) {
  return attempt("could not rename group", () => api.tabGroups.update(groupId, { title }));
}

export async function recolorGroup(api, groupId, apiColor) {
  return attempt("could not recolor group", () => api.tabGroups.update(groupId, { color: apiColor }));
}

async function attempt(message, action) {
  try {
    await action();
    return true;
  } catch (error) {
    console.warn(`Foxy: ${message}`, error);
    return false;
  }
}
