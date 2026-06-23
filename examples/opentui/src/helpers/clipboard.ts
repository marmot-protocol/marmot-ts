import { spawn } from "node:child_process";

/**
 * Copy text to the system clipboard by shelling out to the platform's clipboard
 * tool. There is no portable clipboard API in a terminal, so we pick the command
 * by platform — `pbcopy` on macOS, `clip` on Windows, and the first available of
 * `wl-copy`/`xclip`/`xsel` on Linux (Wayland first, then X11).
 *
 * Returns `true` once the text was handed to a clipboard tool that exited
 * cleanly, `false` if no tool was found or the copy failed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: string[][] =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [
            ["wl-copy"],
            ["xclip", "-selection", "clipboard"],
            ["xsel", "--clipboard", "--input"],
          ];

  for (const [cmd, ...args] of candidates) {
    if (await tryCopy(cmd, args, text)) return true;
  }
  return false;
}

function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    // Tool missing from PATH, or it died before we finished writing stdin.
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
    child.stdin.on("error", () => done(false));
    child.stdin.end(text);
  });
}
