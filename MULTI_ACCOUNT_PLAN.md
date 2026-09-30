# Kelių Google ir Microsoft paskyrų įgyvendinimo planas

Atnaujinta: 2026-09-30. Būsena: **MA-8a baigtas** — automatinė regresija, Docker ir backup roundtrip praėjo; liko MA-8b gyvų paskyrų priėmimas.

## Įgyvendinimo būsena

- [x] **MA-1a:** versijuota, pakartojama SQLite migracija pakeičia OAuth unikalumą į `user + provider + provider_account_id`, išlaikydama esamus ID, užšifruotus žetonus, scopes, generation ir laikus.
- [x] **MA-1b:** pridėtos savininkui pririštos `calendar_preferences` ir `calendar_preference_sets`, išsaugomas aiškiai tuščias pasirinkimas, o Outlook blokai turi `mirror_connection_id` su savininko apsauga ir saugiu backfill.
- [x] **MA-2a:** OAuth servisas moka išvardyti jungtis bei rasti jas pagal ID ar tiekėjo paskyrą; tas pats account atnaujinamas vietoje, kita paskyra sukuriama kaip atskira eilutė, o senas vienos paskyros metodas kelių aktyvių jungčių atveju sustoja su aiškia klaida.
- [x] **MA-2b:** OAuth operacijoje serveryje saugomas `add` arba `reconsent` režimas ir laukiamas jungties ID; callback tikrina tikrą tiekėjo paskyrą, statusas grąžina saugų `connections` sąrašą, o viena jungtis atjungiama pagal konkretų ID.
- [x] **Backup / restore pagrindas:** pilna kopija apima naujas lenteles ir schemos versiją, sena kopija normalizuojama atkūrimo transakcijoje, tikrinami išoriniai raktai ir neatkuriamos senos naršyklės sesijos.
- [x] **MA-3:** nustatymų UI rodo visas jungtis su atskirais pridėjimo, atnaujinimo ir atjungimo veiksmais (`IntegrationAccounts.tsx`); `/api/auth/me` grąžina `identities` ir `activeSessionCount`.
- [x] **MA-4a/b:** agreguotas kelių paskyrų kalendorių katalogas (`/api/google/calendars`, `/api/microsoft/calendars`) su normalizuotais pasirinkimais; įvykių GET agregavimas per `allSettledLimited` su dalinėmis klaidomis UI.
- [x] **MA-5:** vieninga spalvų sistema — `calendarColor` ant įvykių per visus rodinius (dienos, savaitės, mėnesio, visos dienos blokai); primary/default kalendoriaus atsarginė spalva neeksplicitiniam pasirinkimui.
- [x] **MA-6:** jungčiai priskirtas įvykių kūrimas ir visos mutacijos (PATCH/PUT/DELETE) tikrina `connectionId`; `ExistingEventEditor` rodo kalendoriaus pavadinimą.
- [x] **MA-7:** visi užduočių maršrutai naudoja jungčiai priskirtus gateway; sąrašų paskirtys rodo paskyros etiketę; mutacijos tikrina account ir connection ID; Outlook blokui pasirenkama Microsoft paskyra, o blokas kuriamas jos numatytajame kalendoriuje.
- [x] **MA-8a:** `npm run typecheck`, 310/310 Node testų, produkcinis build, smoke, Calendar / Tasks HTTP patikros ir 45/45 Playwright scenarijai praėjo. `npm run test:docker` patvirtino image build, health, keturių OAuth jungčių pilnos kopijos atkūrimą ir pakartotinį paleidimą su tais pačiais duomenimis (2026-09-30).
- [ ] **Kitas žingsnis — MA-8b:** kontroliuojamas priėmimas su gyvomis Google ir Microsoft paskyromis bei rezultato dokumentavimas.

## Produkto tikslas

Vienas „Dienos planas“ naudotojas gali vienu metu prijungti kelias asmenines ir darbines Google bei Microsoft paskyras. Visų pasirinktų paskyrų kalendoriai rodomi viename kalendoriuje, o kiekvieną konkretų kalendorių galima parodyti arba paslėpti paprastu checkbox. Užduočių sąrašai iš visų prijungtų paskyrų taip pat pasiekiami bendrame planavime.

Pagrindinis scenarijus:

