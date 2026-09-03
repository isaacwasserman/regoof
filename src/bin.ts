#!/usr/bin/env node

import { run } from "@stricli/core";
import { extractGlobalOptions } from "./global-options.js";
import { app, type RegoofContext } from "./index.js";

try {
  const { cacheMode, commandInputs, projectPath } = extractGlobalOptions(process.argv.slice(2));
  const context: RegoofContext = { process, cacheMode, projectPath };
  await run(app, commandInputs, context);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`regoof: ${message}\n`);
  process.exitCode = 1;
}
