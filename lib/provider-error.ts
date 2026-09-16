export class ProviderError extends Error {
  status:number;
  constructor(provider:string,status:number) {super(`${provider} užklausa nepavyko (${status}).`);this.status=status;}
}
