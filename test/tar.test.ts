import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  checkSymlinkTarget,
  safeRelativePath,
  TarExtractor,
} from "../lib/tar.ts";
import {
  haveCommand,
  pseudoRandom,
  run,
  snapshotTree,
  tmpdir,
} from "./_helpers.ts";

const haveTar = haveCommand("tar");
const win = process.platform === "win32";

function makeTree(root: string): string {
  const top = path.join(root, "zig-test-1.0.0");
  // Name > 100 chars (needs ustar prefix / GNU longname / pax) but total < 256 so ustar can still store it.
  const deep = path.join(top, "lib", "a".repeat(40), "b".repeat(40));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(
    path.join(deep, `very-long-path-file-${"x".repeat(40)}.txt`),
    "deep",
  );
  fs.writeFileSync(path.join(top, "README.md"), "hello\n");
  fs.writeFileSync(path.join(top, "empty"), "");
  fs.writeFileSync(path.join(top, "big.bin"), pseudoRandom(700_000));
  fs.writeFileSync(path.join(top, "zig"), "#!/bin/sh\necho zig\n", {
    mode: 0o755,
  });
  fs.mkdirSync(path.join(top, "doc", "empty-dir"), { recursive: true });
  if (!win) {
    fs.symlinkSync("README.md", path.join(top, "link-to-readme"));
  }
  return top;
}

const formats = win ? ["ustar", "pax"] : ["ustar", "pax", "gnutar"];

for (const format of formats) {
  test(`extracts a ${format} archive created by system tar, stripping the top directory`, {
    skip: !haveTar && "tar not installed",
  }, () => {
    const dir = tmpdir("tar");
    const top = makeTree(dir);
    const archive = path.join(dir, "t.tar");
    try {
      run("tar", [
        "--format",
        format,
        "-cf",
        archive,
        "-C",
        dir,
        path.basename(top),
      ]);
    } catch (e) {
      if (/format/i.test((e as Error).message)) {
        return; // GNU tar spells it --format=gnu; skip exotic combos
      }
      throw e;
    }
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const t = new TarExtractor(out, { strip: 1 });
    const data = fs.readFileSync(archive);
    for (let i = 0; i < data.length; i += 1000) {
      t.write(data.subarray(i, i + 1000));
    }
    t.end();
    assert.deepEqual(snapshotTree(out), snapshotTree(top));
    assert.ok(t.entries >= 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

interface HeaderFields {
  name?: string;
  mode?: number;
  size?: number;
  type?: string;
}

test("handles GNU long names and pax headers from a hand-built archive", () => {
  // Build a tar by hand: GNU 'L' long name record followed by the file.
  const header = (fields: HeaderFields): Buffer => {
    const h = Buffer.alloc(512);
    h.write(fields.name ?? "", 0, 100, "latin1");
    h.write(
      `${(fields.mode ?? 0o644).toString(8).padStart(7, "0")}\0`,
      100,
      8,
      "latin1",
    );
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(
      `${(fields.size ?? 0).toString(8).padStart(11, "0")}\0`,
      124,
      12,
      "latin1",
    );
    h.write("00000000000\0", 136);
    h.write(fields.type ?? "0", 156, 1, "latin1");
    h.write("ustar\0" + "00", 257, 8, "latin1");
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    }
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    return h;
  };
  const pad = (b: Buffer): Buffer =>
    Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const longName = `top/${"d".repeat(150)}/file.txt`;
  const content = Buffer.from("long-named content");
  const paxBody = (() => {
    const rec = (k: string, v: string): string => {
      const base = `${k}=${v}\n`;
      let len = base.length + 1;
      len = `${len} ${base}`.length;
      return `${len} ${base}`;
    };
    return Buffer.from(
      rec("path", `top/pax/${"p".repeat(120)}.dat`) + rec("size", "3"),
    );
  })();
  const tar = Buffer.concat([
    header({ name: "././@LongLink", type: "L", size: longName.length + 1 }),
    pad(Buffer.from(`${longName}\0`)),
    header({ name: "ignored", size: content.length }),
    pad(content),
    header({ name: "pax-header", type: "x", size: paxBody.length }),
    pad(paxBody),
    header({ name: "ignored2", size: 3 }),
    pad(Buffer.from("abc")),
    header({ name: "top/", type: "5", mode: 0o755 }),
    Buffer.alloc(1024),
  ]);
  const out = tmpdir("tar-hand");
  const t = new TarExtractor(out, { strip: 1 });
  t.write(tar);
  t.end();
  assert.equal(
    fs.readFileSync(path.join(out, "d".repeat(150), "file.txt"), "utf8"),
    "long-named content",
  );
  assert.equal(
    fs.readFileSync(path.join(out, "pax", `${"p".repeat(120)}.dat`), "utf8"),
    "abc",
  );
  fs.rmSync(out, { recursive: true, force: true });
});

test("rejects unsafe paths", () => {
  assert.throws(() => safeRelativePath("/etc/passwd", 0), /absolute/);
  assert.throws(() => safeRelativePath("C:/Windows/x", 0), /absolute/);
  assert.throws(() => safeRelativePath("top/../../x", 1), /\.\./);
  assert.throws(() => safeRelativePath("top/a\\b", 1), /unsafe/);
  assert.equal(safeRelativePath("top/", 1), null);
  assert.equal(safeRelativePath("top/./lib//std.zig", 1), "lib/std.zig");
});

test("rejects symlinks that point outside the destination", () => {
  const dest = path.resolve("out");
  const link = path.join(dest, "lib", "link");
  const ok = (target: string): void =>
    checkSymlinkTarget(dest, link, "lib/link", target);
  ok("../LICENSE");
  ok("std/std.zig");
  ok("./../lib/../LICENSE");
  assert.throws(() => ok("../../etc/passwd"), /outside the archive/);
  assert.throws(() => ok("../.."), /outside the archive/);
  assert.throws(() => ok("/etc/passwd"), /outside the archive/);
  assert.throws(() => ok("C:/Windows"), /outside the archive/);
  // A sibling directory whose name merely starts with ".." is fine.
  checkSymlinkTarget(dest, path.join(dest, "a"), "a", "..b");
});

test("detects truncated archives and bad checksums", () => {
  const out = tmpdir("tar-bad");
  const t = new TarExtractor(out, { strip: 1 });
  const h = Buffer.alloc(512, 1);
  assert.throws(() => t.write(h), /checksum/);
  const t2 = new TarExtractor(out, { strip: 0 });
  t2.write(Buffer.alloc(100));
  assert.throws(() => t2.end(), /truncated/);
  fs.rmSync(out, { recursive: true, force: true });
});
