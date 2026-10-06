import crypto from "node:crypto";

/**
 * Dependency-free, streaming .xz decompressor (LZMA2 filter only).
 *
 * This is the fallback used when the system `tar` cannot handle .tar.xz,
 * which is the case in several popular minimal Linux container images that
 * lack the `xz` binary. It is a straightforward port of the LZMA
 * specification's reference decoder, plus the LZMA2 chunk framing and the
 * .xz container format. Every block's integrity check (CRC32/CRC64/SHA-256)
 * is verified, so a decoder bug cannot silently produce wrong output.
 *
 * Usage:
 *   const xz = new XzDecoder((chunk) => sink.write(chunk));
 *   for await (const buf of input) xz.write(buf);
 *   xz.end();
 *
 * Emitted chunks are views into the decoder's window and are only valid until
 * the next `write()`; consume or copy them synchronously.
 *
 * Only LZMA2 (filter 0x21) is supported, which is what `xz` produces by
 * default; BCJ/Delta filters throw a clear error.
 */

export type ChunkSink = (chunk: Buffer) => void;

// Byte reads below index typed arrays that are always bounds-checked first
// (by `need`/`end` comparisons); `at()` makes that explicit for the checker.
const byte = (buf: Uint8Array, i: number): number => buf[i] ?? 0;

