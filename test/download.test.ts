import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import test from "node:test";
import { downloadVerified } from "../lib/download.ts";
import { makeSigner, pseudoRandom, tmpdir } from "./_helpers.ts";

const FILE = "zig-x86_64-linux-0.0.1.tar.xz";
const data = pseudoRandom(300_000);
const shasum = crypto.createHash("sha256").update(data).digest("hex");
const { pubText, sign } = makeSigner();
const goodSig = sign(data, { fileName: FILE });

/** How a fake mirror misbehaves. Each mirror is a path prefix on one server. */
type Behaviour =
  | "good"
  | "missing"
  | "corrupt"
  | "wrong-file"
  | "no-sig"
  | "slow"
  | "hang";

interface Server {
  /** Paths requested, in order. */
  requests: string[];
  mirror(b: Behaviour): string;
  close(): Promise<void>;
}

async function serve(): Promise<Server> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    requests.push(pathname);
    const [, behaviour, name] = pathname.split("/");
    const isSig = name === `${FILE}.minisig`;
    if (name !== FILE && !isSig) {
      res.writeHead(404).end();
      return;
    }
    switch (behaviour as Behaviour) {
      case "missing":
        res.writeHead(404).end();
        return;
      case "hang":
        return; // never answers; the client must time out
      case "no-sig":
        if (isSig) {
          res.writeHead(404).end();
          return;
        }
        break;
      case "wrong-file":
        if (isSig) {
          res.end(sign(data, { fileName: "zig-x86_64-linux-0.0.0.tar.xz" }));
          return;
        }
        break;
      case "corrupt":
        if (!isSig) {
          const bad = Buffer.from(data);
          bad[100] = (bad[100] ?? 0) ^ 1;
          res.end(bad);
          return;
        }
        break;
      case "slow":
        if (!isSig) {
          // Headers straight away, then the body trickles out over ~600 ms.
          res.writeHead(200, { "content-length": String(data.length) });
          const step = Math.ceil(data.length / 12);
          let off = 0;
          const timer = setInterval(() => {
            res.write(data.subarray(off, off + step));
            off += step;
            if (off >= data.length) {
              clearInterval(timer);
              res.end();
            }
          }, 50);
          return;
        }
        break;
      case "good":
        break;
    }
    res.end(isSig ? goodSig : data);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    requests,
    mirror: (b) => `http://127.0.0.1:${port}/${b}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function download(
  s: Server,
  mirrors: Behaviour[],
  official: Behaviour,
  timeouts?: { headerMs?: number; idleMs?: number },
): Promise<{ url: string; logs: string[]; dest: string; dir: string }> {
  const dir = tmpdir("download");
  const dest = path.join(dir, FILE);
  const logs: string[] = [];
  const req = {
    fileName: FILE,
    officialUrl: `${s.mirror(official)}/${FILE}`,
    shasum,
    size: data.length,
    mirrors: mirrors.map((m) => s.mirror(m)),
    publicKey: pubText,
    dest,
    log: (m: string) => logs.push(m),
  };
  const { url } = await downloadVerified(timeouts ? { ...req, timeouts } : req);
  return { url, logs, dest, dir };
}

test("downloads and verifies from the first working mirror", async () => {
  const s = await serve();
  try {
    const r = await download(s, ["missing", "corrupt", "good"], "missing");
    assert.ok(r.url.startsWith(s.mirror("good")));
    assert.ok(fs.readFileSync(r.dest).equals(data));
    assert.ok(!fs.existsSync(`${r.dest}.part`));
    assert.ok(r.logs.some((l) => /HTTP 404/.test(l)));
    assert.ok(r.logs.some((l) => /SHA-256 mismatch/.test(l)));
    fs.rmSync(r.dir, { recursive: true, force: true });
  } finally {
    await s.close();
  }
});

test("a slow but healthy download is not cut off by the header timeout", async () => {
  const s = await serve();
  try {
    const r = await download(s, ["slow"], "missing", { headerMs: 200 });
    assert.ok(r.url.startsWith(s.mirror("slow")));
    assert.ok(fs.readFileSync(r.dest).equals(data));
    fs.rmSync(r.dir, { recursive: true, force: true });
  } finally {
    await s.close();
  }
});

test("gives up on a mirror whose headers never arrive", async () => {
  const s = await serve();
  try {
    const r = await download(s, ["hang", "good"], "missing", {
      headerMs: 200,
    });
    assert.ok(r.url.startsWith(s.mirror("good")));
    assert.ok(r.logs.some((l) => /failed: timed out/.test(l)));
    fs.rmSync(r.dir, { recursive: true, force: true });
  } finally {
    await s.close();
  }
});

test("rejects a missing or mismatched signature and tries the next source", async () => {
  const s = await serve();
  try {
    const r = await download(s, ["wrong-file", "no-sig"], "good");
    assert.ok(r.url.startsWith(s.mirror("good")));
    assert.ok(r.logs.some((l) => /is for "zig-x86_64-linux-0\.0\.0/.test(l)));
    assert.ok(r.logs.some((l) => /HTTP 404/.test(l)));
    // The signature is checked first, so the archive itself was never
    // requested from the bad mirrors.
    assert.deepEqual(
      s.requests.filter((p) => p.endsWith(`/${FILE}`)),
      [`/good/${FILE}`],
    );
    fs.rmSync(r.dir, { recursive: true, force: true });
  } finally {
    await s.close();
  }
});

test("reports every failure when no source works", async () => {
  const s = await serve();
  try {
    await assert.rejects(
      download(s, ["missing", "corrupt"], "missing"),
      (e) => {
        const msg = (e as Error).message;
        assert.match(msg, /could not download/);
        assert.match(msg, /HTTP 404/);
        assert.match(msg, /SHA-256 mismatch/);
        return true;
      },
    );
  } finally {
    await s.close();
  }
});
