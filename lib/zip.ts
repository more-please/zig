import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { safeRelativePath } from "./tar.ts";
import { crc32 } from "./xz.ts";

/**
 * Minimal zip extractor (stored + deflate, zip64 aware), used as the fallback
 * for the Windows archives when `tar.exe` is unavailable. Reads the central
 * directory, then extracts each entry via positional reads so that memory use
 * stays bounded even for very large entries.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const STREAM_THRESHOLD = 32 * 1024 * 1024;

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) {
      throw new Error("zip: unexpected end of file");
    }
    got += n;
  }
  return buf;
}

function readU64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("zip: value too large");
  }
  return Number(v);
}

/** Extract `file` into `dest`, stripping `strip` leading path components. Returns the entry count. */
export async function extractZip(
  file: string,
  dest: string,
  { strip = 0 }: { strip?: number } = {},
): Promise<number> {
  dest = path.resolve(dest);
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    // Locate the end-of-central-directory record (max comment 65535 bytes).
    const tailLen = Math.min(size, 22 + 65535);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) {
      throw new Error("zip: end of central directory not found");
    }
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (
      entries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      const locPos = size - tailLen + eocd - 20;
      const loc = readAt(fd, locPos, 20);
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOCATOR) {
        throw new Error("zip: zip64 locator not found");
      }
      const eocd64 = readAt(fd, readU64(loc, 8), 56);
      if (eocd64.readUInt32LE(0) !== SIG_EOCD64) {
        throw new Error("zip: zip64 EOCD not found");
      }
      entries = readU64(eocd64, 32);
      cdSize = readU64(eocd64, 40);
      cdOffset = readU64(eocd64, 48);
    }
    const cd = readAt(fd, cdOffset, cdSize);

    let off = 0;
    let count = 0;
    for (let i = 0; i < entries; i++) {
      if (cd.readUInt32LE(off) !== SIG_CENTRAL) {
        throw new Error("zip: bad central directory entry");
      }
      const madeBy = cd.readUInt16LE(off + 4);
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const crc = cd.readUInt32LE(off + 16);
      let compSize = cd.readUInt32LE(off + 20);
      let uncompSize = cd.readUInt32LE(off + 24);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const externalAttrs = cd.readUInt32LE(off + 38);
      let localOffset = cd.readUInt32LE(off + 42);
      const name = cd.toString(
        flags & 0x800 ? "utf8" : "latin1",
        off + 46,
        off + 46 + nameLen,
      );
      const extra = cd.subarray(
        off + 46 + nameLen,
        off + 46 + nameLen + extraLen,
      );
      off += 46 + nameLen + extraLen + commentLen;

      // zip64 extended information
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e),
          len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          if (uncompSize === 0xffffffff) {
            uncompSize = readU64(extra, p);
            p += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = readU64(extra, p);
            p += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = readU64(extra, p);
            p += 8;
          }
        }
        e += 4 + len;
      }

      if (flags & 0x1) {
        throw new Error(`zip: encrypted entry "${name}"`);
      }
      if (method !== 0 && method !== 8) {
        throw new Error(
          `zip: unsupported compression method ${method} for "${name}"`,
        );
      }

      const fromUnix = madeBy >>> 8 === 3;
      const unixMode = fromUnix ? (externalAttrs >>> 16) & 0o7777 : 0o644;
      const isDir =
        name.endsWith("/") ||
        (fromUnix && ((externalAttrs >>> 16) & 0o170000) === 0o040000);
      const rel = safeRelativePath(name, strip);
      if (rel === null) {
        continue;
      }
      const target = path.join(dest, rel);
      count++;

      if (isDir) {
        fs.mkdirSync(target, { recursive: true, mode: unixMode | 0o700 });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });

      const local = readAt(fd, localOffset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) {
        throw new Error(`zip: bad local header for "${name}"`);
      }
      const dataStart =
        localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

      if (uncompSize <= STREAM_THRESHOLD) {
        const comp = readAt(fd, dataStart, compSize);
        const data = method === 8 ? zlib.inflateRawSync(comp) : comp;
        if (data.length !== uncompSize) {
          throw new Error(`zip: size mismatch for "${name}"`);
        }
        if (crc32(data) !== crc) {
          throw new Error(`zip: CRC mismatch for "${name}"`);
        }
        fs.writeFileSync(target, data, { mode: unixMode | 0o600 });
      } else {
        const src = fs.createReadStream(file, {
          start: dataStart,
          end: dataStart + compSize - 1,
        });
        const out = fs.createWriteStream(target, { mode: unixMode | 0o600 });
        let actualCrc = 0,
          actualSize = 0;
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            actualCrc = crc32(chunk, actualCrc);
            actualSize += chunk.length;
            cb(null, chunk);
          },
        });
        if (method === 8) {
          await pipeline(src, zlib.createInflateRaw(), tap, out);
        } else {
          await pipeline(src, tap, out);
        }
        if (actualSize !== uncompSize) {
          throw new Error(`zip: size mismatch for "${name}"`);
        }
        if (actualCrc !== crc) {
          throw new Error(`zip: CRC mismatch for "${name}"`);
        }
      }
    }
    return count;
  } finally {
    fs.closeSync(fd);
  }
}
