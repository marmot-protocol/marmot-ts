import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./components/App.js";
import { MarmotProvider } from "./hooks/use-marmot.js";
import { createController, parseArgs } from "./marmot/setup.js";

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Run network discovery before the renderer takes over the terminal.
  const controller = await createController(opts, (line) => console.log(line));

  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  let stopped = false;
  const quit = (): void => {
    if (stopped) return;
    stopped = true;
    controller.stop();
    process.exit(0);
  };
  process.on("exit", () => {
    if (!stopped) controller.stop();
  });
  process.on("SIGINT", quit);

  createRoot(renderer).render(
    <MarmotProvider controller={controller}>
      <App onQuit={quit} />
    </MarmotProvider>,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
