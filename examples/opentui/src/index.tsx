import { useCallback, useRef, useState } from "react";

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./components/App.js";
import { MarmotProvider } from "./hooks/use-marmot.js";
import { redirectDebugToFile, type LogFile } from "./marmot/logging.js";
import type { MarmotController } from "./marmot/controller.js";
import {
  createController,
  HELP_TEXT,
  parseArgs,
  wantsHelp,
  type CliOptions,
} from "./marmot/setup.js";

/**
 * Owns the live {@link MarmotController} and swaps it out when the user logs out
 * and starts a fresh account. Building a new controller wipes the old account's
 * local state (see {@link createController}'s `fresh` flag), so we remount
 * {@link App} via a changing `key` to clear its per-account UI state, and hand
 * the new controller back to `onController` so process-level cleanup stops the
 * right one.
 */
function Root(props: {
  initial: MarmotController;
  opts: CliOptions;
  logFile?: LogFile;
  onQuit: () => void;
  onController: (controller: MarmotController) => void;
}) {
  const [controller, setController] = useState(props.initial);
  const [generation, setGeneration] = useState(0);
  const switching = useRef(false);

  const handleLogout = useCallback(
    (params: { name: string; relays: string[] }) => {
      if (switching.current) return;
      switching.current = true;
      const previous = controller;
      void (async () => {
        try {
          previous.stop();
          const next = await createController(
            props.opts,
            (line) => props.logFile?.status(line),
            params,
          );
          props.onController(next);
          setController(next);
          setGeneration((value) => value + 1);
        } finally {
          switching.current = false;
        }
      })();
    },
    [controller, props],
  );

  return (
    <MarmotProvider controller={controller}>
      <App key={generation} onQuit={props.onQuit} onLogout={handleLogout} />
    </MarmotProvider>
  );
}

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
  const initial = await createController(opts, (line) => logFile?.status(line));

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);

  // Tracks the controller currently mounted by <Root> so teardown stops the
  // live one even after the user has logged into a fresh account.
  let live = initial;

  let stopped = false;
  const quit = (): void => {
    if (stopped) return;
    stopped = true;
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    root.unmount();
    renderer.destroy();
    // stop() disposes the EventStore (and its loader) and closes the relay pool,
    // so applesauce leaves no JS timers holding the loop open. But opentui's
    // native (Zig) renderer keeps a handle alive that renderer.destroy() does
    // not fully release under Bun — with the full UI mounted it pins the process
    // for ~15-18s after teardown even though no JS timer or libuv handle remains.
    // All our own teardown above is synchronous and complete here, so exit
    // explicitly rather than waiting on a loop that won't drain on its own.
    live.stop();
    logFile?.close();
    process.exit(0);
  };
  process.on("exit", () => {
    if (!stopped) {
      root.unmount();
      renderer.destroy();
      live.stop();
    }
    logFile?.close();
  });
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  root.render(
    <Root
      initial={initial}
      opts={opts}
      logFile={logFile}
      onQuit={quit}
      onController={(controller) => {
        live = controller;
      }}
    />,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
