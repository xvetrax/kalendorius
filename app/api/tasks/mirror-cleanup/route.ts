import {db} from "@/lib/db";
import {apiError,assertSameOrigin} from "@/lib/http";
import {cachedMicrosoftAccountId,defaultTaskListId,graphFetch,isMicrosoftConnected,microsoftAccountId} from "@/lib/microsoft";
import {cachedGoogleAccountId,googleAccountId,googleTasksFetch,isGoogleTasksConnected} from "@/lib/google";
import {createTaskService,TaskError} from "@/lib/task-service";

export const runtime="nodejs";
const tasks=createTaskService(db,{connected:isMicrosoftConnected,cachedAccountId:cachedMicrosoftAccountId,
  accountId:microsoftAccountId,defaultListId:defaultTaskListId,request:graphFetch},{connected:isGoogleTasksConnected,
  cachedAccountId:cachedGoogleAccountId,accountId:googleAccountId,request:googleTasksFetch});

export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const body=await request.json();
    if (!body || typeof body!=="object" || Array.isArray(body)) throw new TaskError("Neteisingi Outlook bloko valymo duomenys.");
    return Response.json(await tasks.cleanupMirror(body));
  } catch(error) {
    if (error instanceof TaskError) return Response.json({error:error.message},{status:error.status});
    if (error instanceof SyntaxError) return Response.json({error:"Neteisingi užklausos duomenys."},{status:400});
    return apiError(error);
  }
}
