import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import manifest from "../app/manifest.ts";

function pngSize(file) {
  const png = readFileSync(file);
  assert.equal(png.subarray(1, 4).toString(), "PNG", `${file} turi būti PNG failas`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("PWA manifestas aprašo įdiegiamą programėlę ir visas reikalingas ikonas", () => {
  const value = manifest();
  assert.equal(value.name, "Dienos planas");
  assert.equal(value.start_url, "/");
  assert.equal(value.scope, "/");
  assert.equal(value.display, "standalone");
  assert.ok(value.background_color);
  assert.ok(value.theme_color);

  const icons = new Map(value.icons.map((icon) => [icon.src, icon]));
  assert.equal(icons.get("/pwa/icon-192.png")?.sizes, "192x192");
  assert.equal(icons.get("/pwa/icon-512.png")?.sizes, "512x512");
  assert.equal(icons.get("/pwa/icon-maskable-512.png")?.purpose, "maskable");
});

test("PWA PNG failų matmenys atitinka manifestą ir Apple reikalavimą", () => {
  assert.deepEqual(pngSize("public/pwa/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngSize("public/pwa/icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngSize("public/pwa/icon-maskable-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngSize("public/pwa/apple-touch-icon.png"), { width: 180, height: 180 });
});
