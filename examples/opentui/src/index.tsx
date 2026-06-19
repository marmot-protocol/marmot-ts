import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./components/App.js";
import { MarmotProvider } from "./hooks/use-marmot.js";
import { redirectDebugToFile, type LogFile } from "./marmot/logging.js";
import {
  createController,
  HELP_TEXT,
  parseArgs,
  wantsHelp,
} from "./marmot/setup.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(HELP_TEXT);
    return;
  }

  const opts = parseArgs(argv);
  let logFile: LogFile | undefined;
  if (opts.logsPath) logFile = redirectDebugToFile(opts.logsPath);

  // Run network discovery before the renderer takes over the terminal.
  const controller = await createController(opts, (line) =>
    logFile?.status(line),
  );

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);

  let stopped = false;
  const quit = (): void => {
    if (stopped) return;
    stopped = true;
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    root.unmount();
    renderer.destroy();
    controller.stop();
    logFile?.close();
    process.exitCode = 0;
  };
  process.on("exit", () => {
    if (!stopped) {
      root.unmount();
      renderer.destroy();
      controller.stop();
    }
    logFile?.close();
  });
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  root.render(
    <MarmotProvider controller={controller}>
      <App onQuit={quit} />
    </MarmotProvider>,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
