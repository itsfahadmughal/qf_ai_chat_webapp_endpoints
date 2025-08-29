import crypto from "crypto";

function getMasterKey(): Buffer {
  const b64 = process.env.ENCRYPTION_KEY_BASE64 || "";
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error("ENCRYPTION_KEY_BASE64 must be 32 bytes base64.");
  }
  return raw;
}

export function encryptSecret(plain: string) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12); // GCM nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encKey: ct, iv, tag };
}

export function decryptSecret(encKey: Buffer, iv: Buffer, tag: Buffer): string {
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(encKey), decipher.final()]);
  return pt.toString("utf8");
}
