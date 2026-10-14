# Proxmox VM, Docker ir Tailscale Funnel diegimo vadovas

Atnaujinta 2026-10-14. Ši instrukcija aprašo tą pačią architektūrą, kuri
naudojama „Dienos planui“, ir gali būti pakartota kitam Docker projekte
paleidžiamam web servisui.

```text
Internetas
    │
    ▼
Tailscale Funnel (viešas HTTPS ir *.ts.net adresas)
    │
    ▼
atskira Ubuntu VM Proxmox serveryje
    │
    ├── 127.0.0.1:3000 ── Docker web programėlė
    ├── Docker workeris
    └── vardinis Docker volume su SQLite duomenimis
```

Kolegoms Tailscale kliento nereikia. Jie atidaro viešą HTTPS adresą ir
prisijungia pačioje programėlėje. Maršrutizatoriuje portų atverti nereikia.

## Kodėl pasirinkta atskira VM

Programėlė sąmoningai nebuvo įkelta į bendrą Docker LXC, kuriame veikia
Portainer, Nginx Proxy Manager, AdGuard Home ir medijos servisai. Atskira VM:

- izoliuoja programėlę ir jos OAuth paslaptis nuo kitų servisų;
- leidžia atskirai atnaujinti Ubuntu ir Docker;
- turi savo Proxmox atsargines kopijas ir momentines kopijas;
- leidžia sustabdyti, atkurti ar perkelti programėlę neliečiant kitų servisų;
- nebereikalauja Nginx Proxy Manager, nes HTTPS pateikia Tailscale Funnel.

Vienam nedideliam projektui pakanka 2 vCPU, 3 GB RAM ir 32 GB disko. Kiekvienam
naujam projektui rekomenduojama kurti atskirą VM, jei resursų pakanka.

## 0. Užpildyk diegimo reikšmes

Toliau pateiktuose pavyzdžiuose naudojamos mūsų „Dienos plano“ reikšmės.
Naujam projektui prieš vykdydamas komandas nuspręsk:

| Reikšmė | Mūsų diegimas | Naujo projekto pavyzdys |
| --- | --- | --- |
| Proxmox VMID | `105` | kitas laisvas ID |
| VM vardas ir hostname | `kalendorius` | `mano-projektas` |
| Ubuntu naudotojas | `andrius` | tavo naudotojas |
| VM LAN IP | `192.168.50.82` | DHCP paskirtas arba rezervuotas IP |
| Git repozitorija | `xvetrax/kalendorius` | naujo projekto repo |
| Git šaka | `main` | dažniausiai `main` |
| Diegimo katalogas | `/srv/kalendorius` | `/srv/mano-projektas` |
| Vietinis portas | `3000` | programėlės portas |
| Docker Compose failas | `docker-compose.production.yml` | projekto Compose failas |
| Duomenų volume | `kalendorius-data` | unikalus projekto volume |
| Viešas adresas | `https://kalendorius.taila1dcb8.ts.net` | Funnel suteiktas adresas |

Komandose nenaudok pažodinių `mano-projektas` reikšmių. Pakeisk jas naujo
projekto vardais. Paslapčių, `.env`, DB kopijų ir OAuth žetonų nekelk į Git.

## 1. Patikrink Proxmox resursus

Šias komandas vykdyk **Proxmox hosto shell**, ne būsimoje VM:

```bash
pveversion
pvesh get /cluster/nextid
pvesm status
pveam list local
free -h
ip -4 route
```

Patikrink, kad:

- pasirinktas VMID laisvas;
- `local-lvm` ar kita saugykla turi pakankamai vietos;
- Proxmox hoste lieka pakankamai RAM;
- Ubuntu Server ISO yra `local` saugykloje.

Mūsų ISO buvo:

```text
local:iso/ubuntu-26.04-live-server-amd64.iso
```

Proxmox perspėjimas, kad visų thin volume dydžių suma viršija fizinį pool,
nėra diegimo klaida, tačiau jo ignoruoti negalima. Stebėk `local-lvm` vietą,
sukonfigūruok thin-pool autoextend arba skirk mažesnį diską. Užsipildęs thin
pool gali sugadinti visas jame esančias VM.

## 2. Sukurk VM

Proxmox shell nustatyk naujo projekto reikšmes ir sukurk VM:

