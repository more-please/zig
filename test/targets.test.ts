import assert from "node:assert/strict";
import test from "node:test";
import { exeName, zigTarget } from "../lib/targets.ts";

test("maps common Node platforms to Zig targets", () => {
  assert.equal(zigTarget("darwin", "arm64"), "aarch64-macos");
  assert.equal(zigTarget("darwin", "x64"), "x86_64-macos");
  assert.equal(zigTarget("linux", "x64"), "x86_64-linux");
  assert.equal(zigTarget("linux", "arm64"), "aarch64-linux");
  assert.equal(zigTarget("linux", "arm"), "arm-linux");
  assert.equal(zigTarget("linux", "ia32"), "x86-linux");
  assert.equal(zigTarget("linux", "riscv64"), "riscv64-linux");
  assert.equal(zigTarget("linux", "s390x"), "s390x-linux");
  assert.equal(zigTarget("linux", "loong64"), "loongarch64-linux");
  assert.equal(zigTarget("win32", "x64"), "x86_64-windows");
  assert.equal(zigTarget("win32", "arm64"), "aarch64-windows");
  assert.equal(zigTarget("win32", "ia32"), "x86-windows");
  assert.equal(zigTarget("freebsd", "x64"), "x86_64-freebsd");
  assert.equal(zigTarget("netbsd", "arm64"), "aarch64-netbsd");
  assert.equal(zigTarget("openbsd", "riscv64"), "riscv64-openbsd");
});

test("returns null for unsupported combinations", () => {
  assert.equal(zigTarget("aix", "ppc64"), null);
  assert.equal(zigTarget("sunos", "x64"), null);
  assert.equal(zigTarget("linux", "mips"), null);
  assert.equal(zigTarget("android", "arm64"), null);
});

test("every target in zig-release.json is reachable from zigTarget()", async () => {
  const { release } = await import("../lib/install.ts");
  const reachable = new Set<string>();
  const platforms: NodeJS.Platform[] = [
    "darwin",
    "linux",
    "win32",
    "freebsd",
    "netbsd",
    "openbsd",
  ];
  const arches: NodeJS.Architecture[] = [
    "arm64",
    "arm",
    "x64",
    "ia32",
    "riscv64",
    "s390x",
    "loong64",
    "ppc64",
  ];
  for (const p of platforms) {
    for (const a of arches) {
      const t = zigTarget(p, a);
      if (t) {
        reachable.add(t);
      }
    }
  }
  for (const t of Object.keys(release.targets)) {
    assert.ok(
      reachable.has(t),
      `release target ${t} is not produced by zigTarget()`,
    );
  }
});

test("exe name", () => {
  assert.equal(exeName("win32"), "zig.exe");
  assert.equal(exeName("linux"), "zig");
});
