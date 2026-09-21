export class ProviderError extends Error {
  status:number;
  provider:string;
  constructor(provider:string,status:number) {super(`${provider} užklausa nepavyko (${status}).`);this.status=status;this.provider=provider;}
}
