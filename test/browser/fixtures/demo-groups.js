export const demoGroups = ["reading", "work", "travel", "recipes", "research", "side project"]
  .map((title, i) => ({ id: i + 1, windowId: 1, title: title.toUpperCase(), color: ["blue", "green", "orange", "red", "purple", "cyan"][i] }));