```bash
VMID=105
VM_NAME=kalendorius
ISO_VOL=local:iso/ubuntu-26.04-live-server-amd64.iso

qm create "$VMID" \
  --name "$VM_NAME" \
  --description "Docker web application" \
  --ostype l26 \
  --machine q35 \
  --cpu host \
  --sockets 1 \
  --cores 2 \
  --memory 3072 \
  --balloon 2048 \
  --scsihw virtio-scsi-single \
  --scsi0 local-lvm:32,discard=on,iothread=1,ssd=1 \
  --ide2 "$ISO_VOL",media=cdrom \
  --boot 'order=ide2;scsi0' \
  --net0 virtio,bridge=vmbr0,firewall=1 \
  --agent enabled=1,fstrim_cloned_disks=1 \
  --onboot 1

qm config "$VMID"
qm start "$VMID"
```

Jei disko saugykla nėra `local-lvm`, pakeisk tik `--scsi0` saugyklos vardą.
Proxmox UI atverk VM → **Console** ir pradėk Ubuntu diegimą.

## 3. Įdiek Ubuntu Server

Diegimo vedlyje:

1. Pasirink įprastą Ubuntu Server diegimą.
2. Tinklo lange palik DHCP, jei maršrutizatorius vėliau rezervuos tą IP.
3. Saugyklai galima naudoti visą 32 GB diską ir numatytąjį LVM išdėstymą.
4. Nurodyk VM hostname, pavyzdžiui, `kalendorius`.
5. Sukurk administravimo naudotoją, pavyzdžiui, `andrius`.
6. Pažymėk **Install OpenSSH server**.
7. Papildomų snap paketų diegti nereikia.
8. Baigus diegimą perkrauk VM.

Konsolės simbolių rinkiniui ir klaviatūrai tinka `Latin` bei `English (US)`.
Proxmox noVNC konsolėje įklijavimas dažnai ribotas, todėl po pirmo paleidimo
toliau dirbk per SSH.

Po diegimo Proxmox shell pakeisk boot tvarką ir išimk ISO:

```bash
VMID=105
qm set "$VMID" --boot order=scsi0
qm set "$VMID" --delete ide2
```

## 4. Patikrink VM ir prisijunk per SSH

VM konsolėje prisijunk ir paleisk:

```bash
hostnamectl --static
ip -br -4 address
df -h /
systemctl is-active qemu-guest-agent
```

Jei `qemu-guest-agent` neįdiegtas arba neaktyvus:

```bash
sudo apt update
sudo apt install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent
```

Maršrutizatoriuje rezervuok VM DHCP adresą pagal jos MAC adresą. Tai apsaugo
nuo LAN IP pasikeitimo. Mūsų VM gavo `192.168.50.82`.

Savo **Mac arba kitame darbo kompiuteryje** patikrink SSH ir prisijunk:

```bash
nc -vz -G 5 192.168.50.82 22
ssh andrius@192.168.50.82
```

Linux klientas vietoje `nc -G 5` gali naudoti `nc -vz -w 5`. Jei Ubuntu buvo
įdiegtas kaip minimized sistema, komandų aprašymus ir įprastus paketus galima
atkurti su `sudo unminimize`.

## 5. Atnaujink Ubuntu ir įdiek pagalbinius paketus

Nuo šio žingsnio komandas vykdyk **naujos Ubuntu VM SSH sesijoje**:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y ca-certificates curl git nano python3 openssl
sudo reboot
```

Po perkrovimo vėl prisijunk per SSH. Jei naudoji UFW, pirmiausia leisk SSH ir
tik tada jį įjunk:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

Programėlės `3000` porto UFW atverti nereikia.

## 6. Įdiek Docker Engine ir Compose

Naudok oficialią Docker Ubuntu saugyklą:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Patikrink diegimą:

```bash
sudo docker run --rm hello-world
sudo docker version --format 'Server: {{.Server.Version}}'
sudo docker compose version
systemctl is-active docker
```

Mes Docker komandas vykdome su `sudo`; dėl to naudotojo nereikia dėti į
privilegijuotą `docker` grupę.

## 7. Įdiek ir prijunk Tailscale

VM SSH sesijoje:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=kalendorius
```

Komanda parodys prisijungimo nuorodą. Atidaryk ją savo naršyklėje ir prijunk VM
prie pasirinkto tailnet. Tada patikrink:

```bash
systemctl is-active tailscaled
tailscale version
tailscale ip -4
tailscale status
tailscale status --json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"])'
```

