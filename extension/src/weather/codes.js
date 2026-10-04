// WMO weather interpretation codes (as used by Open-Meteo) to a label and an
// in-house line glyph. Glyphs are drawn on a 24 x 24 grid with a neutral
// stroke; elements marked `accent` take a small colour (sun core, rain, bolt).

const LABELS = new Map([
  [0, "Clear"], [1, "Mainly clear"], [2, "Partly cloudy"], [3, "Overcast"],
  [45, "Fog"], [48, "Fog"],
  [51, "Light drizzle"], [53, "Drizzle"], [55, "Heavy drizzle"], [56, "Freezing drizzle"], [57, "Freezing drizzle"],
  [61, "Light rain"], [63, "Rain"], [65, "Heavy rain"], [66, "Freezing rain"], [67, "Freezing rain"],
  [71, "Light snow"], [73, "Snow"], [75, "Heavy snow"], [77, "Snow grains"],
  [80, "Light showers"], [81, "Showers"], [82, "Heavy showers"], [85, "Snow showers"], [86, "Snow showers"],
  [95, "Thunderstorm"], [96, "Thunderstorm, hail"], [99, "Thunderstorm, hail"],
]);

function glyphFor(code, isDay) {
  if (code === 0) return isDay ? "clear-day" : "clear-night";
  if (code === 1 || code === 2) return isDay ? "partly-day" : "partly-night";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code >= 95 && code <= 99) return "thunder";
  return "cloudy";
}

export function condition(code, isDay = true) {
  return LABELS.has(code) ? { label: LABELS.get(code), glyph: glyphFor(code, isDay) } : { label: "Unknown", glyph: "cloudy" };
}

const CLOUD = "M7 19a4 4 0 0 1-.6-7.95A5.75 5.75 0 0 1 17.45 9.6 4.75 4.75 0 0 1 17 19z";
const CLOUD_HIGH = "M7 16a4 4 0 0 1-.6-7.95A5.75 5.75 0 0 1 17.45 6.6 4.75 4.75 0 0 1 17 16z";
const SMALL_CLOUD = "M9 20a3.5 3.5 0 0 1-.5-6.96A5 5 0 0 1 18.1 12.1 4 4 0 0 1 18 20z";
const SHOWER_CLOUD = "M9 16a3.5 3.5 0 0 1-.5-6.96A5 5 0 0 1 18.1 8.1 4 4 0 0 1 18 16z";
const rays = (cx, cy, inner, outer, angles) => angles.map(degrees => {
  const r = degrees * Math.PI / 180, f = n => Math.round(n * 100) / 100;
  return ["line", { x1: f(cx + inner * Math.cos(r)), y1: f(cy + inner * Math.sin(r)),
    x2: f(cx + outer * Math.cos(r)), y2: f(cy + outer * Math.sin(r)) }];
});
const sun = ["circle", { cx: 12, cy: 12, r: 4, accent: "sun" }];
const MOON = "M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5 7.5 7.5 0 1 0 19.5 14.6z";
const SMALL_MOON = "M13.4 8.9A4.6 4.6 0 0 1 7.6 3.1 4.6 4.6 0 1 0 13.4 8.9z";
const drops = points => points.map(([x, y]) => ["line", { x1: x, y1: y, x2: x - 1, y2: y + 2.6, accent: "rain" }]);

const flake = (cx, cy) => [0, 60, 120].map(degrees => {
  const r = degrees * Math.PI / 180, f = n => Math.round(n * 100) / 100, dx = 1.4 * Math.cos(r), dy = 1.4 * Math.sin(r);
  return ["line", { x1: f(cx - dx), y1: f(cy - dy), x2: f(cx + dx), y2: f(cy + dy) }];
});
const behind = ([tag, attributes]) => [tag, { ...attributes, behind: true }];

/**
 * Element lists per glyph: [tag, attributes]. A `cutout` entry is not drawn:
 * it hides the parts of `behind` elements (sun, moon) that the cloud covers.
 */
export const GLYPHS = {
  "clear-day": [sun, ...rays(12, 12, 6.5, 9, [0, 45, 90, 135, 180, 225, 270, 315])],
  "clear-night": [["path", { d: MOON }]],
  "partly-day": [["cutout", { d: SMALL_CLOUD }], behind(["circle", { cx: 8, cy: 7.5, r: 2.6, accent: "sun" }]),
    ...rays(8, 7.5, 4.6, 6.2, [180, 225, 270, 315]).map(behind), ["path", { d: SMALL_CLOUD }]],
  "partly-night": [["cutout", { d: SMALL_CLOUD }], behind(["path", { d: SMALL_MOON }]), ["path", { d: SMALL_CLOUD }]],
  cloudy: [["path", { d: CLOUD }]],
  fog: [["line", { x1: 4, y1: 9, x2: 20, y2: 9 }], ["line", { x1: 2.5, y1: 13, x2: 17.5, y2: 13 }],
    ["line", { x1: 6.5, y1: 17, x2: 21.5, y2: 17 }]],
  drizzle: [["path", { d: CLOUD_HIGH }], ...[[9, 19.5], [13, 21], [17, 19.5]].map(([cx, cy]) =>
    ["circle", { cx, cy, r: 0.9, accent: "rain", fill: true }])],
  rain: [["path", { d: CLOUD_HIGH }], ...drops([[9, 18.6], [13, 18.6], [17, 18.6]])],
  showers: [["cutout", { d: SHOWER_CLOUD }], behind(["circle", { cx: 7.5, cy: 5.5, r: 2.4, accent: "sun" }]),
    ...rays(7.5, 5.5, 4.3, 5.8, [180, 225, 270]).map(behind), ["path", { d: SHOWER_CLOUD }], ...drops([[11.5, 18.6], [15.5, 18.6]])],
  snow: [["path", { d: CLOUD_HIGH }], ...flake(9, 19.6), ...flake(13, 21.2), ...flake(17, 19.6)],
  thunder: [["path", { d: CLOUD_HIGH }], ["path", { d: "M13 15.5l-2.6 4h3.2l-2 3.5", accent: "bolt" }]],
};
