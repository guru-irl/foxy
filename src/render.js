// Builds the pinned strip and the group cards. Text goes in with textContent
// only, so a tab title can never be parsed as markup.

/**
 * @param {HTMLElement} root  the #pinned strip
 * @param {Array<{id: number, title: string, icon: string | null}>} pinned
 * @param {(tabId: number) => void} onPick
 */
export function renderPinned(root, pinned, onPick) {
  root.hidden = pinned.length === 0;
  root.replaceChildren(
    ...pinned.map((tab) => {
      const button = tabButton("pin", tab, onPick);
      button.append(icon(tab.icon));
      return button;
    }),
  );
}

/**
 * Redraws all cards, keeping each card's scroll position (by group id).
 * @param {HTMLElement} root  the #groups grid
 * @param {Array<{id: number, title: string, color: string, tabs: Array<{id: number, title: string, icon: string | null}>}>} groups
 * @param {(tabId: number) => void} onPick
 */
export function renderGroups(root, groups, onPick) {
  const scroll = new Map();
  for (const list of root.querySelectorAll(".card-tabs")) {
    scroll.set(list.dataset.groupId, list.scrollTop);
  }
  root.hidden = groups.length === 0;
  root.replaceChildren(...groups.map((group) => card(group, onPick)));
  for (const list of root.querySelectorAll(".card-tabs")) {
    list.scrollTop = scroll.get(list.dataset.groupId) ?? 0;
  }
}

function card(group, onPick) {
  const section = el("section", "card");
  section.dataset.color = group.color;

  const heading = el("h2", "card-title");
  const name = el("span", "card-name");
  name.textContent = group.title;
  heading.append(el("span", "dot"), name);

  const list = el("div", "card-tabs");
  list.dataset.groupId = String(group.id);
  for (const tab of group.tabs) {
    const row = tabButton("row", tab, onPick);
    const label = el("span", "row-label");
    label.textContent = tab.title;
    row.append(icon(tab.icon), label);
    list.append(row);
  }

  section.append(heading, list);
  return section;
}

function tabButton(className, tab, onPick) {
  const button = el("button", className);
  button.type = "button";
  button.title = tab.title;
  button.addEventListener("click", () => onPick(tab.id));
  return button;
}

// A favicon, or the neutral globe when there is none or it fails to load
// (for example chrome:// icons, which an add-on page can't load).
function icon(url) {
  if (!url) return el("span", "icon icon-none");
  const img = el("img", "icon");
  img.alt = "";
  img.draggable = false;
  img.addEventListener("error", () => img.replaceWith(el("span", "icon icon-none")), { once: true });
  img.src = url;
  return img;
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
