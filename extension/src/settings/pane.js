import { saveSetting, cardAlpha } from "./store.js";

const panes = new WeakMap();
let sequence = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text) {
  const node = el("button", "", text); node.type = "button"; return node;
}

// Both pages use the same stores and the same failure rollback. A successful
// save is applied to the board only by its existing storage-change listener.
export function settingActions(api, onReset) {
  return {
    onChange(scope, key, value) { return saveSetting(api, scope, key, value); },
    onReset,
  };
}

export async function resetLayout(api) {
  const stored = await api.storage.sync.get(null);
  await api.storage.sync.remove(Object.keys(stored).filter(key => key.startsWith("tile:")));
}

/** Shared pane. Repeated calls update values without replacing focused nodes. */
export function renderSettings(container, state, handlers) {
  let pane = panes.get(container);
  if (!pane) {
    pane = { state, handlers, controls: [], confirmed: false, timer: 0, saving: new Map() };
    panes.set(container, pane);
    const scroll = el("div", "settings-scroll"); scroll.tabIndex = -1;
    container.replaceChildren(scroll);
    // pane.state holds stored values only (from storage or a successful save).
    // After a failure the control shows the stored value again, but only once
    // no later save for the same key is still in flight.
    const change = async (scope, key, value) => {
      const id = `${scope}:${key}`;
      pane.saving.set(id, (pane.saving.get(id) ?? 0) + 1);
      try {
        const stored = await pane.handlers.onChange(scope, key, value);
        if (stored) renderSettings(container, { ...pane.state, ...stored }, pane.handlers);
      } catch (error) {
        console.warn("Foxy: could not change setting", error);
        if (pane.saving.get(id) === 1) update();
      } finally {
        pane.saving.set(id, pane.saving.get(id) - 1);
        if (key === "railCells" && !pane.saving.get(id)) update();
      }
    };
    function section(title) {
      const node = el("section", "settings-section");
      node.append(el("h2", "settings-title", title)); scroll.append(node); return node;
    }
    function label(section, text, device = false) {
      const row = el("div", "setting"), title = el("div", "setting-label", text);
      title.id = `setting-${++sequence}`; row.append(title);
      let caption;
      if (device) {
        caption = el("small", "setting-caption", "This device only");
        caption.id = `setting-${++sequence}`; row.append(caption);
      }
      section.append(row); return { row, title, caption };
    }
    function segmented(section, text, scope, key, choices, device = false) {
      const { row, title, caption } = label(section, text, device), group = el("div", "settings-segmented");
      if (caption) group.setAttribute("aria-describedby", caption.id);
      group.dataset.key = key; group.setAttribute("role", "group"); group.setAttribute("aria-labelledby", title.id);
      for (const [value, text] of choices) {
        const node = button(text); node.dataset.value = value;
        node.addEventListener("click", () => {
          if (pane.state[scope][key] !== value) change(scope, key, value);
        });
        group.append(node);
      }
      row.append(group);
      pane.controls.push(() => {
        for (const node of group.children) node.setAttribute("aria-pressed", String(node.dataset.value === pane.state[scope][key]));
      });
    }
    function toggle(section, text, key) {
      const { row, title } = label(section, text), node = button("");
      row.classList.add("setting-toggle"); node.className = "settings-toggle"; node.dataset.key = key;
      node.setAttribute("role", "switch"); node.setAttribute("aria-labelledby", title.id);
      node.addEventListener("click", () => {
        const before = node.getAttribute("aria-checked") === "true";
        node.setAttribute("aria-checked", String(!before));
        change("synced", key, !before);
      }); row.append(node);
      pane.controls.push(() => node.setAttribute("aria-checked", String(pane.state.synced[key])));
    }
    const grid = section("Grid");
    segmented(grid, "Cell size", "device", "cellSize", [["S", "S"], ["M", "M"], ["L", "L"], ["XL", "XL"], ["custom", "Custom"]], true);
    const custom = el("div", "setting setting-custom"), customLabel = el("label", "setting-label", "Cell size in px");
    const field = el("input", "settings-number"); field.type = "number"; field.min = "40"; field.max = "240"; field.step = "1";
    field.id = `setting-${++sequence}`; field.dataset.key = "customCell"; customLabel.htmlFor = field.id;
    custom.append(customLabel, field); grid.append(custom);
    field.addEventListener("change", () => {
      const value = field.valueAsNumber;
      if (!Number.isInteger(value) || value < 40 || value > 240) { field.value = pane.state.device.customCell; return; }
      if (value !== pane.state.device.customCell) change("device", "customCell", value);
    });
    pane.controls.push(() => {
      custom.hidden = field.hidden = pane.state.device.cellSize !== "custom";
      field.value = pane.state.device.customCell;
    });
    const { row: rail, title: railLabel } = label(grid, "TABS rail width"), stepper = el("div", "settings-stepper");
    stepper.setAttribute("role", "group"); stepper.setAttribute("aria-labelledby", railLabel.id);
    const minus = button("−"), plus = button("+"), count = el("output", "", "");
    minus.dataset.rail = "minus"; plus.dataset.rail = "plus"; count.dataset.rail = "value";
    minus.setAttribute("aria-label", "Decrease TABS rail width"); plus.setAttribute("aria-label", "Increase TABS rail width");
    const railCells = () => Math.max(2, Math.min(pane.state.railMax, pane.state.synced.railCells));
    function showRail(value) {
      const cells = Math.max(2, Math.min(pane.state.railMax, value));
      count.textContent = cells; minus.disabled = cells <= 2; plus.disabled = cells >= pane.state.railMax;
    }
    function stepRail(delta) {
      showRail(Number(count.textContent) + delta);
      change("synced", "railCells", Number(count.textContent));
    }
    minus.addEventListener("click", () => stepRail(-1));
    plus.addEventListener("click", () => stepRail(1));
    stepper.append(minus, count, plus); rail.append(stepper);
    pane.controls.push(() => {
      showRail(pane.saving.get("synced:railCells") ? Number(count.textContent) : railCells());
    });
    const tiles = section("Tiles");
    toggle(tiles, "Show clock", "showClock"); toggle(tiles, "Show pinned", "showPinned"); toggle(tiles, "Show saved", "showSaved");
    const reset = button("Reset layout"); reset.className = "settings-reset settings-pill"; tiles.append(reset);
    const clearConfirm = () => { clearTimeout(pane.timer); pane.confirmed = false; reset.textContent = "Reset layout"; };
    reset.addEventListener("keydown", event => {
      if (event.repeat && ["Enter", " "].includes(event.key)) event.preventDefault();
    });
    reset.addEventListener("click", async event => {
      if (event.detail > 1) return;
      if (!pane.confirmed) {
        pane.confirmed = true; pane.armedAt = performance.now();
        reset.textContent = "Confirm reset"; pane.timer = setTimeout(clearConfirm, 3000); return;
      }
      if (performance.now() - pane.armedAt < 400) return;
      clearConfirm(); reset.disabled = true;
      try { await pane.handlers.onReset(); }
      catch (error) { console.warn("Foxy: could not reset layout", error); }
      finally { reset.disabled = false; }
    });
    const clock = section("Clock");
    segmented(clock, "Time format", "synced", "timeFormat", [["24", "24-hour"], ["12", "12-hour"]]);
    toggle(clock, "Show date", "showDate");
    const cards = section("Cards");
    segmented(cards, "Transparency", "synced", "transparency", [["low", "Low"], ["medium", "Medium"], ["high", "High"]]);
    segmented(cards, "Row density", "device", "density", [["normal", "Normal"], ["compact", "Compact"]], true);
    const windows = section("Windows");
    toggle(windows, "Show tabs and groups from other windows", "otherWindows");
    toggle(windows, "Switch to an open tab instead of opening a duplicate", "switchToOpenTab");
    toggle(section("Pins"), "Clicking a pin from another window moves it here", "pinsMoveHere");
    function edges() {
      container.classList.toggle("scroll-start", scroll.scrollTop > 0);
      container.classList.toggle("scroll-end", scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop >= 1);
    }
    scroll.addEventListener("scroll", edges, { passive: true });
    new ResizeObserver(edges).observe(scroll);
    pane.updateEdges = edges;
    function update() { for (const control of pane.controls) control(); }
  }
  pane.state = state; pane.handlers = handlers;
  for (const control of pane.controls) control();
  for (const scheme of ["dark", "light"]) container.style.setProperty(`--card-alpha-${scheme}`, cardAlpha(state.synced.transparency, scheme));
  pane.updateEdges();
}
