# „Dienos planas“ PWA įgyvendinimo planas

Atnaujinta: 2026-10-03. Būsena: PWA-1a užbaigtas; PWA-1b kodas ir automatinė patikra užbaigti, liko realių įrenginių ir gyvos OAuth sesijos priėmimo patikra. Gyva kelių paskyrų MA-8b patikra užbaigiama lygiagrečiai pagal [kelių Google ir Microsoft paskyrų etapą](MULTI_ACCOUNT_PLAN.md).

## Įgyvendinimo eiga

- [x] **PWA-1a:** manifestas, 192×192, 512×512, maskable ir Apple Touch ikonos, šviesios / tamsios temos naršyklės spalvos bei vieša prieiga prieš prisijungimą.
- [ ] **PWA-1b:** diegimo sąsaja, standalone ir safe-area išdėstymas įgyvendinti; liko gyva OAuth, atsijungimo ir realaus macOS / Android įdiegimo patikra.
- [ ] **PWA-2:** saugus service worker, ryšio būsena ir programos atnaujinimo eiga.

### PWA-1b perdavimo būsena

- Praėjo `npm run typecheck`, 315 vienetinių / integracinių testų, produkcinis `npm run build`, HTTP smoke ir Docker smoke patikros.
- PWA diegimo bei mobiliojo išdėstymo Playwright scenarijai praėjo 8/8; į juos įtrauktas priimtas ir atmestas naršyklės diegimo dialogas, `appinstalled`, standalone bei iOS standalone būsenos.
- Pirmo nepriklausomo vertinimo pastabos dėl horizontalaus telefono `safe-area` ir vienkartinio atmesto diegimo įvykio sutvarkytos bei padengtos testais.
- Pakartotinis nepriklausomas vertinimas neįvyko, nes vertinimo agento workspace baigėsi kreditai. Prieš pažymint PWA-1b užbaigtu reikia peržiūrėti galutinį diff ir atlikti žemiau nurodytą gyvą patikrą.
- Gyvai patikrinti: diegimą ir paleidimą macOS bei Android, prisijungimą ir atsijungimą standalone lange, Google ir Microsoft OAuth grįžimą bei pasibaigusios sesijos nukreipimą į `/login`.

## Tikslas

Padaryti esamą Next.js programėlę įdiegiamą macOS, Windows ir Android įrenginiuose kaip atskirą programą, išlaikant vieną web kodo bazę. Pirmoji PWA versija turi suteikti programos ikoną, atskirą langą, patogų paleidimą ir aiškią ryšio būseną. Pranešimai bei ribotas darbas be interneto įvedami vėliau, kai įdiegimas jau patikrintas realiuose įrenginiuose.

PWA nepakeičia serverio: naudotojų paskyros, Google / Microsoft integracijos, SQLite duomenys ir sinchronizacija lieka serveryje. HTTPS yra privalomas; dabartinis Tailscale Funnel adresas tinka bandymui, tačiau prieš viešą pranešimų paleidimą verta pasirinkti stabilų galutinį domeną, nes Web Push prenumerata susieta su konkrečiu origin.

## Esama būsena

- Programėlė naudoja Next.js 16 App Router ir produkcinį `standalone` Docker build.
- Viešas diegimas jau pateikiamas per HTTPS.
- `public/` šiuo metu turi tik `favicon.svg`; nėra PWA manifest'o, PNG ikonų ar service worker.
- Autentifikuoti kalendorių ir užduočių API atsakymai turi `Cache-Control: no-store`. Šios apsaugos negalima apeiti service worker podėliu.
- Programėlė turi fokusavimo laikmatį, tačiau uždarius programą patikimam pranešimui reikės Web Push ir serverio suplanuotų darbų, o ne vien naršyklės `setTimeout`.