// ---------------------------------------------------------------------------
// Checksums

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32(buf: Uint8Array, crc = 0): number {
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC32_TABLE[(crc ^ byte(buf, i)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

// CRC-64/XZ (ECMA-182 polynomial, reflected), kept as two 32-bit halves.
const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
{
  const POLY_HI = 0xc96c5795,
    POLY_LO = 0xd7870f42;
  for (let i = 0; i < 256; i++) {
    let lo = i,
      hi = 0;
    for (let k = 0; k < 8; k++) {
      const bit = lo & 1;
      lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
      hi = hi >>> 1;
      if (bit) {
        lo = (lo ^ POLY_LO) >>> 0;
        hi = (hi ^ POLY_HI) >>> 0;
      }
    }
    CRC64_LO[i] = lo;
    CRC64_HI[i] = hi;
  }
}

interface Check {
  update(buf: Uint8Array): void;
  digest(): Buffer;
}

class Crc64 implements Check {
  private lo = 0xffffffff;
  private hi = 0xffffffff;
  update(buf: Uint8Array): void {
    let lo = this.lo,
      hi = this.hi;
    for (let i = 0; i < buf.length; i++) {
      const idx = (lo ^ byte(buf, i)) & 0xff;
      lo = (((lo >>> 8) | ((hi & 0xff) << 24)) ^ (CRC64_LO[idx] ?? 0)) >>> 0;
      hi = ((hi >>> 8) ^ (CRC64_HI[idx] ?? 0)) >>> 0;
    }
    this.lo = lo;
    this.hi = hi;
  }
  /** Little-endian 8-byte digest, as stored in the .xz block check field. */
  digest(): Buffer {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(~this.lo >>> 0, 0);
    out.writeUInt32LE(~this.hi >>> 0, 4);
    return out;
  }
}

class Crc32Check implements Check {
  private crc = 0;
  update(buf: Uint8Array): void {
    this.crc = crc32(buf, this.crc);
  }
  digest(): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(this.crc, 0);
    return out;
  }
}

class Sha256Check implements Check {
  private h = crypto.createHash("sha256");
  update(buf: Uint8Array): void {
    this.h.update(buf);
  }
  digest(): Buffer {
    return this.h.digest();
  }
}

// check type -> [size, factory]
const CHECKS: Record<number, [number, (() => Check) | null]> = {
  0: [0, null],
  1: [4, () => new Crc32Check()],
  4: [8, () => new Crc64()],
  10: [32, () => new Sha256Check()],
};

// ---------------------------------------------------------------------------
// LZMA decoder (port of LzmaSpec.cpp from the LZMA SDK)

const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;
const kNumMoveBits = 5;
const PROB_INIT = kBitModelTotal >>> 1;
const kTopValue = 1 << 24;

const kNumPosBitsMax = 4;
const kNumStates = 12;
const kNumLenToPosStates = 4;
const kNumAlignBits = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >>> 1);
const kMatchMinLen = 2;

/**
 * Sliding dictionary. Output is delivered to `emit` whenever the window
 * wraps or `flush()` is called, so memory use is bounded by dictSize.
 */
class OutWindow {
  private readonly buf: Buffer;
  private readonly size: number;
  private pos = 0;
  private isFull = false;
  private flushed = 0;
  /** Bytes written since the last dictionary reset (for position-dependent probabilities). */
  totalPos = 0;
  private readonly emit: ChunkSink;

  constructor(dictSize: number, emit: ChunkSink) {
    this.buf = Buffer.allocUnsafe(dictSize);
    this.size = dictSize;
    this.emit = emit;
  }
  reset(): void {
    // Dictionary reset: nothing previously written may be referenced.
    this.flush();
    this.pos = 0;
    this.flushed = 0;
    this.isFull = false;
    this.totalPos = 0;
  }
  flush(): void {
    if (this.pos > this.flushed) {
      this.emit(this.buf.subarray(this.flushed, this.pos));
    }
    this.flushed = this.pos;
  }
  putByte(b: number): void {
    this.buf[this.pos++] = b;
    this.totalPos++;
    if (this.pos === this.size) {
      this.flush();
      this.pos = 0;
      this.flushed = 0;
      this.isFull = true;
    }
  }
  /** Byte at distance `dist` back from the write position (0 = most recent byte). */
  getByte(dist: number): number {
    let i = this.pos - dist - 1;
    if (i < 0) {
      i += this.size;
    }
    return byte(this.buf, i);
  }
  copyMatch(dist: number, len: number): void {
    for (; len > 0; len--) {
      this.putByte(this.getByte(dist));
    }
  }
  checkDistance(dist: number): boolean {
    return dist < this.pos || (this.isFull && dist < this.size);
  }
  isEmpty(): boolean {
    return this.pos === 0 && !this.isFull;
  }
}

class RangeDecoder {
  private range = 0;
  private code = 0;
  private buf: Uint8Array = new Uint8Array(0);
  off = 0;
  private end = 0;

  init(buf: Uint8Array, off: number, end: number): void {
    this.buf = buf;
    this.off = off;
    this.end = end;
    this.range = 0xffffffff;
    this.code = 0;
    if (this.byte() !== 0) {
      throw new Error("xz: corrupt LZMA stream (bad range coder init)");
    }
    for (let i = 0; i < 4; i++) {
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    if (this.code === this.range) {
      throw new Error("xz: corrupt LZMA stream");
    }
  }
  private byte(): number {
    if (this.off >= this.end) {
      throw new Error("xz: corrupt LZMA stream (truncated chunk)");
    }
    return byte(this.buf, this.off++);
  }
  isFinished(): boolean {
    return this.code === 0;
  }
  private normalize(): void {
    if (this.range < kTopValue) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }
  bit(probs: Uint16Array, idx: number): number {
    const p = probs[idx] ?? 0;
    const bound = (this.range >>> kNumBitModelTotalBits) * p;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      probs[idx] = p + ((kBitModelTotal - p) >>> kNumMoveBits);
      b = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[idx] = p - (p >>> kNumMoveBits);
      b = 1;
    }
    this.normalize();
    return b;
  }
  directBits(n: number): number {
    let res = 0;
    do {
      this.range = this.range >>> 1;
      this.code = (this.code - this.range) >>> 0;
      const t = this.code >>> 31; // 1 if the subtraction "went negative"
      if (t) {
        this.code = (this.code + this.range) >>> 0;
      }
      if (this.code === this.range) {
        throw new Error("xz: corrupt LZMA stream");
      }
      this.normalize();
      res = res * 2 + (1 - t);
    } while (--n);
    return res;
  }
  bitTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) {
      m = (m << 1) + this.bit(probs, base + m);
    }
    return m - (1 << numBits);
  }
  reverseBitTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1,
      sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }
}

