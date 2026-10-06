import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { extractArchive } from "../lib/extract.ts";
import { pseudoRandom, run, snapshotTree, tmpdir } from "./_helpers.ts";

const win = process.platform === "win32";

/** A small release-like tree packed as .tar.xz by the system tar, or null. */
function makeArchive(dir: string): { archive: string; top: string } | null {
  const top = path.join(dir, "zig-test-0.0.1");
  fs.mkdirSync(path.join(top, "lib", "std"), { recursive: true });
  fs.writeFileSync(path.join(top, "lib", "std", "std.zig"), "// std\n");
  fs.writeFileSync(path.join(top, "LICENSE"), "MIT\n");
  fs.writeFileSync(path.join(top, "blob.bin"), pseudoRandom(100_000));
  fs.writeFileSync(path.join(top, "zig"), "#!/bin/sh\necho 0.0.1\n", {
    mode: 0o755,
  });
  const archive = path.join(dir, "zig-test-0.0.1.tar.xz");
  try {
    run("tar", ["-cJf", archive, "-C", dir, path.basename(top)]);
  } catch {
    return null; // this tar cannot write .tar.xz (GNU tar without xz)
  }
  return { archive, top };
}

test("auto mode uses the system tar when it can read the archive", (t) => {
  const dir = tmpdir("extract");
  const made = makeArchive(dir);
  if (!made) {
    t.skip("system tar cannot create .tar.xz");
    return;
  }
  const logs: string[] = [];
  return extractArchive(made.archive, path.join(dir, "out"), {
    log: (m) => logs.push(m),
  }).then((method) => {
    assert.equal(method, "tar");
    // --no-same-owner must be accepted first time, without the retry.
    assert.deepEqual(logs, []);
    assert.deepEqual(
      snapshotTree(path.join(dir, "out")),
      snapshotTree(made.top),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("auto mode falls back to the built-in extractor when tar fails", {
  skip: win && "needs a shell script on PATH",
}, async () => {
  const dir = tmpdir("extract");
  const made = makeArchive(dir);
  // Shadow the real tar with one that always fails.
  const fakeBin = path.join(dir, "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "tar"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${savedPath}`;
  try {
    const archive = made?.archive ?? path.join(dir, "zig-test-0.0.1.tar.xz");
    if (!made) {
      // No real .tar.xz available; a forced-tar run still has to report the
      // failure rather than hang or fall back.
      fs.writeFileSync(archive, "");
    }
    await assert.rejects(
      extractArchive(archive, path.join(dir, "out-tar"), { method: "tar" }),
      /system tar failed: exit 1/,
    );
    if (made) {
      const logs: string[] = [];
      const method = await extractArchive(archive, path.join(dir, "out"), {
        method: "auto",
        log: (m) => logs.push(m),
      });
      assert.equal(method, "js");
      assert.ok(logs.some((l) => /using built-in extractor/.test(l)));
      assert.deepEqual(
        snapshotTree(path.join(dir, "out")),
        snapshotTree(made.top),
      );
    }
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
