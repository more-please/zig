import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `moreplease-zig-${prefix}-`));
}

export function haveCommand(
  cmd: string,
  args: string[] = ["--version"],
): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
  return !r.error && r.status === 0;
}

export function run(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): string {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${r.status}):\n${String(r.stderr)}`,
    );
  }
  return String(r.stdout);
}

/** Deterministic pseudo-random bytes (xorshift), so fixtures are stable. */
export function pseudoRandom(n: number, seed = 0x12345678): Buffer {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** Hash every file in a tree, for comparing extraction results. */
export function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(root, r));
      if (st.isDirectory()) {
        out[`${r}/`] = "dir";
        walk(r);
      } else if (st.isSymbolicLink()) {
        out[r] = `link:${fs.readlinkSync(path.join(root, r))}`;
      } else {
        const exec =
          process.platform === "win32" ? "" : st.mode & 0o111 ? ":x" : "";
        out[r] =
          fs.readFileSync(path.join(root, r)).toString("hex").slice(0, 64) +
          ":" +
          st.size +
          exec;
      }
    }
  };
  walk("");
  return out;
}
