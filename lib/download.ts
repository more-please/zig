import crypto from "node:crypto";
import fs from "node:fs";
import type { Logger } from "./extract.ts";
import { parsePublicKey, parseSignature, verify } from "./minisign.ts";

const MIRROR_LIST_URL = "https://ziglang.org/download/community-mirrors.txt";
const SOURCE_TAG = "moreplease-zig";
const HEADER_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;

function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function requestInit(signal: AbortSignal): RequestInit {
  return {
    redirect: "follow",
    signal,
    headers: {
      "user-agent": `${SOURCE_TAG} (+https://www.npmjs.com/package/@moreplease/zig)`,
    },
  };
}

function checkOk(res: Response, url: string): Response {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res;
}

/** Fetch a small text resource, with `ms` as the limit for the whole request. */
async function fetchText(url: string, ms = HEADER_TIMEOUT_MS): Promise<string> {
  const res = await fetch(url, requestInit(AbortSignal.timeout(ms)));
  return checkOk(res, url).text();
}

/**
 * Start a request, giving up if the response headers do not arrive within
 * `ms`. The timer is cleared once they do: an AbortSignal that stayed armed
 * would also abort the body stream, so a large but healthy download would
 * fail after `ms` regardless of progress. The caller is responsible for an
 * idle timeout while reading the body.
 */
async function fetchHeaders(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("response headers timed out", "TimeoutError"),
      ),
    ms,
  );
  try {
    return checkOk(await fetch(url, requestInit(controller.signal)), url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the list of download mirrors: an explicit override, else the live
 * community list from ziglang.org, else the snapshot baked into the package.
 */
export async function resolveMirrors({
  snapshot,
  override,
  log,
}: {
  snapshot: readonly string[];
  override?: string | undefined;
  log: Logger;
}): Promise<string[]> {
  if (override) {
    return override
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  try {
    const text = await fetchText(MIRROR_LIST_URL, 10_000);
    const list = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^https:\/\//.test(l));
    if (list.length) {
      return shuffle(list);
    }
    throw new Error("empty list");
  } catch (e) {
    log(
      `could not fetch mirror list (${errorMessage(e)}); using bundled snapshot`,
    );
    return shuffle(snapshot);
  }
}

interface Downloaded {
  size: number;
  sha256: string;
  blake2b512: Buffer;
}

/**
 * Stream `url` to `dest`, hashing as we go. Enforces an idle timeout so a
 * stalled mirror cannot hang the install, and an expected size so a bad
 * mirror is abandoned early.
 */
async function downloadFile(
  url: string,
  dest: string,
  {
    expectedSize,
    onProgress,
    headerTimeoutMs = HEADER_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  }: {
    expectedSize?: number;
    onProgress?: ((received: number) => void) | undefined;
    headerTimeoutMs?: number | undefined;
    idleTimeoutMs?: number | undefined;
  },
): Promise<Downloaded> {
  const res = await fetchHeaders(url, headerTimeoutMs);
  const declared = Number(res.headers.get("content-length"));
  if (declared && expectedSize && declared !== expectedSize) {
    throw new Error(
      `unexpected content-length ${declared} (expected ${expectedSize})`,
    );
  }
  if (!res.body) {
    throw new Error("empty response body");
  }
  const sha256 = crypto.createHash("sha256");
  const blake2b = crypto.createHash("blake2b512");
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("download stalled")),
          idleTimeoutMs,
        );
      });
      const { done, value } = await Promise.race([reader.read(), idle]).finally(
        () => clearTimeout(timer),
      );
      if (done) {
        break;
      }
      received += value.length;
      if (expectedSize && received > expectedSize) {
        throw new Error("download larger than expected");
      }
      sha256.update(value);
      blake2b.update(value);
      if (!out.write(value)) {
        await new Promise((r) => out.once("drain", r));
      }
      onProgress?.(received);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
  }
  if (expectedSize && received !== expectedSize) {
    throw new Error(`download truncated: ${received} of ${expectedSize} bytes`);
  }
  return {
    size: received,
    sha256: sha256.digest("hex"),
    blake2b512: blake2b.digest(),
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.name === "TimeoutError" ? "timed out" : e.message;
  }
  return String(e);
}

export interface DownloadRequest {
  /** Archive file name, e.g. "zig-x86_64-linux-0.16.0.tar.xz". */
  fileName: string;
  /** Canonical URL on ziglang.org, used as the last resort. */
  officialUrl: string;
  /** Pinned SHA-256 (hex) from the official release index. */
  shasum: string;
  /** Pinned size in bytes. */
  size: number;
  /** Mirror base URLs, already in the order to try them. */
  mirrors: readonly string[];
  /** ZSF minisign public key (base64). */
  publicKey: string;
  /** Where to write the verified archive. */
  dest: string;
  log?: Logger;
  onProgress?: (received: number) => void;
  /** Override the network timeouts (mainly for tests). */
  timeouts?: { headerMs?: number; idleMs?: number };
}

/**
 * Download a Zig release archive, trying mirrors in order and finally
 * ziglang.org itself. Every candidate must pass ALL of:
 *   - exact size and SHA-256 pinned in this package (from the official index)
 *   - a valid minisign signature from the Zig Software Foundation's key
 *   - the signature's trusted comment naming this exact archive file
 *
 * Resolves with the URL the archive was fetched from.
 */
export async function downloadVerified({
  fileName,
  officialUrl,
  shasum,
  size,
  mirrors,
  publicKey,
  dest,
  log = () => {},
  onProgress,
  timeouts = {},
}: DownloadRequest): Promise<{ url: string }> {
  const pub = parsePublicKey(publicKey);
  const candidates = mirrors.map(
    (m) => `${m.replace(/\/+$/, "")}/${fileName}?source=${SOURCE_TAG}`,
  );
  candidates.push(officialUrl);
  const failures: string[] = [];
  const partial = `${dest}.part`;

  for (const url of candidates) {
    const sigUrl = url.replace(fileName, `${fileName}.minisig`);
    const origin = new URL(url).host;
    try {
      log(
        `downloading ${fileName} (${(size / 1048576).toFixed(1)} MiB) from ${origin}`,
      );
      const got = await downloadFile(url, partial, {
        expectedSize: size,
        onProgress,
        headerTimeoutMs: timeouts.headerMs,
        idleTimeoutMs: timeouts.idleMs,
      });
      if (got.sha256 !== shasum) {
        throw new Error(`SHA-256 mismatch (got ${got.sha256})`);
      }
      const sig = parseSignature(await fetchText(sigUrl));
      verify(sig, pub, {
        blake2b512: got.blake2b512,
        expectedFileName: fileName,
      });
      fs.renameSync(partial, dest);
      log(`verified ${fileName}: SHA-256 and minisign signature OK`);
      return { url };
    } catch (e) {
      fs.rmSync(partial, { force: true });
      const msg = errorMessage(e);
      failures.push(`${origin}: ${msg}`);
      log(`  ${origin} failed: ${msg}`);
    }
  }
  throw new Error(
    `could not download ${fileName} from any source:\n  ${failures.join("\n  ")}`,
  );
}