Mūsų rezultatas buvo:

```text
Tailscale IP: 100.69.216.10
MagicDNS:     kalendorius.taila1dcb8.ts.net
```

Tailscale IP skirtas administravimui tarp tailnet įrenginių. Viešą prieigą
vėliau pateiks Funnel. Jei SSH per Tailscale IP neveikia, LAN SSH vis tiek
veiks; atskirai patikrink tailnet ACL arba Tailscale SSH nustatymą.

## 8. Nuklonuok projektą

VM SSH sesijoje pakeisk šias reikšmes ir klonuok `main` šaką:

```bash
APP_NAME=kalendorius
INSTALL_DIR=/srv/kalendorius
REPO_URL=https://github.com/xvetrax/kalendorius.git
BRANCH=main

sudo install -d -o "$USER" -g "$(id -gn)" "$INSTALL_DIR"
git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
git status --short --branch
git rev-parse --short HEAD
```

Privačiai repozitorijai naudok atskirą read-only deploy SSH raktą arba GitHub
App. Nedėk asmeninio prieigos rakto į repozitorijos URL ar shell istoriją.

Jei serveris anksčiau buvo klonuotas tik iš vienos feature šakos ir
`origin/main` nerandamas, vieną kartą atkurk visų šakų sekimą:

```bash
cd /srv/kalendorius
git config --replace-all remote.origin.fetch \
  '+refs/heads/*:refs/remotes/origin/*'
git fetch --prune origin
git switch main 2>/dev/null || git switch -c main --track origin/main
git merge --ff-only origin/main
```

## 9. Paruošk `.env`

Pirmiausia VM sukurk šabloną:

```bash
cd /srv/kalendorius
cp .env.example .env
chmod 600 .env
nano .env
```

Jei `.env` ruoši savo Mac, `scp` komandą vykdyk **Mac terminale**, ne VM:

```bash
scp /private/tmp/kalendorius-production.env \
  andrius@192.168.50.82:/srv/kalendorius/.env
```

Tada VM:

```bash
chmod 600 /srv/kalendorius/.env
ls -l /srv/kalendorius/.env
```

„Dienos planui“ būtinos reikšmės:

```dotenv
APP_ORIGIN=https://kalendorius.taila1dcb8.ts.net
PUBLIC_SIGNUP=true
INITIAL_ADMIN_EMAIL=tavo-adresas@example.com
TOKEN_ENCRYPTION_KEY=64_HEX_SIMBOLIAI

VAPID_PUBLIC_KEY=VIESAS_VAPID_RAKTAS
VAPID_PRIVATE_KEY=PRIVATUS_VAPID_RAKTAS
VAPID_SUBJECT=mailto:tavo-adresas@example.com

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://kalendorius.taila1dcb8.ts.net/api/google/callback

MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT=common
MICROSOFT_REDIRECT_URI=https://kalendorius.taila1dcb8.ts.net/api/microsoft/callback

DATABASE_PATH=/app/data/planner.db
TZ=Europe/Vilnius
```

Sugeneruok stabilų žetonų šifravimo raktą:

```bash
openssl rand -hex 32
```

Nukopijuok gautą 64 simbolių reikšmę į `TOKEN_ENCRYPTION_KEY`. Šį raktą ir
VAPID raktus laikyk slaptažodžių saugykloje bei atsarginėje kopijoje. Pakeitus
šifravimo raktą nebebus galima perskaityti saugomų OAuth žetonų. Pakeitus VAPID
raktus naudotojai turės iš naujo įjungti pranešimus.

VAPID raktams pirmiausia sukurk dabartinį image, tada paleisk projekto skriptą:

```bash
cd /srv/kalendorius
sudo docker compose -f docker-compose.production.yml build app
sudo docker compose -f docker-compose.production.yml \
  run --rm --no-deps app npm run vapid:generate
```

Jei naujame projekte tokio npm skripto nėra, naudok jo dokumentacijoje nurodytą
Web Push raktų generatorių. Raktų nekopijuok į pokalbį, Git ar ekrano nuotrauką.

`PUBLIC_SIGNUP=true` leidžia bet kuriam Google ar Microsoft patvirtintam
naudotojui susikurti atskirą programėlės paskyrą. Kvietimų administratoriui
siųsti nereikia. `INITIAL_ADMIN_EMAIL` nustatyk prieš pirmą prisijungimą.

