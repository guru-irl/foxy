import { pinOrigin } from "../sync/names.js";
import { normalizePinName } from "../sync/codec.js";
import { colorKey } from "../model.js";
import { attachDnd } from "./dnd.js";
import { openNameEditor, openColorPicker } from "./edit.js";

const editors = new WeakMap();
const renameStarts = new WeakMap();
const banners = new WeakMap();
const confirmations = new WeakMap();

const layouts = new WeakMap();

function readEdge(node) {
  const horizontal = node.classList.contains("strip");
  const position = horizontal ? node.scrollLeft : node.scrollTop;
  const extent = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
  // Integer extents and fractional offsets can disagree at the maximum.
  // Less than one CSS pixel remaining is at-end; a full pixel gets a hint.
  return { node, start: extent > 0 && position > 0, end: extent > 0 && extent - position >= 1 };
}

function writeEdge({ node, start, end }) {
  node.toggleAttribute("data-scroll-start", start);
  node.toggleAttribute("data-scroll-end", end);
}

export function updateScrollEdges(root) {
  const edges = [...root.querySelectorAll(".strip, .rows")].map(readEdge);
  for (const edge of edges) writeEdge(edge);
}

function watchLayout(root) {
  // Each render replaces the scroll containers. Release the old observations
  // before watching their replacements, including content size changes.
  layouts.get(root)?.disconnect();
  const observer = new ResizeObserver(() => {
    alignColumns(root);
    updateScrollEdges(root);
  });
  layouts.set(root, observer);
  observer.observe(root);
  for (const node of root.querySelectorAll(".strip, .rows")) {
    node.addEventListener("scroll", () => writeEdge(readEdge(node)), { passive: true });
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
  }
  updateScrollEdges(root);
}
function alignColumns(root) {
  const strip = root.querySelector(".strip");
  root.style.setProperty("--strip-scrollbar", `${strip.offsetHeight - strip.clientHeight}px`);
}

// Text is always assigned as textContent, never parsed as markup.
export function renderBoard(root, board, ui, handlers) {
  if (ui.confirmFolderId == null) confirmations.delete(root);
  else if (confirmations.get(root)?.folderId !== ui.confirmFolderId) {
    confirmations.set(root, { folderId: ui.confirmFolderId, at: performance.now() });
  }
  const focus = savedFocus(root);
  // A vanished editor must also release its document listeners. Controller
  // identity checks prevent this old cleanup from ending a newer editor.
  editors.get(root)?.cancel();
  root.setAttribute("role", "region");
  const strip = el("div", "strip");
  strip.tabIndex = -1;
  if (board.saved?.length) strip.append(savedColumn(root, board.saved, ui, handlers));
  strip.append(...board.columns.map(column => groupColumn(root, column, handlers)));
  const create = el("section", "column new-group");
  create.dataset.zone = "new-group";
  const action = el("span", "action");
  action.textContent = "+ NEW GROUP";
  create.append(action);
  strip.append(create);
  root.replaceChildren(fixedColumn(root, "pinned", "PINNED", board.pinned, handlers), strip,
    fixedColumn(root, "tabs", "TABS", board.tabs, handlers));
  const previousBanner = banners.get(root);
  const missingCount = board.missing?.length ?? 0;
  if (missingCount && previousBanner?.dataset.count === String(missingCount)) {
    updateBanner(previousBanner, ui, handlers);
  } else {
    previousBanner?.remove();
    banners.delete(root);
    if (missingCount) {
      const banner = missingBanner(missingCount, ui, handlers);
      root.before(banner);
      banners.set(root, banner);
    }
  }
  attachDnd(root, handlers, board);
  alignColumns(root);
  if (ui.editGroupId != null) {
    const name = root.querySelector(`.column[data-group-id="${ui.editGroupId}"] .group-name`);
    renameStarts.get(name)?.();
  }
  if (focus && !root.querySelector(".name-editor")) {
    let target;
    if (focus.folderId !== undefined) {
      const rows = [...root.querySelectorAll(".saved-row")];
      const row = rows.find(row => row.dataset.folderId === focus.folderId);
      target = row ? (focus.selector ? row.querySelector(focus.selector) : row)
        : rows[Math.min(focus.index, rows.length - 1)]?.querySelector(".row-open");
    } else target = banners.get(root)?.querySelector(focus.selector);
    (target ?? strip).focus({ preventScroll: true });
  }
  watchLayout(root);
}

