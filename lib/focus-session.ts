export const FOCUS_DURATION_SECONDS=25*60;
export type FocusSessionState={
  taskKey:string;remainingSeconds:number;running:boolean;startedAt:number|null;endsAt:number|null;
};

function seconds(value:unknown){return typeof value==="number"&&Number.isInteger(value)&&value>0&&value<=FOCUS_DURATION_SECONDS?value:null;}
export function remainingFocusSeconds(endsAt:number,now=Date.now()){
  if(!Number.isFinite(endsAt)||!Number.isFinite(now))return 0;
  return Math.max(0,Math.min(FOCUS_DURATION_SECONDS,Math.ceil((endsAt-now)/1000)));
}
export function parseFocusSession(raw:string|null,now=Date.now()):FocusSessionState|null{
  if(!raw)return null;
  try{
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=="object")return null;
    const data=value as Record<string,unknown>,taskKey=typeof data.taskKey==="string"&&data.taskKey&&data.taskKey.length<=4096?data.taskKey:null;
    const legacySeconds=seconds(data.seconds);
    if(taskKey&&legacySeconds&&data.version===undefined)return {taskKey,remainingSeconds:legacySeconds,running:false,startedAt:null,endsAt:null};
    const remaining=seconds(data.remainingSeconds),running=data.running,startedAt=data.startedAt,endsAt=data.endsAt;
    if(data.version!==1||!taskKey||!remaining||typeof running!=="boolean"||(startedAt!==null&&!(typeof startedAt==="number"&&Number.isFinite(startedAt)&&startedAt>0)))return null;
    if(!running){if(endsAt!==null)return null;return {taskKey,remainingSeconds:remaining,running:false,startedAt:startedAt as number|null,endsAt:null};}
    if(typeof startedAt!=="number"||typeof endsAt!=="number"||!Number.isFinite(endsAt)||endsAt<=startedAt)return null;
    const current=Math.min(remaining,remainingFocusSeconds(endsAt,now));
    return {taskKey,remainingSeconds:current,running:current>0,startedAt,endsAt:current>0?endsAt:null};
  }catch{return null;}
}
export function serializeFocusSession(state:FocusSessionState){return JSON.stringify({version:1,...state});}
