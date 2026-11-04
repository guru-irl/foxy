export const WIDGETS = Object.freeze(['clock', 'pinned', 'weather', 'memory', 'saved']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const groupId = id => typeof id === 'string' && /^group:[^\s:]+$/.test(id);
const own = (value, key) => Object.hasOwn(value, key);

export function validBoard(raw) {
  const source = object(raw) ? raw : {};
  const order = [...new Set((Array.isArray(source.order) ? source.order : []).filter(groupId))];
  const heights = Object.fromEntries(Object.entries(object(source.heights) ? source.heights : {})
    .filter(([id, h]) => groupId(id) && Number.isInteger(h) && h >= 2 && h <= 40));
  const widgets = [];
  for (const item of Array.isArray(source.widgets) ? source.widgets : []) {
    if (!object(item) || !WIDGETS.includes(item.kind) || widgets.some(w => w.kind === item.kind)) continue;
    widgets.push({ kind: item.kind, h: Number.isFinite(item.h) && item.h > 0 ? item.h : null });
  }
  for (const kind of WIDGETS) if (!widgets.some(w => w.kind === kind)) widgets.push({ kind, h: null });
  return { order, heights, widgets, t: Number.isFinite(source.t) && source.t >= 0 ? source.t : 0 };
}

function bounded(board, live, absent) {
  const ids = [...new Set([...board.order, ...Object.keys(board.heights)])];
  const keep = ids.filter(id => live.has(id) || (absent.get(id) ?? 0) < 2);
  while (keep.length > 400) {
    const unknown = keep.findIndex(id => !live.has(id));
    keep.splice(unknown < 0 ? keep.length - 1 : unknown, 1);
  }
  const allowed = new Set(keep);
  return { ...board, order: board.order.filter(id => allowed.has(id)),
    heights: Object.fromEntries(Object.entries(board.heights).filter(([id]) => allowed.has(id))) };
}

async function upgrade(api, entries) {
  // Recheck before writing: another new-tab page may already have upgraded.
  const latest = await api.storage.sync.get('board');
  if (latest.board !== undefined) return validBoard(latest.board);
  const { layoutsShown = {} } = await api.storage.local.get('layoutsShown');
  const widths = Object.keys(entries).filter(k => /^layout:\d+$/.test(k)).map(k => Number(k.slice(7)));
  const shown = widths.filter(k => Number.isFinite(layoutsShown[k]));
  const choices = shown.length ? shown : widths;
  choices.sort((a,b) => (shown.length ? layoutsShown[b] - layoutsShown[a] : (entries[`layout:${b}`]?.t ?? 0) - (entries[`layout:${a}`]?.t ?? 0)) || b-a);
  const prefix = choices.length ? `tile:${choices[0]}:` : 'tile:';
  const tiles = Object.entries(entries).filter(([key, rect]) => key.startsWith(prefix) && groupId(key.slice(prefix.length)) &&
    object(rect) && Number.isFinite(rect.x) && Number.isFinite(rect.y))
    .sort(([a, ar], [b, br]) => ar.y - br.y || ar.x - br.x || a.localeCompare(b));
  const board = bounded(validBoard({ order: tiles.map(([key]) => key.slice(prefix.length)), t: Date.now() }), new Set(), new Map());
  const settings = { ...(object(entries.settings) ? entries.settings : {}) };
  const cells = settings.railCells ?? entries.railCells;
  if (Number.isInteger(cells) && cells > 0 && !own(settings, 'railWidth')) settings.railWidth = cells * 48 + (cells - 1) * 16;
  delete settings.railCells;
  await api.storage.sync.set({ board, ...(entries.settings !== undefined || cells !== undefined ? { settings } : {}) });
  // WebExtension storage has no atomic set-and-remove. New data is durable first;
  // every obsolete sync key is then removed in a single batch.
  const obsolete = Object.keys(entries).filter(key => key.startsWith('tile:') || key.startsWith('layout:') || key === 'railCells');
  if (obsolete.length) await api.storage.sync.remove(obsolete);
  return board;
}

export function createBoardStore(api) {
  let value, loaded = false, writes = Promise.resolve();
  const absent = new Map();
  return {
    get value() { return value; },
    async load() {
      const entries = await api.storage.sync.get(null);
      value = entries.board === undefined ? await upgrade(api, entries) : validBoard(entries.board);
      loaded = true;
      return value;
    },
    observe(live) {
      if (!loaded) return;
      for (const id of new Set([...value.order, ...Object.keys(value.heights)])) {
        if (live.has(id)) absent.delete(id);
        else absent.set(id, (absent.get(id) ?? 0) + 1);
      }
    },
    gesture(change, live, now = Date.now()) {
      if (!loaded) return Promise.reject(new Error('Load board before writing'));
      const job = writes.then(async () => {
        const next = bounded(validBoard(change(structuredClone(value))), live, absent);
        next.t = now;
        await api.storage.sync.set({ board: next });
        value = next;
        return next;
      });
      writes = job.catch(() => {});
      return job;
    },
  };
}

export async function resetBoard(api) {
  const { settings = {} } = await api.storage.sync.get(null);
  const { widgetsWidth, railWidth, ...rest } = settings;
  await api.storage.sync.remove('board');
  await api.storage.sync.set({ settings: rest });
}