1. Naudotojas prijungia asmeninę Google, antrą Google Workspace, asmeninę Microsoft ir darbinę Microsoft 365 paskyrą.
2. Nustatymuose mato keturias atskiras paskyras, jų būseną ir kalendorius.
3. Pažymi norimus kalendorius; pasirinkimas išlieka po perkrovimo ir kituose tos programėlės įrenginiuose.
4. Dienos, savaitės, mėnesio ir visos dienos vaizduose įvykiai turi nuoseklias paskyros bei kalendoriaus spalvas ir tekstinę kilmę.
5. Naują įvykį ar užduotį kurdamas pasirenka konkrečią paskyrą ir kalendorių / sąrašą.
6. Vienos paskyros klaida, leidimo atšaukimas ar atjungimas nesustabdo kitų paskyrų duomenų.

## Sąvokų atskyrimas

- **Prisijungimo tapatybė** leidžia prisijungti į pačią programėlę per Google arba Microsoft. Ji neprideda kalendoriaus.
- **Integracijos paskyra** yra konkreti Google Calendar + Tasks arba Outlook + To Do OAuth jungtis.
- **Kalendorius** priklauso vienai integracijos paskyrai. Viena paskyra gali turėti daug kalendorių.
- **Connection ID** yra programėlės vidinis OAuth jungties ID. Jis visada tikrinamas kartu su prisijungusiu programėlės naudotoju ir tiekėjo paskyros ID.

UI privalo šias sąvokas įvardyti skirtingai. Veiksmas **Pridėti kalendoriaus paskyrą** negali būti painiojamas su **Susieti prisijungimo būdą**.

## Dabartinė techninė būsena

### Kas jau tinkama kelioms paskyroms

- OAuth schema, servisas ir duomenų OAuth callback palaiko kelias jungtis, aiškius `add` / `reconsent` režimus bei tikslų vienos jungties atjungimą.
- Statuso API grąžina saugų `connections` sąrašą, palikdamas senus laukus suderinamumui.
- Kalendorių pasirinkimai saugomi pagal jungtį normalizuotose lentelėse; aiškiai tuščias pasirinkimas atskiriamas nuo dar nepasirinktos būsenos.
- Outlook papildomas blokas saugo `mirror_connection_id`, o DB neleidžia susieti kito naudotojo ar ne Microsoft jungties.
- Kalendoriaus įvykio tapatybė apima tiekėją, `connectionId`, kalendorių ir įvykio ID.
- Kalendoriaus kūrimo operacijų registras jau turi paskyros bei jungties ID.
- Nuotolinių užduočių ir sąrašų talpykla turi tiekėją bei `account_id`.
- Google ir Microsoft prieigos žetonų talpyklos viduje jau raktinamos pagal jungties ID.
- Užduoties paskirties pasirinkimas jau rodo tiekėjo sąrašus.

### Kas dar nepatvirtinta

- Tikrų Google ir Microsoft OAuth langų, leidimų atšaukimo ir tiekėjų klaidų elgsena su dviem kiekvieno tiekėjo paskyromis.
- Gyvas kiekvienos paskyros Calendar / Tasks CRUD, Outlook bloko nukreipimas ir pasirinkimų išlikimas kitame įrenginyje.
- Tiekėjų išorinių versijų konfliktai bei ribojimo (`429`) atsakymai šiame etape patikrinti sintetiškai, bet dar ne gyvose paskyrose.

## Nekintamos saugumo taisyklės

1. Klientas niekada nepateikia `user_id`; savininkas nustatomas tik iš serverio sesijos.
2. Kiekvienas kliento pateiktas `connectionId` tikrinamas pagal `user_id`, tiekėją ir, kai taikoma, `provider_account_id`.
3. Vienas naudotojas negali sužinoti, ar ta pati Google / Microsoft paskyra prijungta kitam programėlės naudotojui.
4. Refresh žetonai lieka AES-256-GCM užšifruoti; jų negalima grąžinti statuso, atsarginės kopijos eksporto ar klaidos atsakyme.
5. Vienos paskyros atjungimas, žetono rotacija ar vėluojantis OAuth atsakymas negali pakeisti kitos jungties.
6. Kalendoriaus ir užduoties mutacija visada turi vienareikšmę jungtį. Jei jos trūksta, operacija atmetama, o ne parenkama „pirma“ paskyra.
7. Administratorius negauna prieigos prie kitų naudotojų integracijų ar kalendorių.

## MA-1 — duomenų modelio išplėtimas

### OAuth jungtys

