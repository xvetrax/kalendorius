import { db } from "@/lib/db";
import { createTaskService, TaskError } from "@/lib/task-service";
import { cachedMicrosoftAccountId, defaultTaskListId, graphFetch, isMicrosoftConnected, microsoftAccountId } from "@/lib/microsoft";
import { cachedGoogleAccountId, googleAccountId, googleTasksFetch, isGoogleTasksConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";

export const runtime = "nodejs";
const tasks=createTaskService(db,{connected:isMicrosoftConnected,cachedAccountId:cachedMicrosoftAccountId,accountId:microsoftAccountId,defaultListId:defaultTaskListId,request:graphFetch},
  {connected:isGoogleTasksConnected,cachedAccountId:cachedGoogleAccountId,accountId:googleAccountId,request:googleTasksFetch});
function failure(error:unknown) {
  if (error instanceof TaskError) return Response.json({error:error.message},{status:error.status});
  return apiError(error);
}
async function input(request:Request) {
  assertSameOrigin(request);
  const value=await request.json();
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new TaskError("Neteisingi sąrašo duomenys.");
  return value as Record<string,unknown>;
}
export async function GET(request:Request) {
  try {
    const params=new URL(request.url).searchParams;
    const result=params.has("list_id") ? await tasks.previewListDeletion(Object.fromEntries(params)) : await tasks.listCatalog();
    return Response.json(result,{headers:{"Cache-Control":"no-store"}});
  } catch(error){return failure(error);}
}
export async function POST(request:Request) {
  try {return Response.json(await tasks.createList(await input(request)),{status:201});}
  catch(error){return failure(error);}
}
export async function PATCH(request:Request) {
  try {return Response.json(await tasks.renameList(await input(request)));}
  catch(error){return failure(error);}
}
export async function DELETE(request:Request) {
  try {await tasks.deleteList(await input(request));return Response.json({ok:true});}
  catch(error){return failure(error);}
}
