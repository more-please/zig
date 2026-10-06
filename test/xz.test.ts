import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { crc32, decompressXz, XzDecoder } from "../lib/xz.ts";
import { haveCommand, pseudoRandom, run, tmpdir } from "./_helpers.ts";

const haveXz = haveCommand("xz");
const skipNoXz = !haveXz && "xz not installed";

test("crc32 matches known vectors", () => {
  assert.equal(crc32(Buffer.from("")), 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(
    crc32(Buffer.from("The quick brown fox jumps over the lazy dog")),
    0x414fa339,
  );
});

test("rejects non-xz input", () => {
  assert.throws(() => decompressXz(Buffer.alloc(32)), /not an \.xz file/);
  assert.throws(
    () => decompressXz(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])),
    /truncated/,
  );
});

function fixtures(): Record<string, Buffer> {
  // A mix of compressible and incompressible content exercises literals,
  // matches, repeated distances and LZMA2 uncompressed chunks.
  const text = Buffer.from(
    "the quick brown fox jumps over the lazy dog. ".repeat(20000),
  );
  const random = pseudoRandom(300_000);
  const mixed = Buffer.concat([
    text.subarray(0, 100_000),
    random.subarray(0, 100_000),
    text.subarray(0, 50_000),
    random,
  ]);
  const zeros = Buffer.alloc(1_000_000);
  return {
    empty: Buffer.alloc(0),
    tiny: Buffer.from("x"),
    text,
    random,
    mixed,
    zeros,
  };
}

test("decompresses xz output in various configurations", {
  skip: skipNoXz,
}, () => {
  const dir = tmpdir("xz");
  const configs = [
    ["-0"],
    ["-6"],
    ["-9e"],
    ["-6", "--check=crc32"],
    ["-6", "--check=sha256"],
    ["-6", "--check=none"],
    ["-6", "--block-size=65536"],
    ["-6", "-T2", "--block-size=200000"],
    ["--lzma2=preset=6,lc=0,lp=2,pb=0"],
    ["--lzma2=dict=4KiB"],
    ["--format=xz", "--lzma2=preset=3,nice=273"],
  ];
  for (const [name, data] of Object.entries(fixtures())) {
    const src = path.join(dir, name);
    fs.writeFileSync(src, data);
    for (const args of configs) {
      run("xz", ["-k", "-f", ...args, src]);
      const compressed = fs.readFileSync(`${src}.xz`);
      const out = decompressXz(compressed);
      assert.ok(out.equals(data), `${name} with ${args.join(" ")}`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("streams correctly when fed in small pieces", { skip: skipNoXz }, () => {
  const dir = tmpdir("xz");
  const data = fixtures().mixed ?? Buffer.alloc(0);
  const src = path.join(dir, "mixed");
  fs.writeFileSync(src, data);
  run("xz", ["-k", "-f", "-6", "-T2", "--block-size=100000", src]);
  const compressed = fs.readFileSync(`${src}.xz`);
  for (const step of [1, 7, 1000, 65536]) {
    const parts: Buffer[] = [];
    const d = new XzDecoder((c) => parts.push(Buffer.from(c)));
    for (let i = 0; i < compressed.length; i += step) {
      d.write(compressed.subarray(i, i + step));
    }
    d.end();
    assert.ok(Buffer.concat(parts).equals(data), `step ${step}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("handles concatenated streams with padding", { skip: skipNoXz }, () => {
  const dir = tmpdir("xz");
  const a = Buffer.from("first stream ".repeat(1000)),
    b = pseudoRandom(5000, 99);
  fs.writeFileSync(path.join(dir, "a"), a);
  fs.writeFileSync(path.join(dir, "b"), b);
  run("xz", ["-k", "-f", path.join(dir, "a"), path.join(dir, "b")]);
  const combined = Buffer.concat([
    fs.readFileSync(path.join(dir, "a.xz")),
    Buffer.alloc(8),
    fs.readFileSync(path.join(dir, "b.xz")),
    Buffer.alloc(4),
  ]);
  assert.ok(decompressXz(combined).equals(Buffer.concat([a, b])));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("detects corruption", { skip: skipNoXz }, () => {
  const dir = tmpdir("xz");
  const data = fixtures().mixed ?? Buffer.alloc(0);
  const src = path.join(dir, "mixed");
  fs.writeFileSync(src, data);
  run("xz", ["-k", "-f", "-6", src]);
  const compressed = fs.readFileSync(`${src}.xz`);
  let detected = 0;
  for (const pos of [
    12,
    40,
    1000,
    20000,
    compressed.length - 30,
    compressed.length - 5,
  ]) {
    const bad = Buffer.from(compressed);
    bad[pos] = (bad[pos] ?? 0) ^ 0x55;
    try {
      const out = decompressXz(bad);
      assert.ok(
        !out.equals(data),
        `corruption at ${pos} produced identical output`,
      );
    } catch (e) {
      assert.match((e as Error).message, /^xz:/);
      detected++;
    }
  }
  assert.ok(detected >= 4, `only ${detected} corruptions raised errors`);
  assert.throws(
    () => decompressXz(compressed.subarray(0, compressed.length - 1)),
    /truncated|xz:/,
  );
  assert.throws(
    () => decompressXz(Buffer.concat([compressed, Buffer.from("junk!")])),
    /xz:/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses unsupported filter chains", { skip: skipNoXz }, () => {
  const dir = tmpdir("xz");
  const src = path.join(dir, "f");
  fs.writeFileSync(src, pseudoRandom(10000));
  run("xz", ["-k", "-f", "--x86", "--lzma2", src]);
  assert.throws(
    () => decompressXz(fs.readFileSync(`${src}.xz`)),
    /unsupported filter chain/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