SQLite migracijoje `oauth_connections` lentelė perstatoma išsaugant esamus `id` ir duomenis:

- pašalinamas `UNIQUE(user_id, provider)`;
- pridedamas `UNIQUE(user_id, provider, provider_account_id)`;
- pridedamas naudotojo pasirenkamas `display_label`;
- pridedama stabili `color_key` arba saugomas paskyrai paskirtas paletės indeksas;
- statusas naudojamas atskirti aktyvią, leidimo netekusią ir atjungtą jungtį;
- indeksas optimizuojamas pagal `user_id + provider + status`.

Migracija vykdoma vienoje transakcijoje: sukurti naują lentelę, nukopijuoti eilutes su tais pačiais ID, patikrinti eilučių skaičių ir unikalumą, pervadinti lenteles. Prieš diegimą daroma pilna DB kopija.

### Kalendorių pasirinkimai

Vietoje vieno tiekėjo JSON nustatymo kuriama normalizuota lentelė, pavyzdžiui:

```text
calendar_preferences
  user_id
  connection_id
  calendar_id
  enabled
  color_override
  updated_at
```

Pirminis raktas: `user_id + connection_id + calendar_id`. `connection_id` turi užsienio raktą į OAuth jungtį. Dabartiniai Google ir Microsoft kalendorių pasirinkimai perkeliami prie esamos jungties; jeigu ankstesnis JSON neteisingas, pasirinkimai nepanaikinami tyliai ir migracija užregistruoja diagnostiką.

### Veidrodiniai Outlook blokai

`task_plans` papildomas `mirror_connection_id`. Esami blokai susiejami su dabartine Microsoft jungtimi tik kai sutampa išsaugotas `mirror_account_id`; neaiškus ryšys pažymimas tvarkymui ir nėra automatiškai trinamas ar perkeliamas.

### Schemos versija ir grįžimas

- Įvedama aiški DB schemos versija ir idempotentiška migracija.
- Senų stulpelių ar nustatymų šiame etape netriname.
- Kol nepridėta antra to paties tiekėjo paskyra, galima grįžti prie ankstesnio konteinerio naudojant prieš migraciją padarytą DB kopiją.
- Kai realiai prijungiama antra paskyra, senas programos build tampa nesuderinamas. Grįžimui naudojamas naujo kodo taisomasis leidimas arba visa prieš diegimą padaryta kopija; papildomos paskyros netrinamos automatiškai.

### Priėmimo kriterijai

- Dabartinės Google ir Microsoft eilutės išlaiko ID, užšifruotą žetoną, paskyros ID, scopes ir generation.
- Migraciją galima saugiai pakartoti.
- Sugadinus kopijavimo patikrą visa migracija rollback'inama.
- Pilna atsarginė kopija bei atkūrimas apima naujas lenteles ir stulpelius.

## MA-2 — kelių jungčių OAuth paslauga

### Naujas paslaugos kontraktas

- `listConnections(userId, provider?)` grąžina visas naudotojo jungtis.
- `getConnectionById(userId, connectionId, provider?)` privalomai tikrina savininką.
- `getConnectionByAccount(userId, provider, accountId)` naudojamas dubliui bei pakartotiniam prijungimui atpažinti.
- `saveConnection` įrašo ar atnaujina tik konkrečią `user + provider + provider_account_id` eilutę.
- `disconnectConnection(userId, connectionId)` atjungia vieną pasirinktą jungtį.

Senas `getConnection(userId, provider)` laikinai paliekamas tik suderinamumo etapui ir turi mesti aiškią klaidą, jei randama daugiau nei viena aktyvi jungtis. Jis negali tyliai parinkti pirmos eilutės.

### OAuth prijungimo režimai

- **Pridėti naują paskyrą:** `mode=add`, nesiunčiamas senos paskyros `login_hint`, Google / Microsoft lange prašoma pasirinkti paskyrą.
- **Atnaujinti leidimą:** perduodamas tik naudotojui priklausantis `connectionId`; naudojamas tos paskyros hint ir tikimasi to paties tiekėjo account ID.
- **Suteikti papildomą Google Tasks leidimą:** visada atnaujinama tik pasirinkta Google jungtis.

Callback pirmiausia saugiai gauna tikrą tiekėjo paskyros ID. Pridėjimo režime esama ta pati paskyra atnaujinama, o nauja sukuriama atskirai. Leidimo atnaujinimo režime kitos paskyros pasirinkimas atmetamas ir nieko neperrašo.

