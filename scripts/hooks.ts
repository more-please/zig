#!/usr/bin/env node
/**
 * Make git run hooks from .githooks/ by setting core.hooksPath. Runs from
 * `prepare`, so it must be a no-op when there is no .git directory (e.g.
 * installing from a tarball, or a CI checkout made without git) or no git.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (fs.existsSync(path.join(root, ".git"))) {
  const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error?.code !== "ENOENT" && r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}
