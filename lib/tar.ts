import fs from "node:fs";
import path from "node:path";

/**
 * Minimal streaming tar extractor (ustar, GNU long names, pax headers).
 *
 * Used together with XzDecoder as the fallback for .tar.xz archives when the
 * system `tar` cannot handle them. It writes regular files and directories,
 * recreates symlinks and hard links, and skips everything else. Paths are
 * sanitised: absolute paths and ".." segments are rejected, and the first
 * `strip` path components are removed (the Zig archives have a single
 * top-level directory).
 *
 *   const t = new TarExtractor(destDir, { strip: 1 });
 *   t.write(chunk); ...; t.end();
 */

const BLOCK = 512;

function parseOctal(buf: Buffer): number {
  const first = buf[0] ?? 0;
  if (first & 0x80) {
    // GNU base-256 encoding for large numbers.
    let v = first & 0x7f;
    for (let i = 1; i < buf.length; i++) {
      v = v * 256 + (buf[i] ?? 0);
    }
    return v;
  }
  const s = buf.toString("latin1").replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function parseString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.toString("utf8", 0, end === -1 ? buf.length : end);
}

/**
 * Validate an archive member path and strip leading components.
 * Returns null when nothing remains (e.g. the top-level directory itself).
 */
export function safeRelativePath(name: string, strip: number): string | null {
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`tar: refusing absolute path "${name}"`);
  }
  if (parts.some((p) => p === "..")) {
    throw new Error(`tar: refusing path with ".." "${name}"`);
  }
  if (parts.some((p) => /[\\:]/.test(p))) {
    throw new Error(`tar: refusing path with unsafe characters "${name}"`);
  }
  const rest = parts.slice(strip);
  return rest.length ? rest.join("/") : null;
}

/**
 * A symlink must stay inside `dest`: a later entry extracted *through* a
 * link that points outside would otherwise write outside the tree.
 */
export function checkSymlinkTarget(
  dest: string,
  linkPath: string,
  name: string,
  linkName: string,
): void {
  const refuse = (): never => {
    throw new Error(
      `tar: refusing symlink "${name}" -> "${linkName}" outside the archive`,
    );
  };
  if (path.isAbsolute(linkName) || /^[A-Za-z]:/.test(linkName)) {
    refuse();
  }
  const resolved = path.resolve(path.dirname(linkPath), linkName);
  const rel = path.relative(dest, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    refuse();
  }
}

type Mode = "header" | "meta" | "data" | "skip" | "end";
type MetaType = "L" | "K" | "x" | "g";

export class TarExtractor {
  readonly dest: string;
  readonly strip: number;
  /** Number of (non-meta) entries seen. */
  entries = 0;

  private buf: Buffer = Buffer.alloc(0);
  private mode: Mode = "header";
  private need = BLOCK;
  private metaType: MetaType = "L";
  private metaSize = 0;
  private fd: number | null = null;
  private remaining = 0;
  private padding = 0;
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax: Record<string, string> | null = null;
  private zeroBlocks = 0;

  constructor(dest: string, { strip = 0 }: { strip?: number } = {}) {
    this.dest = path.resolve(dest);
    this.strip = strip;
  }

  write(chunk: Buffer): void {
    let off = 0;
    while (off < chunk.length) {
      switch (this.mode) {
        case "data": {
          const n = Math.min(this.remaining, chunk.length - off);
          if (this.fd !== null) {
            let w = 0;
            while (w < n) {
              w += fs.writeSync(this.fd, chunk, off + w, n - w);
            }
          }
          off += n;
          this.remaining -= n;
          if (this.remaining === 0) {
            this.closeFile();
            this.mode = "skip";
            this.need = this.padding;
            if (this.need === 0) {
              this.mode = "header";
              this.need = BLOCK;
            }
          }
          break;
        }
        case "skip": {
          const n = Math.min(this.need, chunk.length - off);
          off += n;
          this.need -= n;
          if (this.need === 0) {
            this.mode = "header";
            this.need = BLOCK;
          }
          break;
        }
        case "end":
          off = chunk.length; // trailing zero padding
          break;
        case "header":
        case "meta": {
          // accumulate exactly `need` bytes
          const n = Math.min(this.need - this.buf.length, chunk.length - off);
          const piece = chunk.subarray(off, off + n);
          this.buf = this.buf.length
            ? Buffer.concat([this.buf, piece])
            : Buffer.from(piece);
          off += n;
          if (this.buf.length < this.need) {
            break;
          }
          const block = this.buf;
          this.buf = Buffer.alloc(0);
          if (this.mode === "header") {
            this.header(block);
          } else {
            this.meta(block);
          }
          break;
        }
      }
    }
  }

