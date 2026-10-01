/**
 * @typedef {Object} TabDrop
 * @property {"group"|"tabs"|"pinned"|"new-group"} zone
 * @property {number} tabId The dragged tab; required to suppress no-op drops.
 * @property {number} [slot] Insertion slot (not needed for new-group).
 * @property {number} [groupId] Group column ID when zone is group.
 */

/**
 * Resolve a row insertion slot to a move target; null means no change.
 * @param {Object} board
 * @param {TabDrop} drop
 * @param {number} currentWindowId
 */
export function resolveTabTarget(board, drop, currentWindowId) {
  if (drop.zone === "new-group") return { kind: "new-group", windowId: currentWindowId };

  let rows, target;
  if (drop.zone === "group") {
    const column = board.columns.find(column => column.id === drop.groupId);
    if (!column) return null;
    rows = column.rows;
    target = {
      kind: "group", groupId: column.id, windowId: column.windowId,
      beforeTabId: rows[drop.slot]?.id ?? null,
    };
  } else if (drop.zone === "pinned" || drop.zone === "tabs") {
    rows = board[drop.zone].flatMap(section => section.rows);
    const { windowId, beforeId } = adjacentTarget(rows, drop.slot, currentWindowId);
    target = { kind: drop.zone, windowId, beforeTabId: beforeId };
    if (drop.zone === "tabs" && drop.slot === 0 && board.tabs[0]?.windowId !== currentWindowId) {
      target = { kind: "tabs", windowId: currentWindowId, beforeTabId: null };
    }
    if (drop.zone === "pinned" && windowId !== currentWindowId) {
      target = { kind: "pinned", windowId: currentWindowId, beforeTabId: null };
    }
  } else {
    return null;
  }

  // Check the resolved window, not just the row position: a foreign pin must
  // still move here, even when it sits just above the original drop slot.
  if (drop.tabId != null) {
    if (target.kind === "pinned" && target.windowId === currentWindowId && target.beforeTabId === null &&
        board.pinned.find(section => section.windowId === currentWindowId)?.rows.at(-1)?.id === drop.tabId) {
      return null;
    }
    const above = rows[drop.slot - 1];
    if (target.beforeTabId === drop.tabId ||
        (above?.id === drop.tabId && above.windowId === target.windowId)) return null;
  }
  return target;
}

/** Resolve a column insertion slot, suppressing both slots adjacent to itself. */
export function resolveGroupTarget(board, groupId, slot, currentWindowId) {
  const before = board.columns[slot], after = board.columns[slot - 1];
  if (before?.id === groupId || after?.id === groupId) return null;
  const { windowId, beforeId } = adjacentTarget(board.columns, slot, currentWindowId);
  return { windowId, beforeGroupId: beforeId };
}

// A boundary belongs to the window above it. At the top, use the window below;
// inside a window, insert before the row/column below; an empty zone is local.
function adjacentTarget(items, slot, currentWindowId) {
  const before = items[slot], after = items[slot - 1];
  if (before && (!after || after.windowId === before.windowId)) {
    return { windowId: before.windowId, beforeId: before.id };
  }
  return { windowId: after?.windowId ?? currentWindowId, beforeId: null };
}

/** Count row/column midpoints strictly above the pointer. */
export function slotFromPointer(midpoints, y) {
  return midpoints.filter(midpoint => midpoint < y).length;
}
