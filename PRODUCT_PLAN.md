# „Dienos planas“ — kelias iki kasdien naudojamo produkto

Atnaujinta: 2026-09-21. Būsena: **tikslas aktyvus; auditas atliktas, produktas dar nebaigtas**.

## Tikslas ir darbo principas

Vieno naudotojo, nemokama, savarankiškai talpinama planavimo programėlė lietuvių kalba. Viename lange — Google ir Outlook kalendoriai, Google Tasks, Microsoft To Do ir vietinės užduotys. Pagrindinis scenarijus: sukurti užduotį, nutempti ją į antradienio 10:00 langelį, perkelti į trečiadienį, prailginti iki 60 min., užbaigti tiesiai kalendoriuje ir matyti teisingą būseną šaltinyje.

Užduoties terminas ir suplanuotas darbo laikas yra atskiri duomenys. Planavimo veiksmas nekeičia termino ir nesukuria išorinio įvykio. Pasirenkamas Outlook blokas visada `showAs: free`. Vietinės užduotys matomos ir prijungus išorines paskyras.

„Visos funkcijos“ įgyvendinamos pagal žemiau pateiktą funkcijų sąrašą ir oficialių API galimybes. Google Calendar sąsajos galimybės nėra tapačios viešai API. Pavyzdžiui, Google Tasks API neleidžia skaityti ar rašyti tikslaus suplanuoto paros laiko — jį saugosime vietoje. Nepalaikomos tiekėjo funkcijos turi turėti aiškų paaiškinimą arba nuorodą į originalią programą.

## Pavyzdžiai, kuriais remiamės

