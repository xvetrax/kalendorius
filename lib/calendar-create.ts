import {createHash} from "node:crypto";

export function calendarCreateOperationId(value:unknown){
  if(typeof value!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new Error("Trūksta tinkamo įvykio kūrimo operacijos ID.");
  return value.toLowerCase();
}

function digest(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export function calendarCreateIdentity(provider:"google"|"outlook",accountId:string,connectionId:string,calendarId:string,operationId:string,payload:unknown){
  const fingerprint=digest(payload),key=digest({provider,accountId,connectionId,calendarId,operationId});
  const transactionId=`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`;
  return {fingerprint,key,googleEventId:`dp${key.slice(0,40)}`,transactionId};
}
