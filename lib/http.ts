const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function safeOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)))) {
    throw new Error("APP_ORIGIN turi būti HTTPS adresas arba vietinis HTTP adresas");
  }
  return url.origin;
}

export function appOrigin(requestUrl: string) {
  return safeOrigin(process.env.APP_ORIGIN || new URL(requestUrl).origin);
}

export function oauthRedirectUri(value: string | undefined, callbackPath: string) {
  if (!value) throw new Error("Neužpildyti OAuth nustatymai");
  const url = new URL(value);
  const expectedOrigin = process.env.APP_ORIGIN ? safeOrigin(process.env.APP_ORIGIN) : url.origin;
  if (url.origin !== expectedOrigin || url.pathname !== callbackPath || url.search || url.hash) {
    throw new Error("OAuth redirect URI turi sutapti su APP_ORIGIN ir callback keliu");
  }
  safeOrigin(url.origin);
  return url.toString();
}

export function oauthCookieOptions(requestUrl: string) {
  return { httpOnly: true, sameSite: "lax" as const, secure: appOrigin(requestUrl).startsWith("https://"), maxAge: 600, path: "/" };
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== appOrigin(request.url)) throw new Error("CSRF");
}

export function apiError(error: unknown) {
  if (error instanceof SyntaxError) return Response.json({error:"Neteisingi užklausos duomenys."},{status:400});
  const status=error instanceof Error && "status" in error ? Number(error.status) : 0;
  const messages:Record<number,string>={400:"Paslauga atmetė pakeitimą. Patikrink įvykio duomenis.",401:"Prisijungimas nebegalioja. Prijunk paskyrą iš naujo.",403:"Nepakanka leidimų šiam veiksmui.",404:"Įvykis arba užduotis neberasta. Atnaujink duomenis.",409:"Duomenys pasikeitė. Atnaujink ir bandyk dar kartą.",412:"Įvykis jau pakeistas kitur. Atnaujink kalendorių.",429:"Pasiekta paslaugos užklausų riba. Palauk ir bandyk dar kartą."};
  if (messages[status]) return Response.json({error:messages[status]},{status:status===412 ? 409 : status});
  const message = error instanceof Error ? error.message : "";
  if (message === "CSRF") return Response.json({ error: "Užklausa atmesta dėl saugumo patikros. Atnaujink puslapį ir bandyk dar kartą." }, { status: 403 });
  if (/neprijungtas|OAuth nustatymai|APP_ORIGIN|redirect URI|TOKEN_ENCRYPTION_KEY/i.test(message)) {
    return Response.json({ error: "Integracija neprijungta arba nesukonfigūruota." }, { status: 409 });
  }
  return Response.json({ error: "Nepavyko susisiekti su išorine paslauga. Bandyk dar kartą." }, { status: 502 });
}

export function oauthResultUrl(requestUrl: string, provider: "microsoft" | "google", result: "connected" | "error" | "not-configured" | "tasks-permission-required") {
  let origin: string;
  try { origin = appOrigin(requestUrl); }
  catch { origin = safeOrigin(new URL(requestUrl).origin); }
  const url = new URL("/", origin);
  url.searchParams.set("integration", provider);
  url.searchParams.set("oauth", result);
  return url;
}
