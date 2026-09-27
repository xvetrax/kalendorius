import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temp = mkdtempSync(path.join(tmpdir(), "planner-public-signup-"));
const dbFile = path.join(temp, "test.db");
process.env.DATABASE_PATH = dbFile;
process.env.MULTI_USER_DATABASE_PATH = dbFile;
process.env.INITIAL_ADMIN_EMAIL = "owner@example.test";
process.env.PUBLIC_SIGNUP = "true";

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

const { db } = await import("../lib/db-multi.ts");
const { findOrCreateOidcUser, isPublicSignupEnabled } = await import("../lib/user-service.ts");

after(() => {
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

test("configured owner can become the initial admin after members have registered", () => {
  const member = findOrCreateOidcUser({
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "member-subject",
    displayName: "Member",
    email: "member@example.test",
  });
  assert.equal(member.role, "member");

  const owner = findOrCreateOidcUser({
    provider: "microsoft",
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    subject: "owner-subject",
    displayName: "Owner",
    email: "OWNER@example.test",
  });
  assert.equal(owner.role, "admin");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 2);
});

test("same verified identity is idempotent and matching email never merges providers", () => {
  const first = findOrCreateOidcUser({
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "stable-subject",
    displayName: "One",
    email: "shared@example.test",
  });
  const repeated = findOrCreateOidcUser({
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "stable-subject",
    displayName: "Changed",
    email: "shared@example.test",
  });
  const otherProvider = findOrCreateOidcUser({
    provider: "microsoft",
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    subject: "different-subject",
    displayName: "Two",
    email: "shared@example.test",
  });

  assert.equal(repeated.created, false);
  assert.equal(repeated.userId, first.userId);
  assert.notEqual(otherProvider.userId, first.userId);
});

test("PUBLIC_SIGNUP=false closes only new registration", () => {
  assert.equal(isPublicSignupEnabled(), true);
  process.env.PUBLIC_SIGNUP = "false";
  assert.equal(isPublicSignupEnabled(), false);
  process.env.PUBLIC_SIGNUP = "true";
});
