import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TarExtractor } from "./tar.ts";
import { XzDecoder } from "./xz.ts";
import { extractZip } from "./zip.ts";

export type ExtractMethod = "auto" | "tar" | "js";
export type Logger = (message: string) => void;

/**
 * Extract a Zig release archive (.tar.xz or .zip) into `dest`, dropping the
 * archive's single top-level directory. Returns the method that was used.
 *
 * Strategy: try the system `tar` first (bsdtar on macOS and Windows handles
 * both formats; GNU tar on Linux needs `xz` installed). If that fails for any
 * reason, fall back to the bundled pure-JS extractor, which is slower but has
 * no external requirements. `method` can force one or the other.
 */
export async function extractArchive(
  archive: string,
  dest: string,
  {
    method = "auto",
    log = () => {},
  }: { method?: ExtractMethod; log?: Logger } = {},
): Promise<"tar" | "js"> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (method === "auto" || method === "tar") {
    const result = extractWithSystemTar(archive, dest);
    if (result.ok) {
      return "tar";
    }
    if (method === "tar") {
      throw new Error(`system tar failed: ${result.reason}`);
    }
    log(`system tar unavailable (${result.reason}); using built-in extractor`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
  }
  await extractWithJs(archive, dest);
  return "js";
}

function extractWithSystemTar(
  archive: string,
  dest: string,
): { ok: true } | { ok: false; reason: string } {
  const r = spawnSync(
    "tar",
    ["-xf", archive, "-C", dest, "--strip-components=1"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      timeout: 15 * 60 * 1000,
    },
  );
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" ? "tar not found" : r.error.message,
    };
  }
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim().split("\n").at(-1) ?? "";
    return {
      ok: false,
      reason: `exit ${r.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  return { ok: true };
}

export async function extractWithJs(
  archive: string,
  dest: string,
): Promise<void> {
  if (archive.endsWith(".zip")) {
    await extractZip(archive, dest, { strip: 1 });
    return;
  }
  if (!archive.endsWith(".tar.xz")) {
    throw new Error(`unsupported archive type: ${path.basename(archive)}`);
  }
  const tar = new TarExtractor(dest, { strip: 1 });
  const xz = new XzDecoder((chunk) => tar.write(chunk));
  for await (const chunk of fs.createReadStream(archive, {
    highWaterMark: 1 << 20,
  })) {
    xz.write(chunk as Buffer);
  }
  xz.end();
  tar.end();
}
