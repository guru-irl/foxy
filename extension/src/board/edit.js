import { colorKey } from "../model.js";

const COLORS = ["blue", "cyan", "green", "grey", "orange", "pink", "purple", "red", "yellow"];

/** Replace a title in place; both explicit completion and blur are single-shot. */
export function openNameEditor(nameEl, { initial, onSave, onCancel }) {
  const input = document.createElement("input");
  input.className = "group-name name-editor";
  input.type = "text";
  input.value = initial;
  input.setAttribute("aria-label", `Rename ${initial.trim() || "Unnamed"}`);
  const header = nameEl.closest(".column-header");
  const draggable = header.draggable;
  header.draggable = false;
  let ended = false;
  function finish(save) {
    if (ended) return;
    ended = true;
    header.draggable = draggable;
    input.removeEventListener("blur", blur);
    input.removeEventListener("keydown", keydown);
    const focused = document.activeElement === input;
    if (save) {
      const title = input.value.trim();
      nameEl.textContent = title || "UNNAMED";
      nameEl.classList.toggle("unnamed", title === "");
      nameEl.title = nameEl.textContent;
      nameEl.setAttribute("aria-label", `Rename ${title || "Unnamed"}`);
    }
    input.replaceWith(nameEl);
    if (focused) nameEl.focus({ preventScroll: true });
    if (save) onSave(input.value.trim());
    else onCancel();
  }
  function blur() { finish(true); }
  function keydown(event) {
    if (event.isComposing) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    finish(event.key === "Enter");
  }
  input.addEventListener("blur", blur);
  input.addEventListener("keydown", keydown);
  nameEl.replaceWith(input);
  input.focus(); input.select();
  return { save: () => finish(true), cancel: () => finish(false) };
}

/** Nine API colours, with the CSS grey/gray mapping confined to the palette. */
export function openColorPicker(dotEl, { current, onPick, onClose }) {
  const picker = document.createElement("div");
  picker.className = "color-picker";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Group colour");
  picker.addEventListener("mousedown", event => {
    if (event.target === picker) event.preventDefault();
  });
  let ended = false;
  function close(restoreFocus = false) {
    if (ended) return;
    ended = true;
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("focusout", focusout);
    document.removeEventListener("visibilitychange", visibilitychange);
    window.removeEventListener("blur", windowBlur);
    picker.remove();
    dotEl.setAttribute("aria-expanded", "false");
    if (restoreFocus && dotEl.isConnected) dotEl.focus({ preventScroll: true });
    onClose();
  }
  for (const color of COLORS) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "dot";
    choice.dataset.color = color;
    choice.dataset.palette = colorKey(color);
    choice.setAttribute("aria-label", color);
    choice.setAttribute("aria-pressed", String(color === current));
    choice.addEventListener("click", event => {
      event.stopPropagation();
      if (ended) return;
      // Start the API action before releasing the edit hold.
      try { if (color !== current) onPick(color); } finally { close(true); }
    });
    picker.append(choice);
  }
  function outside(event) {
    if (!picker.contains(event.target) && !dotEl.contains(event.target)) close();
  }
  function focusout(event) {
    if (!picker.contains(event.relatedTarget) && !dotEl.contains(event.relatedTarget)) close();
  }
  function visibilitychange() { if (document.hidden) close(); }
  function windowBlur() { close(); }
  function keydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    close(true);
  }
  dotEl.closest(".column-header").after(picker);
  dotEl.setAttribute("aria-expanded", "true");
  document.addEventListener("click", outside, true);
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("focusout", focusout);
  document.addEventListener("visibilitychange", visibilitychange);
  window.addEventListener("blur", windowBlur);
  (picker.querySelector('[aria-pressed="true"]') ?? picker.firstElementChild).focus({ preventScroll: true });
  return { close: () => close() };
}
