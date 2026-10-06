// npm/pnpm/yarn postinstall hook: download the Zig toolchain for this platform.
// If lifecycle scripts are disabled, the `zig` launcher downloads on first use.
// The same lazy path covers a failure here, so a download problem (offline,
// firewalled) is reported as a warning rather than failing the whole install.

import { errorMessage } from "./lib/download.ts";
import { defaultLog, ENV, ensureZig, envBinaryPath } from "./lib/install.ts";

if (envBinaryPath()) {
  defaultLog(`${ENV.binaryPath} is set; skipping download`);
} else {
  try {
    await ensureZig();
  } catch (e) {
    defaultLog(`warning: could not install Zig now (${errorMessage(e)})`);
    defaultLog("the download will be retried the first time `zig` is run");
  }
}
