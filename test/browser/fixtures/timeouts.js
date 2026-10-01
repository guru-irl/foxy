import { test } from "../harness.js";

test("overridden hanging test", () => new Promise(() => {}), { timeout: 30 });
test("default hanging test", () => new Promise(() => {}));
test("tests continue after timeouts", () => {});
