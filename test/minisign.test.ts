import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  parsePublicKey,
  parseSignature,
  signedFileName,
  verify,
} from "../lib/minisign.ts";

// Real data from https://ziglang.org/download/ (0.16.0, aarch64-macos).
const ZSF_KEY = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";
// Fetched from https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz.minisig
const REAL_SIG = `untrusted comment: signature from minisign secret key
RUSGOq2NVecA2UCgISG/oZAGNDbHEQ+oKdD+CUUOiEKnRAgzCX58caYr3BdbKTw3nPAvy0bfuSO/wwl0cosJLLq/BGyBgiutIgw=
trusted comment: timestamp:1776173999\tfile:zig-aarch64-macos-0.16.0.tar.xz\thashed
+gAsCwQNWV3ygomHSiXhjThL1FZsdCbBdkeD+3YDoBG9uUJGA4Pyx7APYrUIOSIkPBP0eRbT5b3SeRjSIFjYBw==
`;

test("parses the ZSF public key", () => {
  const pub = parsePublicKey(ZSF_KEY);
  assert.equal(pub.keyId.toString("hex"), "863aad8d55e700d9");
  assert.equal(pub.key.asymmetricKeyType, "ed25519");
});

test("parses a real ZSF signature and its trusted comment verifies", () => {
  const pub = parsePublicKey(ZSF_KEY);
  const sig = parseSignature(REAL_SIG);
  assert.equal(sig.algorithm, "ED");
  assert.ok(sig.prehashed);
  assert.ok(sig.keyId.equals(pub.keyId));
  assert.equal(
    signedFileName(sig.trustedComment),
    "zig-aarch64-macos-0.16.0.tar.xz",
  );
  // We don't have the 54 MB archive here, but the global signature covers
  // (signature || trusted comment) and can be checked on its own.
  const msg = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment)]);
  assert.ok(crypto.verify(null, msg, pub.key, sig.globalSignature));
});

// --- Synthetic end-to-end tests with a throwaway key -----------------------

interface SignOptions {
  fileName: string;
  prehashed?: boolean;
  badKeyId?: boolean;
  tamperComment?: boolean;
}

function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(jwk.x ?? "", "base64url");
  const keyId = crypto.randomBytes(8);
  const pubText = `untrusted comment: test key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  const sign = (
    data: Buffer,
    {
      fileName,
      prehashed = true,
      badKeyId = false,
      tamperComment = false,
    }: SignOptions,
  ): string => {
    const message = prehashed
      ? crypto.createHash("blake2b512").update(data).digest()
      : data;
    const signature = crypto.sign(null, message, privateKey);
    const trusted = `timestamp:1700000000\tfile:${fileName}\t${prehashed ? "hashed" : ""}`;
    const global = crypto.sign(
      null,
      Buffer.concat([signature, Buffer.from(trusted)]),
      privateKey,
    );
    const sigBlob = Buffer.concat([
      Buffer.from(prehashed ? "ED" : "Ed"),
      badKeyId ? crypto.randomBytes(8) : keyId,
      signature,
    ]);
    const comment = tamperComment
      ? trusted.replace(fileName, "other.tar.xz")
      : trusted;
    return `untrusted comment: sig\n${sigBlob.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  };
  return { pubText, sign };
}

test("verifies a prehashed signature over data", () => {
  const { pubText, sign } = makeSigner();
  const data = crypto.randomBytes(5000);
  const pub = parsePublicKey(pubText);
  const sig = parseSignature(sign(data, { fileName: "a.tar.xz" }));
  assert.ok(verify(sig, pub, { data, expectedFileName: "a.tar.xz" }));
  assert.ok(
    verify(sig, pub, {
      blake2b512: crypto.createHash("blake2b512").update(data).digest(),
    }),
  );
});

test("verifies a legacy non-prehashed signature", () => {
  const { pubText, sign } = makeSigner();
  const data = crypto.randomBytes(100);
  const sig = parseSignature(sign(data, { fileName: "a", prehashed: false }));
  assert.ok(verify(sig, parsePublicKey(pubText), { data }));
  assert.throws(
    () =>
      verify(sig, parsePublicKey(pubText), { blake2b512: Buffer.alloc(64) }),
    /need raw data/,
  );
});

test("rejects tampered data", () => {
  const { pubText, sign } = makeSigner();
  const data = crypto.randomBytes(5000);
  const sig = parseSignature(sign(data, { fileName: "a.tar.xz" }));
  data[42] = (data[42] ?? 0) ^ 1;
  assert.throws(
    () => verify(sig, parsePublicKey(pubText), { data }),
    /verification FAILED/,
  );
});

test("rejects a signature for a different file name", () => {
  const { pubText, sign } = makeSigner();
  const data = crypto.randomBytes(100);
  const sig = parseSignature(sign(data, { fileName: "zig-0.15.0.tar.xz" }));
  assert.throws(
    () =>
      verify(sig, parsePublicKey(pubText), {
        data,
        expectedFileName: "zig-0.16.0.tar.xz",
      }),
    /is for "zig-0\.15\.0\.tar\.xz", expected "zig-0\.16\.0\.tar\.xz"/,
  );
});

test("rejects a tampered trusted comment", () => {
  const { pubText, sign } = makeSigner();
  const data = crypto.randomBytes(100);
  const sig = parseSignature(
    sign(data, { fileName: "a", tamperComment: true }),
  );
  assert.throws(
    () => verify(sig, parsePublicKey(pubText), { data }),
    /trusted comment verification FAILED/,
  );
});

test("rejects a signature from a different key", () => {
  const a = makeSigner(),
    b = makeSigner();
  const data = crypto.randomBytes(100);
  const sig = parseSignature(a.sign(data, { fileName: "a" }));
  assert.throws(
    () => verify(sig, parsePublicKey(b.pubText), { data }),
    /different key/,
  );
  const badId = parseSignature(a.sign(data, { fileName: "a", badKeyId: true }));
  assert.throws(
    () => verify(badId, parsePublicKey(a.pubText), { data }),
    /different key/,
  );
});

test("rejects malformed inputs", () => {
  assert.throws(() => parsePublicKey("not base64!!"), /malformed public key/);
  assert.throws(
    () => parseSignature("just one line"),
    /malformed signature file/,
  );
  assert.throws(
    () =>
      parseSignature("untrusted comment: x\nAAAA\ntrusted comment: y\nAAAA\n"),
    /malformed signature/,
  );
});
