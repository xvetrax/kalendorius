import { requireUserContext } from "@/lib/db-multi";
import { saveUserSetting } from "@/lib/db";
import { graphFetchForUser } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { calendarSelectionVersion } from "@/lib/calendar-selection";
import { getCalendarSelection, replaceCalendarSelection, CalendarPreferenceError } from "@/lib/calendar-preferences";
import { listConnections, getConnectionById, type OAuthConnectionRow } from "@/lib/oauth-service";
import { allSettledLimited, calendarAccountError, calendarAccountLabel } from "@/lib/calendar-multi";
import { resolveLegacyCalendarSelection, writeLegacyCalendarSelection } from "@/lib/calendar-legacy";
import { resolveCalendarAccountColors } from "@/lib/calendar-colors";

export const runtime = "nodejs";
const colors: Record<string,string>={lightBlue:"#74b7e8",lightGreen:"#57a55a",lightOrange:"#e8975b",lightGray:"#9e9e9e",lightYellow:"#e8c85b",lightTeal:"#4db6ac",lightPink:"#e87494",lightBrown:"#a07850",lightRed:"#e85b5b",lightMagenta:"#b04db6",auto:"#0078d4"};
type Item={id:string;name:string;color?:string;isDefault?:boolean;writable:boolean};
// Each account needs its own default-calendar slot. A single shared setting is
// racy when two account catalogs load concurrently: the last response would
// otherwise make mirror recognition fail for every sibling connection.
export const outlookDefaultCalendarSetting=(connectionId:string)=>`microsoft_default_calendar_identity:${connectionId}`;

export async function microsoftCalendarCatalogForConnection(userId:number,connection:OAuthConnectionRow){
  const items:Item[]=[],visited=new Set<string>();let next:string|null="/me/calendars?$top=50&$select=id,name,color,isDefaultCalendar,canEdit";
  while(next){if(visited.has(next))break;visited.add(next);const page=await graphFetchForUser(userId,connection,next);for(const cal of page.value||[])items.push({id:String(cal.id),name:String(cal.name||cal.id),color:colors[cal.color]||undefined,isDefault:Boolean(cal.isDefaultCalendar),writable:Boolean(cal.canEdit)});const link=page["@odata.nextLink"]||null;if(!link){next=null;continue;}const url=new URL(link);next=url.origin==="https://graph.microsoft.com"&&!url.username&&!url.password&&!url.hash?url.pathname.slice(5)+url.search:null;}
  const current=getConnectionById(userId,connection.id,"microsoft");if(!current||current.status!=="active"||current.provider_account_id!==connection.provider_account_id)throw Object.assign(new Error("Microsoft paskyra pasikeitė. Atnaujink kalendorius."),{status:409});
  const connectionId=String(connection.id),primary=items.find(item=>item.isDefault);if(primary)saveUserSetting(userId,outlookDefaultCalendarSetting(connectionId),JSON.stringify([connection.provider_account_id,connectionId,primary.id]));
  // Legacy selections stored "primary" for the default calendar; map it onto the
  // live opaque default id so the overlay references a real calendar.
  const normalized=getCalendarSelection(userId,connection.id);
  const overlay=!normalized.explicit&&listConnections(userId,"microsoft").filter(item=>item.status==="active").length===1?resolveLegacyCalendarSelection(userId,connection.id,connection.provider_account_id,"microsoft",id=>id==="primary"&&primary?primary.id:id):null;
  const selection=overlay?.selection??normalized,live=new Set(items.map(item=>item.id)),overrides=new Map(selection.items.flatMap(item=>item.color_override?[[item.calendar_id,item.color_override] as const]:[])),coloredItems=items.map(item=>({...item,color:overrides.get(item.id)??item.color}));
  const enabled=selection.explicit?selection.items.filter(item=>item.enabled&&live.has(item.calendar_id)).map(item=>item.calendar_id):items.filter(item=>item.isDefault).map(item=>item.id);
  return {provider:"microsoft" as const,connectionId,accountId:connection.provider_account_id,email:connection.provider_email,label:calendarAccountLabel(connection),colorKey:connection.color_key,items:coloredItems,enabled,explicit:selection.explicit,defaultAlias:overlay?.defaultAlias??false,version:calendarSelectionVersion("microsoft",connection.provider_account_id,connectionId,selection)};
}

export async function microsoftCalendarCatalog(userId:number){const active=listConnections(userId,"microsoft").filter(c=>c.status==="active");if(active.length!==1)throw Object.assign(new Error("Pasirink konkrečią Microsoft paskyrą."),{status:409});return microsoftCalendarCatalogForConnection(userId,active[0]);}

export async function GET(request:Request){try{const user=requireUserContext(request),connections=listConnections(user.id,"microsoft").filter(c=>c.status==="active");if(!connections.length)return Response.json({accounts:[],items:[],enabled:[],errors:[],version:""});const settled=await allSettledLimited(connections,3,connection=>microsoftCalendarCatalogForConnection(user.id,connection));const accounts=resolveCalendarAccountColors(settled.flatMap(result=>result.status==="fulfilled"?[result.value]:[])),errors=settled.flatMap((result,index)=>result.status==="rejected"?[calendarAccountError(connections[index],result.reason)]:[]);if(!accounts.length&&connections.length===1)throw (settled[0] as PromiseRejectedResult).reason;const sole=accounts.length===1?accounts[0]:null;return Response.json({accounts,items:sole?.items??[],enabled:sole?.enabled??[],explicit:sole?.explicit??false,defaultAlias:sole?.defaultAlias??false,version:sole?.version??"",errors},{headers:{"Cache-Control":"no-store"}});}catch(error){if(error instanceof Response)return error;return apiError(error);}}

export async function PATCH(request:Request){try{assertSameOrigin(request);const user=requireUserContext(request),body=await request.json(),active=listConnections(user.id,"microsoft").filter(c=>c.status==="active");const connectionId=Number(body.connectionId??(active.length===1?active[0].id:NaN)),connection=Number.isSafeInteger(connectionId)?getConnectionById(user.id,connectionId,"microsoft"):null;if(!connection||connection.status!=="active")return Response.json({error:"Microsoft paskyra neprijungta."},{status:409});if(!Array.isArray(body.enabled))return Response.json({error:"Neteisingas kalendorių sąrašas."},{status:400});const catalog=await microsoftCalendarCatalogForConnection(user.id,connection),live=new Set(catalog.items.map(item=>item.id));if(body.version!==catalog.version)return Response.json({error:"Microsoft paskyra arba kalendorių katalogas pasikeitė. Atnaujink kalendorius."},{status:409});if(body.enabled.some((item:any)=>typeof item?.id!=="string"||!live.has(item.id)))return Response.json({error:"Kalendorius šiai paskyrai nepriklauso."},{status:409});const selection=replaceCalendarSelection(user.id,connection.id,connection.provider_account_id,body.enabled.map((item:any)=>({id:item.id,color_override:item.color_override})),"microsoft");writeLegacyCalendarSelection(user.id,"microsoft",connection.provider_account_id,selection.items.filter(item=>item.enabled).map(item=>({id:item.calendar_id})));return Response.json({ok:true,connectionId:String(connection.id),version:calendarSelectionVersion("microsoft",connection.provider_account_id,String(connection.id),selection),enabled:selection.items.filter(item=>item.enabled).map(item=>item.calendar_id)});}catch(error){if(error instanceof Response)return error;if(error instanceof CalendarPreferenceError)return Response.json({error:error.message},{status:error.status});return apiError(error);}}
