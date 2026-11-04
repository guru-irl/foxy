export const realGroups = ["tbr", "dev", "cov", "oce", "harness", "telemetry"]
  .map((title, i) => ({ id: i + 1, windowId: 1, title: title.toUpperCase(), color: "grey" }));
