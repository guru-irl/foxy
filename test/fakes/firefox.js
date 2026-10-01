// Stateful Firefox 157 subset. All snapshots are detached from internal state.
const copy = value => structuredClone(value);
const jsonCopy = value => JSON.parse(JSON.stringify(value));
const asArray = value => Array.isArray(value) ? value : [value];
const COLORS = ["blue", "purple", "cyan", "orange", "yellow", "pink", "green", "grey", "red"];
const ROOTS = ["root________", "menu________", "toolbar_____", "unfiled_____", "mobile______"];

export function createFirefox(setup = {}) {
  const calls = [], errors = [], pending = [], events = new Map(), messages = new Set();
  const wins = (setup.windows ?? [{ id: 1, focused: true }]).map(w => ({
    id: w.id, focused: w.focused ?? false, type: w.type ?? "normal", incognito: w.incognito ?? false, tabs: [],
  }));
  const groups = (setup.groups ?? []).map(g => ({
    id: g.id, windowId: g.windowId, title: g.title ?? "", color: g.color ?? "blue", collapsed: g.collapsed ?? false,
  }));
  let clock = 0, colorIndex = 0;
  let nextTab = Math.max(0, ...(setup.tabs ?? []).map(t => t.id)) + 1;
  let nextGroup = Math.max(0, ...groups.map(g => g.id)) + 1;
  let nextWindow = Math.max(0, ...wins.map(w => w.id)) + 1;
  const currentWindowId = setup.currentWindowId ?? wins.find(w => w.focused)?.id ?? wins[0]?.id;
  let lastFocusedId = wins.find(w => w.focused)?.id ?? wins[0]?.id;
  const browser = { tabs: {}, tabGroups: {}, windows: {}, bookmarks: {}, storage: { local: {}, session: {} }, runtime: {} };

  function event(name) {
    const listeners = new Set();
    const object = {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
    };
    events.set(name, listeners);
    return object;
  }
  for (const [namespace, names] of Object.entries({
    tabs: ["onCreated", "onUpdated", "onMoved", "onDetached", "onAttached", "onRemoved", "onActivated"],
    tabGroups: ["onCreated", "onUpdated", "onMoved", "onRemoved"],
    windows: ["onRemoved", "onFocusChanged"],
    bookmarks: ["onCreated", "onRemoved", "onChanged", "onMoved"],
    storage: ["onChanged"], runtime: ["onMessage", "onStartup", "onInstalled"],
  })) {
    for (const name of names) browser[namespace][name] = event(`${namespace}.${name}`);
  }
  function queue(name, ...args) {
    if (!events.has(name)) throw new Error(`Unknown event: ${name}`);
    pending.push({ name, args: copy(args) });
  }
  async function deliver({ name, args }, respond = false) {
    let result;
    for (const listener of [...events.get(name)]) {
      try {
        const value = await listener(...copy(args));
        if (respond && result === undefined && value !== undefined) result = copy(value);
      } catch (error) {
        errors.push(error);
      }
    }
    return result;
  }
  let settling;
  function settle() {
    if (settling) return settling;
    settling = (async () => {
      let deliveries = 0;
      while (pending.length || messages.size) {
        if (pending.length) {
          if (++deliveries > 10000) throw new Error("Event delivery limit exceeded: 10000");
          await deliver(pending.shift());
        } else {
          await Promise.all([...messages]);
        }
      }
    })().finally(() => { settling = undefined; });
    return settling;
  }
  function api(namespace, name, fn, sync = false) {
    const wrapped = (...args) => {
      calls.push({ api: `${namespace}.${name}`, args: copy(args) });
      return fn(...args);
    };
    const target = namespace.startsWith("storage.") ? browser.storage[namespace.split(".")[1]] : browser[namespace];
    target[name] = sync ? (...args) => copy(wrapped(...args)) : async (...args) => {
      const result = wrapped(...args);
      return copy(result && typeof result.then === "function" ? await result : result);
    };
  }
  function windowById(id) {
    const win = wins.find(w => w.id === id);
    if (!win) throw new Error(`Invalid window ID: ${id}`);
    return win;
  }
  function windowTabs(id) { return windowById(id).tabs; }
  function tabById(id) {
    const tab = wins.flatMap(w => w.tabs).find(t => t.id === id);
    if (!tab) throw new Error(`Invalid tab ID: ${id}`);
    return tab;
  }
  function groupById(id) {
    const group = groups.find(g => g.id === id);
    if (!group) throw new Error(`No group with id: ${id}`);
    return group;
  }
  function reindex(id) { windowTabs(id).forEach((t, i) => { t.index = i; }); }
  function pinnedCount(id) { return windowTabs(id).filter(t => t.pinned).length; }
  function groupTabs(id) { return windowTabs(groupById(id).windowId).filter(t => t.groupId === id); }
  function tabObject(t) {
    return { id: t.id, windowId: t.windowId, index: t.index, pinned: t.pinned, groupId: t.groupId,
      url: t.url, title: t.title, favIconUrl: t.favIconUrl, active: t.active, discarded: t.discarded,
      hidden: false, status: "complete", lastAccessed: t.lastAccessed, incognito: windowById(t.windowId).incognito };
  }
  function windowObject(w, populate = false) {
    const result = { id: w.id, focused: w.focused, type: w.type, incognito: w.incognito };
    if (populate) result.tabs = w.tabs.map(tabObject);
    return result;
  }
  function updated(t, before) {
    const changes = {};
    for (const key of ["url", "title", "pinned", "groupId", "discarded"]) {
      if (before[key] !== t[key]) changes[key] = t[key];
    }
    if (Object.keys(changes).length) queue("tabs.onUpdated", t.id, changes, tabObject(t));
  }
  function activate(t, notify = true) {
    for (const other of windowTabs(t.windowId)) other.active = other === t;
    t.lastAccessed = ++clock;
    t.discarded = false;
    if (notify) queue("tabs.onActivated", { tabId: t.id, windowId: t.windowId });
  }
  function ensureActive(id) {
    const tabs = windowTabs(id);
    if (tabs.length && !tabs.some(t => t.active)) {
      const before = { ...tabs[0] };
      activate(tabs[0]);
      updated(tabs[0], before);
    }
  }
  function removeEmptyGroups() {
    for (const group of [...groups]) {
      if (!windowTabs(group.windowId).some(t => t.groupId === group.id)) {
        groups.splice(groups.indexOf(group), 1);
        queue("tabGroups.onRemoved", group, { isWindowClosing: false });
      }
    }
  }
  function closeEmptyWindow(id) {
    const win = windowById(id);
    if (win.tabs.length) { ensureActive(id); return; }
    wins.splice(wins.indexOf(win), 1);
    if (lastFocusedId === id) lastFocusedId = wins.find(w => w.focused)?.id ?? wins[0]?.id;
    queue("windows.onRemoved", id);
  }
  function checkURL(url, bookmark = false) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Illegal URL: ${url}`); }
    const legal = bookmark ? !["javascript:", "data:"].includes(parsed.protocol)
      : ["http:", "https:", "moz-extension:"].includes(parsed.protocol) || url === "about:blank";
    if (!legal) throw new Error(`Illegal URL: ${url}`);
  }
  function makeTab(t) {
    const url = t.url ?? "about:blank";
    const stamp = ++clock;
    clock = Math.max(clock, t.lastAccessed ?? stamp);
    return { id: t.id, windowId: t.windowId, url, title: t.title ?? url, pinned: t.pinned ?? false,
      groupId: t.pinned ? -1 : t.groupId ?? -1, active: t.active ?? false, discarded: t.discarded ?? false,
      favIconUrl: t.favIconUrl, lastAccessed: t.lastAccessed ?? stamp };
  }
  for (const tab of setup.tabs ?? []) windowTabs(tab.windowId).push(makeTab(tab));
  for (const win of wins) {
    // Accept unordered fixtures, but establish strip invariants before APIs see them.
    const pinned = win.tabs.filter(t => t.pinned), unpinned = win.tabs.filter(t => !t.pinned);
    const ordered = [], seen = new Set();
    for (const tab of unpinned) {
      if (tab.groupId === -1) ordered.push(tab);
      else if (!seen.has(tab.groupId)) {
        const group = groupById(tab.groupId);
        if (group.windowId !== win.id) throw new Error(`Group ${group.id} belongs to another window`);
        ordered.push(...unpinned.filter(t => t.groupId === group.id));
        seen.add(group.id);
      }
    }
    const active = win.tabs.find(t => t.active) ?? win.tabs[0];
    win.tabs = [...pinned, ...ordered];
    for (const tab of win.tabs) tab.active = tab === active;
    reindex(win.id);
  }

  api("tabs", "query", (q = {}) => wins.flatMap(w => w.tabs).filter(t =>
    (q.windowId == null || t.windowId === q.windowId) && (!q.currentWindow || t.windowId === currentWindowId) &&
    (q.pinned == null || t.pinned === q.pinned) && (q.groupId == null || t.groupId === q.groupId) &&
    (q.active == null || t.active === q.active) && (q.windowType == null || q.windowType === "normal")
  ).map(tabObject));
  api("tabs", "get", id => tabObject(tabById(id)));
  api("tabs", "getCurrent", () => setup.selfTabId == null ? undefined : tabObject(tabById(setup.selfTabId)));
  api("tabs", "create", (props = {}) => {
    checkURL(props.url ?? "about:blank");
    const id = props.windowId ?? currentWindowId;
    const tabs = windowTabs(id), pinned = props.pinned ?? false, discarded = props.discarded ?? false;
    if (discarded) {
      if (props.active === true) throw new Error("Active tabs cannot be created and discarded.");
      if (pinned) throw new Error("Pinned tabs cannot be created and discarded.");
      // Keep the brief's missing-URL rejection. Firefox uses BROWSER_NEW_TAB_URL
      // (moz-extension with Foxy's override); "" resolves to an extension URL there,
      // but this fake's checkURL rejects relative URLs before reaching this branch.
      if (props.url == null || props.url.startsWith("about:")) {
        throw new Error('Cannot create a discarded new tab or "about" urls.');
      }
    } else if (props.title) {
      throw new Error("Title may only be set for discarded tabs.");
    }
    const count = pinnedCount(id);
    const index = pinned ? Math.max(0, Math.min(props.index ?? count, count))
      : Math.max(count, Math.min(props.index ?? tabs.length, tabs.length));
    const before = tabs[index - 1], after = tabs[index];
    const groupId = !pinned && before && before.groupId !== -1 && before.groupId === after?.groupId ? before.groupId : -1;
    const t = makeTab({ ...props, id: nextTab++, windowId: id, groupId, active: false,
      title: discarded ? props.title : props.url ?? "about:blank" });
    tabs.splice(index, 0, t);
    reindex(id);
    if (props.active ?? !discarded) activate(t);
    queue("tabs.onCreated", tabObject(t));
    return tabObject(t);
  });
  function pin(t, pinned) {
    if (t.pinned === pinned) return;
    const tabs = windowTabs(t.windowId);
    tabs.splice(t.index, 1);
    t.pinned = pinned;
    t.groupId = -1;
    const index = tabs.filter(t => t.pinned).length;
    tabs.splice(index, 0, t);
    reindex(t.windowId);
  }
  api("tabs", "update", (id, props) => {
    const t = tabById(id), before = { ...t };
    if (props.url != null) checkURL(props.url);
    if (props.pinned != null) pin(t, props.pinned);
    if (props.active === true) activate(t, !t.active);
    if (props.url != null) { t.url = props.url; t.title = props.url; t.discarded = false; }
    if (props.muted != null) t.muted = props.muted;
    updated(t, before);
    removeEmptyGroups();
    return tabObject(t);
  });
  function relocate(t, targetId, index, membership, selectTab = false) {
    const oldWindowId = t.windowId, oldPosition = t.index, before = { ...t };
    const source = windowTabs(oldWindowId);
    source.splice(oldPosition, 1);
    reindex(oldWindowId);
    t.windowId = targetId;
    t.groupId = t.pinned ? -1 : membership;
    const target = windowTabs(targetId);
    target.splice(index, 0, t);
    reindex(targetId);
    if (oldWindowId !== targetId) {
      // tabs.move defaults to false; group.addTabs passes the source selection.
      t.active = false;
      queue("tabs.onDetached", t.id, { oldWindowId, oldPosition });
      queue("tabs.onAttached", t.id, { newWindowId: targetId, newPosition: t.index });
      if (selectTab) activate(t);
    } else if (oldPosition !== t.index) {
      queue("tabs.onMoved", t.id, { windowId: targetId, fromIndex: oldPosition, toIndex: t.index });
    }
    updated(t, before);
    return oldWindowId;
  }
  api("tabs", "move", (ids, props) => {
    const toMove = asArray(ids).map(tabById), moved = [], last = new Map();
    if (props.windowId != null) windowById(props.windowId);
    for (const t of toMove) {
      const targetId = props.windowId ?? t.windowId, tabs = windowTabs(targetId), same = targetId === t.windowId;
      if (same && tabs.length === 1) { last.set(targetId, 0); continue; }
      const maximum = tabs.length - (same ? 1 : 0);
      let index = props.index === -1 ? maximum : Math.min(props.index, maximum);
      if (last.has(targetId)) index = same && t.index <= last.get(targetId) ? last.get(targetId) : last.get(targetId) + 1;
      const count = pinnedCount(targetId);
      if (t.pinned ? index > count : index < count) continue;
      if (same && t.pinned) index = Math.min(index, count - 1);
      if (!(same && t.index === index)) {
        const neighbor = tabs[index];
        const membership = neighbor?.groupId ?? -1;
        const sourceId = relocate(t, targetId, index, membership);
        removeEmptyGroups();
        if (sourceId !== targetId) {
          closeEmptyWindow(sourceId);
          ensureActive(targetId);
        }
      }
      last.set(targetId, t.index);
      moved.push(tabObject(t));
    }
    return moved;
  });
  api("tabs", "group", options => {
    const tabs = asArray(options.tabIds).map(tabById);
    if (!tabs.length) throw new Error("No tabs to group");
    const windowId = options.createProperties?.windowId ?? currentWindowId;
    windowById(windowId);
    let group = options.groupId == null ? undefined : groupById(options.groupId);
    const targetId = group?.windowId ?? windowId;
    const target = windowTabs(targetId);
    // Capture the DOM insertion reference before unpinning, as ext-tabs does.
    let insertBefore = tabs.find(tab => tab.windowId === targetId);
    if (!group && insertBefore && insertBefore.groupId !== -1) {
      const members = groupTabs(insertBefore.groupId);
      if (insertBefore !== members[0]) insertBefore = target[members.at(-1).index + 1];
    }
    for (const tab of tabs) {
      const before = { ...tab };
      pin(tab, false);
      updated(tab, before);
    }
    const sourceIds = new Set();
    function place(tab, index) {
      if (tab.windowId === targetId && tab.index < index) index--;
      const sourceId = relocate(tab, targetId, index, group.id, tab.active);
      sourceIds.add(sourceId);
      if (sourceId !== targetId) ensureActive(sourceId);
    }
    let toAppend = tabs;
    if (group) {
      const first = groupTabs(group.id)[0];
      const before = tabs.filter(tab => tab.windowId === windowId && tab.index < first.index);
      if (before.length && targetId !== windowId) {
        throw new Error("tabs.group: moving tabs before a group in another window is undefined in Firefox 157");
      }
      toAppend = tabs.filter(tab => !before.includes(tab));
      // moveTabsBefore preserves tabIds order, unlike tabs.ungroup's index sort.
      let anchor;
      for (const tab of before) {
        place(tab, anchor ? anchor.index + 1 : first.index);
        anchor = tab;
      }
    } else {
      group = { id: nextGroup++, windowId: targetId, title: "", color: COLORS[colorIndex++ % COLORS.length], collapsed: false };
      groups.push(group);
      queue("tabGroups.onCreated", group);
    }
    for (const tab of toAppend) {
      // moveTabToExistingGroup does not reorder a tab already in this group.
      if (tab.groupId === group.id) continue;
      const last = groupTabs(group.id).at(-1);
      place(tab, last ? last.index + 1 : insertBefore?.index ?? target.length);
    }
    removeEmptyGroups();
    for (const id of sourceIds) if (id !== targetId) closeEmptyWindow(id);
    ensureActive(targetId);
    return group.id;
  });
  api("tabs", "ungroup", ids => {
    const byGroup = new Map();
    for (const tab of asArray(ids).map(tabById)) {
      if (tab.groupId === -1) continue;
      if (!byGroup.has(tab.groupId)) byGroup.set(tab.groupId, []);
      byGroup.get(tab.groupId).push(tab);
    }
    for (const [id, tabs] of byGroup) {
      tabs.sort((a, b) => a.index - b.index);
      const members = groupTabs(id);
      let index = tabs[0] === members[0] ? members[0].index : members.at(-1).index + 1;
      for (const tab of tabs) {
        if (tab.index < index) index--;
        relocate(tab, tab.windowId, index, -1);
        index = tab.index + 1;
      }
      removeEmptyGroups();
    }
  });
  api("tabs", "remove", ids => {
    for (const tab of asArray(ids).map(tabById)) {
      const id = tab.windowId;
      windowTabs(id).splice(tab.index, 1);
      reindex(id);
      queue("tabs.onRemoved", tab.id, { windowId: id, isWindowClosing: false });
      removeEmptyGroups();
      closeEmptyWindow(id);
    }
  });
  api("tabs", "discard", ids => {
    const tabs = asArray(ids).map(tabById);
    for (const tab of tabs) {
      const before = { ...tab };
      if (!tab.active) tab.discarded = true;
      updated(tab, before);
    }
    return tabs.map(tabObject);
  });

  api("tabGroups", "get", groupById);
  api("tabGroups", "query", (q = {}) => wins.filter(w => q.windowId == null || w.id === q.windowId)
    .flatMap(w => [...new Set(w.tabs.map(t => t.groupId).filter(id => id !== -1))].map(groupById)));
  api("tabGroups", "update", (id, props) => {
    const group = groupById(id);
    for (const key of ["title", "color", "collapsed"]) if (props[key] != null) group[key] = props[key];
    queue("tabGroups.onUpdated", group);
    return group;
  });
  api("tabGroups", "move", (id, props) => {
    const group = groupById(id), sourceId = group.windowId;
    const targetId = props.windowId ?? sourceId, target = windowTabs(targetId), members = groupTabs(id);
    const same = targetId === sourceId, first = members[0].index;
    let index = props.index === -1 ? target.length : Math.min(props.index, target.length);
    const validated = Math.min(target.length, index + (same && index > first ? members.length : 0));
    const prev = target[validated - 1], next = target[validated];
    if (next?.pinned) throw new Error("Cannot move the group to an index that is in the middle of pinned tabs.");
    if (prev && next?.groupId !== -1 && next?.groupId != null && prev.groupId === next.groupId && next.groupId !== id) {
      throw new Error("Cannot move the group to an index that is in the middle of another group.");
    }
    const source = windowTabs(sourceId);
    const oldPositions = members.map(t => t.index);
    source.splice(first, members.length);
    index = Math.min(index, target.length);
    target.splice(index, 0, ...members);
    group.windowId = targetId;
    for (const tab of members) {
      tab.windowId = targetId;
      if (!same) tab.active = false;
    }
    reindex(sourceId);
    if (!same) reindex(targetId);
    members.forEach((tab, i) => {
      if (same) {
        if (oldPositions[i] !== tab.index) queue("tabs.onMoved", tab.id, { windowId: targetId, fromIndex: oldPositions[i], toIndex: tab.index });
      } else {
        queue("tabs.onDetached", tab.id, { oldWindowId: sourceId, oldPosition: oldPositions[i] });
        queue("tabs.onAttached", tab.id, { newWindowId: targetId, newPosition: tab.index });
      }
    });
    if (!same) ensureActive(targetId);
    queue("tabGroups.onMoved", group);
    if (!same) closeEmptyWindow(sourceId);
    return group;
  });

  browser.windows.WINDOW_ID_NONE = -1;
  api("windows", "create", async (props = {}) => {
    const win = { id: nextWindow++, focused: props.focused ?? true, type: props.type ?? "normal",
      incognito: props.incognito ?? false, tabs: [] };
    wins.push(win);
    if (win.focused) {
      for (const other of wins) other.focused = other === win;
      lastFocusedId = win.id;
      queue("windows.onFocusChanged", win.id);
    }
    for (const url of asArray(props.url ?? "about:blank")) {
      await browser.tabs.create({ windowId: win.id, url, active: win.tabs.length === 0 });
    }
    return windowObject(win, true);
  });
  api("windows", "getAll", (props = {}) => wins
    .filter(w => !props.windowTypes || props.windowTypes.includes(w.type))
    .map(w => windowObject(w, props.populate)));
  function getWindow(id, props) {
    if (Object.hasOwn(props, "windowTypes")) {
      errors.push(new Error("Warning processing windowTypes: This property is deprecated"));
    }
    return windowObject(windowById(id), props.populate);
  }
  api("windows", "get", (id, props = {}) => getWindow(id, props));
  api("windows", "getCurrent", (props = {}) => getWindow(currentWindowId, props));
  api("windows", "getLastFocused", (props = {}) => getWindow(lastFocusedId, props));
  api("windows", "update", (id, props) => {
    const win = windowById(id);
    if (props.focused === true) {
      for (const w of wins) w.focused = w === win;
      lastFocusedId = id;
      queue("windows.onFocusChanged", id);
    }
    return windowObject(win);
  });
  async function closeWindow(id) {
    const win = windowById(id);
    for (const tab of win.tabs) queue("tabs.onRemoved", tab.id, { windowId: id, isWindowClosing: true });
    for (const group of groups.filter(g => g.windowId === id)) {
      queue("tabGroups.onRemoved", group, { isWindowClosing: true });
      groups.splice(groups.indexOf(group), 1);
    }
    win.tabs = [];
    closeEmptyWindow(id);
  }

  const nodes = [], localStore = {};
  let nextBookmark = 1, bookmarkClock = 0, remoteBookmarks = false;
  const bookmarkJournal = [], unuploaded = new Set();
  function recordBookmark(node) {
    if (!remoteBookmarks) bookmarkJournal.push(copy(node));
  }
  function bookmarkChanges(sinceCursor = 0) {
    const changed = new Map();
    for (const entry of bookmarkJournal.slice(sinceCursor)) {
      changed.delete(entry.id);
      changed.set(entry.id, entry);
    }
    return { cursor: bookmarkJournal.length, nodes: [...changed.values()].map(entry =>
      entry.deleted ? entry : copy(nodes.find(node => node.id === entry.id) ?? { id: entry.id, deleted: true })) };
  }
  function nodeById(id) {
    const node = nodes.find(n => n.id === id);
    if (!node) throw new Error(`Invalid bookmark ID: ${id}`);
    return node;
  }
  function children(id) { return nodes.filter(n => n.parentId === id).sort((a, b) => a.index - b.index); }
  function folderById(id) {
    const node = nodeById(id);
    if (node.type !== "folder") throw new Error("Parent must be a folder");
    return node;
  }
  function reindexChildren(id) {
    children(id).forEach((n, i) => {
      if (n.index !== i) { n.index = i; recordBookmark(n); }
    });
  }
  function treeNode(node) {
    return node.type === "folder" ? { ...node, children: children(node.id).map(treeNode) } : { ...node };
  }
  function insertNode(props, notify = true) {
    const parentId = props.parentId ?? "unfiled_____";
    if (parentId === ROOTS[0]) throw new Error("The bookmark root cannot be modified");
    folderById(parentId);
    if (props.url != null) checkURL(props.url, true);
    const siblings = children(parentId), index = Math.max(0, Math.min(props.index ?? siblings.length, siblings.length));
    for (const n of siblings.slice(index)) { n.index++; recordBookmark(n); }
    const node = { id: props.id ?? `${notify ? setup.bookmarkPrefix ?? "b" : "b"}${String(nextBookmark++).padStart(11, "0")}`, parentId, index, title: props.title ?? "",
      type: props.url == null ? "folder" : "bookmark", dateAdded: props.dateAdded ?? ++bookmarkClock };
    if (props.url != null) node.url = props.url;
    nodes.push(node);
    if (notify) {
      if (!remoteBookmarks) unuploaded.add(node.id);
      recordBookmark(node); queue("bookmarks.onCreated", node.id, node);
    }
    return node;
  }
  nodes.push({ id: ROOTS[0], index: 0, title: "", type: "folder", dateAdded: ++bookmarkClock });
  for (const [index, title] of ["Bookmarks Menu", "Bookmarks Toolbar", "Other Bookmarks", "Mobile Bookmarks"].entries()) {
    nodes.push({ id: ROOTS[index + 1], parentId: ROOTS[0], index, title, type: "folder", dateAdded: ++bookmarkClock });
  }
  function seedBookmarks(list, parentId) {
    for (const props of list) {
      const node = insertNode({ ...props, parentId }, false);
      if (props.children) seedBookmarks(props.children, node.id);
    }
  }
  seedBookmarks(setup.bookmarks ?? [], "unfiled_____");
  for (const node of nodes) if (!ROOTS.includes(node.id)) recordBookmark(node);
  api("bookmarks", "getTree", () => [treeNode(nodeById(ROOTS[0]))]);
  api("bookmarks", "getSubTree", id => [treeNode(nodeById(id))]);
  api("bookmarks", "getChildren", id => { folderById(id); return children(id); });
  api("bookmarks", "get", ids => asArray(ids).map(nodeById));
  api("bookmarks", "search", q => nodes.filter(n => (q.title == null || n.title === q.title) && (q.url == null || n.url === q.url)));
  api("bookmarks", "create", insertNode);
  api("bookmarks", "update", (id, props) => {
    const node = nodeById(id);
    if (props.url != null) {
      checkURL(props.url, true);
      if (node.type !== "bookmark") throw new Error("Cannot set a folder URL");
    }
    for (const key of ["title", "url"]) {
      if (props[key] != null && node[key] !== props[key]) {
        node[key] = props[key];
        recordBookmark(node);
        queue("bookmarks.onChanged", id, { [key]: props[key] });
      }
    }
    return node;
  });
  function mutableNode(id) {
    if (ROOTS.includes(id)) throw new Error("Cannot modify a built-in root");
    return nodeById(id);
  }
  api("bookmarks", "move", (id, props) => {
    const node = mutableNode(id), oldParentId = node.parentId, oldIndex = node.index;
    const parentId = props.parentId ?? oldParentId;
    let ancestor = folderById(parentId);
    while (ancestor) {
      if (ancestor.id === id) throw new Error("Cannot move a folder into itself");
      ancestor = ancestor.parentId ? nodeById(ancestor.parentId) : undefined;
    }
    // Remove first, then interpret index in the destination's new child list.
    node.parentId = undefined;
    reindexChildren(oldParentId);
    const siblings = children(parentId), index = Math.max(0, Math.min(props.index ?? siblings.length, siblings.length));
    for (const n of siblings.slice(index)) { n.index++; recordBookmark(n); }
    node.parentId = parentId;
    node.index = index;
    recordBookmark(node);
    queue("bookmarks.onMoved", id, { parentId, index, oldParentId, oldIndex });
    return node;
  });
  function removeNode(node, notify = true) {
    const info = { parentId: node.parentId, index: node.index, node: copy(node) };
    for (const child of children(node.id)) removeNode(child, false);
    recordBookmark({ id: node.id, deleted: true });
    nodes.splice(nodes.indexOf(node), 1);
    reindexChildren(node.parentId);
    if (notify) queue("bookmarks.onRemoved", node.id, info);
  }
  api("bookmarks", "remove", id => {
    const node = mutableNode(id);
    if (children(id).length) throw new Error("Cannot remove a non-empty folder");
    removeNode(node);
  });
  api("bookmarks", "removeTree", id => removeNode(mutableNode(id)));

  function markUploaded(cursor) {
    for (const node of bookmarkJournal.slice(0, cursor)) unuploaded.delete(node.id);
  }
  function rekeyBookmark(node, id) {
    const old = node.id;
    node.id = id;
    unuploaded.delete(old);
    for (const child of nodes) if (child.parentId === old) child.parentId = id;
    for (const entry of bookmarkJournal) {
      if (entry.id === old) entry.id = id;
      if (entry.parentId === old) entry.parentId = id;
    }
    // Places emits bookmark-guid-changed, which ext-bookmarks does not expose.
  }

  // Sync changes emit normal events, except dedupe GUID changes, and are not
  // re-uploaded as local edits. Only locally created, never-uploaded items dedupe.
  async function applyRemoteBookmarks(changes, { orderEvents = batch => batch } = {}) {
    const eventStart = pending.length;
    remoteBookmarks = true;
    try {
      for (const change of changes.filter(node => node.deleted)) {
        const node = nodes.find(node => node.id === change.id);
        if (node && !ROOTS.includes(node.id)) removeNode(node);
      }
      const remaining = changes.filter(node => !node.deleted && !ROOTS.includes(node.id));
      // Parent folders can arrive after children in an upload.
      let waiting = [...remaining];
      while (waiting.length) {
        const ready = waiting.filter(node => nodes.some(parent => parent.id === node.parentId))
          .sort((a, b) => a.index - b.index);
        if (!ready.length) throw new Error("Remote bookmark parent missing");
        for (const change of ready) {
          let node = nodes.find(node => node.id === change.id);
          if (!node) {
            const type = change.type ?? (change.url == null ? "folder" : "bookmark");
            node = nodes.find(local => unuploaded.has(local.id) && local.parentId === change.parentId
              && local.type === type && local.title === (change.title ?? "")
              && (type === "folder" || local.url === change.url));
            if (node) {
              rekeyBookmark(node, change.id);
              node.dateAdded = change.dateAdded ?? node.dateAdded;
            } else node = insertNode(change);
          }
          if (node.title !== change.title || node.url !== change.url) {
            await browser.bookmarks.update(node.id, { title: change.title, url: change.url });
          }
          if (node.parentId !== change.parentId || node.index !== change.index) {
            await browser.bookmarks.move(node.id, { parentId: change.parentId, index: change.index });
          }
        }
        waiting = waiting.filter(node => !ready.includes(node));
      }
    } finally {
      remoteBookmarks = false;
      pending.push(...orderEvents(pending.splice(eventStart)));
    }
  }

  const session = {};
  for (const [area, storage] of [["local", localStore], ["session", session]]) {
    api(`storage.${area}`, "get", keys => {
      if (keys == null) return jsonCopy(storage);
      const result = {};
      const defaults = typeof keys === "object" && !Array.isArray(keys) ? keys : undefined;
      for (const key of defaults ? Object.keys(defaults) : asArray(keys)) {
        if (Object.hasOwn(storage, key)) result[key] = jsonCopy(storage[key]);
        else if (defaults && defaults[key] !== undefined) result[key] = jsonCopy(defaults[key]);
      }
      return result;
    });
    api(`storage.${area}`, "set", obj => {
      const changes = {}, values = jsonCopy(obj);
      for (const [key, value] of Object.entries(values)) {
        changes[key] = Object.hasOwn(storage, key) ? { oldValue: storage[key], newValue: value } : { newValue: value };
        storage[key] = value;
      }
      if (Object.keys(changes).length) queue("storage.onChanged", changes, area);
    });
    function removeStorage(keys) {
      const changes = {};
      for (const key of keys) if (Object.hasOwn(storage, key)) { changes[key] = { oldValue: storage[key] }; delete storage[key]; }
      if (Object.keys(changes).length) queue("storage.onChanged", changes, area);
    }
    api(`storage.${area}`, "remove", keys => removeStorage(asArray(keys)));
    api(`storage.${area}`, "clear", () => removeStorage(Object.keys(storage)));
  }

  browser.runtime.id = setup.extensionId ?? "foxy-test";
  api("runtime", "getURL", path => `moz-extension://${browser.runtime.id}/${path}`, true);
  api("runtime", "sendMessage", msg => {
    // Messaging needs a response without an explicit settle(), but is never synchronous.
    const sender = { id: browser.runtime.id };
    if (setup.selfTabId != null) sender.tab = tabObject(tabById(setup.selfTabId));
    const args = copy([msg, sender]);
    const response = Promise.resolve().then(() => deliver({ name: "runtime.onMessage", args }, true));
    messages.add(response);
    response.then(() => messages.delete(response), () => messages.delete(response));
    return response;
  });

  function restart({ restore = false } = {}) {
    if (settling || messages.size) throw new Error("Settle Firefox before restarting");
    pending.length = 0;
    for (const listeners of events.values()) listeners.clear();
    for (const key of Object.keys(session)) delete session[key];
    if (restore) {
      const ids = new Map();
      for (const group of groups) {
        const oldId = group.id;
        group.id = nextGroup++;
        ids.set(oldId, group.id);
      }
      for (const win of wins) for (const tab of win.tabs) {
        tab.id = nextTab++;
        tab.groupId = ids.get(tab.groupId) ?? -1;
      }
    } else {
      groups.length = 0;
      wins.splice(0, wins.length, { id: currentWindowId, focused: true, type: "normal", incognito: false,
        tabs: [makeTab({ id: nextTab++, windowId: currentWindowId, url: "about:home", active: true })] });
      lastFocusedId = currentWindowId;
      reindex(currentWindowId);
    }
    queue("runtime.onStartup");
  }

  function layout(id) {
    const tabs = wins.find(w => w.id === id)?.tabs ?? [];
    const pinned = tabs.filter(t => t.pinned).map(t => `P${t.id}`).join(" ");
    const items = [], seen = new Set();
    for (const t of tabs.filter(t => !t.pinned)) {
      if (t.groupId === -1) items.push(String(t.id));
      else if (!seen.has(t.groupId)) {
        items.push(`[${t.groupId}: ${tabs.filter(member => member.groupId === t.groupId).map(member => member.id).join(" ")}]`);
        seen.add(t.groupId);
      }
    }
    return `${pinned ? `${pinned} ` : ""}| ${items.join(" ")}`;
  }
  return { browser, settle, layout, closeWindow, restart, bookmarkChanges, markUploaded, applyRemoteBookmarks, fire: queue, errors, calls };
}
