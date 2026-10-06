/**
 * @moreplease/zig — public API.
 *
 * Most users just want the `zig` executable this package puts on PATH. Build
 * scripts that spawn Zig many times can avoid the Node launcher overhead by
 * calling `ensureZig()` once and spawning the returned path directly.
 */

export type { Release, ReleaseTarget } from "./install.ts";
export {
  ENV,
  ensureZig,
  envBinaryPath,
  installedBinaryPath,
  isInstalled,
} from "./install.ts";
export { zigTarget } from "./targets.ts";

import { envBinaryPath, installedBinaryPath, release } from "./install.ts";

/** The Zig version this package installs (the package version without its packaging revision). */
export const version: string = release.version;

/**
 * Where the Zig binary is (or will be, once installed). Synchronous and
 * side-effect free; use `ensureZig()` when you need it to actually exist.
 */
export function zigBinaryPath(): string {
  return envBinaryPath() ?? installedBinaryPath();
}
