import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSessionToken, verifySessionToken, checkPassword, isAuthEnabled, sessionCookieOptions } from "../lib/session.ts";

describe("session", () => {
  before(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
  });

  describe("createSessionToken / verifySessionToken", () => {
    it("valid token passes", () => {
      const token = createSessionToken();
      assert.equal(verifySessionToken(token), true);
    });

    it("tampered payload rejected", () => {
      const token = createSessionToken();
      const [b64, mac] = token.split(".");
      const bad = Buffer.from('{"iat":0}').toString("base64url");
      assert.equal(verifySessionToken(`${bad}.${mac}`), false);
    });

    it("tampered mac rejected", () => {
      const token = createSessionToken();
      const [b64] = token.split(".");
      assert.equal(verifySessionToken(`${b64}.invalidsig`), false);
    });

    it("empty / undefined rejected", () => {
      assert.equal(verifySessionToken(undefined), false);
      assert.equal(verifySessionToken(""), false);
      assert.equal(verifySessionToken("garbage"), false);
    });

    it("expired token rejected", () => {
      const key = process.env.TOKEN_ENCRYPTION_KEY;
      const payload = JSON.stringify({ iat: Date.now() - 25 * 60 * 60 * 1000 });
      const b64 = Buffer.from(payload).toString("base64url");
      const mac = createHmac("sha256", key).update(b64).digest("base64url");
      assert.equal(verifySessionToken(`${b64}.${mac}`), false);
    });
  });

  describe("checkPassword", () => {
    before(() => { process.env.APP_PASSWORD = "correct-password"; });
    after(() => { delete process.env.APP_PASSWORD; });

    it("correct password passes", () => {
      assert.equal(checkPassword("correct-password"), true);
    });

    it("wrong password fails", () => {
      assert.equal(checkPassword("wrong"), false);
    });

    it("empty password fails", () => {
      assert.equal(checkPassword(""), false);
    });
  });

  describe("isAuthEnabled", () => {
    it("false when APP_PASSWORD not set", () => {
      const saved = process.env.APP_PASSWORD;
      delete process.env.APP_PASSWORD;
      assert.equal(isAuthEnabled(), false);
      if (saved !== undefined) process.env.APP_PASSWORD = saved;
    });

    it("true when APP_PASSWORD set", () => {
      process.env.APP_PASSWORD = "secret";
      assert.equal(isAuthEnabled(), true);
      delete process.env.APP_PASSWORD;
    });
  });

  describe("sessionCookieOptions", () => {
    it("secure=false → no Secure flag", () => {
      const opts = sessionCookieOptions(false);
      assert.equal(opts.secure, false);
      assert.equal(opts.httpOnly, true);
      assert.equal(opts.sameSite, "lax");
    });

    it("secure=true → Secure flag", () => {
      const opts = sessionCookieOptions(true);
      assert.equal(opts.secure, true);
    });
  });
});