// SAVED and the sibling banner are not tab/group focus identities. Preserve
// these here; the controller continues owning tab focus and scroll restoration.
function savedFocus(root) {
  const active = document.activeElement;
  const row = active.closest?.(".saved-row");
  if (row && root.contains(row)) {
    return { folderId: row.dataset.folderId,
      index: [...root.querySelectorAll(".saved-row")].indexOf(row),
      selector: active === row ? null : active.matches(".saved-delete") ? ".saved-delete" : ".row-open" };
  }
  if (banners.get(root)?.contains(active)) {
    return { selector: active.matches(".banner-restore") ? ".banner-restore" : ".banner-dismiss" };
  }
  return null;
}

function missingBanner(count, ui, handlers) {
  const banner = el("div", "banner");
  banner.setAttribute("role", "status");
  banner.dataset.count = String(count);
  const text = el("span", "banner-text");
  text.textContent = `${count} ${count === 1 ? "GROUP" : "GROUPS"} DIDN'T COME BACK`;
  const restore = button("banner-restore", "Restore all missing groups", "RESTORE ALL");
  const dismiss = button("banner-dismiss", "Dismiss missing groups", "DISMISS");
  const separator = () => {
    const node = el("span", "banner-separator");
    node.textContent = "·";
    node.setAttribute("aria-hidden", "true");
    return node;
  };
  banner.append(text, separator(), restore, separator(), dismiss);
  updateBanner(banner, ui, handlers);
  return banner;
}

function updateBanner(banner, ui, handlers) {
  banner.querySelector(".banner-restore").onclick = () => {
    if (!ui.busy?.has("banner")) handlers.onRestoreAll?.();
  };
  banner.querySelector(".banner-dismiss").onclick = () => {
    if (!ui.busy?.has("banner")) handlers.onDismissMissing?.();
  };
  const busy = Boolean(ui.busy?.has("banner"));
  banner.classList.toggle("busy", busy);
  for (const button of banner.querySelectorAll("button")) {
    button.setAttribute("aria-busy", String(busy));
    button.setAttribute("aria-disabled", String(busy));
  }
}

function savedColumn(root, saved, ui, handlers) {
  const column = el("section", "column saved");
  column.dataset.zone = "saved";
  const heading = el("h2", "column-title");
  heading.textContent = "SAVED";
  const list = rows("saved");
  list.append(...saved.map(group => savedRow(root, group, ui, handlers)));
  column.append(heading, list);
  return column;
}

function savedRow(root, group, ui, handlers) {
  const row = el("div", "row saved-row");
  // As with tab rows, open and delete are siblings, not nested buttons.
  row.tabIndex = -1;
  row.dataset.folderId = group.folderId;
  row.dataset.color = group.color;
  const unnamed = group.title.trim() === "";
  const title = unnamed ? "Unnamed" : group.title;
  row.title = title;
  const blockedLabel = group.cantReopen.length ? `, ${group.cantReopen.length} can't reopen` : "";
  const open = button("row-open", `Open saved group: ${title}, ${group.count} ${group.count === 1 ? "bookmark" : "bookmarks"}${blockedLabel}`);
  const dot = el("span", "dot");
  dot.dataset.palette = colorKey(group.color);
  const label = el("span", "row-label");
  label.textContent = unnamed ? "UNNAMED" : group.title;
  label.classList.toggle("unnamed", unnamed);
  const count = el("span", "saved-count");
  count.textContent = String(group.count);
  open.append(dot, label, count);
  if (group.cantReopen.length) {
    const blocked = el("span", "cant-reopen");
    blocked.textContent = `${group.cantReopen.length} CAN'T REOPEN`;
    blocked.title = group.cantReopen.join("\n");
    open.append(blocked);
  }
  const confirming = ui.confirmFolderId === group.folderId;
  row.classList.toggle("confirming", confirming);
  const remove = button("saved-delete", `Delete saved group: ${title}`, confirming ? "DELETE?" : "×");
  remove.tabIndex = confirming ? 0 : -1;
  if (confirming) remove.dataset.color = "red";
  const busy = () => ui.busy?.has(group.folderId);
  const confirm = () => {
    if (busy()) return;
    if (confirmations.get(root)?.folderId !== group.folderId) {
      confirmations.set(root, { folderId: group.folderId, at: performance.now() });
    }
    handlers.onConfirmDelete?.(group.folderId);
  };
  const cancel = () => {
    if (row.isConnected && !busy() && ui.confirmFolderId === group.folderId) handlers.onConfirmDelete?.(null);
  };
  row.addEventListener("click", event => {
    if (busy() || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    handlers.onOpenSaved?.(group.folderId);
  });
  remove.addEventListener("click", event => {
    event.stopPropagation();
    if (busy() || event.detail > 1) return;
    if (confirming) {
      const armed = confirmations.get(root);
      if (armed?.folderId === group.folderId && performance.now() - armed.at >= 400) handlers.onDeleteSaved?.(group.folderId);
    } else confirm();
  });
  row.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (["Enter", " ", "Delete", "Backspace", "Escape"].includes(event.key)) event.preventDefault();
    if (event.repeat || busy()) return;
    if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
    if (event.target === remove) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); remove.click(); }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); handlers.onOpenSaved?.(group.folderId);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault(); confirm();
      // The controller may have rebuilt the DOM synchronously. Find by identity
      // rather than interpolating a bookmark GUID into a CSS selector.
      const next = [...root.querySelectorAll(".saved-row")].find(node => node.dataset.folderId === group.folderId);
      next?.querySelector(".saved-delete")?.focus({ preventScroll: true });
    }
  });
  row.addEventListener("mouseleave", cancel);
  row.addEventListener("focusout", event => {
    if (!row.contains(event.relatedTarget)) cancel();
  });
  row.append(open, remove);
  setBusy(row, busy());
  return row;
}

