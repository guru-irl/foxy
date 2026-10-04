/** One vertical edge-scroll step; callers own the animation-frame lifecycle. */
export function scrollAtEdge(element, y) {
  const bounds = element.getBoundingClientRect();
  if (y < bounds.top || y > bounds.bottom) return false;
  const threshold = Math.min(48, bounds.height / 2);
  const edge = y < bounds.top + threshold ? -1 : y > bounds.bottom - threshold ? 1 : 0;
  // Match the old tab drag: small per-frame steps, not smooth-scroll restarts.
  element.scrollTop += edge * 12;
  return edge !== 0;
}