`auth_operations` saugo prijungimo režimą ir laukiamą `connection_id`; šios reikšmės nepriimamos iš callback query kaip patikimos.

### Priėmimo kriterijai

- Galima iš eilės prijungti dvi Google ir dvi Microsoft paskyras.
- Pakartotinai prijungus tą pačią paskyrą naujas dublikatas nesukuriamas.
- Atnaujinant vienos paskyros leidimą ir OAuth lange pasirinkus kitą, abi esamos jungtys lieka nepakeistos.
- Lygiagretus žetonų atnaujinimas izoliuotas pagal jungties ID.
- Atjungus vieną paskyrą kitos paskyros žetonas, karta ir talpykla nepasikeičia.

## MA-3 — paskyrų statusas ir nustatymų sąsaja

### Sąsaja

Nustatymuose skiltys atskiriamos taip:

```text
Kalendoriaus ir užduočių paskyros
  Google
    Asmeninė · a@gmail.com       [Atnaujinti] [Atjungti]
    Darbo · a@company.com        [Atnaujinti] [Atjungti]
    + Pridėti Google paskyrą

  Microsoft
    Asmeninė · a@outlook.com     [Atnaujinti] [Atjungti]
    Darbo · a@company.com        [Atnaujinti] [Atjungti]
    + Pridėti Microsoft paskyrą

Prisijungimo būdai
  Google tapatybė
  Microsoft tapatybė
```

Kiekviena integracijos paskyra rodo:

- el. paštą ir pasirinktinį pavadinimą;
- tiekėjo ženklą ir paskyros spalvą;
- Calendar ir Tasks / To Do leidimų būseną;
- paskutinio sėkmingo atnaujinimo laiką;
- konkrečius **Atnaujinti leidimą** ir **Atjungti** veiksmus.

Atjungiant rodoma peržiūra: kiek pasirinktų kalendorių, užduočių planų ir Outlook blokų priklauso paskyrai. Atjungimas nešalina duomenų be aiškiai aprašytos politikos; vietiniai planai išsaugomi, o nuotoliniai duomenys pažymimi nepasiekiamais iki pakartotinio prijungimo.

### API suderinamumas

Statuso atsakymai pirmame leidime papildomi `connections: []`, laikinai paliekant senus `connected/account` laukus. Atnaujinus klientą seni laukai pašalinami tik atskiru vėlesniu contract etapu.

### Priėmimo kriterijai

- Nustatymų ekrane aiškiai skiriasi programėlės login tapatybės ir duomenų integracijos.
- Kiekvienas veiksmas veikia tik pasirinktą paskyrą.
- Ilgi darbinių paskyrų adresai nesuspaudžia mygtukų telefone ar siaurame lange.
- Klaviatūra ir ekrano skaitytuvas paskyrą identifikuoja ne vien spalva.

## MA-4 — visų kalendorių skaitymas ir matomumo valdymas

### Skaitymo eiga

- Serveris gauna visas aktyvias naudotojo jungtis ir kiekvienai atskirai skaito kalendorių katalogą bei įvykius.
- Užklausos vykdomos ribotu lygiagretumu ir su `Promise.allSettled` principu: vienos paskyros 401, 403, 429 ar tinklo klaida neuždengia kitų rezultatų.
- Kiekvienas rezultatas išsaugo `connectionId`, tiekėjo account ID, paskyros etiketę, kalendoriaus ID, pavadinimą ir spalvą.
- Pasenusi vienos paskyros talpykla pažymima tik tai paskyrai.

### Kalendorių pasirinkimas

Kalendoriai nustatymuose grupuojami pagal paskyrą. Kiekvienas turi checkbox; paskyros antraštė turi **Rodyti visus**, **Slėpti visus** ir **Rodyti tik šią paskyrą** veiksmus. Bent vieno kalendoriaus pasirinkimas nėra privalomas — naudotojas gali sąmoningai paslėpti visus.

Pasirinkimo versija apima `userId + connectionId + accountId + calendarId`. Senas vienos paskyros atsakymas negali perrašyti naujesnio pasirinkimo ar kitos paskyros nustatymų.

### Priėmimo kriterijai

- Dvi paskyros gali turėti vienodus kalendoriaus ir įvykio ID be susidūrimo.
- Pažymėjus ar nužymėjus kalendorių pakeitimas išlieka po perkrovimo.
- Paslėptas kalendorius nedalyvauja skaitikliuose, konfliktuose ir paieškoje.
- Sugedus vienai paskyrai kitos paskyros įvykiai lieka matomi, o klaida įvardija konkrečią paskyrą.

