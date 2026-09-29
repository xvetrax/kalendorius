"use client";

export type IntegrationConnection = {
  id:number; accountId:string; email:string|null; label:string|null; colorKey:string;
  status:"active"|"revoked"|"error"; connectedAt?:string;
  calendarConnected?:boolean; tasksConnected?:boolean;
};
export type IntegrationStatus = {connected:boolean;configured:boolean;account:string|null;connections?:IntegrationConnection[]};

function swatch(key:string){let hash=0;for(const char of key)hash=(hash*31+char.charCodeAt(0))>>>0;return `hsl(${hash%360} 68% 48%)`;}

export function IntegrationAccounts({google,microsoft,busy,onDisconnect}:{google:IntegrationStatus;microsoft:IntegrationStatus;busy:string|null;onDisconnect:(provider:"google"|"microsoft",connection:IntegrationConnection)=>void}){
  return <section className="integrationAccounts" aria-label="Kalendoriaus ir užduočių paskyros">
    {(["google","microsoft"] as const).map(provider=>{const status=provider==="google"?google:microsoft,label=provider==="google"?"Google":"Microsoft",connections=status.connections??[];return <section className="integrationProvider" key={provider} aria-labelledby={`${provider}-accounts`}>
      <div className="integrationProviderHead"><h4 id={`${provider}-accounts`}>{label}</h4>{status.configured&&<a className="integrationAdd" href={`/api/${provider}/connect?mode=add`}>+ Pridėti {label} paskyrą</a>}</div>
      {!status.configured?<p className="formHint">Serveryje dar nesukonfigūruotas {label} OAuth.</p>:!connections.length?<p className="formHint">Paskyrų dar nėra.</p>:<ul className="integrationAccountList">{connections.map(connection=>{const name=connection.label||connection.email||`${label} paskyra`,active=connection.status==="active";return <li key={connection.id} className="integrationAccount">
        <span className="integrationSwatch" style={{background:swatch(connection.colorKey)}} aria-hidden="true"/>
        <div className="integrationAccountInfo"><strong>{name}</strong>{connection.label&&connection.email&&<small>{connection.email}</small>}<small>{active?`Calendar: prijungta · ${provider==="google"?`Tasks: ${connection.tasksConnected?"prijungta":"reikia leidimo"}`:`To Do: ${connection.tasksConnected?"prijungta":"reikia leidimo"}`}`:"Reikia atnaujinti leidimą"}</small>{connection.connectedAt&&<small>Prijungta / leidimas atnaujintas {new Date(connection.connectedAt).toLocaleDateString("lt-LT")}</small>}</div>
        <div className="integrationActions"><a href={`/api/${provider}/connect?mode=reconsent&connectionId=${connection.id}`} aria-label={`${connection.tasksConnected===false&&provider==="google"?"Suteikti Tasks leidimą":"Atnaujinti leidimą"}: ${name}`}>{connection.tasksConnected===false&&provider==="google"?"Suteikti Tasks leidimą":"Atnaujinti leidimą"}</a><button type="button" disabled={busy===`${provider}:${connection.id}`} onClick={()=>onDisconnect(provider,connection)} aria-label={`Atjungti integraciją: ${name}`}>{busy===`${provider}:${connection.id}`?"Atjungiama…":"Atjungti"}</button></div>
      </li>})}</ul>}
    </section>})}
  </section>;
}
