import { COLOR_EMOJI, isOpenableUrl } from './sync/codec.js';
import { markOwn } from './tabs/own.js';

const nameKey = name => name.trim().toLowerCase();
const urlKey = text => {
  try { const url = new URL(text); url.hash = ''; return url.href; }
  catch { return text; }
};
const refused = error => ({ ok: false, error });
const eligible = win => win.type === 'normal' && !win.incognito;

/** Uses the sync controller's saved snapshot, not a separate bookmark root. */
export function createAgentHandler({ api, saved, idle, deleteSaved, mark = markOwn }) {
  let lastNormal;
  let focusRead = Promise.resolve();
  api.windows.onFocusChanged.addListener(id => {
    focusRead = focusRead.then(async () => {
      try { const win = await api.windows.get(id); if (eligible(win)) lastNormal = id; }
      catch { /* Closed window or OS focus loss. */ }
    });
    return focusRead;
  });

  async function snapshot() {
    await focusRead;
    const windows = (await api.windows.getAll({ windowTypes: ['normal'] })).filter(eligible);
    try {
      const win = await api.windows.getLastFocused();
      if (eligible(win)) lastNormal = win.id;
    } catch { /* A live normal window below is sufficient. */ }
    const windowId = windows.find(w => w.id === lastNormal)?.id
      ?? windows.sort((a,b) => a.id - b.id)[0]?.id ?? null;
    if (windowId !== null) lastNormal = windowId;
    const groups = (await api.tabGroups.query({})).filter(g => windows.some(w => w.id === g.windowId));
    const open = [];
    for (const group of groups) {
      const tabs = await api.tabs.query({ groupId: group.id });
      open.push({ ...group, count: tabs.length, lastFocused: group.windowId === windowId });
    }
    const closed = await saved();
    if (!Array.isArray(closed?.saved)) throw new Error('Saved groups are unavailable');
    return { windowId, open, saved: closed.saved, folders: closed.folders };
  }

  function validate(request) {
    if (!request || !['groups','tabs','add','new','remove','delete'].includes(request.command)) return 'Unknown command';
    if (request.deadline !== undefined && (typeof request.deadline !== 'number' || !Number.isFinite(request.deadline))) return 'deadline must be a number';
    if (request.command === 'groups') return null;
    const title = request.command === 'new' ? request.title : request.group;
    if (typeof title !== 'string' || !title.trim() || [...title].length > 200) return 'Group title must be 1 to 200 characters';
    if (request.command === 'tabs') return null;
    if (request.command === 'delete') {
      return request.closeTabs !== undefined && typeof request.closeTabs !== 'boolean' ? 'closeTabs must be a boolean' : null;
    }
    if (!Array.isArray(request.urls) || request.urls.length < 1 || request.urls.length > 50) return 'Provide 1 to 50 URLs';
    if (!request.urls.every(url => typeof url === 'string' && isOpenableUrl(url))) return 'Only http: and https: URLs are allowed';
    if (request.command === 'remove') {
      return request.close !== undefined && typeof request.close !== 'boolean' ? 'close must be a boolean' : null;
    }
    if (request.color !== undefined && (typeof request.color !== 'string' || !Object.hasOwn(COLOR_EMOJI, request.color))) return 'Unknown tab group colour';
    if (request.create !== undefined && typeof request.create !== 'boolean') return 'create must be a boolean';
    return null;
  }

  async function tabsOf(group, closed) {
    return closed
      ? (await api.bookmarks.getChildren(group.folderId)).filter(b => b.type === 'bookmark')
      : (await api.tabs.query({ groupId: group.id })).sort((a,b) => a.index - b.index);
  }

  return async request => {
    const error = validate(request);
    if (error) return refused(error);
    try {
      const state = await snapshot();
      if (request.command === 'groups') return { ok: true, windowId: state.windowId, open: state.open, saved: state.saved };
      const wanted = request.command === 'new' ? request.title : request.group;
      const candidates = state.open.filter(g => nameKey(g.title) === nameKey(wanted))
        .sort((a,b) => Number(b.windowId === state.windowId) - Number(a.windowId === state.windowId)
          || a.windowId - b.windowId || a.id - b.id);
      let group = candidates[0];
      let closed = false;
      if (!group) {
        group = state.saved.find(g => nameKey(g.title) === nameKey(wanted));
        closed = !!group;
      }
      if (request.command === 'new') {
        if (candidates.length) return refused(`Group ${wanted.trim()} exists; use add`);
        group = null; closed = false;
      }
      if (!group && request.command !== 'new' && !(request.command === 'add' && request.create)) {
        const names = [...new Set([...state.open,...state.saved].map(g => g.title))];
        return refused(`No group named ${wanted.trim()}. Groups: ${names.join(', ') || '(none)'}`);
      }
      const existing = group ? await tabsOf(group, closed) : [];
      if (request.command === 'tabs') {
        return { ok: true, group, tabs: existing.map(({ title, url }) => ({ title, url })) };
      }
      if (request.deadline !== undefined && Date.now() > request.deadline) {
        return refused('Request expired before Foxy could start it; nothing changed');
      }
      const title = group?.title.trim();
      const expired = () => request.deadline !== undefined && Date.now() > request.deadline;
      const summary = group && { title: group.title, color: group.color };
      const closeTargets = async (tabs, action) => {
        const remaining = new Set(tabs.map(tab => tab.id));
        const closed = [];
        try {
          for (const tab of tabs) {
            const active = (await api.tabs.query({active:true})).find(t => remaining.has(t.id));
            if (active) {
              const advice = action === 'delete' ? 'ask the user to switch away or close it' : 'remove without --close or ask the user';
              return {closed, error:`${active.url} is the active tab in a window; ${advice}`};
            }
            if (!closed.length && expired()) return {closed, error:'Request expired before Foxy could start it; nothing changed'};
            try { await api.tabs.remove(tab.id); }
            catch (error) {
              try {
                if (!(await api.tabs.query({})).some(t => t.id === tab.id)) closed.push(tab);
              } catch { /* The browser could not confirm whether the tab closed. */ }
              throw error;
            }
            closed.push(tab);
            remaining.delete(tab.id);
          }
          return {closed};
        } catch (error) { return {closed, error:String(error.message ?? error)}; }
      };
      if (request.command === 'remove') {
        const keys = new Set(request.urls.map(urlKey));
        const matches = existing.filter(tab => keys.has(urlKey(tab.url)));
        const found = new Set(matches.map(tab => urlKey(tab.url)));
        const missing = request.urls.filter(url => !found.has(urlKey(url)));
        if (!matches.length) return refused(`No matching tabs in ${title}`);
        if (matches.length === existing.length) return refused(`This would empty ${title}; use delete`);
        if (closed) {
          for (const bookmark of matches) await api.bookmarks.remove(bookmark.id);
        } else if (request.close) {
          const result = await closeTargets(matches, 'remove');
          if (result.error) {
            if (!result.closed.length) return refused(result.error);
            return {ok:false, error:result.error, closedTabs:result.closed.length,
              deleted:{...summary, tabs:result.closed.map(({title,url}) => ({title,url}))}};
          }
        } else await api.tabs.ungroup(matches.map(tab => tab.id));
        return { ok: true, group, closed, removed: matches.length, missing };
      }
      if (request.command === 'delete') {
        if (!closed && !request.closeTabs) {
          return refused(`${title} is open in a window; pass --close-tabs to close its ${existing.length} tabs and delete it`);
        }
        const folderId = closed ? group.folderId : state.folders?.[group.id];
        if (!folderId) return refused(`The saved folder for ${title} is not available; try again`);
        const deleted = { ...summary, tabs: existing.map(({ title, url }) => ({ title, url })) };
        let closedTabs = 0;
        try {
          if (!closed) {
            const result = await closeTargets(existing, 'delete');
            closedTabs = result.closed.length;
            if (result.error) {
              if (!closedTabs) return refused(result.error);
              return {ok:false, error:result.error, closedTabs, deleted};
            }
            await idle();
          }
          if (!(await deleteSaved(folderId)).ok) throw new Error(`Could not delete ${title}`);
        } catch (error) {
          if (!closedTabs) return refused(String(error.message ?? error));
          return {ok:false, error:`Closed ${closedTabs} tabs but could not delete ${title}; run delete again`, closedTabs, deleted};
        }
        return { ok: true, group: summary, closedTabs, deleted };
      }
      const seen = new Set(existing.map(t => urlKey(t.url)));
      const urls = request.urls.filter(url => {
        const key = urlKey(url);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      if (closed) {
        for (const url of urls) await api.bookmarks.create({ parentId: group.folderId, title: url, url });
      } else {
        const windowId = group?.windowId ?? state.windowId;
        if (windowId === null) return refused('No non-private normal window');
        const tabIds = [];
        for (const url of urls) {
          const tab = await api.tabs.create({ windowId, url, active: false });
          mark(tab.id);
          tabIds.push(tab.id);
        }
        if (tabIds.length) {
          const groupId = await api.tabs.group(group
            ? { groupId: group.id, tabIds }
            : { tabIds, createProperties: { windowId } });
          if (!group) {
            const properties = { title: wanted.trim() };
            if (request.color !== undefined) properties.color = request.color;
            group = await api.tabGroups.update(groupId, properties);
          }
        }
      }
      return { ok: true, group, closed, added: urls.length, skipped: request.urls.length - urls.length };
    } catch (error) { return refused(String(error.message ?? error)); }
  };
}

/** The factory and scheduler let tests exercise the real request dispatch. */
export async function connectAgent({ api, handle, portFactory = name => api.runtime.connectNative(name), schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let nativePort, platform, sequence = 0;
  const memoryPending = new Map();
  function finish(rid, reply) {
    const item = memoryPending.get(rid);
    if (!item) return;
    memoryPending.delete(rid);
    cancel(item.timer);
    item.resolve(reply);
  }
  // Register before the platform await so MV3 can wake on page requests.
  api.runtime.onMessage.addListener(message => {
    if (message?.type !== 'foxy:memory') return undefined;
    if (!nativePort) return Promise.resolve(platform === 'win' ? { unavailable: true, platform } : { unavailable: true });
    return new Promise(resolve => {
      const rid = `memory:${++sequence}`;
      const timer = schedule(() => finish(rid, { error: 'Memory request timed out' }), 3000);
      timer?.unref?.();
      memoryPending.set(rid, { resolve, timer });
      try { nativePort.postMessage({ type: 'memory', rid }); }
      catch { finish(rid, { error: 'Memory helper disconnected' }); }
    });
  });
  platform = (await api.runtime.getPlatformInfo()).os;
  if (platform === 'win') return;
  // Firefox timers are numbers; Node timers must not retain a test process.
  const retry = delay => schedule(() => connect(false), delay)?.unref?.();
  function connect(first = true) {
    let port;
    try { port = portFactory('foxy_agent'); }
    catch { retry(first ? 5000 : 60000); return; }
    nativePort = port;
    let connected = true;
    const started = now();
    let queue = Promise.resolve();
    port.onMessage.addListener(request => {
      first = true;
      if (request?.type === 'memory') {
        if (connected) finish(request.rid, request);
        return;
      }
      queue = queue.then(async () => {
        const reply = await handle(request);
        if (connected) {
          let message = { ...reply, id: request?.id };
          if (new TextEncoder().encode(JSON.stringify(message)).length > 1024 * 1024) {
            message = { ...refused('Reply too large (maximum 1 MB)'), id: request?.id };
          }
          try { port.postMessage(message); }
          catch { /* The pipe can close while handling a request. */ }
        }
      }).catch(() => {});
      return queue;
    });
    port.onDisconnect.addListener(() => {
      if (!connected) return;
      connected = false;
      if (nativePort === port) nativePort = undefined;
      for (const rid of memoryPending.keys()) finish(rid, { error: 'Memory helper disconnected' });
      // A host that ran for a while (or answered) was working: come back quickly.
      retry(first || now() - started >= 5000 ? 5000 : 60000);
    });
  }
  connect();
}
