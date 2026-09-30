import { attachDnd } from "./dnd.js";

const layouts = new WeakSet();
function alignColumns(root) {
  const strip = root.querySelector(".strip");
  root.style.setProperty("--strip-scrollbar", `${strip.offsetHeight - strip.clientHeight}px`);
}

// Text is always assigned as textContent, never parsed as markup.
export function renderBoard(root, board, ui, handlers) {
  const strip = el("div", "strip");
  strip.tabIndex = -1;
  strip.append(...board.columns.map(column => groupColumn(column, ui, handlers)));
  const create = el("section", "column new-group");
  create.dataset.zone = "new-group";
  const action = el("span", "action");
  action.textContent = "+ NEW GROUP";
  create.append(action);
  strip.append(create);
  root.replaceChildren(fixedColumn("pinned", "PINNED", board.pinned, handlers), strip,
    fixedColumn("tabs", "TABS", board.tabs, handlers));
  attachDnd(root, handlers);
  alignColumns(root);
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

function groupColumn(group, ui, handlers) {
  const column = el("section", "column group");
  column.dataset.groupId = String(group.id);
  column.dataset.windowId = String(group.windowId);
  column.dataset.color = group.color;
  const header = el("header", "column-header");
  header.draggable = true;
  const dot = button("dot", "Group colour");
  const name = el("span", "group-name");
  const unnamed = group.title.trim() === "";
  name.classList.toggle("unnamed", unnamed);
  name.textContent = unnamed ? "UNNAMED" : group.title;
  name.title = name.textContent;
  const close = button("column-close", "Close group", "×");
  close.addEventListener("click", () => handlers.onCloseGroup?.(group.id));
  header.append(dot, name);
  if (!group.current) {
    header.classList.add("remote");
    const bring = button("bring-here", "Bring here", "↙");
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
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.draggable = true;
  row.dataset.tabId = String(tab.id);
  row.dataset.windowId = String(tab.windowId);
  row.title = tab.title;
  const label = el("span", "row-label");
  label.textContent = tab.title;
  if (tab.title === tab.url) label.classList.add("url");
  const close = button("row-close", "Close tab", "×");
  close.tabIndex = -1;
  close.addEventListener("click", event => {
    event.stopPropagation();
    handlers.onCloseTab?.(tab.id);
  });
  row.addEventListener("click", event => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    handlers.onOpen?.(tab);
  });
  row.addEventListener("keydown", event => {
    if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    handlers.onOpen?.(tab);
  });
  row.append(icon(tab.icon), label, close);
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
