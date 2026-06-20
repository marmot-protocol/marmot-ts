// Validates clean shutdown end-to-end. Mirrors what index.tsx does: install
// timer tracking, build + start the controller, stop it, then unref the residual
// background timers. With NO forced process.exit(), a clean exit proves the fix:
// the event loop drains on its own. A hang (timeout) proves a leak remains.
//
//   bun run scripts/probe-shutdown.ts
import {
  installTimerTracking,
  unrefBackgroundTimers,
} from "../src/helpers/timers.js";
import { createController, parseArgs } from "../src/marmot/setup.js";

installTimerTracking();

const opts = parseArgs(["--ephemeral"]);
const controller = await createController(opts, () => {});
await controller.start();
await new Promise((r) => setTimeout(r, 2500));

controller.stop();
unrefBackgroundTimers();

console.error(
  "teardown complete — if this process now exits on its own, shutdown is clean.",
);
// Intentionally NO process.exit(): the loop must drain by itself.
