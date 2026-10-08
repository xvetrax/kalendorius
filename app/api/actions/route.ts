import {createActionJournalService,ActionJournalError} from "@/lib/action-journal";
import {db,requireUserContext} from "@/lib/db-multi";
import {apiError,assertSameOrigin} from "@/lib/http";
import {createTaskStartNotificationHooks} from "@/lib/notification-jobs";

export const runtime="nodejs";

function service(request:Request){
  const user=requireUserContext(request);
  return createActionJournalService(db,user.id,createTaskStartNotificationHooks(db,user.id));
}
function failure(error:unknown){
  if(error instanceof ActionJournalError)return Response.json({error:error.message},{status:error.status});
  if(error instanceof SyntaxError)return Response.json({error:"Neteisingi užklausos duomenys."},{status:400});
  if(error instanceof Response)return error;
  return apiError(error);
}
export async function GET(request:Request){
  try{return Response.json({items:service(request).list()},{headers:{"Cache-Control":"no-store"}});}
  catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const body=await request.json();
    if(!body||typeof body!=="object"||Array.isArray(body))throw new ActionJournalError("Neteisingi užklausos duomenys.");
    return Response.json(service(request).undo((body as Record<string,unknown>).operationId));
  }catch(error){return failure(error);}
}
