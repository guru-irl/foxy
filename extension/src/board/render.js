import { attachDnd } from "./dnd.js";
import { openNameEditor, openColorPicker } from "./edit.js";

const editors = new WeakMap();
const renameStarts = new WeakMap();

const layouts = new WeakSet();
function alignColumns(root) {
  const strip = root.querySelector(".strip");
  root.style.setProperty("--strip-scrollbar", `${strip.offsetHeight - strip.clientHeight}px`);
}

// Text is always assigned as textContent, never parsed as markup.
export function renderBoard(root, board, ui, handlers) {
  // A vanished editor must also release its document listeners. Controller
  // identity checks prevent this old cleanup from ending a newer editor.
  editors.get(root)?.cancel();
  root.setAttribute("role", "region");
  const strip = el("div", "strip");
  strip.tabIndex = -1;
  strip.append(...board.columns.map(column => groupColumn(root, column, handlers)));
  const create = el("section", "column new-group");
  create.dataset.zone = "new-group";
  const action = el("span", "action");
  action.textContent = "+ NEW GROUP";
  create.append(action);
  strip.append(create);
  root.replaceChildren(fixedColumn("pinned", "PINNED", board.pinned, handlers), strip,
    fixedColumn("tabs", "TABS", board.tabs, handlers));
  attachDnd(root, handlers, board);
  alignColumns(root);
  if (ui.editGroupId != null) {
    const name = root.querySelector(`.column[data-group-id="${ui.editGroupId}"] .group-name`);
    renameStarts.get(name)?.();
  }
  if (!layouts.has(root)) {
    layouts.add(root);
    // Width changes can add/remove a classic horizontal scrollbar.
    new ResizeObserver(() => alignColumns(root)).observe(root);
  }
}

function fixedColumn(zone, title, sections, handlers) {
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
    list.append(...section.rows.map(row => tabRow(row, handlers)));
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
  list.append(...group.rows.map(row => tabRow(row, handlers)));
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

function tabRow(tab, handlers) {
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
  row.append(open, close);
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
