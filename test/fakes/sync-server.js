import { createFirefox } from "./firefox.js";

/** Deterministic last-writer-wins per id, in attachment/upload order.
 * Devices carry their wired controller as ff.sync. No Firefox/network services.
 */
export function createSyncServer({ deliveryOrder = "forward", seed = 42 } = {}) {
  const replica = createFirefox(), devices = [], deleted = new Map();
  let randomState = seed >>> 0;
  function orderEvents(batch) {
    if (deliveryOrder === "reverse") return batch.reverse();
    if (deliveryOrder === "shuffle") for (let i = batch.length - 1; i > 0; i--) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      const j = Math.floor(randomState / 0x100000000 * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    return batch;
  }
  const flatten = nodes => nodes.flatMap(({ children, ...node }) => [node, ...flatten(children ?? [])]);
  async function upload(device) {
    const changes = device.ff.bookmarkChanges(device.cursor);
    device.cursor = changes.cursor;
    for (const node of changes.nodes) {
      if (node.deleted) deleted.set(node.id, node);
      else deleted.delete(node.id);
    }
    await replica.applyRemoteBookmarks(changes.nodes);
    device.ff.markUploaded(changes.cursor);
    return changes.nodes.length;
  }
  async function snapshot() {
    return [...flatten(await replica.browser.bookmarks.getTree()), ...deleted.values()];
  }
  return {
    attach(ff) { devices.push({ ff, cursor: 0 }); },
    async syncDevice(ff) {
      const device = devices.find(device => device.ff === ff);
      if (!device) throw new Error("Device is not attached");
      await ff.applyRemoteBookmarks(await snapshot(), { orderEvents });
      await ff.settle();
      await ff.sync.idle();
      return { uploaded: await upload(device) };
    },
    async syncAll() {
      let uploaded = 0;
      for (const device of devices) uploaded += await upload(device);
      const merged = await snapshot();
      for (const { ff } of devices) {
        await ff.applyRemoteBookmarks(merged, { orderEvents });
        await ff.settle();
        await ff.sync.idle();
      }
      return { uploaded };
    },
  };
}