- [Tool Finder „Morgen Calendar Review“ (2024-02-09)](https://www.youtube.com/watch?v=vxIrXUltOwU): perskaitytas aprašymas ir transkripto dalys apie planavimą. 2:05–2:43 aptariamas užduoties įkėlimas į kalendorių, trukmės keitimas ir užbaigimas. Tai konkretus pagrindinės sąveikos orientyras; 2024 m. kainos ar integracijų apribojimai nelaikomi dabartinėmis specifikacijomis.
- [Morgen kalendoriaus grupinis redagavimas](https://changelog.morgen.so/bulk-calendar-editing-306079): perplanavimo ir pasirinkimo elgsena — vėlesnio patogumo etapo orientyras.
- [Super Productivity](https://super-productivity.com/): greitas užduočių įvedimas, žingsniai, projektai, fokusas, darbo laiko sekimas ir klaviatūros valdymas.
- [Google Calendar įvykiai](https://developers.google.com/workspace/calendar/api/v3/reference/events), [Google Tasks](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks), [Microsoft įvykių redagavimas](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0), [Microsoft To Do užduoties modelis](https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0).

## Audito išvada

Pradinis `npm test` (4 testai), `npm run typecheck` ir `npm run build` praeina. Tai patvirtina kompiliavimą ir kelias pagalbines funkcijas, bet ne kasdienio naudojimo ar gyvų integracijų veikimą. Kataloge nėra `.git`, todėl nėra versijuotos pakeitimų istorijos. Tikrų paskyrų duomenys šiame audite nenaudojami.

| Svarba | Patvirtinta problema | Įrodymas / poveikis | Etapas |
| --- | --- | --- | --- |
| P0 | Planavimas keičia Microsoft užduoties terminą | `app/page.tsx:planTask` siunčia `due_at`; `app/api/tasks/route.ts:PATCH` keičia `startDateTime` ir `dueDateTime`. Po atnaujinimo planas skaitomas iš termino, trukmė vėl 30 min. | B |
| P0 | Vietinės užduotys paslepiamos prijungus Microsoft | Tasks GET/POST/PATCH/DELETE šaltinį pasirenka pagal bendrą paskyros prijungimą; nėra aiškaus `source/list/account` identifikatoriaus. | B |
| P0 | Vietinis standalone paleidimas nepilnas | `npm start` tiesiog paleisdavo `.next/standalone/server.js`; po švaraus build ten nebuvo `public` ir `.next/static`. Taip pat serveris pakeičia darbinį katalogą, todėl santykinė DB gali atsidurti build kataloge. | A |
| P0 viešam diegimui | Nėra pačios programėlės naudotojo autentifikacijos | Integracijos OAuth nėra programėlės prieigos apsauga. Dabartinis diegimas tinka tik ribotos prieigos aplinkai. | F |
| P1 | Negalima perkelti suplanuotos užduoties arba įvykio | `TaskBlock` neturi tempimo; `EventBlock` yra išorinė nuoroda; Outlook API neturi PATCH. | C |
| P1 | Nevaldomas Outlook blokų gyvavimo ciklas | Kiekvienas planavimas gali kurti naują bloką; nesaugomas įvykio ID, todėl nėra patikimo atnaujinimo, pašalinimo ar ryšio su užbaigimu. | B/C |
| P1 | Klaida viename šaltinyje sustabdo bendrą atnaujinimą | `load()` naudoja nuoseklias užklausas ir `Promise.all`; dalis išsaugojimų neturi `catch/finally`; nėra pakeitimo atšaukimo po nesėkmės. | B/C |
| P1 | Ribotas įvykių ir užduočių gavimas | Tik Google `primary`, Outlook numatytasis kalendorius, vienas To Do sąrašas; `$top=100/250`, `maxResults=250`, nėra puslapiavimo. | D/E |
| P1 | Prisijungimo būsena nepatikrina prieigos | Rodoma žetono buvimo būsena. Kiekviena užklausa atnaujina prieigos žetoną, nėra bendro lygiagretaus atnaujinimo, galiojimo talpyklos ar aiškios „prisijunk iš naujo“ būsenos. | B |
| P1 | Google Tasks integracijos nėra | Yra tik Calendar API ir Calendar OAuth leidimas. | E |
| P1 | Silpnas įvesties ir klaidų apdorojimas | Kai kurie blogi JSON / laikai tampa 502; Google PATCH persiunčia visą kliento `patch`; paslaugų klaidos viduje apima nefiltruotą tiekėjo atsakymą. | B/D |
| P1 | Nepilnas kalendoriaus laiko modelis | Nėra atskiros visos dienos juostos, kelių dienų išskaidymo ar persidengiančių įvykių kolonų. Įvykiai su pavadinimo prefiksu „✓ “ paslepiami, nors gali būti tikri įvykiai. | C |
| P2 | Dizainas turi neveikiančių valdiklių | Temos mygtukas, avataras ir logotipas neturi veiksmo; paieška žada įvykius, bet jų nefiltruoja; nėra realaus ⌘K. | C |
| P2 | Mobilus rodinys ir prieinamumas nepilni | CSS fiksuoja 5 dienų stulpelius net dienos / savaitės režime. Modalai neturi dialogo semantikos, fokuso valdymo ir Escape. | C |
| P2 | Testų aprėptis nepatvirtina verslo scenarijų | Keturi testai netikrina Graph užklausų skaičiaus planuojant, DB išlikimo, OAuth žetonų rotacijos, tikro tempimo ar klaidos atšaukimo. | A–F |

### Ankstesnės suvestinės patikslinimai

- Microsoft planavimas iki šio audito **nebuvo visiškai vietinis**, nors taip parašyta README.
- UTC žymės ir kalendorinių dienų sudarymas buvo patobulinti, bet tai dar nereiškia, kad patikrinti visi vasaros / žiemos laiko atvejai.
- `showAs: free` pagalbinės funkcijos testas patvirtina payload, bet neatstoja tikro Graph HTTP scenarijaus.
- Standalone puslapio atidarymas naršyklėje su talpykla nepatvirtina CSS ir JS prieinamumo po naujo build. Naujas smoke testas tikrina HTTP resursus tiesiogiai.

## Produkto struktūra ir modernus dizainas

Darbalaukyje: siaura aiški navigacija kairėje, platus kalendorius centre, suskleidžiama užduočių juosta dešinėje. Paskyros ir kalendorių matomumas — navigacijoje, užduoties / įvykio detalės — viename nuosekliame redaktoriuje.

- Šviesi neutrali tema su indigo akcentu; tamsi tema su išsaugomu pasirinkimu.
- Kalendoriaus spalva nusako šaltinį / kalendorių, užduotis papildomai atskiriama simboliu ir rėmeliu. Būsena nesirems vien spalva.
- 15 min. tinklelis, tempimo peržiūra su būsimos pradžios laiku, krašto tempimas trukmei keisti, dabartinio laiko linija, visos dienos juosta.
- Paspaudimas atidaro redaktorių. Nuoroda į originalų įvykį lieka aiškiu atskiru veiksmu.
- Darbai: „Šiandien“, „Neplanuota“, „Suplanuota“, „Svarbios“, „Atlikta“, sąrašai / projektai ir paieška.
- Klaviatūra: nauja užduotis / įvykis, paieška, šiandien, pirmyn / atgal, Escape, redagavimo alternatyva kiekvienam tempimo veiksmui.
- Telefone: atskiri kalendoriaus, užduočių ir fokuso ekranai; dienos / darbotvarkės vaizdas; jutiklinis tempimas su slinkimo atskyrimu.
- Įkėlimas, tuščias sąrašas, neprijungta paskyra, klaida ir dalinai pasiekiami šaltiniai turi atskiras būsenas.

## Techninis planas

Išlaikome Next.js, React ir SQLite. Prieš kiekvieną Next.js pakeitimą vadovaujamės vietine `node_modules/next/dist/docs` dokumentacija. Sąsają skaidome į kalendoriaus, užduočių, redaktorių ir paskyrų komponentus palaipsniui.

Duomenų sluoksnis:

- Užduoties tapatybė: `provider + accountId + listId + remoteTaskId`, vietinėms — stabilus vietinis ID.
- Vietinis `task_schedule`: pradžia, trukmė, laiko zona, versija; ryšys su užduotimi. Terminas laikomas atskirai. Pirmiausia viena sesija užduočiai, vėliau galimos kelios darbo sesijos.
- `calendar_event`: tiekėjas, paskyra, kalendorius, įvykio ID, ETag / versija, visos dienos ir pasikartojimo duomenys, redagavimo teisės.
- `mirror_link`: konkreti planavimo sesija ir Outlook įvykio ID. Pakartojamas veiksmas neturi kurti dublikatų. Užbaigiant / išplanuojant susietą bloką šaliname; nesėkmei rodome aiškią pakartojimo būseną.
- Vietinių senų `due_at` įrašų paskirtis dviprasmiška: migruojant išsaugome originalą ir buvusį rodymą, pažymime paveldėtą reikšmę. Microsoft terminų atgaline data automatiškai neatkuriame, nes pradinio termino sistemoje nėra.
- Tiekėjų adapteriai naudoja leidžiamus laukus ir fiksuotus API pagrindus. Puslapiavimo nuorodos tikrinamos prieš siunčiant Authorization; klientas nepasirenka savavališko URL.
- Operacijos aiškiai atskiriamos: `createTask`, `updateTask`, `scheduleTask`, `moveEvent`, `resizeEvent`, `unscheduleTask`.
- Paslaugų klaidos, 401/403/429, tinklo nutrūkimas ir versijos konfliktas turi atskirą elgseną. UI išsaugo paskutinius sėkmingus duomenis, rodo nepavykusią operaciją ir leidžia pakartoti.

## Įgyvendinimo etapai ir priėmimo kriterijai

### A. Pakartojamas paleidimas ir audito pagrindas

- [x] Perskaityti kodą, README, vietinę Next dokumentaciją ir vartotojo pavyzdžius.
- [x] Užregistruoti aktyvų galutinio produkto tikslą ir šį darbų planą.
- [x] Patikrinti pradinį build, TypeScript ir esamus testus.
- [x] Sutvarkyti vietinio standalone statinius resursus, konfigūracijos įkėlimą ir stabilią DB vietą.
- [x] Išplėsti `.env.*` ignoravimą Git ir Docker kontekste, išlaikant `.env.example`.
- [x] Patvirtinti naują HTTP smoke testą ir naujo naršyklės lango scenarijų: užduoties sukūrimas, tempimas į 10:00 ir plano išlikimas po perkrovimo. HTTP patikra patvirtina 9 statinių resursų prieinamumą be naršyklės talpyklos.

Priimta, kai `npm run build && npm start` pateikia HTML, CSS, JS ir favicon, naudoja stabilią DB vietą, o testai naudoja tik laikiną DB. Nereikia tikrų OAuth raktų.

### B. Teisingas planavimas ir integracijų patikimumas — vykdoma

- [x] Atskiras vietinis planavimo modelis ir suderinama migracija.
- [x] Vietinės ir Microsoft užduotys vienu metu; aiškus pasirinkimas, kur kurti užduotį.
- [x] Planavimas / perplanavimas / trukmė / išplanavimas nekeičia To Do termino ir nesikreipia į kalendoriaus API be atskiro pasirinkimo.
- [x] Pasirenkamo `free` bloko sukūrimas, išsaugotas ryšys, atnaujinimas ir pašalinimas atliekant veiksmus programėlėje; sutartiniai testai su imitacine API.
- [x] Susietų blokų sutvarkymas po išorinio užduoties užbaigimo / pašalinimo; jau pašalinto įvykio 404 apdorojimas; tikro Graph pakartojimo patikra.
- [x] Microsoft lygiagretūs veiksmai dalinasi žetono atnaujinimu; rotacija, atjungimas ir paskyros keitimas apsaugoti nuo pavėluotų atsakymų, patikrinti imitaciniais testais.
- [x] Tokia pati Google apsauga: bendras lygiagretus atnaujinimas, užšifruota rotacija, paskyros ir žetono pakeitimas vienoje transakcijoje, atjungimo lenktynių testai.
- [x] Prieigos žetono galiojimas, vienas lygiagretus atnaujinimas, rotacija, atjungimo ir vykstančio atnaujinimo lenktynių apsauga.
- [x] Dalinis kalendorių / užduočių atnaujinimas, vietinių užduočių prieinamumas ir paskutinė Microsoft talpykla nepavykus užklausai; lietuviškos užduočių veiksmų klaidos.
- [x] Vieningas įvykių redaktorių klaidų ir 401/403/429 apdorojimas.

Priimta, kai sutartiniai testai su imitacine Graph paslauga įrodo: 0 kalendoriaus rašymų įprastai planuojant; nepasikeitęs terminas; išlikęs laikas ir trukmė po perkrovimo; pasirinktas blokas `free`; jokio dublikato kartojant; atjungimas negali būti panaikintas vėluojančiu žetono atnaujinimu.

### C. Interaktyvus kalendorius ir nauja sąsaja

- [x] Dienos / savaitės užduoties tempimas į laiką, suplanuoto bloko perkėlimas pele, apatinio krašto tempimas trukmei keisti, klaviatūros trukmės valdymas ir datos redaktorius.
- [x] Savo organizuojamų nepasikartojančių Google / Outlook įvykių perkėlimas ir trukmė; pavadinimo / laiko redaktorius, dalyvių patvirtinimas, konflikto pranešimas. Naršyklėje ir API patikrinta su imitaciniais tiekėjais.
- [x] Užduoties perkėlimas iš sąrašo į bet kurią dieną / laiką, suplanuotos užduoties perkėlimas, grąžinimas į neplanuotas.
- [x] Google / Outlook įvykio perkėlimas tarp dienų, laiko pakeitimas ir trukmės keitimas.
- [x] Skaitymo teisės, pasikartojimo egzemplioriaus atpažinimas, kvietimų dalyviams poveikio paaiškinimas prieš išsaugojimą.
- [x] Tempimo peržiūra ir aiški sėkmė; nepavykus serverio operacijai — ankstesnė padėtis. Sparčių pakeitimų eilė neleidžia pavėluotam atsakymui perrašyti naujesnio.
- [x] Modernus išdėstymas, abiejų temų palaikymas, redaktoriai, paieška, klaviatūra, mobilus rodinys.
- [x] Kairė navigacija, centrinis kalendorius, suskleidžiama dešinė juosta, šviesi / tamsi / sistemos tema, nustatymų langas, ⌘ / Ctrl K paieška ir atskiri mobilūs rodiniai. Pilnas klaviatūros bei jutiklinis valdymas dar nebaigtas.
- [x] Visos dienos ir kelių dienų įvykiai, persidengimai, dabartinis laikas, konfliktai ir 24 val. pasiekiamumas.
- [x] 24 val. dienos / savaitės tinklelis, bendri įvykių ir užduočių persidengimo stulpeliai, naktinių blokų skaidymas ir dabartinio laiko linija. Kelių dienų bei DST tempimas ir kartojamos valandos pasirinkimas lieka nebaigti.

Priimta, kai pagrindinis scenarijus praeina naršyklėje pele ir be pelės, įskaitant perkėlimą į kitą savaitę, trukmę, atšaukimą, HTTP klaidą ir datos pokyčius ties 2026-03-29 bei 2026-10-25 Vilniuje.

### D. Google Calendar ir Outlook įvykių valdymas

- [ ] Visi prieinami kalendoriai, jų pasirinkimas, spalvos ir rašymo teisės; pilnas puslapiavimas.
- [x] Sukūrimas, detalus redagavimas, pašalinimas: pavadinimas, aprašymas, vieta, pradžia / pabaiga, laiko zona, visos dienos įvykis, matomumas, laisvas / užimtas, priminimai.
- [ ] Dalyviai, kvietimų atnaujinimas, dalyvavimo atsakymas, Google Meet / Teams pagal kalendoriaus ir paskyros galimybes.
- [ ] Kasdien / kas savaitę / kas mėnesį / kas metus, intervalai, savaitės dienos, pabaiga; atskiro egzemplioriaus ir serijos redagavimas. „Šį ir būsimus“ tik su atskirai patikrintu serijos skaidymu.
- [ ] ETag / versijų konfliktai, išoriniai pakeitimai, 401/403/429, pakartojimas nesukuriant dvigubų susitikimų.
- [ ] Atskirai įvertinti Google focus time / out-of-office / working location ir Outlook papildomas galimybes pagal viešą API bei paskyros licenciją. Nepalaikomas funkcijas pažymėti galimybių lentelėje.

Priimta, kai kiekviena įgyvendinta operacija patikrinta su imitacine API ir tuomet abiejų tiekėjų bandomaisiais kalendoriais; perskaitytas įvykis sutampa su išsaugotu, nepasimeta dalyviai ar serijos savybės.

### E. Microsoft To Do, Google Tasks ir vietinės užduotys

- [x] Google / Microsoft sąrašų pasirinkimas, visų sąrašų bei užduočių puslapiavimas; saugūs paskyros ir sąrašo ryšiai.
- [x] Google / Microsoft sąrašų kūrimas, pervadinimas ir šalinimas su peržiūra bei pavadinimo patvirtinimu (imitacinė patikra; įtaisyti / svetimi Microsoft sąrašai ir sąrašai su Outlook blokais ar Docs / Chat užduotimis saugomi nuo šalinimo).
- [x] Sukurti, redaguoti, užbaigti, atkurti ir ištrinti visų trijų šaltinių užduotis; pastabos, datos, vietiniai projektai / žymos ir trukmė (sintetinės API patikra).
- [x] Microsoft svarba ir atskiras priminimo įjungimas, laiko keitimas bei išjungimas su versijos / paskyros patikra (imitacinė API).
- [~] Microsoft kartojimas ir žingsniai. „Mano diena” tiksliai atskiriama nuo Microsoft „My Day”, jei vieša API jo nesinchronizuoja. (Kartojimas įgyvendintas 2026-09-21; žingsniai ir „My Day” liko nebaigti.)
- [x] Google užduočių ir pavaldžių užduočių skaitymas bei bendras planavimas; papildomas Tasks OAuth leidimas ir pakartotinio sutikimo eiga (imitacinė patikra).
- [ ] Google hierarchijos ir eilės tvarkos keitimas, perkėlimas tarp palaikomų sąrašų.
- [x] Vienodas vietinis planavimas visų šaltinių užduotims, užbaigimo / atkūrimo būsenos atnaujinimas ir šaltinio nuoroda.
- [ ] Gyvų paskyrų patikra ir šaltinyje ištrintų užduočių pasirenkamų Outlook blokų sutvarkymas.
- [x] Fokusavimo sesijos su išsaugomu pradžios laiku, pauze ir užduoties ryšiu; po perkrovimo laikmatis nepraranda būsenos.

Priimta, kai Google, Microsoft ir vietinę užduotį galima sukurti, suplanuoti, perkelti, užbaigti ir atkurti; persikrovus bei pasikeitus duomenims šaltinyje rodoma teisinga būsena. Nepalaikomi laukai nepateikiami kaip tariamai sinchronizuojami.

### F. Kasdienis naudojimas ir išleidimas

- [ ] Pačios programėlės prieigos apsauga, saugi sesija ir HTTPS diegimo instrukcija viešam / nuotoliniam naudojimui.
- [ ] OAuth PKCE / vienkartinė serverio operacija, konfigūracijos diagnostika, minimalūs leidimai, saugus žurnalų turinys.
- [ ] SQLite atsarginė kopija ir atkūrimas, migracijos testas su ankstesne schema, duomenų eksportas be žetonų.
- [ ] Docker sveikatos patikra, neprivilegijuotas procesas, aiški versija, paleidimo ir atnaujinimo vadovas.
- [ ] Automatizuoti svarbiausi naršyklės scenarijai, mobilus ekranas, prieinamumas, skirtingos laiko zonos, offline / tinklo klaida.
- [ ] Naudotojo patikra su jo paskyromis ir pašalintos rastos klaidos.

Galutinis tikslas laikomas pasiektu tik tada, kai nėra žinomų P0/P1 klaidų pagrindiniuose scenarijuose, veikia abu kalendoriai ir abu užduočių šaltiniai, duomenys išlieka po perkrovimo / atnaujinimo, o tikrų paskyrų scenarijai patvirtinti. Imitaciniai testai nepakeičia OAuth ir realių tiekėjų patikros.

## Darbo eiga ir ribos

### 2026-09-15 tęsinio patikra

- `npm test`: 22/22. Planavimo testai naudoja realią izoliuotą SQLite bazę ir imitacinę Graph paslaugą. OAuth testai vykdo tikrą Microsoft modulį su sintetiniais žetonais ir užblokuotu tikru tinklu.
- `npm run typecheck`, produkcinis `npm run build` ir išplėstas HTTP smoke testas praeina. Smoke tikrina 9 statinius resursus, CSRF, OAuth klaidas ir visą vietinio plano API ciklą, įskaitant 409 konfliktą.
- Naršyklė, atskira testinė DB: sukurta užduotis su penktadienio 17:00 terminu; nutempta į antradienio 10:00; trukmė pele pakeista 30 → 60 min., klaviatūra 60 → 75 min.; po serverio perkrovimo planas išliko; blokas pele perkeltas į trečiadienio 11:00, terminas nepasikeitė; redaktoriumi pakeista į ketvirtadienio 09:30; užbaigus ir perkrovus rodoma „Atlikta 1“.
- Patikrintas 390 px mobilus dienos rodinys — vienas dienos stulpelis (pašalintas klaidingas fiksuotas penkių dienų CSS). Visa mobili darbo eiga ir jutiklinis tempimas dar nepatvirtinti. Naršyklės konsolės klaidų šio scenarijaus metu neužfiksuota.
- Įvykių tempimas, visas modernus dizainas, Google Tasks ir gyvos integracijos dar nebaigti. B ir C etapai bei bendras produkto tikslas nelaikomi užbaigtais.

### 2026-09-15 kalendoriaus įvykių etapas

- Sukurtas bendras `lib/calendar-events.ts` sluoksnis: paskyros ryšys, versija, teisių patikra, leidžiamų PATCH laukų sąrašas, normalizuoti įvykiai ir pilnas numatytojo kalendoriaus puslapiavimas. Google nebepriima savavališko kliento `patch` objekto.
- `app/calendar-event.tsx`: įvykio perkėlimas pele, krašto tempimas ir klaviatūros trukmė. Sąsajoje pridėtas pavadinimo / laiko redaktorius, dalyvių patvirtinimas, atskira visos dienos juosta ir veikiantis įvykių paieškos filtras. Naujo įvykio kūrimo klaidos nebeslepiamos.
- 43 automatiniai testai: izoliuotos SQLite migracijos, abiejų OAuth adapterių lenktynės, įvykių metaduomenų išsaugojimas, teisių / paskyros / versijos patikra, dalyvių patvirtinimas ir tikri API maršrutai su tinklo pakaitalu. TypeScript ir produkcinis build praeina.
- Produkcinis kalendorių HTTP testas patvirtino abiejų šaltinių skaitymą, perkėlimą, trukmę, CSRF, 409 konfliktą, 403 skaitymo režimą ir susitikimo patvirtinimo reikalavimą. Testinis Node paleidimas izoliuotas nuo realių tiekėjų.
- Naršyklėje: Google įvykis perkeltas iš antradienio į ketvirtadienį; Outlook — iš trečiadienio į penktadienį; Outlook trukmė pele 90 → 120 min., Google klaviatūra 90 → 105 min.; pavadinimas pakeistas; imituotas 412 parodytas kaip suprantamas konfliktas. Atšaukus susitikimo tempimą laikas liko senas; patvirtinus testinį pakeitimą naujas laikas išliko perkrovus puslapį.
- Papildomai vizualiai patvirtinta dviejų dienų visos dienos juosta, pasikartojančio įvykio „tik skaityti“ būsena ir 390 px mobilus ne savo organizuojamo įvykio langas su išjungtais laukais bei originalo nuoroda.
- Tikrų susitikimų, kvietimų ar paskyrų šiame etape nenaudota. Pasikartojantys, visos dienos, specialūs ir ne savo organizuojami įvykiai konservatyviai palikti tik skaitymui su originalo nuoroda. Outlook ETag sąlyginis atnaujinimas gyvoje paskyroje dar nepatvirtintas. Pilnas 24 val. / persidengimų modelis, Google Tasks, modernus dizainas ir bendras produkto tikslas lieka nebaigti.

### 2026-09-15 24 val. ir persidengimų etapas

- `lib/calendar-layout.ts`: bendras užduočių ir įvykių stulpelių paskirstymas, minimalaus matomo aukščio įvertinimas, kalendorinės dienos ribos ir naktinių intervalų skaidymas. Pabaiga ties 00:00 neprideda papildomos dienos.
- Dienos / savaitės kalendorius turi visas 24 valandas, pradinis slinkimas nuo maždaug 07:00, dabartinio laiko žyma atsinaujina kas minutę. Dienų antraštės ir visos dienos juosta lieka matomos slenkant į vakarą; tai patvirtinta naršyklėje. Mėnesio rodinys taip pat įtraukia kelias dienas trunkančius intervalus ir neberodo užbaigtų užduočių.
- Tempimas įvertina vietą, už kurios sugriebtas blokas, todėl horizontalus perkėlimas nebeprideda 15 min. Pataisyta naujo įvykio 00:00 pradžia, kuri anksčiau buvo pakeičiama į 10:00. Trumpi blokai rodo pavadinimą, o žemesniuose nei 24 px paslepiami jį uždengiantys papildomi valdikliai.
- 49 automatiniai testai, TypeScript ir produkcinis build praeina. Abiejų produkcinių HTTP scenarijų testai praeina su laikina SQLite ir izoliuotomis tiekėjų imitacijomis.
- Naršyklėje patvirtinti atskiri persidengiančių įvykių stulpeliai ir bendri įvykio / užduoties stulpeliai; horizontalus Google perkėlimas išlaikė 09:00; vietinė užduotis nutempta į ketvirtadienio 23:45, parodyta ir penktadienį, penktadienio 17:00 terminas nepakito. Planas išliko perkrovus. Naktinis įvykis matomas abiejose mėnesio dienose.
- 390 px dienos rodinys turi vieną stulpelį ir 24 valandas, puslapio plotis neišsiplečia; tikrintuose scenarijuose naršyklės klaidų nėra. Visas jutiklinio tempimo scenarijus dar nepatvirtintas.
- Ribos: kelių dienų ir laikrodžio persukimo dienų blokai keičiami redaktoriumi, ne tempiant. Vilniaus 2026-03-29 / 2026-10-25 ribos ir dviprasmiško laiko atmetimas patikrinti vienetiniais testais, ne visa naršyklės eiga. Reikia automatinio slinkimo tempiant, kartojamos valandos pasirinkimo, išsamaus visų zonų testavimo ir dienos krūvio skaičiavimo tik pagal konkrečios dienos intervalo dalį. Modernus išdėstymas, Google Tasks ir bendras produkto tikslas dar nebaigti.

### 2026-09-16 sąsajos ir temų etapas

- `app/planner-shell.css` pateikia temų spalvas ir adaptyvų išdėstymą: navigacija kairėje, kalendorius centre, suskleidžiama darbų dėžutė dešinėje. SVG piktogramos pakeitė neaiškius navigacijos simbolius; pašalintas neveikiantis avataras, logotipas grąžina į šiandieną. Paskyros ir „Free“ parinktis perkelti į pasiekiamą nustatymų dialogą.
- `lib/ui-preferences.ts` ir `app/ui-preferences.tsx`: temos reikšmių leidžiamas sąrašas, saugus localStorage skaitymas / rašymas, sistemos spalvų sekimas, temos pritaikymas prieš pirmą puslapio piešimą. Naršyklėje patvirtintas šviesios temos bei suskleistos juostos išlikimas perkrovus; patikrinta tamsi tema ir mobilūs šviesūs nustatymai.
- Veikia ⌘ / Ctrl K paieška, Escape išvalymas ir dialogo uždarymas, kalendoriaus užduočių paieška, užduoties redaktorius iš lentos. Neplanuotos kortelės tempimas suvienodintas su pointer įvykiais; turi matomą tempimo peržiūrą ir neperima paspaudimo. Naršyklėje kortelė iš dešinės juostos nutempta į 10:00.
- Telefono 390 × 844 px patikra: dienos kalendorius iškart matomas, apačioje navigacija, užduočių juosta atsidaro atskirai, darbų lentos stulpeliai telpa vertikaliai. Užduotis sukurta juostoje, iš lentos suplanuota 12:00 ir matoma kalendoriuje po perkrovimo. Outlook įvykio trukmė klaviatūra pakeista 90 → 105 min. ir išliko.
- Po vidurnakčio patikroje aptiktas senas build datos hidratavimo neatitikimas. Pradinė data dabar neutrali ir nerodoma; tik naršyklėje nustatomas laikas, tada įkeliamas kalendorius. Produkcinis smoke tikrina, kad SSR neįrašo kalendoriaus build datos. Naujoje patikroje React klaidų nėra.
- 53 automatiniai testai, TypeScript, produkcinis build ir abu produkciniai HTTP smoke scenarijai praeina. Tikros paskyros ir naudotojo DB nenaudoti.
- Ribos: jutiklinis tempimas iš sąrašo neįjungtas (naudojamas redaktorius), pilnas fizinio telefono / klaviatūros prieinamumo auditas neatliktas. Google Tasks, papildomi To Do sąrašai, platesnis įvykių redaktorius, realių OAuth paskyrų patikra ir prieigos apsauga lieka nebaigti; bendras produkto tikslas dar nepasiektas.

Kiekvienas etapas užbaigiamas kodo patikra, prasmingais testais, TypeScript, produkciniu build ir susijusiu naršyklės scenarijumi. Šio failo būsenos atnaujinamos pagal įrodymus. Jautrūs raktai, žetonai ir naudotojo SQLite duomenys nepatenka į planą, žurnalus ar versijų istoriją.

Tikram OAuth prisijungimui ir paskyrų patikrai reikės naudotojo veiksmų oficialiuose prisijungimo puslapiuose. Tai netrukdo įgyvendinti ir imituotomis API tikrinti integracijas. Viešas publikavimas, tikrų susitikimų siuntimas ir tiekėjų paskyrų konfigūravimas nėra atliekami vien audito metu.

AI automatinis planavimas, vieši rezervavimo puslapiai, komandinė daugelio naudotojų sistema ir papildomos integracijos lieka po šių pagrindinių funkcijų. Jų nereikia tam, kad veiktų prašomas asmeninis kalendorius ir užduočių valdymas.


## 2026-09-16 — E etapo bendras užduočių planavimas ir Google sutikimas

- Tęstas jau commit’e buvęs trijų šaltinių adapteris: Google `due_date` saugoma kaip diena, `scheduled_at` ir trukmė lieka SQLite. Planavimas, perkėlimas ir trukmė nekeičia tiekėjo datos ir nesiunčia užduočių ar kalendorių rašymo užklausų be atskiro Outlook bloko pasirinkimo.
- Patikrinti kelių sąrašų / užduočių puslapiai, vienodi ID skirtinguose sąrašuose, paskyros pasikeitimas, dalinis ryšio sutrikimas, plano išlikimas po DB atidarymo iš naujo, visi CRUD veiksmai ir tikri API maršrutai su tinklo pakaitalu.
- Šaltinyje užbaigtos užduoties vietinis planas pašalinamas; atkūrimas seno bloko negrąžina. Esamo Outlook bloko pašalinimas atliekamas aiškiai išsaugant užduotį, su pakartojimo pranešimu.
- Sąsajoje pridėtas atnaujinimas, ištrynimas su šaltinio patvirtinimu, vietinių projekto / žymų redagavimas, šaltinio nuorodos ir Google pavaldžios užduoties žyma.
- Google OAuth naudoja papildomą Tasks leidimą, pakartotinį sutikimą ir tik faktiškai grąžintus leidimus. Dalinis / atmestas sutikimas nesunaikina ankstesnio Calendar ryšio. Trūkstamas refresh token pakartotinai naudojamas tik tai pačiai patvirtintai paskyrai. Atskiriamos leidimo ir išjungtos API būsenos, įjungus API galima pakartoti skaitymą.
- Patikra: `npm run typecheck`, 81/81 `npm test`, `npm run build`, `test:smoke`, `test:calendars` ir `test:tasks` praėjo. Produkcinėje sintetinėje kopijoje naršykle patikrintas Google užduoties kūrimas, atskiras dienos ir darbo laiko įvedimas, plano / žymų išlikimas po perkrovimo, užbaigimas, atkūrimas ir leidimo būsena; konsolėje klaidų nebuvo.
- Ribos: tikros paskyros nebuvo keičiamos ar autorizuojamos. Visas E etapas dar nebaigtas: lieka sąrašų administravimas, hierarchijos / eilės keitimas, To Do priminimai / kartojimas / žingsniai, fokusavimo išlikimas ir gyvų integracijų patvirtinimas. Docs / Chat priskirtos Google užduotys neįtraukiamos.

## 2026-09-17 — E etapo užduočių sąrašų valdymas

- Pridėtas `/api/task-lists` ir langas „Tvarkyti sąrašus“ užduočių juostoje bei nustatymuose. Google / Microsoft sąrašą galima sukurti, pasirinkti naujoms užduotims ir pervadinti, išsaugant vietinius planus.
- Prieš šalinimą serveris perskaito visus užduočių puslapius, sąsaja rodo skaičių ir reikalauja tikslaus sąrašo pavadinimo. Prieš DELETE iš naujo tikrinama paskyra, sąrašo versija ir užduočių turinys. Nesėkmingas šalinimas vietinių planų nenaikina; sėkmingas valo tik to tiekėjo, paskyros ir sąrašo duomenis.
- Microsoft įtaisyti, neatpažinti ir ne savininko sąrašai neadministruojami. Google Docs / Chat priskirtos užduotys aptinkamos ir sustabdo sąrašo šalinimą. Bet kuris esamas ar nebaigtas Outlook susiejimas, įskaitant šaltinyje dingusios užduoties planą, taip pat sustabdo šalinimą.
- Sąsaja blokuoja konkuruojančius veiksmus; yra rankinis atnaujinimas, pasenusių duomenų paaiškinimas ir pakartotinis pavadinimo įvedimas po konflikto. Neaiški kūrimo baigtis reikalauja atnaujinti sąrašus prieš bandant dar kartą.
- Patikra: `npm run typecheck`, 102/102 `npm test`, `npm run build`, `test:smoke`, `test:calendars` ir `test:tasks` praėjo. Naršyklėje su sintetinėmis paskyromis sukurti abiejų tiekėjų sąrašai, Google sąrašas pervadintas, patikrinta paskirties pasirinkimo būsena, trynimo peržiūra / tikslaus pavadinimo reikalavimas / atšaukimas, atnaujinimas ir išlikimas po perkrovimo. 390 px lange sąrašų valdymas pasiekiamas iš nustatymų, konsolės klaidų nebuvo. Galutinį DELETE vykdė HTTP testai.
- Ribos: gyvos API ir Google sąrašo `If-Match` elgsena nepatvirtintos; išorinis pakeitimas tarp paskutinio perskaitymo ir DELETE nėra atomiškai užkertamas. Praradus sėkmingo DELETE atsakymą, vietiniai planai paliekami; našlaičių sutvarkymas lieka kitam etapui. Visas E etapas dar nebaigtas: lieka To Do priminimai / kartojimas / žingsniai, Google hierarchijos / eilės keitimas ir perkėlimas, fokusavimo būsenos išlikimas bei gyvų integracijų patikra.

## 2026-09-18 — E etapo Microsoft To Do priminimai

- Microsoft užduoties redaktoriuje pridėtas atskiras priminimo įjungimas, datos / laiko keitimas ir išjungimas. Priminimą pristato Microsoft; jis nekeičia termino, vietinio darbo plano, kartojimo, žingsnių ar Outlook bloko.
- Serveris prieš PATCH iš naujo perskaito užduotį, susieja ją su tiekėju, paskyra, sąrašu ir ID, tikrina visos aktualios užduoties versiją bei siunčia tik `isReminderOn` ir, įjungiant, `reminderDateTime`. Kai tiekėjas grąžina ETag, siunčiamas `If-Match`.
- Neatpažintas Microsoft sieninis laikas nerodomas kaip UTC: sąsaja rodo originalų laiką ir zoną, o pakeitimui reikia įvesti naują laiką. Naršyklės laiko zona rodoma šalia lauko; neegzistuojanti ir pasikartojanti DST valanda atmetama.
- Patikra: `npm run typecheck`, 112/112 `npm test`, `npm run build`, `test:smoke`, `test:calendars` ir `test:tasks` praėjo. Testai apima įjungimą, laiko pakeitimą, išjungimą, paskyros / sąrašo / ID ryšį, CSRF, ETag konfliktą, dvigubą pakeitimą, neaiškią atsakymo baigtį, vietinių duomenų neliečiamumą ir Vilniaus bei pusvalandžio DST perėjimus.
- Naršyklėje su sintetine Microsoft paskyra priminimas įjungtas ir perkeltas į 2026-10-26 11:15 Vilniaus laiku; po perkrovimo būsena išliko, o pagrindinio redaktoriaus pavadinimo juodraštis nebuvo išsaugotas. 2026-10-25 03:30 dviprasmiška Vilniaus valanda atmesta. Tikra paskyra ir tikras pranešimo pristatymas netikrinti.
- Ribos: Graph `If-Match` elgsena su To Do užduotimis gyvai nepatvirtinta, todėl išorinio pakeitimo tarp paskutinio GET ir PATCH pilnai atmesti negalima. Kartojimo taisyklės ir žingsniai šiame žingsnyje tik išsaugomi ir nekeičiami; jų valdymas lieka tolesniems atskiriems commit’ams.

## 2026-09-21 (rytas) — E5 Microsoft To Do kartojimo valdymas

- Naujas `lib/task-recurrence.ts`: `TaskRecurrence` tipas (kasdien / kas savaitę / kas mėnesį / kas metus, intervalas, savaitės dienos, mėnesio diena, pradžios data). `parseTaskRecurrence` tikrina visus laukus griežtai; `graphRecurrence` verčia į MS Graph formatą; `providerRecurrence` atbulai normalizuoja. `sameTaskRecurrence` lygina rezultatą prieš grąžinant sėkmę.
- Naujas `/api/tasks/recurrence` maršrutas: GET grąžina dabartinę taisyklę, tiekėjo palaikymo žymą, siūlomą pradžios datą ir versijos pirštų atspaudą. PATCH priima naują taisyklę arba `null` (pašalinimui), tikrina versiją, paskyros ryšį ir `If-Match` ETag. Nepalaikoma MS Graph taisyklė grąžina 409; neįrašomų sąrašų ir užbaigtų užduočių atveju — 403. Viso kartojimo ciklo versija skaičiuojama iš viso raw įrašo, todėl išoriniai pokyčiai tarp GET ir PATCH atmetami.
- `lib/task-service.ts` išplėstas: `readRecurrence`, `updateRecurrence` ir `recurrenceSnapshot` vidine funkcija. Sėkmingas atnaujinimas patikrinamas palyginus grąžintą taisyklę su norima — nesutapus grąžinama 502. Kartojimas niekada nekeičia vietinio planavimo, terminų ar Outlook blokų.
- `tsconfig.json`: pridėtas `"allowImportingTsExtensions": true` — atitinka Node.js v24 elgseną su `.ts` importais.
- Patikra: 119/119 testai, typecheck, build ir smoke praeina.
- Ribos: žingsniai (subtasks) ir „My Day" atskyrimas neįgyvendinti. Tikros Graph paskyros nebuvo naudotos — `If-Match` elgsena su To Do kartojimo PATCH gyvai nepatvirtinta.

## 2026-09-21 — D2 įvykių redagavimas ir C7 klaviatūros perkėlimas

- **D2 vieta** (`location`): pridėtas laukas naujo įvykio kūrime ir esamo redagavime abiejuose tiekėjuose. Google POST perduoda `location` tiesiogiai; Outlook naudoja `location.displayName`. Normalizatorius ištraukia vietą iš abiejų formatų; `update` leidžiamųjų laukų sąraše įtrauktas `"location"`.
- **D2 aprašymas** (`description`): `CalendarEvent` tipo laukas, normalizuotas iš `raw.description` (Google) ir `raw.body.content` (Outlook). Esamo įvykio redaktoriuje pridėtas `<textarea>`, perduodamas PATCH. Atnaujinta formHint — aprašymas dabar keičiamas, ne tik išsaugomas. Siunčiama tik tada, kai laukas perduotas; nepriskirtų laukų `update` neteršia.
- **D2 laisvas / užimtas ir matomumas**: kūrimo formoje pridėti du papildomi mygtukai — „Laisvas / užimtas" ir „Matomumas". Google: `transparency: "transparent"` ir `visibility: "private"`. Outlook: `showAs` jau turimas; pridėtas `sensitivity: "private"`. Numatytosios reikšmės atitinka tiekėjų elgseną (užimtas, vieša).
- **D2 visos dienos įvykis**: kūrimo formoje pridėtas jungiklis. Kai įjungtas — rodomi tik datos laukai (pradžia ir pabaiga), paslėpti trukmė, dalyviai ir Meet/Teams jungiklis. Google naudoja `start.date` / `end.date` (pabaiga išskirtinė, pridedama +1 diena). Outlook: `isAllDay: true`, `start.dateTime = "YYYY-MM-DDT00:00:00"`, `end.dateTime` — kita diena. Patvirtinimas formoje nepraranda laiko informacijos.
- **D2 priminimai**: kūrimo formoje pasirenkama iš fiksuotų parinkčių (numatytasis, 0, 5, 10, 15, 30, 60, 1440 min.). Google — `reminders.overrides` su `popup`; Outlook — `reminderMinutesBeforeStart`. Kai pasirinkta „Numatytasis", `reminders.useDefault: true` Google pusėje, Outlook laukas neperduodamas. Priminimai rodomi tik ne visos dienos įvykiuose.
- **C7 klaviatūros perkėlimas**: `EventBlock` ir `TaskBlock` pagrindiniame mygtuke pridėtas `onKeyDown` su `Shift+↑↓` (±15 min.) ir `Shift+←→` (±1 diena). Trukmės keitimas klaviatūra (`ArrowUp`/`ArrowDown` be `Shift`) ant resize mygtuko išlieka nepakitęs. Tooltip atnaujintas su klaviatūros valdymo aprašymu.
- Patikra: `npm run typecheck` ir 139/139 `npm test` praeina. Build švarus. Laiko zona, pasikartojančių įvykių redagavimas ir gyvų paskyrų patikra lieka nebaigti.
- Ribos: `description` iš Outlook gali būti HTML, jei įvykis sukurtas ne mūsų programėlėje — rodomas kaip paprastas tekstas, redagavimas pakeičia formatą į plaintext. Laiko zona kūrimo formoje dar neeksponuojama — visi nauji įvykiai kuriami UTC. D2 laikomas baigtu; likusios neįgyvendintos sąlygos (laiko zona, pasikartojimas) priskiriamos D4.
