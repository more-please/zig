#!/usr/bin/env node
import {
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
/**
 * End-to-end test: pack this package, install it into a scratch project with
 * real package managers, and check that `zig version` works. Needs network.
 *
 *   node scripts/integration-test.ts            # all scenarios
 *   node scripts/integration-test.ts npm        # only scenarios matching "npm"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Release } from "../lib/install.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const release = JSON.parse(
  fs.readFileSync(path.join(root, "zig-release.json"), "utf8"),
) as Release;
const filter = process.argv[2] ?? "";
const win = process.platform === "win32";

type Env = NodeJS.ProcessEnv;

function sh(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string> {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: win,
    windowsHide: true,
    ...opts,
  }) as SpawnSyncReturns<string>;
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r;
}
function have(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], {
    stdio: "ignore",
    shell: win,
    windowsHide: true,
  });
  return !r.error && r.status === 0;
}

// 1. Pack
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "moreplease-zig-pack-"));
const packer = have("pnpm") ? "pnpm" : "npm";
sh(packer, ["pack", "--pack-destination", packDir], { cwd: root });
const tgzName = fs.readdirSync(packDir).find((f) => f.endsWith(".tgz"));
if (!tgzName) {
  throw new Error("pack produced no tarball");
}
const tgz = path.join(packDir, tgzName);
console.log(`packed ${tgz} with ${packer}`);

interface Scenario {
  name: string;
  pm: "npm" | "pnpm";
  setup?: (dir: string) => void;
  install: string[];
  env?: Record<string, string>;
  expectInstalledAfterInstall: boolean;
  check?: (dir: string, env: Env) => void;
}

const scenarios: Scenario[] = [
  {
    name: "npm: postinstall downloads, system extractor",
    pm: "npm",
    install: ["install", "--no-audit", "--no-fund", tgz],
    expectInstalledAfterInstall: true,
  },
  {
    name: "npm --ignore-scripts: lazy download on first run, JS extractor",
    pm: "npm",
    install: ["install", "--no-audit", "--no-fund", "--ignore-scripts", tgz],
    env: { MOREPLEASE_ZIG_EXTRACTOR: "js" },
    expectInstalledAfterInstall: false,
  },
  {
    name: "pnpm: approved build script",
    pm: "pnpm",
    setup: (dir) => {
      // pnpm keys build approvals for file: dependencies by their full id, so
      // copy the tarball in and approve that id. Registry installs are keyed
      // by the bare package name (see README).
      fs.copyFileSync(tgz, path.join(dir, "zig.tgz"));
      fs.writeFileSync(
        path.join(dir, "pnpm-workspace.yaml"),
        "allowBuilds:\n  '@moreplease/zig@file:zig.tgz': true\n",
      );
      const pkg = {
        name: "it",
        private: true,
        type: "module",
        dependencies: { "@moreplease/zig": "file:./zig.tgz" },
      };
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    },
    install: ["install"],
    expectInstalledAfterInstall: true,
  },
  {
    name: "ZIG override skips download",
    pm: "npm",
    install: ["install", "--no-audit", "--no-fund", tgz],
    env: { ZIG: process.execPath }, // any executable will do: we only check it is used
    expectInstalledAfterInstall: false,
    check: (dir, env) => {
      const r = sh(
        "node",
        [
          "-e",
          "import('@moreplease/zig').then(async m => console.log(await m.ensureZig()))",
        ],
        { cwd: dir, env },
      );
      if (r.stdout.trim() !== process.execPath) {
        throw new Error(`expected override path, got ${r.stdout}`);
      }
    },
  },
];

let failed = 0;
for (const s of scenarios) {
  if (filter && !s.name.includes(filter)) {
    continue;
  }
  if (!have(s.pm)) {
    console.log(`SKIP ${s.name} (${s.pm} not available)`);
    continue;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moreplease-zig-it-"));
  const env: Env = { ...process.env, ...s.env };
  const started = Date.now();
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "it", private: true, type: "module" }),
    );
    s.setup?.(dir);
    sh(s.pm, s.install, { cwd: dir, env });
    const pkgDir = path.join(dir, "node_modules", "@moreplease", "zig");
    const installed = fs.existsSync(
      path.join(fs.realpathSync(pkgDir), "zig", win ? "zig.exe" : "zig"),
    );
    if (installed !== s.expectInstalledAfterInstall) {
      throw new Error(
        `expected installed=${s.expectInstalledAfterInstall} after install, got ${installed}`,
      );
    }
    if (s.check) {
      s.check(dir, env);
    } else {
      const bin = path.join(
        dir,
        "node_modules",
        ".bin",
        win ? "zig.cmd" : "zig",
      );
      const r = sh(bin, ["version"], { cwd: dir, env });
      if (r.stdout.trim() !== release.version) {
        throw new Error(
          `zig version printed "${r.stdout.trim()}", expected ${release.version}`,
        );
      }
      const api = sh(
        "node",
        [
          "-e",
          "import('@moreplease/zig').then(async m => console.log(m.version, m.isInstalled(), await m.ensureZig()))",
        ],
        { cwd: dir, env },
      );
      if (!api.stdout.startsWith(`${release.version} true `)) {
        throw new Error(`unexpected API output: ${api.stdout}`);
      }
      const r2 = sh(bin, ["version"], { cwd: dir, env }); // second run: already installed
      if (r2.stdout.trim() !== release.version) {
        throw new Error("second run failed");
      }
    }
    console.log(
      `PASS ${s.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
  } catch (e) {
    failed++;
    console.log(
      `FAIL ${s.name}\n${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
fs.rmSync(packDir, { recursive: true, force: true });
if (failed) {
  process.exit(1);
}
