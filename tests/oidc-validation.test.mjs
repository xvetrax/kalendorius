/**
 * tests/oidc-validation.test.mjs — H7 OIDC ID token validation tests
 *
 * Tests lib/oidc.ts verifyGoogleIdToken and verifyMicrosoftIdToken:
 *  a. Expired id_token rejected
 *  b. Wrong audience rejected
 *  c. Wrong issuer rejected
 *  d. Tampered signature rejected
 *  e. Wrong nonce rejected
 *  f. Valid token (mocked JWKS) accepted
 *
 * Pattern: ESM, node:test + node:assert, mocks globalThis.fetch.
 *
 * We generate real RSA keys via node:crypto WebCrypto so that the actual
 * RS256 signature verification path in lib/oidc.ts is exercised end-to-end.
 */

import assert from "node:assert/strict";
import { test, after, before } from "node:test";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Module hooks: resolve @/ aliases (lib/oidc.ts has no @/ imports, but future-proof)
// ---------------------------------------------------------------------------

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier.startsWith("@/")
        ? pathToFileURL(path.resolve(import.meta.dirname, "..", specifier.slice(2) + ".ts")).href
        : specifier,
      context,
    );
  },
});

after(() => {
  hooks.deregister();
});

// ---------------------------------------------------------------------------
// Import the modules under test
// ---------------------------------------------------------------------------

const { verifyGoogleIdToken, verifyMicrosoftIdToken } = await import("../lib/oidc.ts");

// ---------------------------------------------------------------------------
// RSA key generation helpers
// ---------------------------------------------------------------------------

/**
 * Generate an RSA-2048 key pair suitable for RS256 JWTs.
 * Returns { privateKey, publicKey, jwk } where jwk is the public JsonWebKey.
 */
async function generateRsaKeyPair() {
  const { privateKey, publicKey } = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", publicKey);

  return { privateKey, publicKey, jwk: { ...publicJwk, kid: "test-key-id", use: "sig", alg: "RS256" } };
}

// ---------------------------------------------------------------------------
// JWT construction helpers
// ---------------------------------------------------------------------------

