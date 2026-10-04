const own = new Map();

export function markOwn(tabId) {
  const now = Date.now();
  for (const [id, expires] of own) if (expires <= now) own.delete(id);
  own.set(tabId, now + 30000);
}

export function isOwn(tabId) {
  const expires = own.get(tabId);
  if (expires === undefined) return false;
  if (expires <= Date.now()) { own.delete(tabId); return false; }
  return true;
}
