import { createBackup, createExport, restoreBackup } from "@/lib/backup";
import { apiError, assertSameOrigin } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const type = new URL(request.url).searchParams.get("type") ?? "export";
  const isFullBackup = type === "full";
  try {
    const data = isFullBackup ? createBackup() : createExport();
    const now = new Date().toISOString().slice(0, 10);
    const filename = isFullBackup ? `planner-backup-${now}.db` : `planner-export-${now}.db`;
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return Response.json({ error: "Failas tuščias." }, { status: 400 });
    if (buf.byteLength > 100 * 1024 * 1024) return Response.json({ error: "Failas per didelis (maks. 100 MB)." }, { status: 413 });
    const data = Buffer.from(buf);
    // Basic SQLite magic bytes check
    const magic = data.slice(0, 16).toString("utf8");
    if (!magic.startsWith("SQLite format 3")) return Response.json({ error: "Netinkamas failo formatas — tikėtina SQLite duomenų bazė." }, { status: 400 });
    const result = restoreBackup(data);
    return Response.json({ ok: true, tablesRestored: result.tablesRestored });
  } catch (error) {
    if (error instanceof Error && /neatpažinta|trūksta/i.test(error.message)) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return apiError(error);
  }
}