function setBusy(node, busy) {
  node.classList.toggle("busy", Boolean(busy));
  node.setAttribute("aria-busy", String(Boolean(busy)));
  for (const button of node.querySelectorAll("button")) button.setAttribute("aria-disabled", String(Boolean(busy)));
}

function fixedColumn(root, zone, title, sections, handlers) {
  const column = el("section", "column fixed");
  column.dataset.zone = zone;
  const heading = el("h2", "column-title");
  heading.textContent = title;
  const list = rows(zone);
  let otherWindows = 0;
  for (const section of sections) {
    if (!section.current) {
      if (otherWindows++ === 0) {
        const heading = el("h3", "subheading");
        heading.textContent = "OTHER WINDOWS";
        list.append(heading);
      } else {
        list.append(el("div", "window-gap"));
      }
    }
    list.append(...section.rows.map(row => tabRow(root, row, handlers)));
  }
  column.append(heading, list);
  return column;
}

function groupColumn(root, group, handlers) {
  const column = el("section", "column group");
  column.dataset.groupId = String(group.id);
  column.dataset.windowId = String(group.windowId);
  column.dataset.color = group.color;
  const header = el("header", "column-header");
  header.draggable = true;
  const groupName = group.title.trim() || "Unnamed";
  const dot = button("dot", `Colour of ${groupName}`);
  dot.setAttribute("aria-expanded", "false");
  const name = button("group-name", `Rename ${groupName}`);
  const unnamed = group.title.trim() === "";
  name.classList.toggle("unnamed", unnamed);
  name.textContent = unnamed ? "UNNAMED" : group.title;
  name.title = name.textContent;
  function begin(open) {
    editors.get(root)?.finish();
    handlers.onEditState?.(true, group.id);
    const active = { finish: null, cancel: null };
    editors.set(root, active);
    const end = () => {
      if (editors.get(root) !== active) return;
      editors.delete(root);
      handlers.onEditEnd?.(group.id);
    };
    const editor = open(end);
    active.finish = editor.save ?? editor.close;
    active.cancel = editor.cancel ?? editor.close;
  }
  const rename = () => {
    const initial = name.classList.contains("unnamed") ? "" : name.textContent;
    begin(end => openNameEditor(name, {
      initial,
      onSave: title => {
        try { if (title !== initial.trim()) handlers.onRename?.(group.id, title); }
        finally { end(); }
      },
      onCancel: end,
    }));
  };
  renameStarts.set(name, rename);
  name.addEventListener("click", rename);
  dot.addEventListener("click", () => {
    if (dot.getAttribute("aria-expanded") === "true") { editors.get(root)?.finish(); return; }
    begin(end => openColorPicker(dot, { current: group.apiColor,
      onPick: color => handlers.onRecolor?.(group.id, color), onClose: end }));
  });
  const close = button("column-close", `Close group: ${groupName}`, "×");
  close.addEventListener("click", () => handlers.onCloseGroup?.(group.id));
  header.append(dot, name);
  if (!group.current) {
    header.classList.add("remote");
    const bring = button("bring-here", `Bring ${groupName} here`);
    bring.append(el("span", "bring-icon"));
    bring.addEventListener("click", () => handlers.onBringHere?.(group.id));
    header.append(bring);
  }
  header.append(close);
  const list = rows("group", group.id);
  list.append(...group.rows.map(row => tabRow(root, row, handlers)));
  column.append(header);
  if (!group.current) {
    const other = el("div", "other-window");
    other.textContent = "OTHER WINDOW";
    column.append(other);
  }
  column.append(list);
  return column;
}

