import { createFirefox } from "./firefox.js";

/** Deterministic last-writer-wins per id, in attachment/upload order.
 * Devices carry their wired controller as ff.sync. No Firefox/network services.
 */
export function createSyncServer() {
  const replica = createFirefox(), devices = [], deleted = new Map();
  const flatten = nodes => nodes.flatMap(({ children, ...node }) => [node, ...flatten(children ?? [])]);
  return {
    attach(ff) { devices.push({ ff, cursor: 0 }); },
    async syncAll() {
      let uploaded = 0;
      for (const device of devices) {
        const changes = device.ff.bookmarkChanges(device.cursor);
        device.cursor = changes.cursor;
        uploaded += changes.nodes.length;
        for (const node of changes.nodes) {
          if (node.deleted) deleted.set(node.id, node);
          else deleted.delete(node.id);
        }
        await replica.applyRemoteBookmarks(changes.nodes);
      }
      const merged = [...flatten(await replica.browser.bookmarks.getTree()), ...deleted.values()];
      for (const { ff } of devices) {
        await ff.applyRemoteBookmarks(merged);
        await ff.settle();
        await ff.sync.idle();
      }
      return { uploaded };
    },
  };
}