## MA-5 — nuosekli paskyrų ir kalendorių spalvų sistema

### Spalvų taisyklė

- Kiekviena integracijos paskyra gauna stabilią bazinę spalvą iš kontrastingos paletės.
- Jei tiekėjas pateikia kalendoriaus spalvą, ji naudojama kaip pagrindinis kalendoriaus žymuo.
- Jei spalvos nėra arba ji dubliuojasi, atspalvis deterministiškai gaunamas iš `provider + accountId + calendarId`.
- Įvykio fonas naudoja švelnų paskyros / kalendoriaus atspalvį, o kairysis kraštas — sodrią kalendoriaus spalvą.
- Tamsiai temai skaičiuojamas atskiras saugus kontrastas.

Spalva nėra vienintelis identifikatorius. Kortelės informacijoje ir redaktoriuje rodoma paskyros etiketė bei kalendoriaus pavadinimas; tooltip ir prieinamumo tekstas turi pilną kilmę.

Ta pati sistema privaloma:

- dienos, darbo savaitės ir savaitės vaizduose;
- mėnesio vaizde;
- visos dienos bei kelių dienų įvykiuose;
- paieškos rezultatuose ir įvykių redaktoriuje;
- kalendorių pasirinkimo sąraše.

### Priėmimo kriterijai

- Tas pats kalendorius po perkrovimo ar pakartotinio prijungimo išlaiko spalvą.
- Gretimos paskyros vizualiai atskiriamos abiejose temose.
- Spalvų kontrastas ir būsena nėra perduodami vien spalva.
- Mėnesio ir visos dienos rodiniai nebegrįžta prie vienos bendros Google / Outlook spalvos.

## MA-6 — įvykių kūrimas, redagavimas ir šalinimas

- Naujo įvykio forma pirmiausia pasirenka integracijos paskyrą, tada tik jos rašomą kalendorių.
- Kiekvienas PATCH, DELETE, RSVP, recurrence ir move / resize veiksmas privalomai siunčia `connectionId` bei kalendoriaus tapatybę.
- Serveris perskaito jungtį pagal prisijungusį naudotoją; account ID ir kalendorius negali būti pakeisti savavališku kliento parametru.
- Neaiškaus kūrimo operacijos registras lieka atskirtas pagal jungtį.
- Redaktorius aiškiai rodo, kurioje paskyroje bus padarytas pakeitimas ir ar tiekėjas išsiųs dalyvių atnaujinimus.

Priėmimas: sukurti, perkelti, pakeisti, atsakyti ir ištrinti po vieną įvykį kiekvienoje iš dviejų Google bei dviejų Microsoft paskyrų; jokio rašymo į kitą paskyrą.

## MA-7 — visų paskyrų užduotys ir Outlook blokai

- Task gateway tampa jungčiai priskirtu objektu, o užduočių paslauga iteruoja per visas aktyvias Google / Microsoft jungtis.
- Sąrašų ir užduočių identitetas išlaiko tiekėją, account ID, sąrašą ir užduoties ID; kiekviena mutacija papildomai tikrina jungties ID.
- Greito kūrimo ir naujos užduoties formoje paskirtis rodoma su paskyros etikete, pavyzdžiui `Darbo Google · Mano užduotys`.
- Vienos paskyros Tasks leidimo trūkumas nerodo visų Google paskyrų kaip neprijungtų.
- Google papildomo Tasks sutikimo eiga vykdoma pasirinktai paskyrai.
- Microsoft priminimai, kartojimas ir žingsniai kreipiami per užduoties jungtį.
- Outlook papildomam blokui naudotojas pasirenka Microsoft paskyrą ir kalendorių arba nustato numatytąją. Ryšyje saugomi `mirror_connection_id`, account ID, kalendoriaus ID ir įvykio ID.

Priėmimas: kiekvienos paskyros sąraše sukurti, planuoti, perkelti tarp tos pačios paskyros sąrašų, užbaigti, atkurti ir ištrinti užduotį; vienos paskyros klaida nepaveikia kitų.

## MA-8 — atsarginės kopijos, našumas ir pilna patikra

### Automatiniai testai

