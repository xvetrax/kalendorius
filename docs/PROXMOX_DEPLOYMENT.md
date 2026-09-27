# Diegimas Proxmox VM su Tailscale Funnel

Šis variantas programėlę paleidžia atskiroje Ubuntu VM. Docker portas `3000`
pririšamas tik prie VM `127.0.0.1`, todėl jo tiesiogiai nepasiekia LAN ar
internetas. Viešą HTTPS adresą pateikia Tailscale Funnel.

## VM ir Docker

Rekomenduojama VM konfigūracija: 2 vCPU, 3 GB RAM, 32 GB diskas ir Ubuntu
Server. Docker Engine bei Compose diegiami iš oficialios Docker saugyklos.

Produkcijai naudojamas `docker-compose.production.yml`. Programėlės SQLite
duomenys saugomi vardiniame `kalendorius-data` volume ir patenka į visos VM
Proxmox atsarginę kopiją.

## Konfigūracija

Repozitorijos šaknyje sukurk `.env` pagal `.env.example`. Viešo diegimo URL
turi sutapti visuose šiuose kintamuosiuose:

```dotenv
APP_ORIGIN=https://kalendorius.example-tailnet.ts.net
GOOGLE_REDIRECT_URI=https://kalendorius.example-tailnet.ts.net/api/google/callback
MICROSOFT_REDIRECT_URI=https://kalendorius.example-tailnet.ts.net/api/microsoft/callback
```

Prieš pirmą paleidimą taip pat būtina nustatyti `INITIAL_ADMIN_EMAIL`, abiejų
OAuth tiekėjų Client ID ir Client Secret bei naują šifravimo raktą:

```bash
openssl rand -hex 32
```

`.env` faile esantys žetonai ir paslaptys neturi būti keliami į Git.

## Paleidimas

```bash
sudo docker compose -f docker-compose.production.yml config
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml ps
curl --fail http://127.0.0.1:3000/api/health
```

Kai vietinis health check veikia, įjunk išliekantį viešą tunelį:

```bash
sudo tailscale funnel --bg 3000
sudo tailscale funnel status
```

Funnel suteiktas `https://*.ts.net` adresas yra viešas: lankytojams Tailscale
kliento nereikia.

## OAuth callback adresai

Google OAuth Web kliente turi būti užregistruoti abu tikslūs adresai:

```text
https://kalendorius.example-tailnet.ts.net/api/auth/google-oidc/callback
https://kalendorius.example-tailnet.ts.net/api/google/callback
```

Microsoft Entra aplikacijos `Web` platformoje turi būti užregistruoti:

```text
https://kalendorius.example-tailnet.ts.net/api/auth/microsoft-oidc/callback
https://kalendorius.example-tailnet.ts.net/api/microsoft/callback
```

Po callback pakeitimų anksčiau prijungtas integracijas gali reikėti prijungti
iš naujo.

## Atnaujinimas ir grįžimas

Atnaujinant pirmiausia pasirink patikrintą Git commit, tada perkurk image:

```bash
git fetch --all --prune
git checkout <commit>
sudo docker compose -f docker-compose.production.yml up -d --build
```

Grįžimui pasirink ankstesnį commit ir pakartok tą pačią Compose komandą.
Duomenų volume nuo image perkūrimo nepašalinamas.
