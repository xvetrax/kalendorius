import { BackupError, createBackup, createUserExport, restoreBackup } from "@/lib/backup";
import { apiError, assertSameOrigin } from "@/lib/http";
import { requireUserContext } from "@/lib/db-multi";

export const runtime = "nodejs";
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

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

async function downloadBackup(request: Request, requestedType?: "full" | "export") {
  let user;
  try {
    user = requireUserContext(request);
  } catch (response) {
    return response as Response;
  }

  try {
    assertSameOrigin(request);

    const url = new URL(request.url);
    const type = requestedType ?? url.searchParams.get("type") ?? "full";

    if (type !== "full" && type !== "export") {
      return Response.json({ error: "Neatpažintas kopijos tipas." }, { status: 400 });
    }

    if (type === "export") {
      // Any authenticated user may export their own data
      const data = createUserExport(user.id);
      const now = new Date().toISOString().slice(0, 10);
      const filename = `planner-export-${now}.db`;
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Full backup — admin only
    if (user.role !== "admin") {
      return Response.json({ error: "Tik administratorius gali atsisiųsti pilną atsarginę kopiją." }, { status: 403 });
    }

    const data = createBackup();
    const now = new Date().toISOString().slice(0, 10);
    const filename = `planner-backup-${now}.db`;
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

/**
 * GET /api/backup              — legacy/admin full database backup download
 * GET /api/backup?type=export  — legacy authenticated user's data export
 * POST /api/backup JSON        — browser download request (`full` or `export`)
 * POST /api/backup SQLite      — legacy admin restore
 * PUT /api/backup SQLite       — browser admin restore
 */
export async function GET(request: Request) {
  return downloadBackup(request);
}

async function restoreBackupRequest(request: Request) {
  let user;
  try {
    user = requireUserContext(request);
  } catch (response) {
    return response as Response;
  }

  try {
    assertSameOrigin(request);

    if (user.role !== "admin") {
      return Response.json({ error: "Tik administratorius gali atkurti atsarginę kopiją." }, { status: 403 });
    }

    const data = await readBodyWithinLimit(request);
    if (!data.byteLength) return Response.json({ error: "Failas tuščias." }, { status: 400 });
    const result = restoreBackup(data);
    return Response.json({ ok: true, tablesRestored: result.tablesRestored });
  } catch (error) {
    return backupError(error);
  }
}

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    try {
      const body = await request.json() as { type?: unknown };
      if (body.type !== "full" && body.type !== "export") {
        return Response.json({ error: "Neatpažintas kopijos tipas." }, { status: 400 });
      }
      return downloadBackup(request, body.type);
    } catch (error) {
      return backupError(error);
    }
  }
  return restoreBackupRequest(request);
}

export async function PUT(request: Request) {
  return restoreBackupRequest(request);
}
