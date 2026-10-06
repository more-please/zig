// npm/pnpm/yarn postinstall hook: download the Zig toolchain for this platform.
// If lifecycle scripts are disabled, the `zig` launcher downloads on first use.

import { errorMessage } from "./lib/download.ts";
import { defaultLog, ENV, ensureZig, envBinaryPath } from "./lib/install.ts";

if (envBinaryPath()) {
  defaultLog(`${ENV.binaryPath} is set; skipping download`);
} else {
  try {
    await ensureZig();
  } catch (e) {
    defaultLog(`install failed: ${errorMessage(e)}`);
    process.exit(1);
  }
}
