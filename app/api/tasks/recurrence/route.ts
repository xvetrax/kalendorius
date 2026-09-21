import { db } from "@/lib/db";
import { apiError, assertSameOrigin } from "@/lib/http";
import { cachedMicrosoftAccountId, defaultTaskListId, graphFetch, isMicrosoftConnected, microsoftAccountId } from "@/lib/microsoft";
import { createTaskService, TaskError } from "@/lib/task-service";

export const runtime = "nodejs";
const tasks=createTaskService(db,{connected:isMicrosoftConnected,cachedAccountId:cachedMicrosoftAccountId,
  accountId:microsoftAccountId,defaultListId:defaultTaskListId,request:graphFetch});

function failure(error:unknown) {
  if (error instanceof TaskError) return Response.json({error:error.message},{status:error.status});
  if (error instanceof Error && "status" in error && error.status === 412)
    return Response.json({error:"Microsoft kartojimo taisyklė jau pakeista. Atnaujink kartojimą."},{status:409});
  return apiError(error);
}

export async function GET(request:Request) {
  try {return Response.json(await tasks.readRecurrence(Object.fromEntries(new URL(request.url).searchParams)),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return failure(error);}
}

export async function PATCH(request:Request) {
  try {
    assertSameOrigin(request);
    const body=await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskError("Neteisingi kartojimo duomenys.");
    return Response.json(await tasks.updateRecurrence(body),{headers:{"Cache-Control":"no-store"}});
  } catch(error){return failure(error);}
}