function b64url(buf) {
  const base64 = Buffer.from(buf).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function encodeJwtPart(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

/**
 * Build and sign a JWT with the given key and claims.
 * kid in the header matches the JWK's kid so OIDC verifier can find the right key.
 */
async function buildJwt(privateKey, claims, headerOverrides = {}) {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: "test-key-id",
    ...headerOverrides,
  };

  const headerB64 = encodeJwtPart(header);
  const payloadB64 = encodeJwtPart(claims);
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBuf = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = b64url(sigBuf);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/**
 * Build a standard set of valid Google claims.
 */
function googleClaims({ sub, aud, nonce, exp, iss } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: iss ?? "https://accounts.google.com",
    sub: sub ?? "google-sub-12345",
    aud: aud ?? "test-google-client-id",
    exp: exp ?? nowSec + 3600,
    iat: nowSec,
    nonce: nonce ?? "test-nonce-value",
    email: "user@example.com",
    email_verified: true,
    name: "Test User",
  };
}

/**
 * Build a standard set of valid Microsoft claims.
 */
function microsoftClaims({ sub, aud, nonce, exp, iss, tid } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const tenantId = tid ?? "test-tenant-id";
  return {
    iss: iss ?? `https://login.microsoftonline.com/${tenantId}/v2.0`,
    sub: sub ?? "ms-sub-12345",
    aud: aud ?? "test-ms-client-id",
    tid: tenantId,
    exp: exp ?? nowSec + 3600,
    iat: nowSec,
    nonce: nonce ?? "test-nonce-ms",
    email: "user@example.com",
    name: "Test User",
    preferred_username: "user@example.com",
  };
}

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

/**
 * The OIDC module caches JWKS by URL with a 1-hour TTL and also caches the
 * discovery doc that produces the JWKS URI. To prevent test-to-test cache
 * poisoning we assign each fetch mock a unique counter so that every call
 * produces a fresh discovery URL, which in turn produces a fresh JWKS URI
 * that is not in the cache yet.
 *
 * The counter is embedded in the JWKS URI so that each mock invocation
 * registers a separate cache entry.
 */
let _mockCounter = 0;

/**
 * Creates a fetch mock that serves:
 *  - Google discovery doc → points to a unique /jwks URL
 *  - JWKS endpoint → returns the given public JWK
 *  - Microsoft discovery + JWKS similarly
 *
 * opts.emptyJwks   – serve an empty keys array (to test "no key found")
 * opts.jwksFails   – serve a 500 from the JWKS endpoint
 */
function makeFetchMock(jwk, opts = {}) {
  const id = ++_mockCounter;
  // Use unique URIs per mock so the module-level JWKS cache never reuses an
  // entry from a previous test that might have had different opts (e.g. emptyJwks).
  const googleJwksUri = `https://www.googleapis.com/oauth2/v3/certs?test=${id}`;
  const msJwksUri = `https://login.microsoftonline.com/test-tenant-id/discovery/v2.0/keys?test=${id}`;
  const msCommonJwksUri = `https://login.microsoftonline.com/common/discovery/v2.0/keys?test=${id}`;

  // The OIDC lib also caches the google JWKS URI from a discovery doc, so the
  // discovery endpoint must be freshly fetched on each test. The module caches
  // the google discovery URL for 24 hours, but it only re-fetches when the
  // cache is stale — since we override fetch per test we always return the
  // current id-based JWKS URI from the discovery mock.
  //
  // NOTE: googleJwksUriFetchedAt is module-level; to bypass the discovery cache
  // we rely on the fact that our mock is called on every fetch (the real network
  // is not involved) and the discovery TTL check always uses Date.now(). We
  // can't reset the module's private variable, so instead we make the DISCOVERY
  // URL itself unique per mock by adding ?test=<id> to the jwks_uri inside the
  // discovery response — the discovery endpoint URL is fixed but the *returned*
  // jwks_uri is unique, so the JWKS-level cache misses every time.

  return async function mockFetch(url) {
    const urlStr = typeof url === "string" ? url : url.toString();

    // Google discovery
    if (
      urlStr === "https://accounts.google.com/.well-known/openid-configuration" ||
      (urlStr.includes("accounts.google.com") && urlStr.includes("openid-configuration"))
    ) {
      return new Response(
        JSON.stringify({ jwks_uri: googleJwksUri }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Google JWKS
    if (urlStr.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
      if (opts.jwksFails) return new Response("", { status: 500 });
      const keys = opts.emptyJwks ? [] : [jwk];
      return new Response(
        JSON.stringify({ keys }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Microsoft discovery
    if (
      urlStr.includes("login.microsoftonline.com") &&
      urlStr.includes("openid-configuration")
    ) {
      const uri = urlStr.includes("/common/") ? msCommonJwksUri : msJwksUri;
      return new Response(
        JSON.stringify({ jwks_uri: uri }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Microsoft JWKS
    if (
      urlStr.startsWith("https://login.microsoftonline.com/test-tenant-id/discovery") ||
      urlStr.startsWith("https://login.microsoftonline.com/common/discovery")
    ) {
      if (opts.jwksFails) return new Response("", { status: 500 });
      const keys = opts.emptyJwks ? [] : [jwk];
      return new Response(
        JSON.stringify({ keys }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fallback — should not be reached in tests
    throw new Error(`Unexpected fetch in OIDC test mock: ${urlStr}`);
  };
}

// ---------------------------------------------------------------------------
// Test setup: generate RSA key pair at module load time (top-level await)
// so it is available when tests are registered, not just when they execute.
// ---------------------------------------------------------------------------

const keyPair = await generateRsaKeyPair();

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helper: run a test with a lazily-created fetch mock.
//
// withFetch(opts, fn) — creates a fresh mock using current keyPair + opts,
// then calls fn() with globalThis.fetch pointing at that mock.
// The mock is created inside the wrapper so that keyPair is always defined.
// ---------------------------------------------------------------------------

function withFetch(opts, fn) {
  return async () => {
    globalThis.fetch = makeFetchMock(keyPair.jwk, opts);
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

// ---------------------------------------------------------------------------
// Test (a): Expired id_token is rejected
// ---------------------------------------------------------------------------

test(
  "OIDC Google: expired id_token is rejected",
  withFetch({}, async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims({ exp: nowSec - 3600 }), // expired 1 hour ago
    );

    let threw = false;
    try {
      await verifyGoogleIdToken(token, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401, "Should throw 401");
      assert.match(e.message, /expired/i, "Error must mention expiry");
    }
    assert.ok(threw, "Expired token must be rejected");
  }),
);

test(
  "OIDC Microsoft: expired id_token is rejected",
  withFetch({}, async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await buildJwt(
      keyPair.privateKey,
      microsoftClaims({ exp: nowSec - 60 }),
    );

    let threw = false;
    try {
      await verifyMicrosoftIdToken(token, "test-nonce-ms", "test-tenant-id", "test-ms-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /expired/i);
    }
    assert.ok(threw, "Expired Microsoft token must be rejected");
  }),
);

// ---------------------------------------------------------------------------
// Test (b): Wrong audience is rejected
// ---------------------------------------------------------------------------

test(
  "OIDC Google: wrong audience is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims({ aud: "wrong-client-id" }),
    );

    let threw = false;
    try {
      await verifyGoogleIdToken(token, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /audience/i);
    }
    assert.ok(threw, "Wrong audience must be rejected");
  }),
);

test(
  "OIDC Microsoft: wrong audience is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      microsoftClaims({ aud: "evil-client-id" }),
    );

    let threw = false;
    try {
      await verifyMicrosoftIdToken(token, "test-nonce-ms", "test-tenant-id", "test-ms-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /audience/i);
    }
    assert.ok(threw, "Wrong audience must be rejected for Microsoft");
  }),
);

// ---------------------------------------------------------------------------
// Test (c): Wrong issuer is rejected
// ---------------------------------------------------------------------------

test(
  "OIDC Google: wrong issuer is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims({ iss: "https://evil.example.com" }),
    );

    let threw = false;
    try {
      await verifyGoogleIdToken(token, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /issuer/i);
    }
    assert.ok(threw, "Wrong issuer must be rejected for Google");
  }),
);

test(
  "OIDC Microsoft: wrong issuer is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      microsoftClaims({ iss: "https://evil.example.com/v2.0" }),
    );

    let threw = false;
    try {
      await verifyMicrosoftIdToken(token, "test-nonce-ms", "test-tenant-id", "test-ms-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /issuer/i);
    }
    assert.ok(threw, "Wrong issuer must be rejected for Microsoft");
  }),
);

// ---------------------------------------------------------------------------
// Test (d): Tampered signature is rejected
// ---------------------------------------------------------------------------

test(
  "OIDC Google: tampered signature is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(keyPair.privateKey, googleClaims());

    // Replace last character of signature to tamper it
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -4) + "AAAA";
    const tampered = parts.join(".");

    let threw = false;
    try {
      await verifyGoogleIdToken(tampered, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /signature|key/i);
    }
    assert.ok(threw, "Tampered signature must be rejected");
  }),
);