class LenDecoder {
  // probs layout: [choice, choice2, low[16][8], mid[16][8], high[256]]
  private readonly probs = new Uint16Array(2 + 16 * 8 + 16 * 8 + 256);
  constructor() {
    this.reset();
  }
  reset(): void {
    this.probs.fill(PROB_INIT);
  }
  decode(rc: RangeDecoder, posState: number): number {
    const p = this.probs;
    if (rc.bit(p, 0) === 0) {
      return rc.bitTree(p, 2 + posState * 8, 3);
    }
    if (rc.bit(p, 1) === 0) {
      return 8 + rc.bitTree(p, 2 + 128 + posState * 8, 3);
    }
    return 16 + rc.bitTree(p, 2 + 256, 8);
  }
}

class LzmaDecoder {
  private readonly rc = new RangeDecoder();
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private literalProbs = new Uint16Array(0);
  private readonly posSlot = new Uint16Array(kNumLenToPosStates << 6);
  private readonly posDecoders = new Uint16Array(
    1 + kNumFullDistances - kEndPosModelIndex,
  );
  private readonly align = new Uint16Array(1 << kNumAlignBits);
  private readonly isMatch = new Uint16Array(kNumStates << kNumPosBitsMax);
  private readonly isRep = new Uint16Array(kNumStates);
  private readonly isRepG0 = new Uint16Array(kNumStates);
  private readonly isRepG1 = new Uint16Array(kNumStates);
  private readonly isRepG2 = new Uint16Array(kNumStates);
  private readonly isRep0Long = new Uint16Array(kNumStates << kNumPosBitsMax);
  private readonly lenDecoder = new LenDecoder();
  private readonly repLenDecoder = new LenDecoder();
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  private readonly window: OutWindow;

  constructor(window: OutWindow) {
    this.window = window;
  }

