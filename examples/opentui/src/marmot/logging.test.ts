import { expect, test } from "bun:test";
import { getLoggerNamespaces, getLoggerSink, logger } from "applesauce-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redirectDebugToFile } from "./logging.js";

test("file logging captures Applesauce v7 logs and restores the logger on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marmot-logging-"));
  const previousSink = getLoggerSink();
  const previousNamespaces = getLoggerNamespaces();
  const file = redirectDebugToFile(join(directory, "debug.log"));
  try {
    logger.extend("upgrade-test")("relay diagnostics");
    file.close();
    expect(getLoggerSink()).toBe(previousSink);
    expect(getLoggerNamespaces()).toBe(previousNamespaces);
    // WriteStream.end() flushes asynchronously.
    let content = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      content = await readFile(file.path, "utf8").catch(() => "");
      if (content.includes("relay diagnostics")) break;
      await Bun.sleep(1);
    }
    expect(content).toContain("applesauce:upgrade-test");
    expect(content).toContain("relay diagnostics");
  } finally {
    file.close();
    await rm(directory, { recursive: true, force: true });
  }
});
