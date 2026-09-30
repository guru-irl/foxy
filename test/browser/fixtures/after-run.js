import { test } from "../harness.js";

const name = "schedules an error after its completion";
test(name, () => {});

// Runner-level fixture: wait for completion rather than assuming timer ordering.
const state = window.__browserTestState;
function afterCompletion() {
  if (state?.active !== null || !state?.results.some(result => result.name === name)) {
    setTimeout(afterCompletion, 0);
    return;
  }
  throw new Error("after run exploded");
}
setTimeout(afterCompletion, 0);