- SQLite migracija, rollback, pakartojimas ir esamų jungčių ID išlaikymas.
- Dvi Google ir dvi Microsoft jungtys vienam naudotojui.
- Toks pats išorinis kalendoriaus, įvykio, sąrašo ar užduoties ID skirtingose paskyrose.
- Add, re-consent, kitos paskyros pasirinkimo klaida, atjungimas ir lygiagreti žetono rotacija.
- Dalinė 401 / 403 / 429 / tinklo klaida vienoje paskyroje.
- Checkbox išlikimas, tuščias pasirinkimas, versijos konfliktas ir paskyrų izoliacija.
- Visų rodinių spalvų identitetas bei šviesi / tamsi tema.
- Įvykių ir užduočių CRUD nukreipiamas tik į pasirinktą jungtį.
- Outlook bloko kūrimas, perkėlimas, našlaičio valymas ir atjungta veidrodžio paskyra.
- Pilna kopija → atkūrimas su keliomis paskyromis; naudotojo eksportas vis dar neįtraukia žetonų.

### Gyvų paskyrų priėmimas

Naudoti keturias valdomas bandomąsias paskyras arba tiek realių paskyrų, kiek naudotojas gali saugiai skirti:

1. Prijungti dvi Google ir dvi Microsoft paskyras.
2. Kiekvienoje sukurti atskirą testinį kalendorių ir užduočių sąrašą.
3. Patikrinti, kad visi keturi kalendoriai matomi kartu ir turi aiškią kilmę.
4. Po vieną slėpti bei rodyti, perkrauti puslapį ir prisijungti kitu įrenginiu.
5. Kiekvienoje paskyroje atlikti įvykio bei užduoties pagrindinį CRUD.
6. Atšaukti vienos paskyros leidimą pas tiekėją ir patikrinti dalinę klaidą.
7. Atjungti vieną paskyrą programėlėje; kitos trys turi veikti be pakeitimų.
8. Padaryti pilną kopiją, atkurti izoliuotoje instancijoje ir patikrinti jungčių metaduomenis.

## Įgyvendinimo commitų seka

Kiekvienas užbaigtas žingsnis yra atskiras patikrintas commit ir push. Pilnas testų rinkinys leidžiamas po didesnio etapo, kaip sutarta; tarpiniuose žingsniuose naudojama siaura migracijos, tipo ar maršruto patikra.

1. [x] **MA-1a:** schemos versija ir `oauth_connections` expand migracija.
2. [x] **MA-1b:** `calendar_preferences`, `mirror_connection_id`, backup / restore sutartis.
3. [x] **MA-2a:** jungčiai priskirtas OAuth service API ir senos vienos jungties apsauga.
4. [x] **MA-2b:** OAuth add / re-consent režimai ir kelių jungčių sintetinė patikra.
5. [x] **MA-3:** paskyrų sąrašo API ir naujas nustatymų ekranas.
6. [x] **MA-4a:** kelių paskyrų kalendorių katalogas bei checkbox saugojimas.
7. [x] **MA-4b:** agreguotas įvykių skaitymas ir dalinės klaidos.
8. [x] **MA-5:** vieninga spalvų sistema visuose kalendoriaus rodiniuose.
9. [x] **MA-6:** jungčiai priskirtas įvykių kūrimas ir visos mutacijos.
10. [x] **MA-7a:** kelių paskyrų užduočių skaitymas ir paskirties pasirinkimas.
11. [x] **MA-7b:** užduočių mutacijos, Google Tasks consent ir Outlook blokai.
12. [x] **MA-8a:** pilna automatinė regresija, Docker bei backup roundtrip.
13. **MA-8b:** kontroliuojama gyvų paskyrų patikra ir dokumentacija.

## Išleidimo vartai

Kelių paskyrų etapas laikomas baigtu tik kai:

- nė viena sena jungtis nebuvo perrašyta migracijos metu;
- dvi to paties tiekėjo paskyros vienu metu skaito ir rašo į teisingą šaltinį;
- kalendorių matomumas išlieka ir gali būti visiškai tuščias;
- visos kalendoriaus reprezentacijos naudoja tą pačią spalvų bei kilmės taisyklę;
- vienos paskyros gedimas nesustabdo kitų;
- backup / restore ir paskyros atjungimas patikrinti;
- gyvas Google bei Microsoft priėmimo scenarijus užbaigtas be žinomų P0/P1 problemų.

Tik tada pradedamas [PWA planas](PWA_PLAN.md).
