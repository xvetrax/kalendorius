/**
 * lib/oidc.ts — OIDC ID token verification (H2)
 *
 * Security constraints (non-negotiable):
 *  - Verifies RS256/RS384 JWT signatures using Google and Microsoft JWKS endpoints.
 *  - Checks iss, aud, exp, nonce claims; on failure throws Error with status=401.
 *  - Uses node:crypto WebCrypto subtle only — no external crypto libraries.
 *  - Caches JWKS with a 1-hour TTL to avoid excess fetches on every request.
 *  - NEVER returns or stores the raw id_token; only the verified claim set.
 */

// Use the global crypto.subtle (available in Node 19+ and all modern runtimes).
// Using the global avoids the type mismatch between node:crypto's webcrypto
// and the standard lib CryptoKey / SubtleCrypto types.
const subtle: SubtleCrypto = globalThis.crypto.subtle;

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

interface JwksCacheEntry {
  rawKeys: RawJwk[];
  cachedAt: number;
}

// JWKS key with optional 'kid' and 'alg' fields (not part of standard JsonWebKey)
interface RawJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

const jwksCache = new Map<string, JwksCacheEntry>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchJwks(jwksUri: string): Promise<{ rawKeys: RawJwk[] }> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);
  if (cached && now - cached.cachedAt < JWKS_TTL_MS) {
    return { rawKeys: cached.rawKeys };
  }

  const resp = await fetch(jwksUri, { cache: "no-store" });
  if (!resp.ok) {
    throw Object.assign(new Error(`JWKS fetch failed: ${resp.status}`), { status: 401 });
  }

  const data = (await resp.json()) as { keys: RawJwk[] };
  const rawKeys: RawJwk[] = data.keys ?? [];

  const entry: JwksCacheEntry = { rawKeys, cachedAt: now };
  jwksCache.set(jwksUri, entry);
  return { rawKeys };
}

// ---------------------------------------------------------------------------
// JWT parsing helpers
// ---------------------------------------------------------------------------

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  headerB64: string;
  payloadB64: string;
  signatureBytes: Uint8Array;
}

function parseJwt(token: string): JwtParts {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw Object.assign(new Error("Invalid JWT structure"), { status: 401 });
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  function b64urlDecode(s: string): Uint8Array {
    // Convert base64url to base64
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  const headerBytes = b64urlDecode(headerB64);
  const payloadBytes = b64urlDecode(payloadB64);
  const signatureBytes = b64urlDecode(sigB64);

  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;

  return { header, payload, headerB64, payloadB64, signatureBytes };
}

async function verifyJwtSignature(
  headerB64: string,
  payloadB64: string,
  signatureBytes: Uint8Array,
  header: Record<string, unknown>,
  rawKeys: RawJwk[],
): Promise<void> {
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const alg = typeof header.alg === "string" ? header.alg : "RS256";
  if (alg !== "RS256" && alg !== "RS384") {
    throw Object.assign(new Error(`Unsupported JWT alg: ${alg}`), { status: 401 });
  }

  const hashName = alg === "RS384" ? "SHA-384" : "SHA-256";
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  // Find candidate keys (by kid if present)
  const candidateJwks = kid
    ? rawKeys.filter((k) => k.kid === kid)
    : rawKeys.filter((k) => k.kty === "RSA" && (k.use === "sig" || !k.use));

  if (candidateJwks.length === 0) {
    throw Object.assign(new Error("No matching JWKS key found"), { status: 401 });
  }

  // Copy into plain ArrayBuffer-backed Uint8Arrays as required by the Web Crypto API.
  const sigBuf = new Uint8Array(signatureBytes) as Uint8Array<ArrayBuffer>;
  const msgBuf = new Uint8Array(signingInput) as Uint8Array<ArrayBuffer>;

  for (const jwk of candidateJwks) {
    try {
      const cryptoKey = await subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: hashName },
        false,
        ["verify"],
      );
      const valid = await subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBuf, msgBuf);
      if (valid) return;
    } catch {
      // Try next key
    }
  }

  throw Object.assign(new Error("JWT signature verification failed"), { status: 401 });
}

// ---------------------------------------------------------------------------
// Verified claims result
// ---------------------------------------------------------------------------

export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Google OIDC verification
// ---------------------------------------------------------------------------

const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
const GOOGLE_ISSUER = "https://accounts.google.com";

let googleJwksUri: string | null = null;
let googleJwksUriFetchedAt = 0;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getGoogleJwksUri(): Promise<string> {
  const now = Date.now();
  if (googleJwksUri && now - googleJwksUriFetchedAt < DISCOVERY_TTL_MS) {
    return googleJwksUri;
  }
  const resp = await fetch(GOOGLE_DISCOVERY_URL, { cache: "no-store" });
  if (!resp.ok) {
    throw Object.assign(new Error(`Google discovery fetch failed: ${resp.status}`), { status: 401 });
  }
  const data = (await resp.json()) as { jwks_uri: string };
  googleJwksUri = data.jwks_uri;
  googleJwksUriFetchedAt = now;
  return googleJwksUri;
}

