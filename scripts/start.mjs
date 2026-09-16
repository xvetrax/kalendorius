import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

// standalone/server.js changes cwd. Load configuration and resolve the database
// relative to the actual project before importing it; never copy secrets into it.
const projectRoot = path.resolve(import.meta.dirname, "..");
const standalone = path.join(projectRoot, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("Pirmiausia paleisk npm run build.");
  process.exit(1);
}
process.env.NODE_ENV = "production";
nextEnv.loadEnvConfig(projectRoot, false, {
  info() {},
  error() { throw new Error("Nepavyko perskaityti serverio konfigūracijos."); },
});
process.env.DATABASE_PATH = path.resolve(projectRoot, process.env.DATABASE_PATH || "data/planner.db");
process.env.HOSTNAME ||= "127.0.0.1";

// Next intentionally excludes these assets from standalone output. Docker
// copies them in its final stage; local npm start needs the same preparation.
cpSync(path.join(projectRoot, "public"), path.join(standalone, "public"), { recursive: true });
cpSync(path.join(projectRoot, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
await import(pathToFileURL(path.join(standalone, "server.js")).href);
