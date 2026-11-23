#!/usr/bin/env node
import { inventory, parseArgs, runCampaign } from "./runner.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: pnpm conformance [options]
  --list                 List runnable cases and unimplemented upstream vectors
  --case <id>            Select a scenario (repeatable); default: complete suite
  --repeat <count>       Fresh-process repetitions; default: 1
  --timeout-ms <ms>      Deadline per worker, including startup; default: 120000
  --out <directory>      New evidence directory; existing directories are refused
  --help                 Show this help`);
  } else if (options.list) {
    console.log(JSON.stringify(await inventory(), null, 2));
  } else {
    const summary = await runCampaign(options);
    process.exitCode = summary.status === "passed" ? 0 : 1;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
