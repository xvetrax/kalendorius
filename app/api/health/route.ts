import pkg from "@/package.json";

export const runtime = "nodejs";

export function GET() {
  return Response.json({ ok: true, version: pkg.version }, { headers: { "Cache-Control": "no-store" } });
}