## 10. Sukonfigūruok OAuth viešam adresui

`APP_ORIGIN`, visi OAuth callback adresai ir naršyklėje naudojamas adresas turi
turėti tą pačią HTTPS kilmę. Kelio pabaigoje nepridėk papildomo `/`.

### Google Cloud

Google OAuth Web kliente pridėk:

```text
Authorized JavaScript origin:
https://kalendorius.taila1dcb8.ts.net

Authorized redirect URIs:
https://kalendorius.taila1dcb8.ts.net/api/auth/google-oidc/callback
https://kalendorius.taila1dcb8.ts.net/api/google/callback
```

Tame pačiame Google Cloud projekte įjunk **Google Calendar API** ir
**Google Tasks API**. OAuth consent ekrane pridėk Calendar bei Tasks scopes.
Jei programa veikia **Testing** režimu, kiekvieną bandytojo Google adresą
pridėk prie **Test users**. Prisijungimas ir Calendar/Tasks leidimų suteikimas
yra du atskiri OAuth žingsniai.

### Microsoft Entra

App registration → Authentication → Web pridėk:

```text
https://kalendorius.taila1dcb8.ts.net/api/auth/microsoft-oidc/callback
https://kalendorius.taila1dcb8.ts.net/api/microsoft/callback
```

Pridėk delegated leidimus:

```text
User.Read
Calendars.ReadWrite
Tasks.ReadWrite
offline_access
```

Sukurk Client Secret, jo **Value** iš karto saugiai įrašyk į `.env` ir
slaptažodžių saugyklą. Daugeliui asmeninių ir darbinių paskyrų tinka
`MICROSOFT_TENANT=common`; organizacijos politika gali reikalauti admin consent.

Naujam projektui callback keliai gali būti kitokie. Visada patikrink jo
autentifikacijos maršrutus ir `.env.example`, o ne aklai kopijuok šiuos URL.

## 11. Pirmą kartą paleisk Docker servisus

VM SSH sesijoje:

```bash
cd /srv/kalendorius
sudo docker compose -f docker-compose.production.yml config --quiet
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml ps
```

Palauk, kol abu servisai taps `healthy`, ir patikrink web servisą bei workerį:

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3000/api/health
echo

sudo docker compose -f docker-compose.production.yml \
  exec -T notifications \
  cat /app/data/notification-worker-health.json
echo
```

Compose turi viešinti web portą tik per loopback:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

Taip LAN ir internetas negali apeiti Funnel HTTPS. Duomenys turi būti vardiniame
volume, o ne konteinerio rašomame sluoksnyje. Mūsų volume vadinasi
`kalendorius-data`.

## 12. Įjunk viešą Tailscale Funnel

Pirmą kartą Tailscale gali paprašyti tailnet administratoriaus naršyklėje
įjungti Funnel. Funnel reikalauja MagicDNS, HTTPS ir leidimo šiam įrenginiui.

VM SSH sesijoje:

```bash
sudo tailscale funnel --bg --https=443 http://127.0.0.1:3000
sudo tailscale funnel status
```

Patikrink viešą health adresą:

```bash
curl --fail --silent --show-error \
  https://kalendorius.taila1dcb8.ts.net/api/health
echo
```

`--bg` išsaugo Funnel konfigūraciją, todėl atskiro systemd serviso kurti
nereikia. Kolegoms duok tik viešą programėlės URL:

```text
https://kalendorius.taila1dcb8.ts.net
```

Šis adresas pasiekiamas visam internetui, todėl programėlės prisijungimas,
saugios sesijos ir `PUBLIC_SIGNUP` politika yra būtini.

## 13. Galutinė priėmimo patikra

Patikrink bent šiuos punktus:

1. `docker compose ps` rodo `app` ir `notifications` kaip `healthy`.
2. Vietinis ir viešas `/api/health` grąžina `{"ok":true,...}`.
3. Google ir Microsoft prisijungimas grįžta į tikslų viešą adresą.
4. Naujas naudotojas gauna savo atskirą darbo erdvę.
5. Google Calendar / Tasks ir Microsoft Calendar / To Do prijungiami atskirai.
6. Programėlė įdiegiama kaip PWA, sesija išlieka ją uždarius ir vėl atidarius.
7. Web Push bandomas kiekviename įrenginyje atskirai.
8. VM perkrovus Docker servisai ir Funnel vėl veikia.

VM perkrovimo patikra:

```bash
sudo reboot
```

Po kelių minučių vėl prisijunk ir paleisk:

```bash
cd /srv/kalendorius
sudo docker compose -f docker-compose.production.yml ps
sudo tailscale funnel status
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
curl --fail --silent --show-error \
  https://kalendorius.taila1dcb8.ts.net/api/health
