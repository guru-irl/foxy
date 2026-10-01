const tests = [];

export function test(name, fn, { timeout = 5000 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("test timeout must be a positive number");
  tests.push({ name, fn, timeout });
}

function describe(value) {
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function same(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  if (Array.isArray(actual) && actual.length !== expected.length) return false;
  const a = Object.keys(actual).sort(), b = Object.keys(expected).sort();
  return a.length === b.length && a.every((key, index) =>
    key === b[index] && same(actual[key], expected[key]));
}

export const assert = {
  ok(value, message = "expected a truthy value") {
    if (!value) throw new Error(message);
  },
  equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      throw new Error(message ?? `expected ${describe(expected)}, got ${describe(actual)}`);
    }
  },
  deepEqual(actual, expected, message) {
    if (!same(actual, expected)) {
      throw new Error(message ?? `expected ${describe(expected)}, got ${describe(actual)}`);
    }
  },
  async rejects(operation, expected) {
    try {
      await (typeof operation === "function" ? operation() : operation);
    } catch (error) {
      const message = error?.message ?? String(error);
      if (expected instanceof RegExp) assert.ok(expected.test(message), `unexpected rejection: ${message}`);
      else if (typeof expected === "function") assert.ok(error instanceof expected, `unexpected rejection: ${message}`);
      else if (expected?.message instanceof RegExp) assert.ok(expected.message.test(message), `unexpected rejection: ${message}`);
      else if (expected?.message !== undefined) assert.equal(message, expected.message);
      return error;
    }
    throw new Error("expected a rejection, but the operation resolved");
  },
};

export function fixture() {
  let element = document.getElementById("fixture");
  if (!element) {
    element = document.createElement("div");
    element.id = "fixture";
    document.body.append(element);
  }
  return element;
}

// Page-created DataTransfer stays readable during dragover; real drags hide data.
// Drag/drop acceptance must therefore use dataTransfer.types, not getData().
export function dispatchDrag(type, target, { dataTransfer = new DataTransfer(), ...options } = {}) {
  const event = new DragEvent(type, { ...options, bubbles: true, cancelable: true, dataTransfer });
  target.dispatchEvent(event);
  return event;
}

// Inactive headless Firefox does not expose trusted hover/focus-visible from
// synthetic events. Substitute equal-specificity classes in the real rules.
export function withPseudoState(elements, pseudo, check) {
  const sheet = [...document.styleSheets].find(sheet => sheet.href?.endsWith("/extension/newtab.css"));
  const rules = [...sheet.cssRules].filter(rule => rule.selectorText?.includes(`:${pseudo}`));
  const selectors = rules.map(rule => rule.selectorText);
  const className = `test-${pseudo}`;
  try {
    rules.forEach(rule => { rule.selectorText = rule.selectorText.replaceAll(`:${pseudo}`, `.${className}`); });
    elements.forEach(element => element.classList.add(className));
    check();
  } finally {
    rules.forEach((rule, index) => { rule.selectorText = selectors[index]; });
    elements.forEach(element => element.classList.remove(className));
  }
}

export function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// Used by run.html after all test modules have registered their tests.
// Only #fixture is reset; document/window listeners and body-appended nodes carry over.
// A timeout cannot cancel the test's promises/timers; tests must clean those up themselves.
export async function runTests({ state = { results: [], active: null }, onStart = () => {} } = {}) {
  const results = state.results;
  for (const { name, fn, timeout } of tests) {
    const fresh = document.createElement("div");
    fresh.id = "fixture";
    fixture().replaceWith(fresh);
    let timer;
    let uncaught;
    let active;
    let finished = false;
    let failed = false;
    const eventFailure = new Promise((resolve, reject) => {
      active = { fail(error) { uncaught ??= error; reject(error); } };
    });
    try {
      await Promise.race([
        Promise.resolve().then(async () => {
          await onStart(name);
          if (finished) return;
          state.active = active;
          await fn();
          // Firefox queues rejection reporting separately from timer tasks.
          // Keep attribution through a frame and the following event turn.
          await nextFrame();
          await new Promise(resolve => setTimeout(resolve, 0));
        }),
        eventFailure,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), timeout);
        }),
      ]);
      results.push({ name, ok: true, error: "" });
    } catch (error) {
      failed = true;
      error = uncaught ?? error;
      results.push({ name, ok: false,
        error: error?.stack ? `${String(error)}\n${error.stack}` : String(error) });
    } finally {
      finished = true;
      clearTimeout(timer);
      // A rejected race may finish before queued error events from that test.
      if (failed) await new Promise(resolve => setTimeout(resolve, 0));
      state.active = null;
    }
  }
  return results;
}
