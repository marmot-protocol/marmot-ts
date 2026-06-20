// Validates clean shutdown end-to-end. Mirrors what index.tsx does: build +
// start the controller, then stop it. stop() disposes the EventStore (and its
// attached event loader) and closes the relay pool, so applesauce leaves no
// background timers running. With NO forced process.exit(), a clean exit proves
// the teardown is complete: the event loop drains on its own. A hang (timeout)
// proves a leak remains.
//
//   bun run scripts/probe-shutdown.ts
import { createController, parseArgs } from "../src/marmot/setup.js";

const opts = parseArgs(["--ephemeral"]);
const controller = await createController(opts, () => {});
await controller.start();
await new Promise((r) => setTimeout(r, 2500));

controller.stop();

console.error(
  "teardown complete — if this process now exits on its own, shutdown is clean.",
);
// Intentionally NO process.exit(): the loop must drain by itself.
