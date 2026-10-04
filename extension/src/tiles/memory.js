const PERIOD = 5000;
const WINDOW = 5 * 60 * 1000;

function hostOf(tab) {
  try {
    const url = new URL(tab.url);
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname.replace(/^www\./, '') : null;
  } catch { return null; }
}

export function loadedSites(tabs, windows) {
  const normal = new Set(windows.filter(win => win.type === 'normal' && !win.incognito).map(win => win.id));
  const sites = new Map();
  for (const tab of tabs) {
    if (tab.discarded || tab.incognito || !normal.has(tab.windowId)) continue;
    const host = hostOf(tab);
    if (!host) continue;
    const site = sites.get(host) ?? { host, ids: [], count: 0, lastAccessed: 0, icon: null };
    site.ids.push(tab.id);
    ++site.count;
    site.lastAccessed = Math.max(site.lastAccessed, tab.lastAccessed ?? 0);
    site.icon ??= tab.favIconUrl || null;
    sites.set(host, site);
  }
  return [...sites.values()].sort((a, b) => b.count - a.count || b.lastAccessed - a.lastAccessed || a.host.localeCompare(b.host));
}

export async function unloadHost(api, host) {
  const [tabs, windows] = await Promise.all([api.tabs.query({}), api.windows.getAll({ windowTypes: ['normal'] })]);
  const site = loadedSites(tabs, windows).find(site => site.host === host);
  for (const id of site?.ids ?? []) {
    try {
      // Selection may have changed since the row was drawn or the query began.
      const tab = await api.tabs.get(id);
      if (!tab.active && !tab.audible && !tab.discarded && !tab.incognito && hostOf(tab) === host) await api.tabs.discard(id);
    } catch { /* Closed, newly active, or not discardable. Other tabs still unload. */ }
  }
}

export function addSample(samples, sample) {
  return [...samples, sample].filter(item => item.time > sample.time - WINDOW).slice(-60);
}

