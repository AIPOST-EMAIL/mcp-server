import { createHash, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Serialize a value to a canonical JSON string with keys sorted alphabetically.
 * This ensures JSON.stringify produces identical output regardless of the
 * platform or JSON library, as long as keys are sorted before serialization.
 *
 * Required because Go's encoding/json reorders map keys alphabetically,
 * so the server-side SHA256(JSON.stringify(payload)) would differ from
 * the client-side hash if keys are in insertion order.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJsonStringify(v));
    return "[" + items.join(",") + "]";
  }
  // Object: sort keys alphabetically, recurse into values
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ":" + canonicalJsonStringify(v);
  });
  return "{" + pairs.join(",") + "}";
}

/**
 * ED25519 signer for AIPost.email.
 *
 * Two signing modes:
 * 1. Request-level: signs METHOD\nPATH\nSHA256_HEX(body)\nTIMESTAMP_MS
 *    → added as X-Mail-Signature / X-Mail-Timestamp headers
 * 2. Message-level: signs SHA256(canonicalJsonStringify(payload))
 *    → stored in the "signature" field of the message
 *
 * Uses Node.js crypto.sign() / crypto.verify() which support
 * raw ED25519 operations. createSign/createVerify do NOT support
 * ED25519 on all platforms.
 */
export class Ed25519Signer {
  private pemKey: string | null = null;
  public readonly enabled: boolean;

  constructor(config: { privateKeyPath?: string }) {
    if (config.privateKeyPath) {
      try {
        this.pemKey = readFileSync(config.privateKeyPath, "utf-8");

        // Support raw 64-char hex seed → wrap as PKCS8 PEM
        if (!this.pemKey.includes("BEGIN PRIVATE KEY")) {
          const hex = this.pemKey.replace(/\s/g, "");
          if (/^[0-9a-fA-F]{64}$/.test(hex)) {
            const der = Buffer.concat([
              Buffer.from("302e020100300506032b657004220420", "hex"),
              Buffer.from(hex, "hex"),
            ]);
            const b64 = der.toString("base64");
            const lines = (b64.match(/.{1,64}/g) || []).join("\n");
            this.pemKey =
              "-----BEGIN PRIVATE KEY-----\n" + lines + "\n-----END PRIVATE KEY-----\n";
          }
        }

        // Validate by doing a test sign
        sign(null, Buffer.from("test"), this.pemKey);
        this.enabled = true;
      } catch (e) {
        console.error("[aipost-mcp] ED25519 key load failed:", e);
        this.enabled = false;
      }
    } else {
      this.enabled = false;
    }
  }

  /**
   * Request-level signing.
   * Signing string: METHOD\nPATH\nSHA256_HEX(body)\nTIMESTAMP_MS
   */
  requestSignature(
    method: string,
    path: string,
    body: string,
    timestampMs: number
  ): { signature: string; timestamp: number } | null {
    if (!this.pemKey) return null;
    // Server uses path_and_query() for signing, so query parameters
    // MUST be included in the signing string for GET requests.
    const pathForSigning = path;
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const signingString =
      method + "\n" + pathForSigning + "\n" + bodyHash + "\n" + timestampMs;
    const sig = sign(null, Buffer.from(signingString, "utf-8"), this.pemKey);
    return { signature: sig.toString("base64"), timestamp: timestampMs };
  }

  /**
   * Message-level signing: signs SHA256(JSON.stringify(payload)).
   */
  messageSignature(payload: Record<string, unknown>): string | null {
    if (!this.pemKey) return null;
    const hash = createHash("sha256")
      .update(canonicalJsonStringify(payload))
      .digest();
    return sign(null, hash, this.pemKey).toString("base64");
  }

  /**
   * Verify a message-level signature against a 64-char hex public key.
   */
  static verifyMessageSignature(
    payload: Record<string, unknown>,
    signatureBase64: string,
    publicKeyHex: string
  ): boolean {
    try {
      const hash = createHash("sha256")
        .update(canonicalJsonStringify(payload))
        .digest();
      const sig = Buffer.from(signatureBase64, "base64");
      const rawKey = Buffer.from(publicKeyHex, "hex");
      // SPKI DER prefix for ED25519 public key
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        rawKey,
      ]);
      return verify(null, hash, { key: spki, format: "der", type: "spki" }, sig);
    } catch {
      return false;
    }
  }
}