/**
 * verifyGoogleIdToken — verifies a Google OIDC id_token.
 * Checks signature, iss, aud, exp, and nonce.
 * Returns {issuer, subject, email, name} on success; throws with status=401 on failure.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  nonce: string,
  audience: string,
): Promise<OidcClaims> {
  const { header, payload, headerB64, payloadB64, signatureBytes } = parseJwt(idToken);

  // Validate issuer
  const iss = payload.iss;
  if (iss !== GOOGLE_ISSUER && iss !== "accounts.google.com") {
    throw Object.assign(new Error(`Invalid Google issuer: ${String(iss)}`), { status: 401 });
  }

  // Validate audience
  const aud = payload.aud;
  const audMatches =
    aud === audience ||
    (Array.isArray(aud) && (aud as unknown[]).includes(audience));
  if (!audMatches) {
    throw Object.assign(new Error("Google id_token audience mismatch"), { status: 401 });
  }

  // Validate expiry
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp === 0 || Date.now() / 1000 > exp) {
    throw Object.assign(new Error("Google id_token expired"), { status: 401 });
  }

  // Validate nonce
  if (payload.nonce !== nonce) {
    throw Object.assign(new Error("Google id_token nonce mismatch"), { status: 401 });
  }

  // Verify signature
  const jwksUri = await getGoogleJwksUri();
  const { rawKeys } = await fetchJwks(jwksUri);
  await verifyJwtSignature(headerB64, payloadB64, signatureBytes, header, rawKeys);

  const email = typeof payload.email === "string" ? payload.email : "";
  const name = typeof payload.name === "string" ? payload.name : (email || "");
  const sub = typeof payload.sub === "string" ? payload.sub : "";

  if (!sub) {
    throw Object.assign(new Error("Google id_token missing sub claim"), { status: 401 });
  }
  if (!email || payload.email_verified !== true) {
    throw Object.assign(new Error("Google id_token email is not verified"), { status: 401 });
  }

  return {
    issuer: GOOGLE_ISSUER,
    subject: sub,
    email,
    name,
  };
}

// ---------------------------------------------------------------------------
// Microsoft OIDC verification
// ---------------------------------------------------------------------------

const MICROSOFT_AUTHORITY_BASE = "https://login.microsoftonline.com";

// Cache discovery documents per tenant
const msDiscoveryCache = new Map<string, { jwksUri: string; fetchedAt: number }>();

async function getMicrosoftJwksUri(tenantId: string): Promise<string> {
  const now = Date.now();
  const cached = msDiscoveryCache.get(tenantId);
  if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.jwksUri;
  }

  // For multi-tenant ('common', 'organizations', 'consumers') use the v2.0 endpoint
  const discoveryUrl = `${MICROSOFT_AUTHORITY_BASE}/${tenantId}/v2.0/.well-known/openid-configuration`;
  const resp = await fetch(discoveryUrl, { cache: "no-store" });
  if (!resp.ok) {
    throw Object.assign(
      new Error(`Microsoft discovery fetch failed for tenant ${tenantId}: ${resp.status}`),
      { status: 401 },
    );
  }
  const data = (await resp.json()) as { jwks_uri: string };
  msDiscoveryCache.set(tenantId, { jwksUri: data.jwks_uri, fetchedAt: now });
  return data.jwks_uri;
}

/**
 * verifyMicrosoftIdToken — verifies a Microsoft OIDC id_token.
 * Checks signature (RS256 or RS384), iss, aud, exp, nonce.
 * tenantId: the tid claim from the token, or 'common' for multi-tenant.
 * Returns {issuer, subject, email, name} on success; throws with status=401 on failure.
 */
export async function verifyMicrosoftIdToken(
  idToken: string,
  nonce: string,
  tenantId: string,
  audience: string,
): Promise<OidcClaims> {
  const { header, payload, headerB64, payloadB64, signatureBytes } = parseJwt(idToken);

  // Extract the actual tid from the token payload (use it for issuer validation)
  const tokenTid =
    typeof payload.tid === "string" ? payload.tid : tenantId;

  // Microsoft v2.0 issuer pattern: https://login.microsoftonline.com/{tid}/v2.0
  const expectedIssuer = `${MICROSOFT_AUTHORITY_BASE}/${tokenTid}/v2.0`;
  const iss = payload.iss;

  // For 'common'/'organizations'/'consumers' endpoints, iss contains the actual tenant id
  if (typeof iss !== "string") {
    throw Object.assign(new Error("Microsoft id_token missing iss claim"), { status: 401 });
  }
  // Validate iss matches expected pattern for the actual token tenant
  if (iss !== expectedIssuer) {
    throw Object.assign(
      new Error(`Invalid Microsoft issuer: ${iss}, expected: ${expectedIssuer}`),
      { status: 401 },
    );
  }

  // Validate audience
  const aud = payload.aud;
  const audMatches =
    aud === audience ||
    (Array.isArray(aud) && (aud as unknown[]).includes(audience));
  if (!audMatches) {
    throw Object.assign(new Error("Microsoft id_token audience mismatch"), { status: 401 });
  }

  // Validate expiry
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp === 0 || Date.now() / 1000 > exp) {
    throw Object.assign(new Error("Microsoft id_token expired"), { status: 401 });
  }

  // Validate nonce
  if (payload.nonce !== nonce) {
    throw Object.assign(new Error("Microsoft id_token nonce mismatch"), { status: 401 });
  }

  // Verify signature using the tenant-specific JWKS
  // For multi-tenant flows, use the common endpoint JWKS which covers all tenants
  const jwksUri = await getMicrosoftJwksUri(tenantId === "common" ? "common" : tokenTid);
  const { rawKeys } = await fetchJwks(jwksUri);
  await verifyJwtSignature(headerB64, payloadB64, signatureBytes, header, rawKeys);

  const email =
    typeof payload.email === "string"
      ? payload.email
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : "";
  const name =
    typeof payload.name === "string"
      ? payload.name
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : email;
  const sub = typeof payload.sub === "string" ? payload.sub : "";

  if (!sub) {
    throw Object.assign(new Error("Microsoft id_token missing sub claim"), { status: 401 });
  }

  return {
    issuer: expectedIssuer,
    subject: sub,
    email,
    name,
  };
}