export function sparklinePoints(samples) {
  if (!samples.length) return '';
  if (samples.length === 1) return '2.00,16.00 298.00,16.00';
  const low = Math.min(...samples.map(item => item.bytes)), high = Math.max(...samples.map(item => item.bytes));
  const span = Math.max(high - low, 256 * 1024 ** 2), middle = (high + low) / 2;
  const end = samples.at(-1).time;
  return samples.map(item => {
    const x = 2 + 296 * (1 - Math.min(WINDOW, end - item.time) / WINDOW);
    const y = 16 - 28 * (item.bytes - middle) / span;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createMemoryTile() {
  const tile = el('section', 'column memory');
  tile.append(el('h2', 'column-title', 'MEMORY'));
  const summary = el('div', 'memory-summary');
  summary.append(el('div', 'memory-total'), el('div', 'memory-system'), el('p', 'memory-unavailable', 'Install the Foxy helper to see memory'));
  const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  spark.setAttribute('class', 'memory-sparkline');
  spark.setAttribute('viewBox', '0 0 300 32');
  spark.setAttribute('preserveAspectRatio', 'none');
  spark.setAttribute('aria-label', 'Firefox memory over the last 5 minutes');
  spark.setAttribute('role', 'img');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  spark.append(line);
  summary.append(spark);
  const list = el('div', 'rows memory-sites');
  list.dataset.zone = 'memory';
  list.tabIndex = -1;
  tile.append(summary, list);
  return tile;
}

function validMemory(reply) {
  return !reply?.error && !reply?.unavailable && Number.isFinite(reply?.firefox) && reply.firefox > 0 &&
    Number.isFinite(reply?.system?.total) && reply.system.total > 0 && Number.isFinite(reply.system.used) && reply.system.used >= 0;
}

function paint(tile, reply, sites, samples, unload, lastGood) {
  const available = validMemory(reply);
  const measured = available ? reply : reply?.unavailable ? undefined : lastGood;
  tile.querySelector('.memory-total').textContent = measured
    ? measured.firefox < 1024 ** 3 ? `${Math.round(measured.firefox / 1024 ** 2)} MB` : `${(measured.firefox / 1024 ** 3).toFixed(1)} GB`
    : '';
  tile.querySelector('.memory-system').textContent = measured
    ? `of ${Number((measured.system.total / 1024 ** 3).toFixed(1))} GB · system ${Math.round(measured.system.used / measured.system.total * 100)} % used` : '';
  const status = tile.querySelector('.memory-unavailable');
  status.hidden = available;
  status.textContent = reply?.unavailable
    ? reply.platform === 'win' ? 'Memory needs the Foxy helper on macOS or Linux' : 'Install the Foxy helper to see memory'
    : 'Memory unavailable';
  const spark = tile.querySelector('.memory-sparkline');
  spark.toggleAttribute('hidden', !available);
  spark.querySelector('polyline').setAttribute('points', sparklinePoints(samples));
  const list = tile.querySelector('.memory-sites'), top = list.scrollTop;
  const focusedRow = list.contains(document.activeElement) ? document.activeElement.closest('.memory-row') : null;
  const focused = focusedRow?.dataset.host;
  const focusedIndex = [...list.querySelectorAll('.memory-row')].indexOf(focusedRow);
  const rows = sites.map(site => {
    const row = el('div', 'memory-row');
    row.dataset.host = site.host;
    let icon = el('span', 'icon icon-none');
    if (site.icon) {
      icon = el('img', 'icon'); icon.alt = ''; icon.draggable = false;
      icon.addEventListener('error', () => icon.replaceWith(el('span', 'icon icon-none')), { once: true });
      icon.src = site.icon;
    }
    const action = el('button', 'memory-unload', 'UNLOAD'); action.type = 'button';
    action.setAttribute('aria-label', `Unload inactive tabs of ${site.host}`);
    let unloading = false;
    action.onclick = async () => {
      if (unloading) return;
      unloading = true;
      // Native disabled buttons lose focus before tab events replace the board.
      action.setAttribute('aria-disabled', 'true');
      try { await unload(site.host); }
      catch { /* A failed lookup leaves the sites intact; the next click can retry. */ }
      finally { unloading = false; action.removeAttribute('aria-disabled'); }
    };
    row.append(icon, el('span', 'memory-host', site.host), el('span', 'memory-count', `${site.count} ${site.count === 1 ? 'tab' : 'tabs'}`), action);
    return row;
  });
  if (!rows.length) rows.push(el('p', 'memory-empty', 'No loaded sites. Firefox cannot report per-site memory.'));
  list.replaceChildren(...rows);
  list.scrollTop = top;
  if (focused) {
    const row = rows.find(row => row.dataset.host === focused) ?? rows[Math.min(focusedIndex, rows.length - 1)];
    (row?.querySelector('button') ?? list).focus({ preventScroll: true });
  }
}

/** One sampler per page, retained across board renders and stopped on pagehide. */
export function createMemoryController(root, api, { document: doc = root.ownerDocument, schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
  let reply, lastGood, sites = [], samples = [], timer, running = false, inFlight = false, disposed = false;
  const tile = () => root.querySelector('[data-kind="memory"]');
  const visible = () => !disposed && root.isConnected && !doc.hidden && !!tile() && !tile().hidden;
  const draw = () => { if (tile()) paint(tile(), reply, sites, samples, unload, lastGood); };
  async function readSites() {
    const [tabs, windows] = await Promise.all([api.tabs.query({}), api.windows.getAll({ windowTypes: ['normal'] })]);
    return loadedSites(tabs, windows);
  }
  async function unload(host) {
    await unloadHost(api, host);
    try { sites = await readSites(); if (!disposed) draw(); }
    catch { /* The next scheduled sample refreshes the list. */ }
  }
  async function poll() {
    if (!visible() || inFlight) return;
    inFlight = true;
    const started = now();
    try {
      const [next, loaded] = await Promise.all([
        api.runtime.sendMessage({ type: 'foxy:memory' }).catch(() => ({ error: 'Memory request failed' })),
        readSites().catch(() => []),
      ]);
      if (!visible()) return;
      reply = next; sites = loaded;
      if (validMemory(reply)) {
        lastGood = reply;
        samples = addSample(samples, { time: now(), bytes: reply.firefox });
      }
      draw();
    } finally {
      inFlight = false;
      if (running && visible()) timer = schedule(() => { timer = undefined; poll(); }, Math.max(0, PERIOD - (now() - started)));
    }
  }
  function update() {
    if (disposed) return;
    draw();
    if (!visible()) {
      cancel(timer); timer = undefined; running = false;
    } else if (!running) {
      running = true;
      poll();
    }
  }
  function stop() {
    disposed = true; running = false; cancel(timer);
    doc.removeEventListener('visibilitychange', update);
  }
  doc.addEventListener('visibilitychange', update);
  return { update, stop };
}
