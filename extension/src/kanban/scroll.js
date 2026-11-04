/** One vertical edge-scroll step; callers own the animation-frame lifecycle. */
export function scrollAtEdge(element, y, band = 48) {
  const bounds = element.getBoundingClientRect();
  if (y < bounds.top || y > bounds.bottom) return false;
  const threshold = Math.min(band, bounds.height / 2);
  const edge = y < bounds.top + threshold ? -1 : y > bounds.bottom - threshold ? 1 : 0;
  // Match the old tab drag: small per-frame steps, not smooth-scroll restarts.
  const previous = element.scrollTop;
  element.scrollTop += edge * 12;
  return element.scrollTop !== previous;
}
