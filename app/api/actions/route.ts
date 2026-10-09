import {createActionJournalService,ActionJournalError,providerEventSnapshot,type ProviderEventSnapshot,type ProviderUndoHooks} from "@/lib/action-journal";
import {createCalendarService} from "@/lib/calendar-events";
import {db,requireUserContext} from "@/lib/db-multi";
import {apiError,assertSameOrigin} from "@/lib/http";
import {createTaskStartNotificationHooks} from "@/lib/notification-jobs";
import {getConnectionById} from "@/lib/oauth-service";
import {googleFetchForUser} from "@/lib/google";
import {graphFetchForUser} from "@/lib/microsoft";
import {ProviderError} from "@/lib/provider-error";

export const runtime="nodejs";

function service(request:Request){
  const user=requireUserContext(request);
  function connection(provider:"google"|"microsoft",raw:string|number){
    const id=Number(raw),value=Number.isSafeInteger(id)?getConnectionById(user.id,id,provider):null;
    if(!value||value.status!=="active")throw new ActionJournalError(`${provider==="google"?"Google":"Microsoft"} paskyra atjungta arba pasikeitė.`,409);
    return value;
  }
  function calendar(snapshot:ProviderEventSnapshot){
    const provider=snapshot.provider==="outlook"?"microsoft":"google",conn=connection(provider,snapshot.connectionId),connectionId=String(conn.id);
    if(conn.provider_account_id!==snapshot.accountId)throw new ActionJournalError("Kalendoriaus paskyra pasikeitė. Atšaukimas nepritaikytas.",409);
    return createCalendarService(snapshot.provider,{connection:()=>{const current=getConnectionById(user.id,conn.id,provider);return current?.status==="active"?connectionId:null;},accountId:()=>conn.provider_account_id,request:(path,init)=>snapshot.provider==="google"?googleFetchForUser(user.id,conn,path,init):graphFetchForUser(user.id,conn,path,init)});
  }
  const providers:ProviderUndoHooks={
    async readEvent(snapshot){try{return providerEventSnapshot(await calendar(snapshot).read({id:snapshot.id,calendarId:snapshot.calendarId,connectionId:snapshot.connectionId}));}catch(error){if(error instanceof ProviderError&&error.status===404)return null;throw error;}},
    async restoreEvent(current,target){const restored=await calendar(current).update({id:current.id,calendarId:current.calendarId,connectionId:current.connectionId,version:current.version,start:target.allDay?target.start.date:target.start.dateTime,end:target.allDay?target.end.date:target.end.dateTime,allDay:target.allDay,...(!target.allDay&&target.timeZone?{timeZone:target.timeZone}:{}),confirmAttendees:true});return providerEventSnapshot(restored);},
  };
  return createActionJournalService(db,user.id,createTaskStartNotificationHooks(db,user.id),{providers});
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
    return Response.json(await service(request).undo((body as Record<string,unknown>).operationId));
  }catch(error){return failure(error);}
}