```

## 14. Saugus programėlės atnaujinimas

Atnaujink tik iki patikrinto `main` commit. Pirmiausia pastatyk naują image,
kol sena programėlė dar veikia. Tada trumpam sustabdyk abu servisus, sukurk
nuoseklią SQLite kopiją ir paleisk naują versiją.

### 14.1. Atnaujink Git ir išsaugok seną image

```bash
set -Eeuo pipefail

cd /srv/kalendorius
sudo -v

if [ -n "$(git status --porcelain)" ]; then
  echo "KLAIDA: repozitorijoje yra neįrašytų pakeitimų."
  git status --short
  exit 1
fi

git fetch --prune origin
git switch main
git merge --ff-only origin/main

COMMIT="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$HOME/planner-pre-$COMMIT-$STAMP.db"
ROLLBACK_IMAGE="kalendorius:pre-$COMMIT-$STAMP"

OLD_IMAGE="$(sudo docker inspect --format '{{.Image}}' kalendorius-app)"
sudo docker image tag "$OLD_IMAGE" "$ROLLBACK_IMAGE"

echo "Diegiama versija: $COMMIT"
echo "Rollback image: $ROLLBACK_IMAGE"
```

Naujam projektui pakeisk konteinerio vardą `kalendorius-app`, image vardą ir
DB kopijos prefiksą pagal jo Compose failą.

### 14.2. Pastatyk image, sustabdyk servisus ir nukopijuok DB

Tęsk toje pačioje SSH sesijoje, kad išliktų ankstesnio bloko kintamieji:

```bash
sudo docker compose -f docker-compose.production.yml build app

sudo docker compose -f docker-compose.production.yml \
  stop notifications app

sudo docker cp \
  kalendorius-app:/app/data/planner.db \
  "$BACKUP"

sudo chown "$USER:$(id -gn)" "$BACKUP"
chmod 600 "$BACKUP"

sudo docker compose -f docker-compose.production.yml \
  up -d --force-recreate
```

SQLite kopiją daryk tik sustabdęs ir web servisą, ir workerį. Kitu atveju
atskirai gali likti WAL duomenų ir kopija nebus nuosekli.

### 14.3. Palauk health ir patikrink abu adresus

```bash
for attempt in $(seq 1 45); do
  app_health="$(sudo docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    kalendorius-app)"
  worker_health="$(sudo docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    kalendorius-notifications)"

  echo "Patikra $attempt: app=$app_health, worker=$worker_health"
  if [ "$app_health" = healthy ] && [ "$worker_health" = healthy ]; then
    break
  fi
  sleep 2
done

test "$app_health" = healthy
test "$worker_health" = healthy

sudo docker compose -f docker-compose.production.yml ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
echo
sudo docker compose -f docker-compose.production.yml \
  exec -T notifications cat /app/data/notification-worker-health.json
echo
curl --fail --silent --show-error \
  https://kalendorius.taila1dcb8.ts.net/api/health
echo

echo "Įdiegta Git versija: $(git rev-parse --short HEAD)"
echo "DB kopija: $BACKUP"
echo "Rollback image: $ROLLBACK_IMAGE"
```

Programėlės `/api/health` šiuo metu rodo `package.json` versiją, pavyzdžiui,
`0.1.0`, o ne Git commit. Tikslus įdiegtas kodas tikrinamas VM:

```bash
cd /srv/kalendorius
git rev-parse --short HEAD
git status --short --branch
```

## 15. Grįžimas į ankstesnę versiją

Naudok ankstesniame žingsnyje išsaugotą DB failą ir image vardą. Pavyzdyje
juos pakeisk tikromis reikšmėmis:

```bash
cd /srv/kalendorius

BACKUP=/home/andrius/planner-pre-ABC1234-20261009T160206Z.db
ROLLBACK_IMAGE=kalendorius:pre-ABC1234-20261009T160206Z

sudo docker compose -f docker-compose.production.yml \
  stop notifications app

