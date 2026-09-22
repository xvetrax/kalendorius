import { BackupError, createBackup, createExport, restoreBackup } from "@/lib/backup";
import { apiError, assertSameOrigin } from "@/lib/http";
import { verifySessionToken, isAuthEnabled, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

function requireSession(request: Request): Response | null {
  if (!isAuthEnabled()) return null;
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (verifySessionToken(token)) return null;
  return Response.json({ error: "Neprisijungta." }, { status: 401 });
}

function backupError(error: unknown) {
  if (error instanceof BackupError) return Response.json({ error: error.message }, { status: error.status });
  return apiError(error);
}

export async function readBodyWithinLimit(request: Request, maxBytes = MAX_BACKUP_BYTES) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new BackupError("Failas per didelis arba jo dydis neteisingas.", Number(declaredLength) > maxBytes ? 413 : 400);
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BackupError("Failas per didelis (maks. 100 MB).", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function POST(request: Request) {
  const authErr = requireSession(request);
  if (authErr) return authErr;
  try {
    assertSameOrigin(request);
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("type" in body) || (body.type !== "full" && body.type !== "export")) {
      return Response.json({ error: "Nurodyk kopijos tipą: full arba export." }, { status: 400 });
    }
    const isFullBackup = body.type === "full";
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
    return backupError(error);
  }
}

export async function PUT(request: Request) {
  const authErr = requireSession(request);
  if (authErr) return authErr;
  try {
    assertSameOrigin(request);
    const data = await readBodyWithinLimit(request);
    if (!data.byteLength) return Response.json({ error: "Failas tuščias." }, { status: 400 });
    const result = restoreBackup(data);
    return Response.json({ ok: true, tablesRestored: result.tablesRestored });
  } catch (error) {
    return backupError(error);
  }
}
