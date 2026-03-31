#!/usr/bin/env node

import { runCli } from "./cli/app.js";
import { formatError } from "./utils/format.js";
import { getErrorMessage } from "./utils/errors.js";

void runCli().catch((error) => {
  const message = getErrorMessage(error);
  if (message.toLowerCase().includes("readline was closed")) {
    process.exitCode = 0;
    return;
  }

  console.error(formatError(message));
  process.exitCode = 1;
});
