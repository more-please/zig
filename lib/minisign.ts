import crypto from "node:crypto";

/**
 * Minimal, dependency-free verifier for minisign signatures
 * (https://jedisct1.github.io/minisign/), as used by the Zig Software
 * Foundation to sign release archives.
 *
 * A .minisig file looks like:
 *
 *   untrusted comment: <anything>
 *   <base64: sig_alg(2) || key_id(8) || signature(64)>
 *   trusted comment: <text>
 *   <base64: global_signature(64)>
 *
 * sig_alg is "Ed" (signature over the raw file) or "ED" (signature over the
 * BLAKE2b-512 hash of the file). The global signature is an Ed25519 signature
 * over signature || trusted_comment, which binds the comment to the file.
 *
 * A public key is base64 of: "Ed" || key_id(8) || public_key(32).
 */

// DER prefix for an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface PublicKey {
  keyId: Buffer;
  key: crypto.KeyObject;
}

export interface Signature {
  algorithm: "Ed" | "ED";
  prehashed: boolean;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

export function parsePublicKey(text: string): PublicKey {
  const b64 = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("untrusted comment:"))
    .at(-1);
  const buf = Buffer.from(b64 ?? "", "base64");
  if (buf.length !== 42 || buf.toString("latin1", 0, 2) !== "Ed") {
    throw new Error("minisign: malformed public key");
  }
  return {
    keyId: buf.subarray(2, 10),
    key: crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, buf.subarray(10, 42)]),
      format: "der",
      type: "spki",
    }),
  };
}

export function parseSignature(text: string): Signature {
  const lines = text.split(/\r?\n/);
  if (lines.length < 4) {
    throw new Error("minisign: malformed signature file");
  }
  const [untrusted, sigB64, trustedLine, globalB64] = lines as [
    string,
    string,
    string,
    string,
  ];
  if (!untrusted.startsWith("untrusted comment:")) {
    throw new Error("minisign: missing untrusted comment");
  }
  if (!trustedLine.startsWith("trusted comment: ")) {
    throw new Error("minisign: missing trusted comment");
  }
  const sig = Buffer.from(sigB64.trim(), "base64");
  if (sig.length !== 74) {
    throw new Error("minisign: malformed signature");
  }
  const globalSig = Buffer.from(globalB64.trim(), "base64");
  if (globalSig.length !== 64) {
    throw new Error("minisign: malformed global signature");
  }
  const algorithm = sig.toString("latin1", 0, 2);
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`minisign: unsupported signature algorithm "${algorithm}"`);
  }
  const trustedComment = trustedLine.slice("trusted comment: ".length);
  return {
    algorithm,
    prehashed: algorithm === "ED",
    keyId: sig.subarray(2, 10),
    signature: sig.subarray(10, 74),
    trustedComment,
    globalSignature: globalSig,
  };
}

/** Extract the "file:<name>" field from a trusted comment, if present. */
export function signedFileName(trustedComment: string): string | null {
  for (const field of trustedComment.split("\t")) {
    if (field.startsWith("file:")) {
      return field.slice("file:".length);
    }
  }
  return null;
}

export interface VerifyOptions {
  /** BLAKE2b-512 digest of the file (for "ED" signatures). */
  blake2b512?: Buffer;
  /** Raw file contents (required for legacy "Ed" signatures; also accepted for "ED"). */
  data?: Buffer;
  /**
   * If given, the trusted comment's "file:" field must equal this, which
   * prevents a mirror from serving a different (validly signed) archive,
   * e.g. an older version.
   */
  expectedFileName?: string;
}

/** Verify a parsed signature against a parsed public key. Returns true or throws. */
export function verify(
  sig: Signature,
  pub: PublicKey,
  opts: VerifyOptions = {},
): true {
  const { data, expectedFileName } = opts;
  let { blake2b512 } = opts;
  if (!sig.keyId.equals(pub.keyId)) {
    throw new Error("minisign: signature was made with a different key");
  }
  let message: Buffer;
  if (sig.prehashed) {
    if (!blake2b512 && data) {
      blake2b512 = crypto.createHash("blake2b512").update(data).digest();
    }
    if (!blake2b512) {
      throw new Error(
        "minisign: need blake2b512 digest for prehashed signature",
      );
    }
    message = blake2b512;
  } else {
    if (!data) {
      throw new Error("minisign: need raw data for non-prehashed signature");
    }
    message = data;
  }
  if (!crypto.verify(null, message, pub.key, sig.signature)) {
    throw new Error("minisign: signature verification FAILED");
  }
  const globalMessage = Buffer.concat([
    sig.signature,
    Buffer.from(sig.trustedComment, "utf8"),
  ]);
  if (!crypto.verify(null, globalMessage, pub.key, sig.globalSignature)) {
    throw new Error("minisign: trusted comment verification FAILED");
  }
  if (expectedFileName !== undefined) {
    const actual = signedFileName(sig.trustedComment);
    if (actual !== expectedFileName) {
      throw new Error(
        `minisign: signature is for "${actual}", expected "${expectedFileName}"`,
      );
    }
  }
  return true;
}
