import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { crc32 } from "../lib/xz.ts";
import { extractZip } from "../lib/zip.ts";
import {
  haveCommand,
  pseudoRandom,
  run,
  snapshotTree,
  tmpdir,
} from "./_helpers.ts";

const haveZip = haveCommand("zip", ["-v"]);

interface ZipEntry {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  mode?: number;
}

/** Build a zip in memory (stored or deflated). */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      ((e.mode ?? (e.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("extracts a hand-built zip with stored and deflated entries", async () => {
  const dir = tmpdir("zip");
  const big = pseudoRandom(40 * 1024 * 1024); // above the streaming threshold
  const zip = buildZip([
    { name: "top/", data: Buffer.alloc(0) },
    { name: "top/README.md", data: Buffer.from("hello\n") },
    {
      name: "top/lib/std/std.zig",
      data: Buffer.from("pub fn main() void {}\n".repeat(500)),
    },
    { name: "top/stored.bin", data: pseudoRandom(1000), method: 0 },
    { name: "top/big.bin", data: big },
    { name: "top/zig.exe", data: Buffer.from("MZ"), mode: 0o100755 },
    { name: "top/empty/", data: Buffer.alloc(0) },
  ]);
  const file = path.join(dir, "t.zip");
  fs.writeFileSync(file, zip);
  const out = path.join(dir, "out");
  const n = await extractZip(file, out, { strip: 1 });
  assert.equal(n, 6);
  assert.equal(fs.readFileSync(path.join(out, "README.md"), "utf8"), "hello\n");
  assert.ok(fs.readFileSync(path.join(out, "big.bin")).equals(big));
  assert.ok(
    fs.readFileSync(path.join(out, "stored.bin")).equals(pseudoRandom(1000)),
  );
  assert.ok(fs.statSync(path.join(out, "empty")).isDirectory());
  if (process.platform !== "win32") {
    assert.ok(fs.statSync(path.join(out, "zig.exe")).mode & 0o100);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("detects CRC mismatches", async () => {
  const dir = tmpdir("zip");
  const zip = buildZip([
    { name: "top/a.txt", data: Buffer.from("abc"), method: 0 },
  ]);
  const pos = 30 + "top/a.txt".length;
  zip[pos] = (zip[pos] ?? 0) ^ 1; // flip a byte of the stored data
  const file = path.join(dir, "t.zip");
  fs.writeFileSync(file, zip);
  await assert.rejects(
    extractZip(file, path.join(dir, "out"), { strip: 1 }),
    /CRC mismatch/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extracts an archive made by the zip tool", {
  skip: !haveZip && "zip not installed",
}, async () => {
  const dir = tmpdir("zip-tool");
  const top = path.join(dir, "zig-test");
  fs.mkdirSync(path.join(top, "lib", "deep"), { recursive: true });
  fs.writeFileSync(
    path.join(top, "lib", "deep", "f.zig"),
    "const x = 1;\n".repeat(100),
  );
  fs.writeFileSync(path.join(top, "rand.bin"), pseudoRandom(100_000));
  fs.writeFileSync(path.join(top, "zig"), "#!/bin/sh\n", { mode: 0o755 });
  run("zip", ["-r", "-q", "t.zip", "zig-test"], { cwd: dir });
  const out = path.join(dir, "out");
  await extractZip(path.join(dir, "t.zip"), out, { strip: 1 });
  assert.deepEqual(snapshotTree(out), snapshotTree(top));
  fs.rmSync(dir, { recursive: true, force: true });
});
