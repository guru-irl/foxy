const own = new Map();

export function markOwn(tabId) {
  const now = Date.now();
  for (const [id, until] of own) if (until <= now) own.delete(id);
  own.set(tabId, now + 30000);
}

export function isOwn(tabId) {
  const until = own.get(tabId);
  if (until === undefined) return false;
  if (until <= Date.now()) { own.delete(tabId); return false; }
  return true;
}