function rows(zone, groupId) {
  const list = el("div", "rows");
  // Firefox makes overflowing containers focusable. Rows, not containers,
  // are keyboard targets, so suppress the UA scroll-container focus ring.
  list.tabIndex = -1;
  list.dataset.zone = zone;
  if (groupId !== undefined) list.dataset.groupId = String(groupId);
  return list;
}

function tabRow(root, tab, handlers) {
  const row = el("div", "row");
  // The open action and close are sibling buttons, never nested controls.
  row.tabIndex = -1;
  row.draggable = true;
  row.dataset.tabId = String(tab.id);
  row.dataset.windowId = String(tab.windowId);
  row.title = tab.title;
  const label = el("span", "row-label");
  label.textContent = tab.title;
  if (tab.title === tab.url) label.classList.add("url");
  const open = button("row-open", tab.title);
  open.append(icon(tab.icon), label);
  const close = button("row-close", `Close tab: ${tab.title}`, "×");
  close.addEventListener("click", event => {
    event.stopPropagation();
    handlers.onCloseTab?.(tab.id);
  });
  row.addEventListener("click", event => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    handlers.onOpen?.(tab);
  });
  row.append(open);
  if (tab.pinned) {
    const rename = button("row-rename", `Rename pin: ${tab.title}`);
    const start = () => {
      if (row.querySelector(".name-editor")) return;
      editors.get(root)?.finish();
      handlers.onEditState?.(true, null, tab.id);
      const active = { finish: null, cancel: null };
      editors.set(root, active);
      // Keep the favicon visible, with the input as a sibling, not inside a button.
      const favicon = open.firstElementChild;
      row.insertBefore(favicon, open);
      const end = () => {
        open.prepend(favicon);
        if (editors.get(root) !== active) return;
        editors.delete(root);
        handlers.onEditEnd?.(null, tab.id);
      };
      const editor = openNameEditor(open, {
        initial: tab.name ?? tab.title, className: "name-editor pin-name-editor", updateLabel: false,
        onSave: name => {
          try {
            name = normalizePinName(name);
            if (name === normalizePinName(tab.name ?? tab.title)) return;
            label.textContent = name || tab.title;
            handlers.onRenamePin?.(tab.id, name || null, tab.origin ?? pinOrigin(tab.url));
          } finally { end(); }
        }, onCancel: end,
      });
      active.finish = editor.save;
      active.cancel = editor.cancel;
    };
    rename.addEventListener("click", event => { event.stopPropagation(); start(); });
    row.addEventListener("keydown", event => {
      if (event.key !== "F2" || event.isComposing || event.target.matches("input")) return;
      event.preventDefault(); event.stopPropagation(); start();
    });
    if (tab.name && tab.origin && tab.allowed === false) {
      const allow = button("pin-allow", `Allow pin name on this site: ${tab.name}`, "ALLOW");
      allow.addEventListener("click", event => {
        event.stopPropagation();
        handlers.onAllowPin?.(tab.origin);
      });
      row.append(allow);
    }
    row.append(rename);
  }
  row.append(close);
  return row;
}

function icon(url) {
  if (!url) return el("span", "icon icon-none");
  const image = el("img", "icon");
  image.alt = "";
  image.draggable = false;
  image.addEventListener("error", () => image.replaceWith(el("span", "icon icon-none")), { once: true });
  image.src = url;
  return image;
}

function button(className, label, text = "") {
  const node = el("button", className);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.textContent = text;
  return node;
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