  setProps(propsByte: number): void {
    if (propsByte >= 9 * 5 * 5) {
      throw new Error("xz: invalid LZMA properties");
    }
    let d = propsByte;
    this.lc = d % 9;
    d = (d / 9) | 0;
    this.lp = d % 5;
    this.pb = (d / 5) | 0;
    if (this.lc + this.lp > 4) {
      throw new Error("xz: invalid LZMA2 lc/lp");
    }
    this.literalProbs = new Uint16Array(0x300 << (this.lc + this.lp));
  }
  resetState(): void {
    this.literalProbs.fill(PROB_INIT);
    for (const a of [
      this.posSlot,
      this.posDecoders,
      this.align,
      this.isMatch,
      this.isRep,
      this.isRepG0,
      this.isRepG1,
      this.isRepG2,
      this.isRep0Long,
    ]) {
      a.fill(PROB_INIT);
    }
    this.lenDecoder.reset();
    this.repLenDecoder.reset();
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
  private decodeLiteral(state: number, rep0: number): void {
    const w = this.window,
      rc = this.rc;
    const prevByte = w.isEmpty() ? 0 : w.getByte(0);
    let symbol = 1;
    const litState =
      ((w.totalPos & ((1 << this.lp) - 1)) << this.lc) +
      (prevByte >>> (8 - this.lc));
    const base = 0x300 * litState;
    const probs = this.literalProbs;
    if (state >= 7) {
      let matchByte = w.getByte(rep0);
      do {
        const matchBit = (matchByte >>> 7) & 1;
        matchByte <<= 1;
        const bit = rc.bit(probs, base + ((1 + matchBit) << 8) + symbol);
        symbol = (symbol << 1) | bit;
        if (matchBit !== bit) {
          break;
        }
      } while (symbol < 0x100);
    }
    while (symbol < 0x100) {
      symbol = (symbol << 1) | rc.bit(probs, base + symbol);
    }
    w.putByte(symbol - 0x100);
  }
  private decodeDistance(len: number): number {
    const rc = this.rc;
    let lenState = len;
    if (lenState > kNumLenToPosStates - 1) {
      lenState = kNumLenToPosStates - 1;
    }
    const posSlot = rc.bitTree(this.posSlot, lenState << 6, 6);
    if (posSlot < 4) {
      return posSlot;
    }
    const numDirectBits = (posSlot >>> 1) - 1;
    let dist = (2 | (posSlot & 1)) * 2 ** numDirectBits;
    if (posSlot < kEndPosModelIndex) {
      dist += rc.reverseBitTree(
        this.posDecoders,
        dist - posSlot,
        numDirectBits,
      );
    } else {
      dist +=
        rc.directBits(numDirectBits - kNumAlignBits) * (1 << kNumAlignBits);
      dist += rc.reverseBitTree(this.align, 0, kNumAlignBits);
    }
    return dist;
  }
  /**
   * Decode exactly `unpackSize` bytes from compressed bytes buf[off, end).
   * LZMA2 chunks never use the end marker, so sizes are authoritative.
   */
  decodeChunk(
    buf: Uint8Array,
    off: number,
    end: number,
    unpackSize: number,
  ): void {
    const rc = this.rc,
      w = this.window;
    rc.init(buf, off, end);
    const pbMask = (1 << this.pb) - 1;
    let remaining = unpackSize;
    while (remaining > 0) {
      const posState = w.totalPos & pbMask;
      const state = this.state;
      if (rc.bit(this.isMatch, (state << kNumPosBitsMax) + posState) === 0) {
        this.decodeLiteral(state, this.rep0);
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        remaining--;
        continue;
      }
      let len: number;
      if (rc.bit(this.isRep, state) !== 0) {
        if (w.isEmpty()) {
          throw new Error(
            "xz: corrupt LZMA stream (rep with empty dictionary)",
          );
        }
        if (rc.bit(this.isRepG0, state) === 0) {
          if (
            rc.bit(this.isRep0Long, (state << kNumPosBitsMax) + posState) === 0
          ) {
            this.state = state < 7 ? 9 : 11;
            w.putByte(w.getByte(this.rep0));
            remaining--;
            continue;
          }
        } else {
          let dist: number;
          if (rc.bit(this.isRepG1, state) === 0) {
            dist = this.rep1;
          } else {
            if (rc.bit(this.isRepG2, state) === 0) {
              dist = this.rep2;
            } else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.repLenDecoder.decode(rc, posState);
        this.state = state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = this.lenDecoder.decode(rc, posState);
        this.state = state < 7 ? 7 : 10;
        const dist = this.decodeDistance(len);
        if (dist === 0xffffffff) {
          throw new Error("xz: unexpected LZMA end marker in LZMA2 chunk");
        }
        if (!w.checkDistance(dist)) {
          throw new Error("xz: corrupt LZMA stream (distance too far)");
        }
        this.rep0 = dist;
      }
      len += kMatchMinLen;
      if (len > remaining) {
        throw new Error("xz: corrupt LZMA stream (match exceeds chunk)");
      }
      w.copyMatch(this.rep0, len);
      remaining -= len;
    }
    if (!rc.isFinished()) {
      throw new Error("xz: corrupt LZMA stream (range coder not finished)");
    }
    if (rc.off !== end) {
      throw new Error("xz: corrupt LZMA2 chunk (compressed size mismatch)");
    }
  }
}

// ---------------------------------------------------------------------------
// LZMA2 chunk framing

class Lzma2Decoder {
  private readonly window: OutWindow;
  private readonly lzma: LzmaDecoder;
  private needDictReset = true;
  private needProps = true;
  private buf: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(dictSize: number, emit: ChunkSink) {
    this.window = new OutWindow(dictSize, emit);
    this.lzma = new LzmaDecoder(this.window);
  }

  /**
   * Feed compressed bytes; decodes as many whole chunks as are available.
   * Returns the unconsumed bytes after the end marker once it is reached,
   * or null if the LZMA2 stream is not finished yet.
   */
  write(chunk: Buffer): Buffer | null {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    const b = this.buf;
    while (off < b.length && !this.done) {
      const control = byte(b, off);
      if (control === 0x00) {
        this.done = true;
        off++;
        break;
      }
      if (control >= 0xe0 || control === 0x01) {
        this.needDictReset = false;
        this.needProps = true; // a dictionary reset must be followed by new properties
        this.window.reset();
      } else if (this.needDictReset) {
        throw new Error("xz: corrupt LZMA2 stream (missing dictionary reset)");
      }
      if (control >= 0x80) {
        if (off + 5 > b.length) {
          break;
        }
        const unpackSize =
          ((control & 0x1f) << 16) +
          (byte(b, off + 1) << 8) +
          byte(b, off + 2) +
          1;
        const packSize = (byte(b, off + 3) << 8) + byte(b, off + 4) + 1;
        const mode = (control >>> 5) & 3;
        let hdr = 5;
        if (mode >= 2) {
          if (off + 6 > b.length) {
            break;
          }
          this.lzma.setProps(byte(b, off + 5));
          this.needProps = false;
          hdr = 6;
        } else if (this.needProps) {
          throw new Error("xz: corrupt LZMA2 stream (missing properties)");
        }
        if (off + hdr + packSize > b.length) {
          break;
        }
        if (mode >= 1) {
          this.lzma.resetState();
        }
        this.lzma.decodeChunk(b, off + hdr, off + hdr + packSize, unpackSize);
        off += hdr + packSize;
      } else if (control === 0x01 || control === 0x02) {
        if (off + 3 > b.length) {
          break;
        }
        const size = (byte(b, off + 1) << 8) + byte(b, off + 2) + 1;
        if (off + 3 + size > b.length) {
          break;
        }
        const w = this.window;
        for (let i = 0; i < size; i++) {
          w.putByte(byte(b, off + 3 + i));
        }
        off += 3 + size;
      } else {
        throw new Error(
          `xz: corrupt LZMA2 stream (control byte 0x${control.toString(16)})`,
        );
      }
    }
    this.buf = off === b.length ? Buffer.alloc(0) : b.subarray(off);
    this.window.flush();
    return this.done ? this.buf : null;
  }
}

// ---------------------------------------------------------------------------
// .xz container

const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const XZ_FOOTER_MAGIC = Buffer.from([0x59, 0x5a]); // "YZ"

/** Variable-length integer: 7 bits per byte, little-endian, high bit = more. */
function readVli(
  buf: Buffer,
  off: number,
): [value: number, next: number] | null {
  let value = 0,
    mult = 1,
    i = 0;
  for (;;) {
    if (off + i >= buf.length) {
      return null;
    }
    const b = byte(buf, off + i);
    value += (b & 0x7f) * mult;
    i++;
    if ((b & 0x80) === 0) {
      break;
    }
    if (i >= 9) {
      throw new Error("xz: invalid variable-length integer");
    }
    mult *= 128;
  }
  return [value, off + i];
}

function requireVli(buf: Buffer, off: number): [value: number, next: number] {
  const r = readVli(buf, off);
  if (!r) {
    throw new Error("xz: bad block header");
  }
  return r;
}

interface Block {
  headerSize: number;
  declaredCompressedSize: number | null;
  declaredUncompressedSize: number | null;
  compressedSize: number;
  uncompressedSize: number;
  check: Check | null;
  lzma2: Lzma2Decoder;
}

type State =
  | "stream-header"
  | "block-header"
  | "block-data"
  | "block-check"
  | "index"
  | "stream-footer";

export class XzDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private state: State = "stream-header";
  private checkType = 0;
  private block: Block | null = null;
  /** Per-block [unpadded size, uncompressed size], validated against the index. */
  private records: Array<[number, number]> = [];
  private indexSize = 0;
  private finished = false;
  private readonly emit: ChunkSink;

  constructor(emit: ChunkSink) {
    this.emit = emit;
  }

  write(chunk: Uint8Array): void {
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    this.buf = this.buf.length ? Buffer.concat([this.buf, view]) : view;
    this.process();
  }

  end(): void {
    this.process();
    if (this.state !== "stream-header" || !this.finished) {
      throw new Error("xz: truncated input");
    }
    if (this.buf.length) {
      throw new Error("xz: trailing garbage after stream");
    }
  }

  private process(): void {
    for (;;) {
      const b = this.buf;
      switch (this.state) {
        case "stream-header": {
          if (b.length === 0 && this.finished) {
            return;
          }
          // Stream padding (multiple of 4 zero bytes) may precede another stream.
          if (this.finished) {
            let z = 0;
            while (z < b.length && b[z] === 0) {
              z++;
            }
            if (z === b.length) {
              this.buf = Buffer.alloc(0);
              return;
            }
            if (z % 4 !== 0) {
              throw new Error("xz: invalid stream padding");
            }
            this.buf = b.subarray(z);
            this.finished = false; // another stream follows
            continue;
          }
          if (b.length < 12) {
            return;
          }
          if (!b.subarray(0, 6).equals(XZ_MAGIC)) {
            throw new Error("xz: not an .xz file");
          }
          const flags1 = byte(b, 7);
          if (b[6] !== 0 || (flags1 & 0xf0) !== 0) {
            throw new Error("xz: unsupported stream flags");
          }
          if (crc32(b.subarray(6, 8)) !== b.readUInt32LE(8)) {
            throw new Error("xz: stream header CRC mismatch");
          }
          this.checkType = flags1;
          if (!(this.checkType in CHECKS)) {
            throw new Error(`xz: unsupported check type ${this.checkType}`);
          }
          this.records = [];
          this.buf = b.subarray(12);
          this.state = "block-header";
          break;
        }
        case "block-header": {
          if (b.length < 1) {
            return;
          }
          if (b[0] === 0x00) {
            this.state = "index";
            break;
          }
          const headerSize = (byte(b, 0) + 1) * 4;
          if (b.length < headerSize) {
            return;
          }
          this.parseBlockHeader(b.subarray(0, headerSize));
          this.buf = b.subarray(headerSize);
          this.state = "block-data";
          break;
        }
        case "block-data": {
          if (b.length === 0) {
            return;
          }
          const blk = this.currentBlock();
          const leftover = blk.lzma2.write(b);
          if (leftover === null) {
            blk.compressedSize += b.length;
            this.buf = Buffer.alloc(0);
            return;
          }
          blk.compressedSize += b.length - leftover.length;
          this.buf = leftover;
          if (
            blk.declaredCompressedSize !== null &&
            blk.declaredCompressedSize !== blk.compressedSize
          ) {
            throw new Error("xz: block compressed size mismatch");
          }
          if (
            blk.declaredUncompressedSize !== null &&
            blk.declaredUncompressedSize !== blk.uncompressedSize
          ) {
            throw new Error("xz: block uncompressed size mismatch");
          }
          this.state = "block-check";
          break;
        }
        case "block-check": {
          const blk = this.currentBlock();
          const padding = (4 - (blk.compressedSize % 4)) % 4;
          const checkSize = this.checkSize();
          if (b.length < padding + checkSize) {
            return;
          }
          for (let i = 0; i < padding; i++) {
            if (b[i] !== 0) {
              throw new Error("xz: invalid block padding");
            }
          }
          if (blk.check) {
            const expected = b.subarray(padding, padding + checkSize);
            if (!blk.check.digest().equals(expected)) {
              throw new Error("xz: block integrity check FAILED");
            }
          }
          this.records.push([
            blk.headerSize + blk.compressedSize + checkSize,
            blk.uncompressedSize,
          ]);
          this.buf = b.subarray(padding + checkSize);
          this.block = null;
          this.state = "block-header";
          break;
        }
        case "index": {
          // 0x00 indicator, VLI count, records, padding, CRC32
          let r = readVli(b, 1);
          if (r === null) {
            return;
          }
          const count = r[0];
          let off = r[1];
          const recs: Array<[number, number]> = [];
          for (let i = 0; i < count; i++) {
            r = readVli(b, off);
            if (r === null) {
              return;
            }
            const unpadded = r[0];
            off = r[1];
            r = readVli(b, off);
            if (r === null) {
              return;
            }
            recs.push([unpadded, r[0]]);
            off = r[1];
          }
          const padded = (off + 3) & ~3;
          if (b.length < padded + 4) {
            return;
          }
          for (let i = off; i < padded; i++) {
            if (b[i] !== 0) {
              throw new Error("xz: invalid index padding");
            }
          }
          if (crc32(b.subarray(0, padded)) !== b.readUInt32LE(padded)) {
            throw new Error("xz: index CRC mismatch");
          }
          if (recs.length !== this.records.length) {
            throw new Error("xz: index record count mismatch");
          }
          for (let i = 0; i < recs.length; i++) {
            const got = recs[i],
              want = this.records[i];
            if (!got || !want || got[0] !== want[0] || got[1] !== want[1]) {
              throw new Error("xz: index does not match decoded blocks");
            }
          }
          this.indexSize = padded + 4;
          this.buf = b.subarray(padded + 4);
          this.state = "stream-footer";
          break;
        }
        case "stream-footer": {
          if (b.length < 12) {
            return;
          }
          if (crc32(b.subarray(4, 10)) !== b.readUInt32LE(0)) {
            throw new Error("xz: stream footer CRC mismatch");
          }
          const backwardSize = (b.readUInt32LE(4) + 1) * 4;
          if (backwardSize !== this.indexSize) {
            throw new Error("xz: stream footer backward size mismatch");
          }
          if (b[8] !== 0 || b[9] !== this.checkType) {
            throw new Error("xz: stream footer flags mismatch");
          }
          if (!b.subarray(10, 12).equals(XZ_FOOTER_MAGIC)) {
            throw new Error("xz: bad stream footer magic");
          }
          this.buf = b.subarray(12);
          this.finished = true;
          this.state = "stream-header";
          break;
        }
      }
    }
  }

  private currentBlock(): Block {
    if (!this.block) {
      throw new Error("xz: internal error (no current block)");
    }
    return this.block;
  }

  private checkSize(): number {
    return CHECKS[this.checkType]?.[0] ?? 0;
  }

  private parseBlockHeader(h: Buffer): void {
    const size = h.length;
    if (crc32(h.subarray(0, size - 4)) !== h.readUInt32LE(size - 4)) {
      throw new Error("xz: block header CRC mismatch");
    }
    const flags = byte(h, 1);
    const numFilters = (flags & 0x03) + 1;
    if (flags & 0x3c) {
      throw new Error("xz: reserved block header flags set");
    }
    let off = 2;
    let compressedSize: number | null = null,
      uncompressedSize: number | null = null;
    if (flags & 0x40) {
      [compressedSize, off] = requireVli(h, off);
    }
    if (flags & 0x80) {
      [uncompressedSize, off] = requireVli(h, off);
    }
    const filters: Array<{ id: number; props: Buffer }> = [];
    for (let i = 0; i < numFilters; i++) {
      let id: number, propsSize: number;
      [id, off] = requireVli(h, off);
      [propsSize, off] = requireVli(h, off);
      filters.push({ id, props: h.subarray(off, off + propsSize) });
      off += propsSize;
    }
    for (let i = off; i < size - 4; i++) {
      if (h[i] !== 0) {
        throw new Error("xz: invalid block header padding");
      }
    }
    const filter = filters[0];
    if (filters.length !== 1 || !filter || filter.id !== 0x21) {
      const ids = filters.map((f) => `0x${f.id.toString(16)}`).join(", ");
      throw new Error(
        `xz: unsupported filter chain [${ids}]; only LZMA2 is supported`,
      );
    }
    const p = filter.props;
    const p0 = byte(p, 0);
    if (p.length !== 1 || (p0 & 0xc0) !== 0 || (p0 & 0x3f) > 40) {
      throw new Error("xz: invalid LZMA2 properties");
    }
    const bits = p0 & 0x3f;
    let dictSize =
      bits === 40 ? 0xffffffff : (2 | (bits & 1)) * 2 ** ((bits >>> 1) + 11);
    if (dictSize < 4096) {
      dictSize = 4096;
    }
    // The window only needs to hold as much as will ever be referenced. If the
    // block declares its uncompressed size, we can cap the allocation.
    if (uncompressedSize !== null && uncompressedSize < dictSize) {
      dictSize = Math.max(4096, uncompressedSize);
    }
    if (dictSize > 0x7fffffff) {
      throw new Error("xz: dictionary too large");
    }

    const makeCheck = CHECKS[this.checkType]?.[1] ?? null;
    const check = makeCheck ? makeCheck() : null;
    const blk: Block = {
      headerSize: size,
      declaredCompressedSize: compressedSize,
      declaredUncompressedSize: uncompressedSize,
      compressedSize: 0,
      uncompressedSize: 0,
      check,
      lzma2: new Lzma2Decoder(dictSize, (out) => {
        blk.uncompressedSize += out.length;
        if (check) {
          check.update(out);
        }
        this.emit(out);
      }),
    };
    this.block = blk;
  }
}

/** Convenience: decompress a whole Buffer in memory. */
export function decompressXz(input: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  const d = new XzDecoder((c) => parts.push(Buffer.from(c)));
  d.write(input);
  d.end();
  return Buffer.concat(parts);
}
