const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
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

export function dispatchDrag(type, target, { clientX = 0, clientY = 0, dataTransfer = null } = {}) {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY, dataTransfer });
  target.dispatchEvent(event);
  return event;
}

export function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// Used by run.html after all test modules have registered their tests.
export async function runTests() {
  const results = [];
  for (const { name, fn } of tests) {
    const fresh = document.createElement("div");
    fresh.id = "fixture";
    fixture().replaceWith(fresh);
    try {
      await fn();
      results.push({ name, ok: true, error: "" });
    } catch (error) {
      results.push({ name, ok: false,
        error: error?.stack ? `${String(error)}\n${error.stack}` : String(error) });
    }
  }
  return results;
}
