# @moreplease/zig

Installs the official [Zig](https://ziglang.org/) compiler for your platform as
an npm package. **The package version is the Zig version**:
`@moreplease/zig@0.17.0` installs Zig 0.17.0, and upgrading Zig means bumping
the dependency. Fixes to the installer itself ship with the next Zig release.

```sh
npm install --save-dev @moreplease/zig
# or
pnpm add -D @moreplease/zig
```

Then `zig` is on your PATH in package scripts:

```json
{
  "scripts": {
    "build": "zig build"
  }
}
```

or run it directly with `npx zig version` / `pnpm zig version`.

## How it works

Nothing is republished: the toolchain comes straight from the Zig Software
Foundation's release archives. On install (or on first run, see below) the
package:

1. Picks the archive for your platform from the list pinned in
   [`zig-release.json`](./zig-release.json), which records the official URL,
   size and SHA-256 of every prebuilt target for this Zig version.
2. Downloads it from a randomly chosen
   [community mirror](https://ziglang.org/download/community-mirrors/), falling
   back to other mirrors and finally to ziglang.org itself, as the ZSF asks
   automated downloaders to do.
3. Verifies the download three ways before touching it: the pinned size and
   SHA-256, the ZSF's [minisign](https://jedisct1.github.io/minisign/)
   signature, and the file name recorded inside the signed comment (so a
   mirror cannot substitute a different, validly signed archive).
4. Extracts it into `node_modules/@moreplease/zig/zig/` and checks that
   `zig version` reports the expected version.

The package has **no runtime dependencies** and requires Node 22 or later.
Signature verification uses Node's built-in Ed25519 and BLAKE2b. Extraction uses the system `tar` when it
works (bsdtar on macOS and Windows handles both `.tar.xz` and `.zip`), and
otherwise falls back to a bundled pure-JS xz/tar/zip extractor, so it also
works in minimal container images such as `node:slim` and `node:alpine` that
lack the `xz` binary.

### Supported platforms

Every target the ZSF publishes binaries for: macOS (x64, arm64), Linux (x64,
arm64, arm, x86, riscv64, powerpc64le, s390x, loongarch64), Windows (x64,
arm64, x86), FreeBSD, NetBSD and OpenBSD. Linux binaries are static, so glibc
vs musl does not matter. On an unsupported platform the install fails with a
clear message; set `ZIG` (below) to use your own Zig.

## Install-time vs first-run download

The download normally happens in the package's `postinstall` script. pnpm 10+
does not run dependency build scripts until you approve them, and CI setups
often pass `--ignore-scripts`. Both are fine: if the toolchain is missing when
`zig` is first run, the launcher downloads it then. For the same reason a
download failure during `postinstall` (offline, firewalled) only prints a
warning rather than failing your install. To let pnpm do it at install time
instead, approve the script:

```yaml
# pnpm-workspace.yaml (pnpm 11 and later)
allowBuilds:
  "@moreplease/zig": true
```

(pnpm 10 used `onlyBuiltDependencies: ["@moreplease/zig"]` instead; or run
`pnpm approve-builds` and pick it from the list).

## Environment variables

| Variable | Effect |
| --- | --- |
| `ZIG` | Path to an existing `zig` binary (Makefile style, like `CC`). Skips the download entirely and runs that binary instead. Useful in Docker images or CI where Zig is already provisioned. The version is not checked. |
| `MOREPLEASE_ZIG_MIRRORS` | Comma- or whitespace-separated mirror base URLs to use instead of the community list, for example an internal mirror. Downloads are still verified. |
| `MOREPLEASE_ZIG_EXTRACTOR` | `auto` (default), `tar` or `js`. Forces the extraction method. |

Node's `fetch` does not read `HTTP_PROXY`/`HTTPS_PROXY` by default. On Node 24
and later, set `NODE_USE_ENV_PROXY=1` to make it do so.

## JavaScript API

```js
import { ensureZig, zigBinaryPath, version } from "@moreplease/zig";

const zig = await ensureZig(); // absolute path; downloads on first call if needed
spawnSync(zig, ["build"], { stdio: "inherit" });
```

| Export | Description |
| --- | --- |
| `version` | The pinned Zig version (same as the package version). |
| `ensureZig({ log? })` | Installs if necessary and resolves to the binary path. |
| `zigBinaryPath()` | Where the binary is or will be. Synchronous, no download. |
| `isInstalled()` | Whether the pinned version is present. |
| `zigTarget(platform?, arch?)` | Node platform/arch to Zig target name, e.g. `aarch64-macos`. |

Build scripts that invoke Zig many times should spawn the path from
`ensureZig()` directly rather than going through the `zig` launcher, which pays
Node's startup cost on every call.

## Caching in CI

The toolchain lives inside `node_modules/@moreplease/zig/zig/`, so any cache
that covers `node_modules` (or pnpm's virtual store) carries it across runs.
With GitHub Actions and `actions/cache` keyed on your lockfile, a cache hit
means no download at all. Downloads are 50 to 100 MB, so this is worth doing.

## Upgrading Zig (maintainers)

```sh
pnpm update-zig          # pin the latest stable release
pnpm update-zig 0.18.0   # or a specific one
```

This rewrites `zig-release.json` from the official
[index](https://ziglang.org/download/index.json), refreshes the mirror
snapshot, and sets the package version to the Zig version. Review the diff,
run the tests, publish.

Only stable releases are tracked.

## Development

The source is TypeScript. During development Node (22.18 or later) runs the
`.ts` files directly via type stripping, so tests and scripts need no build.
Only erasable syntax is used (no enums, namespaces or parameter properties),
which `tsconfig.json` enforces with `erasableSyntaxOnly`.

The published package is compiled JavaScript plus `.d.ts` files in `dist/`,
because Node deliberately refuses to strip types from anything under
`node_modules`. `pnpm build` produces it and runs automatically on pack and
publish.

```sh
pnpm install --ignore-scripts   # dev dependencies: typescript, @types/node
pnpm build          # strict type-check of everything (incl. tests) and emit dist/
pnpm test           # unit tests (minisign, xz, tar, zip, target mapping)
pnpm test:install   # packs the package and installs it with npm and pnpm; needs network
```

## Security notes

- The ZSF public key is pinned in `zig-release.json` and in
  `scripts/update-zig.mjs`. Changing it is a deliberate, reviewable edit.
- Mirrors are untrusted by design. Every archive must match the pinned SHA-256
  **and** carry a valid ZSF signature naming that exact file.
- Archive paths are sanitised during extraction (no absolute paths, no `..`).
- The verified archive is extracted into a temporary directory and moved into
  place only after `zig version` succeeds.

## License

0BSD. Zig itself is MIT licensed; see the `LICENSE` file inside the installed
toolchain directory.
