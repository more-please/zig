#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { errorMessage } from "../lib/download.ts";
import { ensureZig } from "../lib/install.ts";

let bin: string;
try {
  bin = await ensureZig();
} catch (e) {
  process.stderr.write(`[@moreplease/zig] ${errorMessage(e)}\n`);
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true,
});
if (r.error) {
  process.stderr.write(
    `[@moreplease/zig] failed to run ${bin}: ${r.error.message}\n`,
  );
  process.exit(1);
}
if (r.signal) {
  process.kill(process.pid, r.signal);
}
process.exit(r.status ?? 1);
