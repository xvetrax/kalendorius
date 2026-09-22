import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const standaloneServer = path.join(projectRoot, ".next", "standalone", "server.js");
if (!existsSync(standaloneServer)) {
  console.error("Pirmiausia paleisk npm run build.");
  process.exit(1);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Nepavyko parinkti testų prievado.");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const port = await freePort();
const runDirectory = mkdtempSync(path.join(tmpdir(), "kalendorius-playwright-"));
const child = spawn(process.execPath, [path.join(projectRoot, "node_modules", "@playwright", "test", "cli.js"), "test", ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
    PLAYWRIGHT_DATABASE_PATH: path.join(runDirectory, "planner.db"),
  },
});

let interruptedSignal = null;
const signals = ["SIGHUP", "SIGINT", "SIGTERM"];
const handlers = new Map(signals.map(signal => [signal, () => {
  interruptedSignal = signal;
  child.kill(signal);
}]));
for (const [signal, handler] of handlers) process.once(signal, handler);

let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  rmSync(runDirectory, { recursive: true, force: true });
}

const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
process.exitCode = interruptedSignal ? signalExitCodes[interruptedSignal] : exitCode;
