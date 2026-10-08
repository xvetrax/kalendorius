import { build } from "esbuild";

await build({
  entryPoints: ["scripts/notification-worker-entry.ts"],
  outfile: "dist/notification-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "import { createRequire as __workerCreateRequire } from 'node:module'; const require = __workerCreateRequire(import.meta.url);" },
  sourcemap: false,
  minify: false,
});