sudo docker run --rm \
  --user root \
  -v kalendorius-data:/app/data \
  -v "$BACKUP:/backup/planner.db:ro" \
  --entrypoint sh "$ROLLBACK_IMAGE" \
  -c 'cp /backup/planner.db /app/data/planner.db && \
      rm -f /app/data/planner.db-wal /app/data/planner.db-shm'

sudo docker image tag "$ROLLBACK_IMAGE" kalendorius:0.1.0
sudo docker compose -f docker-compose.production.yml \
  up -d --force-recreate

sudo docker compose -f docker-compose.production.yml ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

Grąžink ir Git checkout į commit, iš kurio buvo sukurtas rollback image, kad
kitas atnaujinimas nebūtų statomas iš netinkamo kodo. Po atkūrimo patikrink
prisijungimą, duomenis, workerį ir viešą health adresą.

## 16. Atsarginės kopijos

Naudok tris nepriklausomus sluoksnius:

1. Programėlės administratoriaus **Pilna kopija** prieš svarbų atnaujinimą.
2. Sustabdytos SQLite DB kopija prieš kiekvieną diegimą.
3. Periodinė Proxmox VM atsarginė kopija į kitą fizinę saugyklą.

Pilnoje programėlės kopijoje yra užšifruoti OAuth žetonai ir push duomenys,
todėl ją saugok kaip slaptažodį. Atkūrimui reikės to paties
`TOKEN_ENCRYPTION_KEY`. Proxmox snapshot patogus trumpam grįžimui, tačiau nėra
atsarginė kopija, jei lieka tame pačiame diske.

Proxmox UI galima sukurti periodinį darbą per **Datacenter → Backup**. Vienai
rankinei kopijai Proxmox shell naudok savo VMID ir atsarginių kopijų saugyklą:

```bash
VMID=105
BACKUP_STORAGE=backup-usb
vzdump "$VMID" \
  --storage "$BACKUP_STORAGE" \
  --mode snapshot \
  --compress zstd
```

Po pirmos kopijos patikrink, kad failas tikrai atsirado pasirinktoje
saugykloje ir kad jo atkūrimo veiksmas matomas Proxmox UI.

## 17. Kasdienė diagnostika

```bash
cd /srv/kalendorius

sudo docker compose -f docker-compose.production.yml ps
sudo docker compose -f docker-compose.production.yml \
  logs --tail=200 app notifications

curl --fail --silent --show-error http://127.0.0.1:3000/api/health
sudo tailscale status
sudo tailscale funnel status
curl --fail --silent --show-error \
  https://kalendorius.taila1dcb8.ts.net/api/health

df -h /
sudo docker system df
```

Nenaudok `docker system prune --volumes`: ši komanda gali pašalinti duomenų
volume. Periodiškai tikrink disko vietą, nes seni image ir logai kaupiasi.

### Funnel rodomas, bet viešas adresas neatsidaro

Pirmiausia patikrink vietinį health. Jei jis veikia, perkurk tik Funnel būseną:

```bash
sudo tailscale funnel reset
sudo systemctl restart tailscaled
sudo tailscale funnel --bg --https=443 http://127.0.0.1:3000
sudo tailscale funnel status
```

### Konteineris dar tik startuoja

Iškart po `up -d --build` pirmas `curl` gali grąžinti `connection reset`.
Palauk, kol `docker compose ps` rodys `healthy`, tada kartok health patikrą.

### `scp` neranda lokalaus failo

`scp /private/tmp/...` reikia vykdyti tame Mac, kuriame yra failas. Paleidus
komandą VM, `/private/tmp` reiškia VM failų sistemą ir failo ten nebus.

### Nepavyksta įklijuoti Proxmox konsolėje

Tai noVNC konsolės apribojimas. Naudok SSH iš Mac terminalo. Ilgas komandas
kopijuok po vieną bloką ir prieš Enter patikrink, ar neatsirado Markdown nuorodų
ar nematomų simbolių.

### OAuth grąžina `redirect_uri_mismatch`

Palygink klaidoje siunčiamą URL su Google arba Microsoft console įrašu. Turi
sutapti schema `https`, hostas, kelias ir slash. Pakeitimai Google pusėje gali
įsigalioti po kelių minučių.

## Oficialūs šaltiniai

- [Proxmox VE administravimo vadovas](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf)
- [Docker Engine diegimas Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Tailscale diegimas Linux](https://tailscale.com/docs/install/linux)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
