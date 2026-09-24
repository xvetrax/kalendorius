import {db} from "@/lib/db";
import {apiError,assertSameOrigin} from "@/lib/http";
import {cachedMicrosoftAccountId,defaultTaskListId,graphFetch,isMicrosoftConnected,microsoftAccountId} from "@/lib/microsoft";
import {createTaskService,TaskError} from "@/lib/task-service";

export const runtime="nodejs";
const tasks=createTaskService(db,{connected:isMicrosoftConnected,cachedAccountId:cachedMicrosoftAccountId,
  accountId:microsoftAccountId,defaultListId:defaultTaskListId,request:graphFetch});

function failure(error:unknown){
  if(error instanceof TaskError)return Response.json({error:error.message},{status:error.status});
  if(error instanceof SyntaxError)return Response.json({error:"Neteisingi žingsnio duomenys."},{status:400});
  return apiError(error);
}
async function input(request:Request){
  assertSameOrigin(request);
  const body=await request.json();
  if(!body||typeof body!=="object"||Array.isArray(body))throw new TaskError("Neteisingi žingsnio duomenys.");
  return body as Record<string,unknown>;
}
export async function GET(request:Request){
  try{return Response.json(await tasks.readSteps(Object.fromEntries(new URL(request.url).searchParams)),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{return Response.json(await tasks.createStep(await input(request)),{status:201,headers:{"Cache-Control":"no-store"}});}
  catch(error){return failure(error);}
}
export async function PATCH(request:Request){
  try{return Response.json(await tasks.updateStep(await input(request)),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return failure(error);}
}
export async function DELETE(request:Request){
  try{return Response.json(await tasks.deleteStep(await input(request)),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return failure(error);}
}
