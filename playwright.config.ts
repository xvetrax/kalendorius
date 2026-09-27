import { defineConfig, devices } from "@playwright/test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const databasePath = process.env.PLAYWRIGHT_DATABASE_PATH;
const storageState = process.env.PLAYWRIGHT_STORAGE_STATE;
if (!baseURL || !databasePath || !storageState) throw new Error("Playwright paleisk per npm run test:e2e, kad testai gautų izoliuotą serverį, DB ir sesiją.");
const serverUrl = new URL(baseURL);
const absoluteDatabasePath = path.resolve(databasePath);
const isWorkerProcess = process.env.TEST_WORKER_INDEX !== undefined;
if (!isWorkerProcess && !existsSync(absoluteDatabasePath)) throw new Error("Playwright wrapperis turi paruošti izoliuotą DB ir prisijungimo sesiją.");
const databaseDirectory = realpathSync(path.dirname(absoluteDatabasePath));
const temporaryRoot = realpathSync(tmpdir());
if (serverUrl.protocol !== "http:" || serverUrl.hostname !== "127.0.0.1" || !serverUrl.port || serverUrl.port === "3000" || serverUrl.origin !== baseURL) {
  throw new Error("Playwright serveriui būtinas wrapperio parinktas 127.0.0.1 prievadas, išskyrus :3000.");
}
if (path.dirname(databaseDirectory) !== temporaryRoot || !path.basename(databaseDirectory).startsWith("kalendorius-playwright-") || path.basename(absoluteDatabasePath) !== "planner.db") {
  throw new Error("Playwright DB turi būti wrapperio sukurtame kalendorius-playwright-* laikiname kataloge.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 15000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    storageState,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/mobile.spec.ts",
    },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true },
      testMatch: "**/mobile.spec.ts",
    },
  ],
  webServer: {
    command: "node scripts/start.mjs",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: serverUrl.port,
      APP_ORIGIN: baseURL,
      DATABASE_PATH: databasePath,
      MULTI_USER_DATABASE_PATH: databasePath,
      PUBLIC_SIGNUP: "true",
      TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REDIRECT_URI: "",
      MICROSOFT_CLIENT_ID: "",
      MICROSOFT_CLIENT_SECRET: "",
      MICROSOFT_REDIRECT_URI: "",
    },
  },
});
