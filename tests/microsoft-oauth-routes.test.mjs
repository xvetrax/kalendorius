import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temp = mkdtempSync(path.join(tmpdir(), "planner-microsoft-consent-"));
const dbFile = path.join(temp, "test.db");
Object.assign(process.env, {
  DATABASE_PATH: dbFile,
  MULTI_USER_DATABASE_PATH: dbFile,
  TOKEN_ENCRYPTION_KEY: "bc".repeat(32),
  APP_ORIGIN: "http://localhost:3000",
  MICROSOFT_CLIENT_ID: "fixture",
  MICROSOFT_CLIENT_SECRET: "fixture",
  MICROSOFT_REDIRECT_URI: "http://localhost:3000/api/microsoft/callback",
});
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

const { db, createSession, SESSION_COOKIE } = await import("../lib/db-multi.ts");
const { encrypt } = await import("../lib/secrets.ts");
const {
  getConnection,
  getConnectionByAccount,
  listConnections,
} = await import("../lib/oauth-service.ts");
const connect = await import("../app/api/microsoft/connect/route.ts");
const callback = await import("../app/api/microsoft/callback/route.ts");
const status = await import("../app/api/microsoft/status/route.ts");
const originalFetch = globalThis.fetch;

const userId = Number(db.prepare(
  "INSERT INTO users (display_name,primary_email,role,status) VALUES ('Microsoft OAuth Test','ms-oauth@example.test','admin','active')",
).run().lastInsertRowid);
const { rawToken } = createSession(userId);
const sessionCookie = `${SESSION_COOKIE}=${rawToken}`;

function connectRequest(query = "") {
  return new Request("http://localhost:3000/api/microsoft/connect" + query, {
    headers: { Cookie: sessionCookie },
  });
}

function callbackRequest(response, query) {
  const state = (response.headers.get("set-cookie") ?? "")
    .match(/microsoft_connect_state=([^;]+)/)?.[1] ?? "";
  return new Request(
    "http://localhost:3000/api/microsoft/callback?" + new URLSearchParams(query),
    { headers: { Cookie: `${sessionCookie}; microsoft_connect_state=${state}` } },
  );
}

function providerAccount(accountId) {
  globalThis.fetch = async (raw) => {
    const url = new URL(raw);
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: `refresh-${accountId}`,
        scope: "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite",
      });
    }
    if (url.hostname === "graph.microsoft.com") {
      return Response.json({ id: accountId, mail: `${accountId}@example.test` });
    }
    throw new Error("No external network allowed");
  };
}

function oauthResult(response) {
  return new URL(response.headers.get("location")).searchParams.get("oauth");
}

beforeEach(() => {
  db.exec(`DELETE FROM oauth_connections WHERE user_id=${userId}; DELETE FROM auth_operations;`);
  globalThis.fetch = async () => {
    throw new Error("No external network allowed");
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

test("overlapping default Microsoft bootstrap flows cannot create different sibling accounts", async () => {
  const first = await connect.GET(connectRequest());
  const second = await connect.GET(connectRequest());
  const firstState = new URL(first.headers.get("location")).searchParams.get("state");
  const secondState = new URL(second.headers.get("location")).searchParams.get("state");
  const modes = db.prepare(
    "SELECT oauth_mode FROM auth_operations WHERE state_hash IN (?,?) ORDER BY id",
  ).all(
    createHash("sha256").update(firstState).digest("hex"),
    createHash("sha256").update(secondState).digest("hex"),
  );
  assert.deepEqual(modes.map((row) => row.oauth_mode), ["legacy", "legacy"]);

  providerAccount("first-account");
  assert.equal(
    oauthResult(await callback.GET(callbackRequest(first, { state: firstState, code: "first" }))),
    "connected",
  );
  providerAccount("second-account");
  assert.equal(
    oauthResult(await callback.GET(callbackRequest(second, { state: secondState, code: "second" }))),
    "error",
  );
  assert.equal(listConnections(userId, "microsoft").length, 1);
  assert.ok(getConnectionByAccount(userId, "microsoft", "first-account"));
});

test("Microsoft add and re-consent are account-bound and one connection can be removed exactly", async () => {
  db.prepare(`INSERT INTO oauth_connections
    (user_id,provider,provider_account_id,provider_email,encrypted_refresh_token,scopes,generation,status)
    VALUES (?,?,?,?,?,?,1,'active')`)
    .run(
      userId,
      "microsoft",
      "old-account",
      "old@example.test",
      encrypt("old-refresh"),
      "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite",
    );
  const old = getConnection(userId, "microsoft");

  const reconsent = await connect.GET(
    connectRequest(`?mode=reconsent&connectionId=${old.id}`),
  );
  const reconsentAuth = new URL(reconsent.headers.get("location"));
  assert.equal(reconsentAuth.searchParams.get("login_hint"), "old@example.test");
  const reconsentState = reconsentAuth.searchParams.get("state");
  const operation = db.prepare(
    "SELECT oauth_mode,expected_connection_id FROM auth_operations WHERE state_hash=?",
  ).get(createHash("sha256").update(reconsentState).digest("hex"));
  assert.deepEqual(
    { ...operation },
    { oauth_mode: "reconsent", expected_connection_id: old.id },
  );

  providerAccount("different-account");
  const rejected = await callback.GET(callbackRequest(reconsent, {
    state: reconsentState,
    code: "wrong-account",
  }));
  assert.equal(oauthResult(rejected), "error");
  assert.equal(listConnections(userId, "microsoft").length, 1);

  const add = await connect.GET(connectRequest("?mode=add"));
  const addAuth = new URL(add.headers.get("location"));
  assert.equal(addAuth.searchParams.get("login_hint"), null);
  assert.equal(addAuth.searchParams.get("prompt"), "select_account");
  const addState = addAuth.searchParams.get("state");
  providerAccount("new-account");
  const added = await callback.GET(callbackRequest(add, {
    state: addState,
    code: "new-account",
  }));
  assert.equal(oauthResult(added), "connected");
  const newConnection = getConnectionByAccount(userId, "microsoft", "new-account");
  assert.ok(newConnection);

  const current = await (await status.GET(new Request(
    "http://localhost:3000/api/microsoft/status",
    { headers: { Cookie: sessionCookie } },
  ))).json();
  assert.equal(current.connections.length, 2);
  assert.equal(current.account, null);

  const removed = await status.DELETE(new Request(
    `http://localhost:3000/api/microsoft/status?connectionId=${newConnection.id}`,
    {
      method: "DELETE",
      headers: { Cookie: sessionCookie, Origin: "http://localhost:3000" },
    },
  ));
  assert.equal(removed.status, 200);
  assert.equal(getConnectionByAccount(userId, "microsoft", "new-account"), null);
  assert.equal(getConnectionByAccount(userId, "microsoft", "old-account").id, old.id);
});
