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
  const quit = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    root.unmount();
    renderer.destroy();
    // Ship the final audit log before tearing the controller down. A no-op
    // unless --audit-upload is set; the recorder appends synchronously, so the
    // file on disk is already complete here. Best-effort — failures are logged
    // and swallowed inside uploadAuditLog(), so a dead tracker never blocks quit
    // beyond the request timeout.
    await controller.uploadAuditLog();
    // stop() disposes the EventStore (and its loader) and closes the relay pool,
    // so applesauce leaves no JS timers holding the loop open. But opentui's
    // native (Zig) renderer keeps a handle alive that renderer.destroy() does
    // not fully release under Bun — with the full UI mounted it pins the process
    // for ~15-18s after teardown even though no JS timer or libuv handle remains.
    // All our own teardown above is synchronous and complete here, so exit
    // explicitly rather than waiting on a loop that won't drain on its own.
    controller.stop();
    logFile?.close();
    process.exit(0);
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
