import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified, resolveMirrors } from "./download.ts";
import { type ExtractMethod, extractArchive, type Logger } from "./extract.ts";
import { exeName, zigTarget } from "./targets.ts";

export interface ReleaseTarget {
  tarball: string;
  shasum: string;
  size: number;
}

export interface Release {
  version: string;
  date: string;
  notes: string;
  publicKey: string;
  mirrorsSnapshotDate: string;
  mirrors: string[];
  targets: Record<string, ReleaseTarget>;
}

/**
 * The package directory: the nearest ancestor holding our package.json. This
 * works both when running the .ts sources (lib/) and the compiled output
 * (dist/lib/).
 */
function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@moreplease/zig") {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("@moreplease/zig: could not locate package root");
    }
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot();
export const release: Release = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "zig-release.json"), "utf8"),
);
export const INSTALL_DIR = path.join(PACKAGE_ROOT, "zig");
const MARKER = path.join(INSTALL_DIR, ".moreplease-zig.json");

export const ENV = {
  /** Absolute path to an existing `zig` binary to use instead of downloading. */
  binaryPath: "ZIG",
  /** "auto" (default), "tar" or "js": how to extract the archive. */
  extractor: "MOREPLEASE_ZIG_EXTRACTOR",
  /** Comma- or whitespace-separated mirror base URLs to use instead of the community list. */
  mirrors: "MOREPLEASE_ZIG_MIRRORS",
} as const;

interface Marker {
  version: string;
  target: string;
  shasum: string;
}

export function defaultLog(msg: string): void {
  process.stderr.write(`[@moreplease/zig] ${msg}\n`);
}

export function envBinaryPath(): string | null {
  const p = process.env[ENV.binaryPath];
  return p?.trim() ? path.resolve(p.trim()) : null;
}

export function installedBinaryPath(): string {
  return path.join(INSTALL_DIR, exeName());
}

export function targetInfo(): ReleaseTarget & { target: string } {
  const target = zigTarget();
  const info = target ? release.targets[target] : undefined;
  if (!target || !info) {
    const supported = Object.keys(release.targets).join(", ");
    throw new Error(
      `no prebuilt Zig ${release.version} for ${process.platform}-${process.arch}` +
        (target ? ` (${target})` : "") +
        `. Supported targets: ${supported}. ` +
        `Set ${ENV.binaryPath} to use a Zig binary you installed yourself.`,
    );
  }
  return { target, ...info };
}

export function isInstalled(): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(MARKER, "utf8")) as Marker;
    const info = targetInfo();
    return (
      marker.version === release.version &&
      marker.target === info.target &&
      marker.shasum === info.shasum &&
      fs.statSync(installedBinaryPath()).isFile()
    );
  } catch {
    return false;
  }
}

function checkBinary(bin: string): string {
  const r = spawnSync(bin, ["version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (r.error) {
    throw new Error(`could not run ${bin}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`${bin} version exited with ${r.status}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function extractMethod(): ExtractMethod {
  const v = process.env[ENV.extractor];
  if (v === "tar" || v === "js" || v === "auto") {
    return v;
  }
  if (v) {
    throw new Error(
      `${ENV.extractor} must be "auto", "tar" or "js", got "${v}"`,
    );
  }
  return "auto";
}

/**
 * Make sure the Zig binary for this package's pinned version is available and
 * return its absolute path. Downloads and verifies it on first use.
 */
export async function ensureZig({
  log = defaultLog,
}: {
  log?: Logger;
} = {}): Promise<string> {
  const override = envBinaryPath();
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`${ENV.binaryPath}=${override} does not exist`);
    }
    return override;
  }
  if (isInstalled()) {
    return installedBinaryPath();
  }

  const info = targetInfo();
  const fileName = path.posix.basename(new URL(info.tarball).pathname);
  const tmp = path.join(
    PACKAGE_ROOT,
    `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const archive = path.join(tmp, fileName);
    const mirrors = await resolveMirrors({
      snapshot: release.mirrors,
      override: process.env[ENV.mirrors],
      log,
    });
    await downloadVerified({
      fileName,
      officialUrl: info.tarball,
      shasum: info.shasum,
      size: info.size,
      mirrors,
      publicKey: release.publicKey,
      dest: archive,
      log,
    });

    const extracted = path.join(tmp, "zig");
    log(`extracting ${fileName}`);
    await extractArchive(archive, extracted, { method: extractMethod(), log });
    fs.rmSync(archive, { force: true });

    const bin = path.join(extracted, exeName());
    const reported = checkBinary(bin);
    if (reported !== release.version) {
      throw new Error(
        `extracted zig reports version "${reported}", expected "${release.version}"`,
      );
    }
    const marker: Marker = {
      version: release.version,
      target: info.target,
      shasum: info.shasum,
    };
    fs.writeFileSync(
      path.join(extracted, path.basename(MARKER)),
      JSON.stringify(marker, null, 2),
    );

    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    try {
      fs.renameSync(extracted, INSTALL_DIR);
    } catch (e) {
      if (!isInstalled()) {
        throw e;
      }
    }
    log(`installed Zig ${release.version} (${info.target}) to ${INSTALL_DIR}`);
    return installedBinaryPath();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