test(
  "OIDC Google: tampered payload is rejected (signature check fails)",
  withFetch({}, async () => {
    const token = await buildJwt(keyPair.privateKey, googleClaims());

    // Swap in a new payload claiming a different sub but keep original signature
    const parts = token.split(".");
    const evilPayload = encodeJwtPart({ ...googleClaims(), sub: "attacker-sub" });
    const tampered = `${parts[0]}.${evilPayload}.${parts[2]}`;

    let threw = false;
    try {
      await verifyGoogleIdToken(tampered, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
    }
    assert.ok(threw, "Token with tampered payload must be rejected");
  }),
);

test(
  "OIDC Microsoft: tampered signature is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(keyPair.privateKey, microsoftClaims());
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -4) + "BBBB";
    const tampered = parts.join(".");

    let threw = false;
    try {
      await verifyMicrosoftIdToken(tampered, "test-nonce-ms", "test-tenant-id", "test-ms-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
    }
    assert.ok(threw, "Tampered Microsoft signature must be rejected");
  }),
);

// ---------------------------------------------------------------------------
// Test (e): Wrong nonce is rejected
// ---------------------------------------------------------------------------

test(
  "OIDC Google: wrong nonce is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims({ nonce: "correct-nonce" }),
    );

    let threw = false;
    try {
      await verifyGoogleIdToken(token, "wrong-nonce", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /nonce/i);
    }
    assert.ok(threw, "Wrong nonce must be rejected");
  }),
);

test(
  "OIDC Microsoft: wrong nonce is rejected",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      microsoftClaims({ nonce: "correct-nonce" }),
    );

    let threw = false;
    try {
      await verifyMicrosoftIdToken(token, "wrong-nonce", "test-tenant-id", "test-ms-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /nonce/i);
    }
    assert.ok(threw, "Wrong nonce must be rejected for Microsoft");
  }),
);

