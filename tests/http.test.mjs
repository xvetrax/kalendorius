import assert from "node:assert/strict";
import test from "node:test";
import { oauthRedirectUri } from "../lib/http.ts";

test("OAuth callback negali nukrypti nuo APP_ORIGIN", () => {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "http://localhost:3000";
  try {
    assert.equal(oauthRedirectUri("http://localhost:3000/api/google/callback", "/api/google/callback"), "http://localhost:3000/api/google/callback");
    assert.throws(() => oauthRedirectUri("https://example.com/api/google/callback", "/api/google/callback"));
    assert.throws(() => oauthRedirectUri("http://localhost:3000/other", "/api/google/callback"));
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous;
  }
});