  end(): void {
    this.closeFile();
    if (this.mode === "data" || this.mode === "meta" || this.buf.length) {
      throw new Error("tar: truncated archive");
    }
  }

  private closeFile(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private header(h: Buffer): void {
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (h[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      if (++this.zeroBlocks >= 2) {
        this.mode = "end";
      }
      return;
    }
    this.zeroBlocks = 0;

    // Verify header checksum (sum of all bytes with the checksum field as spaces).
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    }
    if (sum !== parseOctal(h.subarray(148, 156))) {
      throw new Error("tar: bad header checksum");
    }

    const magic = h.toString("latin1", 257, 263);
    const isUstar = magic === "ustar\0" || magic === "ustar ";
    const isGnu = magic === "ustar ";
    let name = parseString(h.subarray(0, 100));
    if (isUstar && !isGnu) {
      const prefix = parseString(h.subarray(345, 500));
      if (prefix) {
        name = `${prefix}/${name}`;
      }
    }
    const mode = parseOctal(h.subarray(100, 108)) & 0o7777;
    let size = parseOctal(h.subarray(124, 136));
    const typeByte = h[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    let linkName = parseString(h.subarray(157, 257));

    if (type === "L" || type === "K" || type === "x" || type === "g") {
      this.metaType = type;
      this.metaSize = size;
      this.mode = "meta";
      this.need = Math.ceil(size / BLOCK) * BLOCK;
      if (this.need === 0) {
        this.meta(Buffer.alloc(0));
      }
      return;
    }

    if (this.longName !== null) {
      name = this.longName;
    }
    if (this.longLink !== null) {
      linkName = this.longLink;
    }
    if (this.pax) {
      if (this.pax.path !== undefined) {
        name = this.pax.path;
      }
      if (this.pax.linkpath !== undefined) {
        linkName = this.pax.linkpath;
      }
      if (this.pax.size !== undefined) {
        size = Number(this.pax.size);
      }
    }
    this.longName = this.longLink = this.pax = null;

    const rel = safeRelativePath(name, this.strip);
    const target = rel === null ? null : path.join(this.dest, rel);
    this.entries++;

    // Whatever the type, we must consume `size` bytes of data afterwards.
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.fd = null;

    switch (type) {
      case "0":
      case "7":
        if (target !== null) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          this.fd = fs.openSync(target, "w", mode | 0o600);
        }
        break;
      case "5":
        if (target !== null) {
          fs.mkdirSync(target, { recursive: true, mode: mode | 0o700 });
        }
        break;
      case "2":
        if (target !== null) {
          checkSymlinkTarget(this.dest, target, name, linkName);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.symlinkSync(linkName, target);
        }
        break;
      case "1": {
        if (target !== null) {
          const linkRel = safeRelativePath(linkName, this.strip);
          if (linkRel === null) {
            throw new Error(`tar: bad hard link target "${linkName}"`);
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const src = path.join(this.dest, linkRel);
          try {
            fs.linkSync(src, target);
          } catch {
            fs.copyFileSync(src, target);
          }
        }
        break;
      }
      default:
        // devices, fifos, etc.: skip
        break;
    }

    if (this.remaining > 0) {
      this.mode = "data";
    } else {
      this.closeFile();
      this.mode = "header";
      this.need = BLOCK;
    }
  }

  private meta(block: Buffer): void {
    const data = block.subarray(0, this.metaSize);
    switch (this.metaType) {
      case "L":
        this.longName = parseString(data);
        break;
      case "K":
        this.longLink = parseString(data);
        break;
      case "x":
        this.pax = parsePax(data);
        break;
      case "g":
        break; // global pax header: ignored
    }
    this.mode = "header";
    this.need = BLOCK;
  }
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) {
      break;
    }
    const len = parseInt(data.toString("latin1", off, sp), 10);
    if (!Number.isFinite(len) || len <= 0) {
      throw new Error("tar: bad pax record");
    }
    const rec = data.toString("utf8", sp + 1, off + len - 1); // drop trailing \n
    const eq = rec.indexOf("=");
    if (eq !== -1) {
      out[rec.slice(0, eq)] = rec.slice(eq + 1);
    }
    off += len;
  }
  return out;
}
