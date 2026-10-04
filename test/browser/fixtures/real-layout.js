export const realLayout = {
  clock: { x: 0, y: 0, w: 6, h: 4 }, pinned: { x: 0, y: 4, w: 6, h: 3 },
  "group:tbr": { x: 6, y: 0, w: 7, h: 9 }, "group:dev": { x: 13, y: 0, w: 7, h: 9 },
  "group:cov": { x: 20, y: 0, w: 7, h: 9 }, "group:oce": { x: 27, y: 0, w: 7, h: 9 },
  "group:harness": { x: 20, y: 9, w: 7, h: 8 }, "group:telemetry": { x: 27, y: 9, w: 7, h: 8 },
};
export const realGroups = ["tbr", "dev", "cov", "oce", "harness", "telemetry"]
  .map((title, i) => ({ id: i + 1, windowId: 1, title: title.toUpperCase(), color: "grey" }));
export const realFolders = Object.fromEntries(realGroups.map(g => [g.id, g.title.toLowerCase()]));
export const widthEntries = (k, layout = realLayout) => Object.fromEntries(Object.entries(layout).map(([id, r]) => [`tile:${k}:${id}`, r]));