// ---------------------------------------------------------------------------
// Test (f): Valid token (mocked JWKS) is accepted
// ---------------------------------------------------------------------------

test(
  "OIDC Google: valid token with mocked JWKS is accepted",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims({
        sub: "verified-sub-id",
        nonce: "my-nonce",
        aud: "my-client-id",
      }),
    );

    const claims = await verifyGoogleIdToken(token, "my-nonce", "my-client-id");
    assert.equal(claims.issuer, "https://accounts.google.com");
    assert.equal(claims.subject, "verified-sub-id");
    assert.equal(claims.email, "user@example.com");
    assert.equal(claims.name, "Test User");
  }),
);

test(
  "OIDC Google: accepts both accounts.google.com and https://accounts.google.com as issuer",
  withFetch({}, async () => {
    // The alternative issuer form accepted by Google's own libs
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims({ iss: "accounts.google.com" }),
    );

    const claims = await verifyGoogleIdToken(token, "test-nonce-value", "test-google-client-id");
    assert.ok(claims.subject, "Should have a subject");
  }),
);

test(
  "OIDC Microsoft: valid token with mocked JWKS is accepted",
  withFetch({}, async () => {
    const token = await buildJwt(
      keyPair.privateKey,
      microsoftClaims({
        sub: "ms-verified-sub",
        nonce: "ms-nonce",
        aud: "ms-client",
        tid: "test-tenant-id",
      }),
    );

    const claims = await verifyMicrosoftIdToken(token, "ms-nonce", "test-tenant-id", "ms-client");
    assert.equal(claims.issuer, "https://login.microsoftonline.com/test-tenant-id/v2.0");
    assert.equal(claims.subject, "ms-verified-sub");
    assert.ok(claims.email, "Email should be present");
  }),
);

// ---------------------------------------------------------------------------
// Test: Invalid JWT structure rejected
// ---------------------------------------------------------------------------

test("OIDC Google: malformed JWT (not 3 parts) is rejected", async () => {
  let threw = false;
  try {
    await verifyGoogleIdToken("not.a.valid.jwt.token", "nonce", "aud");
  } catch (e) {
    threw = true;
    assert.equal(e.status, 401);
    assert.match(e.message, /Invalid JWT/i);
  }
  assert.ok(threw, "Malformed JWT must be rejected");
});

test("OIDC Google: single-segment string is rejected", async () => {
  let threw = false;
  try {
    await verifyGoogleIdToken("garbage", "nonce", "aud");
  } catch (e) {
    threw = true;
    assert.equal(e.status, 401);
  }
  assert.ok(threw, "Single segment must be rejected");
});

// ---------------------------------------------------------------------------
// Test: No matching JWKS key is rejected
//
// Strategy: sign with a valid key but set kid="unknown-kid-xxx" in the JWT
// header. The OIDC verifier filters JWKS keys by kid — since "unknown-kid-xxx"
// does not match any key in the cached JWKS (which has kid="test-key-id"),
// the verifier throws "No matching JWKS key found". This exercises the same
// code path without needing to clear the module-internal JWKS cache.
// ---------------------------------------------------------------------------

test(
  "OIDC Google: token rejected when JWT kid does not match any JWKS key",
  withFetch({}, async () => {
    // Build a JWT that claims a kid that is not in the JWKS
    const token = await buildJwt(
      keyPair.privateKey,
      googleClaims(),
      { kid: "unknown-kid-not-in-jwks" },
    );

    let threw = false;
    try {
      await verifyGoogleIdToken(token, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
      assert.match(e.message, /No matching JWKS key/i);
    }
    assert.ok(threw, "Token with unmatched kid must be rejected");
  }),
);

// ---------------------------------------------------------------------------
// Test: Token signed by a different key is rejected
// ---------------------------------------------------------------------------

test(
  "OIDC Google: token signed by a different key is rejected",
  withFetch({}, async () => {
    // Generate a second key pair — sign with it, but JWKS still has the original key
    const otherPair = await generateRsaKeyPair();
    const token = await buildJwt(otherPair.privateKey, googleClaims());

    let threw = false;
    try {
      await verifyGoogleIdToken(token, "test-nonce-value", "test-google-client-id");
    } catch (e) {
      threw = true;
      assert.equal(e.status, 401);
    }
    assert.ok(threw, "Token signed by unknown key must be rejected");
  }),
);
