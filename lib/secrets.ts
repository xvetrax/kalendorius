import crypto from "node:crypto";

function key() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || !/^[a-f\d]{64}$/i.test(raw)) {
    throw new Error("TOKEN_ENCRYPTION_KEY turi būti 64 simbolių hex reikšmė");
  }
  return Buffer.from(raw, "hex");
}

export function isTokenEncryptionConfigured() {
  return /^[a-f\d]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY || "");
}

export function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string) {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
