import os from "node:os";

/**
 * Map a Node.js (platform, arch) pair to the Zig target name used in the
 * official download archives, e.g. "aarch64-macos" or "x86_64-windows".
 *
 * Zig's prebuilt binaries are statically linked, so the libc flavour
 * (glibc vs musl) does not matter on Linux.
 */
const CPU: Partial<Record<NodeJS.Architecture, string>> = {
  arm64: "aarch64",
  arm: "arm",
  x64: "x86_64",
  ia32: "x86",
  riscv64: "riscv64",
  s390x: "s390x",
  loong64: "loongarch64",
  // Zig only ships little-endian PowerPC builds; checked below.
  ppc64: "powerpc64le",
};

const OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
  freebsd: "freebsd",
  netbsd: "netbsd",
  openbsd: "openbsd",
};

export function zigTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  const cpu = CPU[arch];
  const osName = OS[platform];
  if (!cpu || !osName) {
    return null;
  }
  if (arch === "ppc64" && os.endianness() !== "LE") {
    return null;
  }
  return `${cpu}-${osName}`;
}

export function exeName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "zig.exe" : "zig";
}
