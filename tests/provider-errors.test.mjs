import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ProviderError } = await import("../lib/provider-error.ts");
const { apiError } = await import("../lib/http.ts");

// apiError reads process.env.APP_ORIGIN for assertSameOrigin usage;
// for our tests only apiError itself is exercised, which does not need it.

describe("ProviderError", () => {
  it("exposes status and provider fields", () => {
    const e = new ProviderError("Microsoft", 401);
    assert.equal(e.status, 401);
    assert.equal(e.provider, "Microsoft");
    assert.ok(e instanceof Error);
    assert.ok(e.message.includes("401"));
  });

  it("works for Google provider", () => {
    const e = new ProviderError("Google", 429);
    assert.equal(e.status, 429);
    assert.equal(e.provider, "Google");
  });
});

describe("apiError — ProviderError status mapping", () => {
  async function body(response) {
    const data = await response.json();
    return { status: response.status, error: data.error };
  }

  it("401 Microsoft → provider-specific reconnect message", async () => {
    const r = await body(apiError(new ProviderError("Microsoft", 401)));
    assert.equal(r.status, 401);
    assert.ok(r.error.includes("Microsoft"), `got: ${r.error}`);
    assert.ok(r.error.includes("paskyrą"), `got: ${r.error}`);
  });

  it("401 Google → provider-specific reconnect message", async () => {
    const r = await body(apiError(new ProviderError("Google", 401)));
    assert.equal(r.status, 401);
    assert.ok(r.error.includes("Google"), `got: ${r.error}`);
  });

  it("403 Microsoft → permission message with provider name", async () => {
    const r = await body(apiError(new ProviderError("Microsoft", 403)));
    assert.equal(r.status, 403);
    assert.ok(r.error.includes("Microsoft"), `got: ${r.error}`);
    assert.ok(r.error.includes("teisių") || r.error.includes("leidimų"), `got: ${r.error}`);
  });

  it("403 Google → permission message with provider name", async () => {
    const r = await body(apiError(new ProviderError("Google", 403)));
    assert.equal(r.status, 403);
    assert.ok(r.error.includes("Google"), `got: ${r.error}`);
  });

  it("429 → rate limit message (Lithuanian)", async () => {
    const r = await body(apiError(new ProviderError("Microsoft", 429)));
    assert.equal(r.status, 429);
    assert.ok(r.error.includes("Palauk") || r.error.includes("riba"), `got: ${r.error}`);
  });

  it("404 → not found message", async () => {
    const r = await body(apiError(new ProviderError("Microsoft", 404)));
    assert.equal(r.status, 404);
    assert.ok(r.error.length > 0);
  });

  it("unknown status → generic fallback message", async () => {
    const r = await body(apiError(new ProviderError("Microsoft", 503)));
    assert.equal(r.status, 502);
    assert.ok(r.error.includes("išorine") || r.error.length > 0);
  });

  it("generic Error with no status → 502 fallback", async () => {
    const r = await body(apiError(new Error("network failure")));
    assert.equal(r.status, 502);
  });
});