Techninis pagrindas: [oficialus Next.js PWA vadovas](https://nextjs.org/docs/app/guides/progressive-web-apps) ir [manifest failo konvencija](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest).

## Ribos ir saugumo principai

1. Service worker netalpina į Cache Storage autentifikuotų `/api/*` atsakymų, kalendoriaus įvykių, užduočių, OAuth duomenų ar atsarginių kopijų.
2. Pirma versija neleidžia redaguoti duomenų be interneto. Taip išvengiama konfliktų su Google, Microsoft ir vietinėmis versijomis.
3. Atsijungus ištrinami programos naudotojui priklausantys naršyklės duomenys ir panaikinama jo Push prenumerata šiame įrenginyje.
4. Pranešimų turinys pagal nutylėjimą neatskleidžia privataus užduoties ar įvykio pavadinimo užrakintame ekrane. Detalus turinys yra atskiras naudotojo pasirinkimas.
5. Leidimo pranešimams prašoma tik po aiškaus naudotojo veiksmo ir paaiškinimo. Pirmo apsilankymo metu naršyklės leidimo langas nerodomas.
6. Kai PWA funkcijos nepalaikomos, aplikacija ir toliau veikia kaip įprastas tinklalapis.

## PWA-1 — įdiegiama programėlė

### Darbai

- Sukurti `app/manifest.ts` su:
  - `name: Dienos planas`;
  - trumpu pavadinimu, aprašymu, `start_url: /`, `scope: /`;
  - `display: standalone`;
  - šviesios ir tamsios sąsajos spalvomis;
  - 192×192, 512×512 ir `maskable` PNG ikonomis.
- Manifestą, ikonas ir vėliau `/sw.js` įtraukti į viešas `proxy.ts` išimtis. Šie keliai turi būti pasiekiami prieš prisijungimą, tačiau juose negali būti naudotojo duomenų.
- Paruošti Apple Touch 180×180 ikoną ir atnaujinti Next metadata.
- Patikrinti ikonų kraštus šviesiame, tamsiame ir Android `maskable` fone.
- Pridėti saugios zonos (`env(safe-area-inset-*)`) palaikymą telefono apačios navigacijai ir modalams.
- Nustatymuose pridėti skiltį **Įdiegti programėlę**:
  - Android / Chromium naršyklėse rodyti galimą diegimo veiksmą;
  - iPhone / iPad pateikti instrukciją „Bendrinti → Add to Home Screen“;
  - macOS paaiškinti Chrome / Edge diegimą ir Safari „Add to Dock“;
  - jau `standalone` režimu veikiančioje programoje skilties neberodyti kaip kvietimo diegti.
- Patikrinti, kad prisijungimo ir OAuth grįžimo eiga veikia PWA lange bei pasibaigus sesijai grąžina į `/login`.

### Priėmimo kriterijai

- Manifestas ir visos ikonos produkciniame Docker image grąžinamos su teisingais MIME tipais.
- Neprisijungęs naudotojas gali gauti manifestą, ikonas ir service worker failą, bet negali pasiekti jokio privataus API.
- Chrome / Edge gali įdiegti programą be DevTools klaidų.
- Įdiegta programa atsidaro atskirame lange, teisingu pavadinimu ir ikona.
- Programos navigacija, OAuth ir atsijungimas veikia taip pat kaip naršyklėje.
- Android ir macOS realiame įrenginyje atliktas įdiegimo, paleidimo, atnaujinimo ir pašalinimo scenarijus.

## PWA-2 — ryšio būsena ir saugus programos karkasas

### Darbai

- Pridėti minimalų, aiškiai versijuojamą service worker.
- Service worker podėlyje laikyti tik nekintamus viešus statinius resursus ir atskirą offline puslapį; navigacijai taikyti `network first`.
- `/sw.js` nustatyti:
  - `Content-Type: application/javascript; charset=utf-8`;
  - `Cache-Control: no-cache, no-store, must-revalidate`;
  - atskirą griežtą Content Security Policy.
- Aplikacijoje rodyti būseną **Nėra interneto** ir išjungti serverio įrašymo veiksmus, kol ryšys negrįžo.
- Atsiradus naujai versijai parodyti aiškų veiksmą **Atnaujinti programėlę**, o ne priverstinai perkrauti atidarytą redaktorių.
- Pakeitus cache versiją pašalinti senus viešų resursų podėlius.

### Sąmoningai neatliekama šiame etape

- Neatidaromi paskutiniai kalendoriaus ar užduočių duomenys be interneto.
- Nekuriama offline mutacijų eilė.
- Nedaromas periodinis Google ar Microsoft sinchronizavimas per service worker.

### Priėmimo kriterijai

- Pirmą kartą programą būtina atidaryti prisijungus prie interneto.
- Nutrūkus ryšiui jau įdiegta programa parodo saugų offline ekraną ir nevaizduoja kito naudotojo duomenų.
- Grįžus ryšiui aplikacija atsigauna be pakartotinio diegimo.
- Atsijungus ir prisijungus kitu naudotoju Cache Storage bei naršyklės saugyklose nelieka ankstesnio naudotojo privataus turinio.
- Naujas Docker leidimas perima valdymą be įstrigusio seno service worker.

## PWA-3 — pranešimai

### Pirmi pranešimų scenarijai

1. Fokusavimo sesija baigėsi.
2. Suplanuota užduotis prasidės po naudotojo pasirinkto laiko.
3. Dienos planavimo priminimas pasirinktu ryto laiku.
4. Dienos uždarymo priminimas pasirinktu vakaro laiku.

Įvykių priminimų iš pradžių nedubliuoti: juos jau gali siųsti Google arba Microsoft. Programėlė turi aiškiai paaiškinti, kurie pranešimai yra jos, o kurie — kalendoriaus tiekėjo.

### Serverio dalis

- Sugeneruoti VAPID raktus ir laikyti privatų raktą tik serverio aplinkoje.
- Pridėti naudotojui priklausančias `push_subscriptions` prenumeratas su įrenginio pavadinimu, sukūrimo data ir paskutiniu sėkmingu pristatymu.
- Pridėti `notification_preferences` ir patvarų `notification_jobs` registrą.
- Paleisti atskirą Docker worker procesą / servisą, kuris:
  - paima mokėtinus darbus;
  - vieną pranešimą išsiunčia ne daugiau kaip vieną kartą;
  - saugiai pakartoja laikinas klaidas;
  - pašalina nebegaliojančias 404 / 410 prenumeratas;
  - nekliudo pagrindiniam Next.js procesui persikrauti.
- Pranešimo paspaudimas atidaro tik tos pačios kilmės programos adresą. Jei sesija pasibaigusi, naudotojas pirmiausia patenka į prisijungimą.

### Kliento dalis

- Nustatymuose pridėti aiškų pranešimų įjungimą, būseną ir bandomąjį pranešimą.
- Leisti atskirai įjungti kiekvieną scenarijų, pasirinkti laiką ir privataus turinio rodymą.
- Rodyti šiame naudotojo profilyje prijungtų įrenginių sąrašą bei leisti atšaukti konkretų įrenginį.
- iOS paaiškinti, kad Web Push veikia tik įdiegus PWA į pagrindinį ekraną ir leidimą suteikus naudotojo veiksmu.

### Priėmimo kriterijai

- Vienas naudotojas negali skaityti, keisti ar išsiųsti kito naudotojo prenumeratos.
- Tas pats pranešimo darbas po worker ar konteinerio perkrovimo neišsiunčiamas dukart.
- Fokusavimo pabaiga pristatoma, kai PWA uždaryta, jei įrenginys ir naršyklė tai palaiko.
- Atšaukus leidimą arba ištrynus paskyrą, nauji pranešimai nebesiunčiami.
- Patikrinta Android Chrome, macOS Chrome / Safari ir bent viename iPhone su įdiegta PWA.

## PWA-4 — ribotas darbas be interneto (vėlesnis etapas)

Šis etapas pradedamas tik surinkus realų poreikį. Pirmiausia leidžiama tik perskaityti paskutinį naudotojo aiškiai pasirinktą dienos planą. Duomenys laikomi IndexedDB, raktinami pagal naudotojo ID, turi galiojimo laiką ir visiškai ištrinami atsijungus.

Offline kūrimas ar redagavimas yra atskiras projektas. Jam reikės patvarios veiksmų eilės, idempotentiškų operacijų ID, konfliktų ekrano ir aiškių Google / Microsoft versijų taisyklių. Jis neįtraukiamas į pradinį PWA leidimą.

## Testavimo matrica

### Automatinė patikra

- Manifesto schema, reikalingi dydžiai, `start_url`, `scope` ir `display`.
- Visų ikonų HTTP 200, MIME tipai ir įtraukimas į standalone Docker image.
- Service worker antraštės, versijos pakeitimas ir senų podėlių valymas.
- Draudimas talpinti `/api/*`, `/login`, backup ar OAuth atsakymus į Cache Storage.
- Offline ekrano Playwright scenarijus ir saugus atsistatymas grįžus ryšiui.
- Push prenumeratų naudotojų izoliacija, CSRF, ištrynimas, 404 / 410 valymas ir pranešimų idempotentiškumas.
- Pilnas `npm test`, `npm run typecheck`, `npm run build`, smoke ir aktualūs Playwright scenarijai po kiekvieno didesnio PWA etapo.

### Rankinė patikra

| Platforma | Įdiegimas | Atskiras langas | Offline būsena | Push |
| --- | --- | --- | --- | --- |
| Android Chrome | privaloma | privaloma | privaloma | privaloma |
| macOS Chrome / Edge | privaloma | privaloma | privaloma | privaloma |
| macOS Safari | Add to Dock | privaloma | privaloma | privaloma |
| iPhone Safari | Add to Home Screen | privaloma | privaloma | privaloma |
| Įprasta naršyklė be diegimo | netaikoma | netaikoma | degradacija | pasirenkama, jei palaikoma |

## Diegimo ir leidimų seka

Kiekviena užbaigta eilutė yra atskiras patikrintas commit ir push į aktyvią šaką. Pilnas testų rinkinys leidžiamas užbaigus didesnį etapą.

1. **PWA manifestas ir ikonų rinkinys.** Be service worker ir be pranešimų.
2. **Diegimo sąsaja ir standalone išdėstymas.** Tik po realaus macOS / Android įdiegimo patikros.
3. **Service worker ir offline karkasas.** Tik vieši statiniai resursai, jokio privataus API cache.
4. **Ryšio bei programos atnaujinimo sąsaja.** Patikrinti nebaigto redagavimo apsaugą.
5. **Push prenumeratos ir nustatymai.** Pirmiausia bandomasis pranešimas.
6. **Patvarus notification worker.** Tada fokusavimo ir dienos ritualų pranešimai.
7. **Visų platformų priėmimo patikra ir dokumentacija.** Tik po jos PWA laikoma viešai paruošta.

## White-label paruošimas

- Manifesto pavadinimas, spalvos ir ikonų adresai ilgainiui turi būti gaunami iš brand konfigūracijos.
- Kiekvienas white-label domenas turės atskirą PWA diegimą ir atskiras Push prenumeratas.
- VAPID identitetas, privatumo politika, pranešimų tekstai ir pagalbos adresas turi būti konfigūruojami pagal klientą.
- Pirmiems white-label klientams saugiausia naudoti atskirą Docker instanciją, DB, domeną ir raktus; bendras kelių nuomininkų Push worker paliekamas vėlesnei SaaS architektūrai.

## Rekomenduojama pirmoji apimtis

Pirmajam leidimui įgyvendinti tik **PWA-1** ir **PWA-2**. Tai suteiks įdiegiamos programos patirtį be rizikos netyčia išsaugoti privačius kalendoriaus duomenis arba sukurti nepatikimą offline redagavimą. Pranešimus pradėti tik pasirinkus stabilų viešą domeną ir patvirtinus, kad pagrindinė programėlė patikimai veikia su gyvomis Google bei Microsoft paskyromis.
