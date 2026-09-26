# „Dienos planas“ — kelias iki kasdien naudojamo produkto

Atnaujinta: 2026-09-25. Būsena: **tikslas aktyvus; auditas atliktas, produktas dar nebaigtas**.

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
- [ ] Susietų blokų sutvarkymas po išorinio užduoties pašalinimo. Užbaigimo ir jau pašalinto Outlook įvykio 404 eiga patikrinta sintetiškai, tačiau ištrintos šaltinio užduoties našlaitis šiuo metu tik pažymimas ir neturi pasiekiamo valymo veiksmo; gyvas Graph dar nepatikrintas.
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

- [x] Visų prieinamų kalendorių sąrašas, spalvos, rašymo teisės, skaitymo pasirinkimas ir pilnas puslapiavimas.
- [x] Teisingas tuščias kalendorių pasirinkimas ir kūrimas / redagavimas / šalinimas pasirinktame ne numatytajame kalendoriuje; įvykio tapatybė apima kalendoriaus ID.
- [x] Sukūrimas, detalus redagavimas ir pašalinimas: pavadinimas, aprašymas, vieta, pradžia / pabaiga, laiko zona, visos dienos įvykis, matomumas, laisvas / užimtas, priminimai. Naujų ir esamų laiko įvykių redaktoriai valdo IANA laiko zoną, o nepasikartojantys įvykiai konvertuojami tarp laiko bei visos dienos režimų.
- [x] Dalyviai, kvietimų atnaujinimas, dalyvavimo atsakymas ir metaduomenų išsaugojimas; Google Meet / Teams pagal kalendoriaus ir paskyros galimybes. RSVP veiksmas patikrintas sintetiniais Google ir Microsoft tiekėjais.
- [x] Kasdien / kas savaitę / kas mėnesį / kas metus, intervalai, savaitės dienos, pabaiga; atskiro egzemplioriaus ir serijos redagavimas. „Šį ir būsimus“ sąmoningai nerodoma, kol nebus atskirai patikrintas serijos skaidymas ir išimčių perkėlimas.
- [ ] ETag / versijų konfliktai, išoriniai pakeitimai ir 401/403/429 apdorojami; nedubliuojantis Google ir Microsoft įvykių kūrimas po neaiškaus atsakymo įgyvendintas ir patikrintas imitacine API, liko gyvos Graph paskyros patikra.
- [x] Atskirai įvertinti Google focus time / out-of-office / working location ir Outlook papildomas galimybes pagal viešą API bei paskyros licenciją. Nepalaikomas funkcijas pažymėti galimybių lentelėje.

Priimta, kai kiekviena įgyvendinta operacija patikrinta su imitacine API ir tuomet abiejų tiekėjų bandomaisiais kalendoriais; perskaitytas įvykis sutampa su išsaugotu, nepasimeta dalyviai ar serijos savybės.

### E. Microsoft To Do, Google Tasks ir vietinės užduotys

- [x] Google / Microsoft sąrašų pasirinkimas, visų sąrašų bei užduočių puslapiavimas; saugūs paskyros ir sąrašo ryšiai.
- [x] Google / Microsoft sąrašų kūrimas, pervadinimas ir šalinimas su peržiūra bei pavadinimo patvirtinimu (imitacinė patikra; įtaisyti / svetimi Microsoft sąrašai ir sąrašai su Outlook blokais ar Docs / Chat užduotimis saugomi nuo šalinimo).
- [x] Sukurti, redaguoti, užbaigti, atkurti ir ištrinti visų trijų šaltinių užduotis; pastabos, datos, vietiniai projektai / žymos ir trukmė (sintetinės API patikra).
- [x] Microsoft svarba ir atskiras priminimo įjungimas, laiko keitimas bei išjungimas su versijos / paskyros patikra (imitacinė API).
- [x] Microsoft kartojimo paslauga, API ir naudotojo sąsaja paprastoms `noEnd` taisyklėms su versijos / paskyros patikra, konflikto bei tik skaitymo būsenomis ir imitaciniu naršyklės testu.
- [x] Microsoft žingsnių adapterio paskyros / sąrašo / versijos / puslapiavimo apsauga, autoritetingi mutacijų rezultatai ir pasiekiamas konflikto atnaujinimas. „My Day” nėra viešos Graph sinchronizacijos API ir nėra pateikiama kaip sinchronizuojama funkcija.
- [x] Google užduočių ir pavaldžių užduočių skaitymas bei bendras planavimas; papildomas Tasks OAuth leidimas ir pakartotinio sutikimo eiga (imitacinė patikra).
- [x] Google hierarchijos ir eilės tvarkos keitimas per `parent` / `previous`, su pilno sąrašo versijos patikra, ciklų bei Google apribojimų validacija ir autoritetingu rezultato perskaitymu.
- [x] Vienodas vietinis planavimas visų šaltinių užduotims, užbaigimo / atkūrimo būsenos atnaujinimas ir šaltinio nuoroda.
- [x] Šaltinyje ištrintų užduočių pasirenkamų Outlook blokų pasiekiamas, pakartojamas sutvarkymas nustatymuose.
- [ ] Gyvų Google ir Microsoft paskyrų patikra pagal priėmimo scenarijus.
- [x] Fokusavimo sesijos pradinis atkūrimas nebeištrina išsaugotos sesijos prieš įkeliant užduotis.
- [x] Fokusavimo sesijoje išsaugomas tikras pradžios laikas, absoliutus pabaigos laikas ir veikimo / pauzės būsena; veikianti bei pristabdyta sesija teisingai atkuriama po perkrovimo.

Priimta, kai Google, Microsoft ir vietinę užduotį galima sukurti, suplanuoti, perkelti, užbaigti ir atkurti; persikrovus bei pasikeitus duomenims šaltinyje rodoma teisinga būsena. Nepalaikomi laukai nepateikiami kaip tariamai sinchronizuojami.

### F. Kasdienis naudojimas ir išleidimas

- [x] Pačios programėlės prieigos apsauga, saugi sesija ir HTTPS diegimo instrukcija viešam / nuotoliniam naudojimui.
- [x] OAuth PKCE / vienkartinė serverio operacija, konfigūracijos diagnostika, minimalūs leidimai, saugus žurnalų turinys.
- [x] SQLite atsarginė kopija ir atkūrimas bei duomenų eksportas be žetonų. Pilnas penkių lentelių roundtrip, senesnės schemos migracija, žetonų pašalinimas eksporte ir klaidingos kopijos rollback patikrinti izoliuotoje SQLite bazėje.
- [x] Docker apraše naudojamas neprivilegijuotas procesas, versijos žyma, paleidimo komandos ir viešas minimalus `/api/health`, veikiantis su `APP_PASSWORD` ir neatskleidžiantis duomenų API.
- [x] Realiai sukurti ir paleisti Docker image; patikrinta sveikata, versija, neprivilegijuotas procesas ir duomenų tomo išlikimas.
- [x] Izoliuoti ir prasmingi svarbiausi naršyklės scenarijai: mobilus ekranas, prieinamumas, konkreti DST diena, tinklo klaidos / rollback ir pilnas vietinių užduočių CRUD. Kiekvienas paleidimas naudoja laisvą prievadą bei unikalią laikiną DB ir ją pašalina.
- [ ] Naudotojo patikra su tikromis paskyromis ir pašalintos rastos klaidos.

Galutinis tikslas laikomas pasiektu tik tada, kai nėra žinomų P0/P1 klaidų pagrindiniuose scenarijuose, veikia abu kalendoriai ir abu užduočių šaltiniai, duomenys išlieka po perkrovimo / atnaujinimo, o tikrų paskyrų scenarijai patvirtinti. Imitaciniai testai nepakeičia OAuth ir realių tiekėjų patikros.

### G. 2026-09-22 audito taisymų seka

Šis etapas turi pirmenybę prieš naujas funkcijas. Kiekviena eilutė užbaigiama atskiru patikrintu commit’u ir push’u į `origin/codex/audit-remediation`; `main` atnaujinama tik po bendros žalios peržiūros.

- [x] **P0 — atsarginės kopijos.** Pilnos kopijos ir eksporto užklausa naudoja `POST`, atkūrimas — `PUT`; abu tikrina sesiją bei kilmę. Atkūrimas patikrina SQLite vientisumą, leidžiamas lenteles ir stulpelių suderinamumą, o visų penkių programos lentelių duomenis pakeičia vienoje transakcijoje per aktyvią jungtį. Roundtrip testas patvirtina create → pakeisti → restore → skaityti / rašyti eigą; eksportas atskirai patikrintas be abiejų OAuth atnaujinimo žetonų.
- [x] **P1 — testų izoliacija.** Playwright wrapperis kiekvienam vykdymui parenka laisvą prievadą ir unikalią laikiną DB, neleidžia tiesiogiai perimti jau veikiančio serverio ir `finally` bloke pašalina duomenis. Testai tikrina realų vieno stulpelio rodinį, konkrečią 2026-03-29 Vilniaus 23 valandų dieną, klaidos pranešimą, UI / DB rollback ir pilną vietinės užduoties CRUD.
- [x] **P1 — Google užduoties tapatybė.** Perkėlimas tarp sąrašų per bendrą užduočių adapterį tikrina paskyrą, paskirties sąrašą ir plano versiją. Tik Google patvirtinus rezultatą viena vietine transakcija pakeičiamas užduoties raktas, perkeliama visa `task_plans` eilutė su Outlook bloko ryšiu ir atnaujinama nuotolinė kopija; nutrūkus tarp tiekėjo ir vietinės transakcijos, patvarus ketinimas suderinamas per kitą atnaujinimą.
- [x] **P1 — kalendoriaus įvykio tapatybė.** Bendras raktas apima tiekėją, prisijungimą, kalendorių ir įvykį. UI atnaujina tik pasirinktą įrašą; PATCH ir DELETE privalo pateikti kalendorių, prisijungimą bei versiją ir naudoja to kalendoriaus kelią. Vienodi ID skirtinguose Google / Outlook kalendoriuose patikrinti integraciniais testais.
- [x] **Outlook bloko rodymo susiejimas.** Serveris susieja Graph įvykį tik pagal dabartinę Microsoft paskyrą, pirminį kalendorių, įvykio ID ir kuriant išsaugotą `transactionId`; neatitinkantis to paties ID įvykis kitame kalendoriuje lieka matomas. UI bloką sutraukia į užduoties planą tik kai sutampa dabartinis laikas, trukmė, pavadinimas ir saugios bloko savybės.
- [x] **P1 — našlaičių Outlook blokų valymas.** Ištrintų šaltinio užduočių susieti blokai patenka į pasiekiamą, pakartojamą valymo eilę.
- [x] **P1 — produkto paviršius.** Užbaigti Google `parent` / `previous` ir fokusavimo sesijos pradžios, veikimo bei pauzės išsaugojimą.
- [x] **P1 — diegimo health.** Viešas minimalus `/api/health` neapeina duomenų API ir veikia su `APP_PASSWORD`; Docker ir Playwright sveikatos patikros naudoja šį maršrutą.
- [x] **P1 — Docker priėmimas.** Realiai sukurtas ir paleistas image; patikrinta sveikata, versija, neprivilegijuotas procesas ir duomenų tomo išlikimas.
- [ ] **D/F priėmimas.** Užbaigti detalaus įvykio redagavimo spragas, sinchronizuoti README su faktine būsena, tada vykdyti abiejų gyvų paskyrų scenarijų pagal atskirą kontrolinį sąrašą.

## Darbo eiga ir ribos

### 2026-09-24 Google Calendar ir Outlook RSVP

- Kviečiamo dalyvio įvykis dabar turi atskirą atsakymo galimybę net tada, kai bendrų įvykio laukų redaguoti negalima. Redaktorius rodo dabartinę būseną ir lietuviškus „Taip“, „Galbūt“ bei „Ne“ veiksmus.
- Bendras versijuotas API prieš veiksmą iš naujo patikrina paskyrą, kalendorių, įvykį ir kviečiamo naudotojo būseną. Google keičia tik `self` dalyvio `responseStatus` su `attendeesOmitted` ir `If-Match`; Microsoft naudoja oficialius `accept`, `tentativelyAccept` arba `decline` veiksmus ir teisingai priima jų tuščią `202 Accepted` atsakymą. Pakartotas jau pasiektos būsenos veiksmas yra idempotentiškas.
- Patikra: `typecheck`, 208/208 vienetiniai ir integraciniai testai, produkcinis build ir 28/28 izoliuoti Playwright scenarijai. Tikros Google bei Microsoft paskyros ir tiekėjų eventualaus atnaujinimo delsa šiame žingsnyje nepatikrintos.

### 2026-09-24 Docker priėmimas

- Realus `linux/arm64` image sukurtas su `APP_VERSION=0.1.0` ir paleistas Docker Desktop. OCI žyma bei `/api/health` grąžino `0.1.0`, procesas veikė kaip `uid=100(planner)`, o įtaisytas Docker healthcheck pasiekė būseną `healthy`.
- Priėmimo metu aptikta ir pataisyta paleidimo klaida: Docker įterptas konteinerio `HOSTNAME` vertė Next standalone serverį klausyti tik konteinerio hostname adresu, o Alpine `wget` naudojamas `localhost` kelias nepasiekė IPv4 serverio. Image dabar nustato `HOSTNAME=0.0.0.0`, o Dockerfile ir Compose healthcheck naudoja `127.0.0.1`.
- Vardiniame `/app/data` tome per tikrą Tasks API sukurta vietinė užduotis. Pašalinus konteinerį ir sukūrus naują su tuo pačiu tomu, užduotis perskaityta su tuo pačiu `id=1`; taip pat atskirai patikrintas hosto ir konteinerio vidaus health kelias.

### 2026-09-24 fokusavimo sesijos išlikimas

- Fokusavimo būsena saugo užduoties raktą, likusį laiką, tikrą pirmo paleidimo laiką, veikimo būseną ir absoliutų pabaigos laiką. Veikiantis laikmatis po perkrovimo įskaito praėjusį laiką, pristabdyta sesija lieka pristabdyta, o senas `{taskKey, seconds}` formatas saugiai perkeliamas kaip pauzė.
- Laikmatis skaičiuojamas nuo absoliutaus pabaigos laiko, todėl naršyklės fono režimas nebekaupia intervalų dreifo. UI rodo pradžios laiką ir turi įvardytus paleidimo, pauzės, atstatymo bei užbaigimo mygtukus.
- Patikra: `typecheck`, 202/202 vienetiniai ir integraciniai testai, produkcinis build ir 27/27 izoliuoti Playwright scenarijai.

### 2026-09-24 Google Tasks hierarchija ir eilė

- Užduoties redaktoriuje galima parinkti tėvinę užduotį ir ankstesnę to paties lygio užduotį. Atskiras API maršrutas prieš įrašą perskaito visą sąrašą, tikrina paskyrą, sąrašą, versiją, ciklus, paslėptas, priskirtas bei pasikartojančias užduotis ir po `tasks.move` dar kartą patvirtina faktinę Google būseną.
- Tarp sąrašų perkėlimo ir vietinio plano tapatybės logika nepakeista. Neaiškus hierarchijos įrašo atsakymas neperrašo vietinės kopijos; veiksmą galima saugiai tęsti atnaujinus būseną.
- Patikra: `typecheck`, 199/199 vienetiniai ir integraciniai testai, produkcinis build ir 26/26 izoliuoti Playwright scenarijai. Gyvos Google paskyros `tasks.move` elgsena dar nepatvirtinta.

### 2026-09-23 kalendoriaus tapatybės pataisa

- Google ir Outlook įvykiai raktinami pagal tiekėją, prisijungimą, kalendorių ir įvykio ID; antrinio kalendoriaus redagavimas bei trynimas nebekreipiami į numatytąjį kalendorių.
- Patikra: `typecheck`, 178/178 vienetinių / integracinių testų, produkcinis build ir 21/21 izoliuotas Playwright scenarijus. Naršyklėje patikrinti vienodų ID laiko bei visos dienos blokai ir pasirinkto bloko perkėlimas. Nepriklausomos peržiūros verdiktas — `ship`.
- Gyvos Google / Graph paskyros šiame žingsnyje nebuvo keičiamos. Outlook bloko slėpimas pagal pilną susiejimą ir našlaičių valymo eilė lieka kitais žingsniais.

### 2026-09-23 Outlook bloko rodymo susiejimas

- Graph įvykio ryšys patvirtinamas serveryje pagal aktyvią Microsoft paskyrą, pirminį kalendorių, įvykio ID ir programėlės sukūrimo `transactionId`; šis identifikatorius klientui neatskleidžiamas. Tikras pirminio kalendoriaus ID patvirtinamas per Graph ir pririšamas prie paskyros bei prisijungimo kartos, o išsaugotas kalendorių pasirinkimas — prie paskyros. To paties ID įvykiai kituose kalendoriuose, neaiškūs arba dubliuoti ryšiai ir vartotojo pakeisti blokai lieka matomi.
- UI paslepia tik vienintelį patvirtintą `free`, vienkartinį, be dalyvių bloką, kai rodomos užduoties raktas, dabartinis pavadinimas, pradžia ir trukmė vis dar sutampa. Ta pati taisyklė taikoma dienos skaitikliui, laiko tinkleliui ir mėnesio rodiniui.
- Patikra: `typecheck`, 182/182 vienetiniai / integraciniai testai, produkcinis build ir 22/22 izoliuoti Playwright scenarijai. Gyva Graph paskyra nepatikrinta; ištrintos šaltinio užduoties našlaičio valymo eilė lieka kitu žingsniu.

### 2026-09-23 našlaičių Outlook blokų valymas

- Tik sėkmingai atnaujintas tiekėjo sąrašas gali pažymėti dingusios užduoties planą našlaičiu. Eilėje išsaugoma stabili valymo versija, paskutinis pavadinimas, Outlook įvykio tapatybė ir jį sukūrusios Microsoft paskyros ryšys; šaltinyje vėl atsiradusi užduotis iš eilės pašalinama.
- Nustatymuose rodoma pasiekiama valymo eilė. Nuotolinis blokas trinamas tik prisijungus prie tos pačios Microsoft paskyros; neaiškus sukūrimas pirmiausia saugiai atkuriamas pagal išsaugotą `transactionId`, o 404 laikomas jau pasiektu rezultatu. Klaida palieka įrašą pakartojimui, pasikeitusi eilės versija atmetama, pakartotas jau įvykdytas prašymas yra idempotentiškas. Jei nuotolinis blokas negalėjo būti sukurtas, vietinis našlaitis išvalomas be paskyros.
- Patikra: `typecheck`, 190/190 vienetinių / integracinių testų, produkcinis build ir 23/23 izoliuoti Playwright scenarijai. Patikrintos migracijos, atsarginės kopijos, same-origin API, pašalintas visas tiekėjo sąrašas, atominis rollback, Google užduoties atkūrimo lenktynė, unikali valymo versija, svetima paskyra, 404 ir laikina trynimo klaida. Gyva Graph paskyra šiame žingsnyje nepatikrinta.

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

### D6 — specialių įvykių tipų galimybių lentelė

| Tipas | Google Calendar API | Microsoft Graph API | Šioje programėlėje |
|---|---|---|---|
| Focus time | `eventType: "focusTime"` — sukuriamas ir atnaujinamas kaip paprastas įvykis, tačiau tiekėjas galima automatiškai nustato `showAs: doNotDisturb` | Nėra tiesioginio atitikmens — galima naudoti kategorijas | Rodomas kaip tik skaityti (`special=true`) |
| Out of Office | `eventType: "outOfOffice"` — API leidžia skaityti; atsakymo nustatymai per atskiras API | `showAs: oof` — skaitymas OK; rašymui reikia specialių teisių tam tikruose tenant'uose | Rodomas kaip tik skaityti |
| Working Location | `eventType: "workingLocation"` — skaityti galima; rašyti per `workingLocationProperties` | Nėra atitikmens | Rodomas kaip tik skaityti |
| Locked | `locked: true` — tiekėjo užraktas; redagavimas draudžiamas net organizatoriui | Nėra tiesioginio lauko | Rodomas kaip tik skaityti |
| All-day | `start.date` + `end.date` | `isAllDay: true` | Skaityti, redaguoti ir konvertuoti į / iš laiko įvykio ✓ |
| Recurring series | `recurrence[]` (master) | `type: "seriesMaster"` | Kūrimas ir paprastos taisyklės redagavimas visai serijai; egzempliorius redaguojamas atskirai |
| Private | `visibility: "private"` | `sensitivity: "private"` | Rodomas; kuriant galima nustatyti |
| Birthday / Holiday | `eventType: "birthday"` arba skaitomas kitas kalendorius | Atskiri readonly kalendoriai | Tik skaityti (kiti kalendoriai per D1) |

Visi neredaguojami tipai gauna aiškų `readOnlyReason` ir nuorodą į originalą.

### 2026-09-22 D etapo darbai

- D3 (dalyviai): `CalendarEvent` turi `attendees?` masyvą su RSVP statusais (accepted/declined/tentative/needsAction). `normalizeEvent` ištraukia dalyvius iš Google ir Outlook. `update` priima `attendees` pakeitimą; el. pašto validacija prieš užrakto gavimą. Laiko keitimo patvirtinimas (409) aktyvinamas tik kai tikrai keičiamas laikas IR yra dalyvių. `ExistingEventEditor` rodo dalyvių sąrašą su RSVP piktogramomis (✓✗?·), leidžia šalinti ir pridėti el. paštu. 141 vieneto testai, 18 maršruto testų — visi praeina.
- D4 (pasikartojantys): Instance (`recurringEventId` / `type="occurrence"`) redaguojamas, serijos šaknis (`recurrence[]` / `type="seriesMaster"`) lieka tik skaitymui. Parodomas ↻ ženklas ir informacinis tekstas.
- D1 (visi kalendoriai): nauji `GET/PATCH /api/google/calendars` ir `/api/microsoft/calendars` maršrutai sąrašuoja prieinamus kalendorius ir išsaugo pasirinktą rinkinį (su pavadinimais ir spalvomis) DB. `CalendarEvent` įgavo `calendarId`, `calendarName`, `calendarColor`. `list()` paraleliai gali gauti įvykius iš kelių kalendorių. Nustatymų lange — checkbox'ai per tiekėją; įvykio bloke rodomas kalendoriaus pavadinimas ir per-kalendoriaus kairiojo krašto spalva.
- D5 (konfliktų UX): `HttpError` klase išsaugomas HTTP statusas visose `responseJson` klaidose. `ExistingEventEditor` aptinka versijų konfliktą (409 + pranešimas „pakeistas kitur") ir rodo inline „Atnaujinti ir uždaryti →" mygtuką — perkrauna kalendorių ir uždaro langą. Dalyvių patvirtinimo 409 atskirtas pagal pranešimą, checkboxas lieka. 429/401/403/404 jau turėjo lietuviškus tekstus per `apiError`.
- D6 (galimybių lentelė): dokumentuoti focus time, OOO, working location, locked, all-day, recurring, private, birthday/holiday tipai — visi neredaguojami tipai gauna `readOnlyReason` + originalo nuorodą.
- TypeScript, produkcinis build ir 141/141 testai praeina po kiekvieno pakeitimo. Naršyklės patikra su realiais paskyrais šio etapo metu neatlikta.
- 2026-09-22 audito pataisa: D etapas nėra baigtas. Trūksta teisingo ne numatytojo kalendoriaus tapatybės naudojimo, pilno esamo įvykio laukų redagavimo, RSVP, nedubliuojančio kūrimo ir pasikartojančių serijų valdymo.

### 2026-09-22 E etapo tęsinys

- E5 (žingsniai): `GET/POST/PATCH/DELETE /api/tasks/steps` per bendrą užduočių adapterį apgaubia Microsoft `checklistItems` API. `TaskSteps` komponentas `TaskEditor` tingiai įkrauna ir rodo žingsnių sąrašą su būsenos keitimu, pridėjimu ir šalinimu — rodoma tik Microsoft užduotims. „My Day" nėra viešos Graph sinchronizacijos API; tai žymėta galimybių lentelėje.
- E7 (perkelti tarp sąrašų): `POST /api/tasks/move` iškviečia Google Tasks `move` API su `destinationTasklist`. `TaskEditor` rodo „Perkelti į sąrašą" išskleidžiamąjį meniu Google užduotims, kai yra ≥2 rašytini sąrašai.
- E8 (paskyrų patikra + blokų tvarkymas): `load()` aptinka `HttpError` 401 atmestuose įvykių gavimo rezultatuose ir rodo specifinį „sesija baigėsi — atidaryk nustatymus" pranešimą. Pasenusių Outlook blokų šalinimas jau buvo įgyvendintas per `syncMirror` užduoties pašalinimo kelyje.
- TypeScript, produkcinis build ir 141/141 testai praėjo tuo metu. 2026-09-22 auditas aptiko kartojimo UI, žingsnių tapatybės, Google plano migravimo, našlaičių blokų ir fokusavimo sesijos spragas; vėlesni įrašai šiame plane žymi jų taisymus ir likusias ribas.

### 2026-09-22 F1 — programėlės prieigos apsauga

- Slaptažodžio apsauga per `APP_PASSWORD` aplinkos kintamąjį. Kai nenustatytas — autentifikacija išjungta (patogiam vietiniam naudojimui). Kai nustatytas — visi maršrutai apsaugoti.
- `lib/session.ts`: HMAC-SHA256 pasirašyti žetonai su `TOKEN_ENCRYPTION_KEY`, 24 val. galiojimas, `timingSafeEqual` slaptažodžio tikrinimas.
- `proxy.ts` (Next.js 16 middleware ekvivalentas, patikrinta per `ƒ Proxy` build žymę): apsaugo visus maršrutus išskyrus `/login` ir `/api/auth/*`. API maršrutai → 401 JSON, puslapiai → peradresuoja į `/login`.
- `/api/auth/login` su 10 bandymų/min/IP apribojimu; `/api/auth/logout`; atsijungimo mygtukas nustatymuose.
- `/app/login/page.tsx` — lietuviškas prisijungimo puslapis.
- `.env.example` papildytas `APP_PASSWORD` komentaru ir `openssl rand -base64 24` pavyzdžiu.
- Automatinės saugumo peržiūros radinys: atviroji peradresavimo spraga `/login?next=` — ištaisyta iš karto (tik santykiniai tos pačios kilmės keliai priimami).
- 153/153 testai, typecheck, produkcinis build praeina.

### 2026-09-22 F2 — OAuth PKCE ir konfigūracijos diagnostika

- PKCE S256 abiem tiekėjams: `generatePKCE()` / `generateMicrosoftPKCE()` generuoja `verifier` + `challenge`; verifier saugomas httpOnly slapuke `/connect`, `challenge` perduodamas į tiekėjo auth URL; verifier naudojamas kodo mainuose `/callback`. Apsaugo nuo autorizacijos kodo perėmimo net be `client_secret`.
- `microsoftAuthUrl` ir `googleAuthUrl` dabar reikalauja antrojo `codeChallenge` parametro; `exchangeCode` / `exchangeMicrosoftCode` — `codeVerifier`. Esami testai atnaujinti.
- `/api/config` (GET, apsaugotas sesija): grąžina visų aplinkos kintamųjų buvimo būseną be verčių — naudinga diagnostikai.
- Minimalūs leidimai jau buvo teisingi: Google — `calendar + tasks + openid`; Microsoft — `Calendars.ReadWrite Tasks.ReadWrite User.Read`. Nepakeisti.
- Žurnalai: `apiError` visada grąžina generines lietuviškas klaidas be tiekėjo detalių. `proxy.ts` neregistruoja žetonų.
- 153/153 testai, typecheck, produkcinis build praeina. Tikrų OAuth paskyrų su PKCE patikra neatliekta.
- Ribos: `APP_ORIGIN` HTTPS instrukcija yra `.env.example` komentare, bet atskiro diegimo vadovo nėra — lieka F4.

### 2026-09-22 F3 — SQLite atsarginė kopija ir atkūrimas

- `lib/backup.ts`: `createBackup()` (visi duomenys), `createExport()` (be `google_refresh_token` / `microsoft_refresh_token`), `restoreBackup()`. Kopija per ATTACH DATABASE + CREATE TABLE + INSERT INTO — vienintelis veikiantis būdas šioje Node.js versijoje (`DatabaseSync.backup()` nėra, `VACUUM INTO` kuria tuščią DB).
- Atkūrimas: SQLite magic bytes patikrinimas iš buferio prieš `new DatabaseSync()` atidarymą; lentelių sąrašo validavimas (tik `tasks` ir `settings`); roll-back jei kopija nepavyko.
- Saugumo pataisymai: laikinieji failai sukuriami su 0o600 teisėmis; `.pre-restore` kopija iš karto `chmod 0o600`; GET `/api/backup` gauna `assertSameOrigin` (anksčiau jo nebuvo).
- `app/api/backup/route.ts`: GET `?type=full|export`, POST atkūrimui. Abi funkcijos gauna tiesioginį sesijos tikrinimą (gynybos gilumas — papildomai prie proxy.ts).
- `app/page.tsx`: `BackupPanel` komponentas nustatymuose — parsisiuntimas ir atkūrimas per failo įkėlimą.
- `tests/backup.test.mjs` (5 testai), `tests/db-migration.test.mjs` (5 testai — sena schema su `due_at`, migracija į `task_plans`, idempotentiškumas).
- 163/163 testai, typecheck, produkcinis build praeina.
- 2026-09-22 audito pataisa: šie testai nepatikrino sėkmingo pilnos kopijos roundtrip. Reali kopija turi papildomas lenteles, kurias atkūrimas atmeta, UI siunčia netinkamą pilnos kopijos tipą, o failo pakeitimas po aktyvia WAL jungtimi yra nesaugus. F3 laikomas nebaigtu.
- 2026-09-22 audito taisymas: kopijavimas apribotas penkiomis programos lentelėmis ir vyksta nuoseklioje skaitymo transakcijoje. Atkūrimas nekeičia DB failo: patikrintus duomenis įkelia per prijungtą tik skaitymui skirtą kopiją ir vieną `BEGIN IMMEDIATE` transakciją. Nežinomos lentelės, nepalaikomi objektai ir naujesni stulpeliai atmetami iki duomenų pakeitimo; senesnės `tasks` / `settings` kopijos užpildomos dabartiniais numatytais laukais ir migracijos žyma.
- API dabar naudoja `POST` pilnai kopijai / eksportui ir `PUT` atkūrimui, todėl visos operacijos turi sesijos bei tos pačios kilmės patikrą. UI siunčia `full` pilnai kopijai. README aprašo žetonų riziką, 100 MB ribą ir atkūrimo eigą.
- Izoliuoti testai patvirtina visas penkias lenteles, pilną create → pakeisti → restore → skaityti / rašyti roundtrip, eksportą be abiejų OAuth atnaujinimo žetonų, seną schemą, nežinomą / naujesnę schemą, nepakeistus esamus duomenis po atmetimo ir API metodų / sesijos / kilmės sutartį.

### 2026-09-22 F4 — Docker ir diegimas

- `Dockerfile`: papildytas `planner` neprivilegijuotu naudotoju (`adduser -S`), `chown /app/data`, `USER planner`, `HEALTHCHECK` su `wget /api/config`, `ARG APP_VERSION` ir `LABEL` OCI anotacijos.
- `docker-compose.yml`: `./data` tome susietas, `env_file: .env`, health check, atnaujinimo komandos komentaruose (`docker compose pull && up -d --build`).
- `app/api/config/route.ts`: grąžina `version` iš `package.json` — sveikatos patikra ir diagnostika vienoje vietoje.
- 163/163 testai, typecheck, produkcinis build praeina.
- Ribos: Docker image tikroje aplinkoje nebuvo paleistas (tam reikia Docker daemon). `APP_ORIGIN` HTTPS nustatymas ir OAuth callback URI koregavimas lieka naudotojo atsakomybe.
- 2026-09-22 audito pataisa: su `APP_PASSWORD` healthcheck gauna 401 iš apsaugoto `/api/config`, todėl F4 laikomas nebaigtu.

### 2026-09-22 F5 — automatizuoti naršyklės testai

- Playwright 1.63.0 įdiegtas; `npm run test:e2e` paleidžia visus testus (20 testų, 2 projektai: desktop + mobile 390px viewport).
- `tests/e2e/task-crud.spec.ts`: puslapio įkėlimas be konsolės klaidų, `/api/config` sveikatos patikra su versija, užduoties sukūrimas (laukiama POST atsakymo), išlikimas po perkrovimo.
- `tests/e2e/mobile.spec.ts`: horizontalus slinkimas ≤ kliento plotui, apatinė navigacija, užduočių sąrašas per „Užduotys" mygtuką (tikslus `nav[aria-label='Rodiniai']` selektorius), vieno stulpelio rodinys.
- `tests/e2e/accessibility.spec.ts`: `<html lang>` atributas, `<main>` ar `role=main` matomumas, Tab klavišo fokusavimas nuo `<body>`, prisijungimo formos etiketės.
- `tests/e2e/network-errors.spec.ts`: užduočių ir kalendorių API klaidų (`abort`) apdorojimas be steko pėdsakų, lėtas tinklas (500ms) nesugriauna puslapio.
- `tests/e2e/timezones.spec.ts`: Vilnius, UTC, New York, Tokyo laiko zonos ir DST riba 2026-03-29 — visi be konsolės klaidų.
- `playwright.config.ts`: desktop projektas ignoruoja `mobile.spec.ts`; mobile projektas vykdo tik `mobile.spec.ts`. Serveriui naudoja esamą `:3000` (`reuseExistingServer: true`).
- `tests/calendar-smoke.mjs` pataisa: `meeting` PATCH testas dabar siunčia laiko pakeitimą (+30 min.) tam, kad suaktyvintų 409 dalyvių patvirtinimo tikrinimą (senas kodas siuntė tą patį laiką → `timeChanged=false` → 200). Visos 3 HTTP smoke priemonės praeina.
- 163 vienetiniai + 20 naršyklės testai praeina.
- 2026-09-22 audito pataisa: `reuseExistingServer: true` leido testams rašyti į naudotojo DB; 22 testiniai įrašai pašalinti tik padarius nuoseklią kopiją. Vieno stulpelio, DST ir tinklo klaidų testų teiginiai stipresni už jų tikrinamas sąlygas. F5 laikomas nebaigtu iki izoliacijos ir prasmingų assertions.
- 2026-09-22 audito taisymas: `scripts/test-e2e.mjs` parenka laisvą prievadą, sukuria unikalų laikinos DB katalogą, perduoda jį Playwright serveriui ir pašalina `finally` bloke. `reuseExistingServer` išjungtas, o konfigūracija be wrapperio atsisako startuoti. Testinis serveris išjungia programėlės slaptažodį ir tikrų OAuth tiekėjų konfigūraciją; `/api/config` testas patvirtina laikinos DB kelią.
- Mobilus testas skaičiuoja vieną `.dayHead` ir `.dayLane`; DST testas fiksuoja laiką ties 2026-03-29 ir tikrina 23 valandų žymą; klaidų testai tikrina matomą lietuvišką pranešimą, lėto atsakymo loading būseną ir nesėkmingo kūrimo UI / DB rollback. CRUD scenarijus sukuria, perkrauna, redaguoja, užbaigia, atkuria ir ištrina vietinę užduotį.

### 2026-09-22 F6 (dalinai) — našlaičių Outlook blokų valymas, health endpoint, focus sesija

- `task_plans`: nauji stulpeliai `mirror_orphaned_at` ir `mirror_orphan_title` (su migracija ir `ALTER TABLE` idempotenčiai). Našlaitis automatiškai išvalomas, kai šaltinio užduotis vėl matoma atnaujinimo metu.
- `task-service.ts`: `mirrorCleanups()` grąžina sąrašą orphan planų; `cleanupMirror()` saugiai pašalina Outlook įvykį (atkuria nebaigtas kūrimo operacijas per `mirror_create_payload`) ir tada pašalina plan eilutę. Stale snapshot apsauga per 409.
- `/api/tasks/mirror-cleanup` (POST): `assertSameOrigin` + sesijos tikrinimas; 409 kai snapshot pasikeičia tarp GET ir POST.
- `/api/tasks?envelope=1` dabar grąžina `cleanups[]` masyvą kartu su `items` ir `lists`.
- Nustatymų lange: „Likę Outlook blokai" sekcija su „Pašalinti bloką" mygtuku kiekvienam orphan įrašui; mygtuko būsena atspindi ar paskyra prijungta.
- Testai: `tests/mirror-cleanup.test.mjs` (išplėstas), `tests/tasks-routes.test.mjs` (naujas testas), `tests/db-migration.test.mjs` (stulpelių tikrinimas), `tests/e2e/mirror-cleanup.spec.ts`.
- `/api/health` (GET, viešas, be autentifikacijos): grąžina `{ok:true,version}` — Docker HEALTHCHECK veikia net kai `APP_PASSWORD` nustatytas. `proxy.ts` leidžia `/api/health` be sesijos. Dockerfile ir docker-compose perjungti nuo `/api/config` prie `/api/health`. Playwright webServer readiness probe taip pat perjungtas.
- Focus sesijos race condition pataisa: `localStorage.removeItem("focus-session")` buvo iškviečiamas pradiniam render metu prieš užkraunant užduotis ir prieš paleidžiant restoration effect. Dabar saugoma/ištrinama tik po `restoredFocus.current = true`.
- `tests/calendar-smoke.mjs` pataisa: `meeting` PATCH siuntė tą patį laiką → `timeChanged=false` → 200 vietoj 409. Pataisyta siųsti +30 min. laiko poslinkį.
- 190 vienetinių + 23 naršyklės testai praeina. TypeScript ir produkcinis build švarūs.
- Ribos: gyvas Graph Outlook bloko šalinimas nepatikrintas su tikra paskyra. Google hierarchija/eiliškumas, RSVP veiksmas ir detalaus įvykio redagavimo spragos lieka.

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

### 2026-09-23 — Microsoft To Do kartojimo naudotojo sąsaja

- Microsoft užduoties redaktoriuje galima įjungti, pakeisti ir išjungti kasdienę, savaitinę, mėnesinę arba metinę paprastą `noEnd` taisyklę. Sąsaja aiškiai palieka terminą ir vietinį darbo planą nepakeistus.
- Redaktorius naudoja API grąžintą versiją, paskyros ir sąrašo tapatybę, blokuoja lygiagrečius pagrindinės užduoties, priminimo bei kartojimo pakeitimus, o 409 konfliktui ir tik skaitymo taisyklei rodo atnaujinimo eigą.
- Naršyklės testas patikrina savaitinės taisyklės išsaugojimo užklausą ir saugo nuo kartojimo valdiklio dubliavimo keičiantis asinchroninei būsenai.
- Patikra: `npm run typecheck`, 190/190 `npm test`, `npm run build` ir 24/24 `npm run test:e2e` praėjo.
- Ribos: tikros Graph paskyros `If-Match` elgsena dar nepatvirtinta; sudėtingos taisyklės ir baigtinis kartojimas sąmoningai lieka tik skaitymui.

### 2026-09-24 — Microsoft To Do žingsnių adapterio apsauga

- Žingsnių GET/POST/PATCH/DELETE perkelti į bendrą užduočių adapterį. Kiekviena operacija iš naujo patvirtina Microsoft paskyrą, sąrašą ir užduotį, naudoja viso užduoties bei checklist snapshot versiją ir serializuojama su kitomis Microsoft To Do operacijomis.
- Žingsnių sąrašas seka tik to paties Graph endpoint saugias `@odata.nextLink` nuorodas, atmeta pasikartojančius ID, o sukūrimą, pakeitimą ir pašalinimą patvirtina nauju tiekėjo snapshot.
- Sąsaja siunčia pilną tapatybės raktą ir versiją, rodo konfliktus, tik skaitymo bei ryšio klaidas, leidžia aiškiai atnaujinti būseną ir blokuoja lygiagrečius užduoties, priminimo ar kartojimo pakeitimus.
- Patikra: `npm run typecheck`, 195/195 `npm test`, `npm run build` ir 25/25 `npm run test:e2e` praėjo.
- Ribos: gyvas Microsoft Graph checklist puslapiavimas ir pakeitimų nuoseklumas su tikra paskyra dar nepatvirtinti. „My Day” sąmoningai nerodoma kaip sinchronizuojama funkcija, nes viešos Graph API jai nėra.

## 2026-09-21 — D2 įvykių redagavimas ir C7 klaviatūros perkėlimas

- **D2 vieta** (`location`): pridėtas laukas naujo įvykio kūrime ir esamo redagavime abiejuose tiekėjuose. Google POST perduoda `location` tiesiogiai; Outlook naudoja `location.displayName`. Normalizatorius ištraukia vietą iš abiejų formatų; `update` leidžiamųjų laukų sąraše įtrauktas `"location"`.
- **D2 aprašymas** (`description`): `CalendarEvent` tipo laukas, normalizuotas iš `raw.description` (Google) ir `raw.body.content` (Outlook). Esamo įvykio redaktoriuje pridėtas `<textarea>`, perduodamas PATCH. Atnaujinta formHint — aprašymas dabar keičiamas, ne tik išsaugomas. Siunčiama tik tada, kai laukas perduotas; nepriskirtų laukų `update` neteršia.
- **D2 laisvas / užimtas ir matomumas**: kūrimo formoje pridėti du papildomi mygtukai — „Laisvas / užimtas" ir „Matomumas". Google: `transparency: "transparent"` ir `visibility: "private"`. Outlook: `showAs` jau turimas; pridėtas `sensitivity: "private"`. Numatytosios reikšmės atitinka tiekėjų elgseną (užimtas, vieša).
- **D2 visos dienos įvykis**: kūrimo formoje pridėtas jungiklis. Kai įjungtas — rodomi tik datos laukai (pradžia ir pabaiga), paslėpti trukmė, dalyviai ir Meet/Teams jungiklis. Google naudoja `start.date` / `end.date` (pabaiga išskirtinė, pridedama +1 diena). Outlook: `isAllDay: true`, `start.dateTime = "YYYY-MM-DDT00:00:00"`, `end.dateTime` — kita diena. Patvirtinimas formoje nepraranda laiko informacijos.
- **D2 priminimai**: kūrimo formoje pasirenkama iš fiksuotų parinkčių (numatytasis, 0, 5, 10, 15, 30, 60, 1440 min.). Google — `reminders.overrides` su `popup`; Outlook — `reminderMinutesBeforeStart`. Kai pasirinkta „Numatytasis", `reminders.useDefault: true` Google pusėje, Outlook laukas neperduodamas. Priminimai rodomi tik ne visos dienos įvykiuose.
- **C7 klaviatūros perkėlimas**: `EventBlock` ir `TaskBlock` pagrindiniame mygtuke pridėtas `onKeyDown` su `Shift+↑↓` (±15 min.) ir `Shift+←→` (±1 diena). Trukmės keitimas klaviatūra (`ArrowUp`/`ArrowDown` be `Shift`) ant resize mygtuko išlieka nepakitęs. Tooltip atnaujintas su klaviatūros valdymo aprašymu.
- Patikra: `npm run typecheck` ir 139/139 `npm test` praeina. Build švarus. Laiko zona, pasikartojančių įvykių redagavimas ir gyvų paskyrų patikra lieka nebaigti.
- Ribos: `description` iš Outlook gali būti HTML, jei įvykis sukurtas ne mūsų programėlėje — rodomas kaip paprastas tekstas, redagavimas pakeičia formatą į plaintext. Laiko zona kūrimo formoje dar neeksponuojama — visi nauji įvykiai kuriami UTC. D2 laikomas baigtu; likusios neįgyvendintos sąlygos (laiko zona, pasikartojimas) priskiriamos D4.

### 2026-09-24 — esamo laiko įvykio matomumas, būsena ir priminimas

- Google ir Outlook laiko įvykių redaktorius skaito ir keičia tiekėjo laisvo / užimto laiko būseną, matomumą bei vieną paprastą priminimą. Google reikšmės verčiamos į `transparency`, `visibility` ir `reminders`; Outlook — į `showAs`, `sensitivity`, `isReminderOn` bei `reminderMinutesBeforeStart`.
- Google numatytasis, išjungtas ir vienas `popup` priminimas normalizuojami atskirai. Keli priminimai arba kitas jų tipas rodomi kaip tiekėjo nustatymas ir per nesusijusį redagavimą neperrašomi. Pasikartojančio egzemplioriaus matomumas programėlėje nekeičiamas, kad pakeitimas nepaveiktų visos Google serijos.
- API priima tik kiekvieno tiekėjo palaikomas reikšmes, 0–40320 minučių intervalą ir pilną įvykio paskyros, kalendoriaus, ID bei versijos tapatybę. Sintetinė API patikra perskaito išsaugotą rezultatą iš naujo.
- Patikra: `npm run typecheck`, 215/215 `npm test`, `npm run build`, 3/3 tiksliniai ir 31/31 visi `npm run test:e2e` scenarijai praėjo.
- Ribos: tikros Google ir Microsoft paskyros šiame žingsnyje nekeistos. Esamo visos dienos įvykio ir laiko zonos redagavimas tebėra neįgyvendintas, todėl visas D2 punktas lieka neužbaigtas.

### 2026-09-24 — esamo visos dienos įvykio datos

- Savo organizuojamą Google arba Outlook visos dienos įvykį galima atverti ir pakeisti nuo pirmos iki paskutinės naudotojui rodomos dienos. API naudoja tiekėjų išskirtinę pabaigos ribą: Google siunčia `start.date` / `end.date`, Outlook — `isAllDay: true` ir abiejų ribų vidurnaktį toje pačioje UTC zonoje.
- Serveris griežtai tikrina realias `YYYY-MM-DD` datas, pradžios ir pabaigos tvarką, įvykio režimą, paskyrą, kalendorių, ID bei versiją. Laiko įvykio negalima netyčia paversti visos dienos įvykiu ar atvirkščiai. Keičiant kvietimo dienas, kaip ir laiką, reikia patvirtinti dalyvių informavimą.
- Normalizuotas Outlook visos dienos įvykis grąžina datos ribas, todėl sąsaja nepriklauso nuo naršyklės laiko zonos. Nesusiję aprašymo, Teams / Meet, priminimų ir kiti metaduomenys į tiekėjo PATCH nepatenka.
- Patikra: `npm run typecheck`, 222/222 `npm test`, `npm run build`, 4/4 tiksliniai ir 32/32 visi `npm run test:e2e` scenarijai praėjo.
- Ribos: tikros Google ir Microsoft paskyros nekeistos. Konvertavimas tarp laiko bei visos dienos režimų ir laiko zonos pasirinkimas palikti atskiriems žingsniams; D2 punktas dar neužbaigtas.

### 2026-09-25 — esamo laiko įvykio laiko zona

- Google ir Outlook laiko įvykio redaktorius rodo įvykio IANA laiko zoną ir leidžia ją pakeisti. Keičiant zoną išlaikomas įvestuose laukuose matomas sieninis laikas, todėl perskaičiuojamas tikras UTC momentas; nekeičiant laukų išsaugomas pradinis momentas ir jo sekundės.
- Bendras laiko zonų modulis nepriklauso nuo serverio ar naršyklės vietinės zonos, tikrina realias IANA reikšmes, atmeta fiksuoto poslinkio identifikatorius ir neegzistuojančią arba dėl vasaros / žiemos laiko pasikartojančią valandą, įskaitant pusvalandžio perėjimus.
- Outlook prieš pakeitimą perskaito pašto dėžutės palaikomas IANA zonas, kanoniškai sulygina lygiaverčius aliasus ir siunčia Graph vietinį `dateTime` su konkrečiu pašto dėžutės grąžintu zonos vardu. Google gauna absoliutų RFC 3339 laiką ir zoną. Nesusijęs redagavimas išsaugo atskiras tiekėjo pradžios bei pabaigos zonas; visos dienos įvykiui zona nesiunčiama.
- Patikra: `git diff --check`, `npm run typecheck`, 233/233 `npm test`, `npm run build` ir 32/32 `npm run test:e2e` scenarijai praėjo.
- Ribos: tikros Google ir Microsoft paskyros nekeistos. Outlook įvykio sena Windows zonos reikšmė, kurios JavaScript neatpažįsta kaip IANA, redaktoriuje saugiai rodoma kaip UTC. Naujo įvykio laiko zonos pasirinkimas ir režimų konvertavimas lieka kitiems žingsniams; D2 punktas dar neužbaigtas.

### 2026-09-25 — naujo laiko įvykio laiko zona

- Naujo Google arba Outlook laiko įvykio formoje galima pasirinkti IANA zoną. Pakeitus zoną įvestas sieninis pradžios laikas lieka toks pats, o klientas perskaičiuoja absoliutų momentą; trukmė pridedama prie momento. Outlook kūrimas atmetamas prieš tiekėjo POST, jei galinis Graph sieninis laikas dėl DST atsukimo būtų dviprasmis.
- Google POST gauna RFC 3339 pradžią bei pabaigą kartu su pasirinkta zona. Outlook prieš kūrimą patikrina pašto dėžutės palaikomas IANA zonas, suderina lygiaverčius aliasus ir Graph siunčia vietinį `dateTime` su pašto dėžutės grąžintu zonos vardu. Paskyros pasikeitimas tarp patikros ir kūrimo atmetamas.
- Serveris atmeta fiksuoto poslinkio, nepalaikomą ar visos dienos įvykiui pateiktą zoną. Senesni klientai be zonos lieka suderinami ir kuria UTC įvykį; Microsoft To Do Outlook blokų UTC sutartis nepakeista.
- Patikra: `git diff --check`, `npm run typecheck`, 238/238 `npm test`, `npm run build` ir 33/33 `npm run test:e2e` scenarijai praėjo.
- Ribos: tikros Google ir Microsoft paskyros nekeistos. Kūrimas vis dar vyksta pirminiame kalendoriuje, o neaiškios sėkmingo POST baigties nedubliuojantis pakartojimas ir konvertavimas tarp laiko bei visos dienos režimų lieka kitiems žingsniams.

### 2026-09-25 — laiko ir visos dienos įvykio konvertavimas

- Nepasikartojančio Google arba Outlook įvykio redaktorius leidžia pakeisti režimą abiem kryptimis. Laiko įvykio vietinės kalendorinės dienos tampa visos dienos intervalu su išskirtine tiekėjo pabaiga; tiksli pabaiga vidurnaktį neprideda tuščios papildomos dienos.
- Visos dienos įvykis, kuris neturi ankstesnės laiko zonos ar valandos, saugiai pradeda konvertavimą nuo 09:00–10:00 UTC; prieš išsaugojimą galima pasirinkti kitą IANA zoną ir laiką. Google gauna `date` arba RFC 3339 laukus, o Outlook — aiškų `isAllDay` bei jo režimui tinkamą `dateTime` ir zoną.
- Konvertavimas išsaugo aprašymą, vietą, susitikimo nuorodą, priminimus ir kitus nesiunčiamus tiekėjo metaduomenis. Laiko pasikeitimui su dalyviais reikia patvirtinimo, paskyra ir versija tikrinamos kaip anksčiau, o pasikartojančio egzemplioriaus režimas paliktas D4 serijos taisyklėms.
- Patikra: `git diff --check`, `npm run typecheck`, 244/244 `npm test`, `npm run build` ir 34/34 `npm run test:e2e` scenarijai praėjo.
- Ribos: tikros Google ir Microsoft paskyros nekeistos. Visos dienos → laiko konvertavimas sąmoningai nespėja ankstesnės valandos ar zonos, nes tiekėjas jų visos dienos įvykyje neturi.

### 2026-09-25 — kūrimas pasirinktame kalendoriuje

- Naujo įvykio forma atskirai pasirenka Google arba Outlook paskyrą ir vieną nustatymuose įjungtą rašomą kalendorių. Tik skaitymo kalendoriai nesiūlomi, o aiškiai tuščias pasirinkimas nebegrįžta į pagrindinį kalendorių ir išjungia kūrimą su paaiškinimu.
- Google ir Microsoft POST dabar reikalauja `calendarId`. Prieš rašymą serveris iš tiekėjo iš naujo perskaito pasirinktą kalendorių, patvirtina tikslų ID, rašymo teisę, paskyros ID ir OAuth ryšio kartą, tada kuria įvykį konkretaus kalendoriaus endpoint. Redagavimas bei šalinimas ir toliau naudoja tą pačią pilną įvykio tapatybę.
- Google kalendorių pasirinkimas, kaip ir Microsoft, saugomas kartu su paskyros ID. Neįrašyta atranka reiškia tik tiekėjo numatytąjį kalendorių, o aiškiai įjungti papildomi kalendoriai vienodai naudojami skaitymui ir kūrimui. Katalogo nepermatoma paskyros bei OAuth ryšio versija privaloma atrankos PATCH ir įvykio POST, todėl sena forma negali įrašyti į naujai prijungtą paskyrą. Vėlyvas paskyros būsenos atsakymas naujo įvykio lange iš naujo įkelia katalogą ir nepalieka klaidingai išjungto pasirinkimo.
- Prieš įvykių skaitymą išsaugota atranka sankirtinama su gyvu tiekėjo katalogu. Pašalintas arba nebeprieinamas kalendorius nebegali numušti viso tiekėjo įvykių sąrašo, o nustatymų sąsaja jo nebeišsaugo paslėptame pasirinkime. Senasis Outlook `primary` aliasas išlieka suderinamas su dabartiniu nepermatomu numatytojo kalendoriaus ID.
- Ankstesnis Google pasirinkimo masyvo formatas pirmo sėkmingo katalogo skaitymo metu perkeliamas į paskyros ID turintį formatą. Išsaugomas ir senas aiškiai tuščias pasirinkimas, todėl atnaujinimas savaime neįjungia pagrindinio kalendoriaus. Microsoft `primary` aliasas leidžia kurti į dabartinį gyvai patikrintą nepermatomą numatytąjį ID.
- Katalogo metu užfiksuota OAuth ryšio karta perduodama į patį įvykių sąrašo adapterį ir tikrinama dar kartą po skaitymo. Paskyrai pasikeitus tarp katalogo ir įvykių užklausos, senas pasirinkimas negali būti pritaikytas naujam prieigos raktui.
- Patikra: `git diff --check`, `npm run typecheck`, 254/254 `npm test`, `npm run build` ir 35/35 `npm run test:e2e` scenarijai praėjo. Imitaciniai tiekėjai patvirtina kūrimą ne pagrindiniame kalendoriuje, tuščią pasirinkimą, skaitymo teisės atmetimą, paskyros susiejimą, ankstesnių pasirinkimų migraciją, ryšio pasikeitimo atmetimą ir pašalinto įjungto kalendoriaus saugų išvalymą.
- Ribos: tikros Google ir Microsoft paskyros šiame žingsnyje nekeistos. Gyvų paskyrų priėmimo scenarijai lieka E etapo užduotyje, o neaiškios sėkmingo POST baigties nedubliuojantis pakartojimas lieka D etapo atskiram žingsniui.

### 2026-09-25 — nedubliuojantis kūrimas ir pasikartojančios serijos

- Naujo įvykio forma visą savo gyvavimo laiką išlaiko stabilų operacijos ID. Serveris patvarioje DB operacijų lentelėje jį susieja su tiekėju, paskyra, OAuth ryšio karta, kalendoriumi ir kanoniniu payload; pakeistas payload tuo pačiu ID atmetamas prieš kitą provider POST. Google gauna leistiną deterministinį `event.id`, privatų operacijos žymeklį ir stabilų Meet `requestId`; po neaiškaus POST atsakymo esamas įvykis saugiai atkuriamas tiksliu GET. Microsoft gauna tai pačiai operacijai nekintamą Graph `transactionId`.
- Bendras griežtas kartojimo modelis palaiko kasdienę, savaitinę, absoliučią mėnesinę ir absoliučią metinę taisyklę, intervalą, savaitės dienas ir pabaigą be ribos, pasirinkta diena arba įvykių skaičiumi. Jis verčiamas į Google RRULE arba Microsoft `patternedRecurrence`, įskaitant serijos laiko zoną.
- Kalendoriaus egzempliorius ir toliau redaguojamas savo ID bei versija. Visos serijos taisyklė pirmiau perskaitoma pagal `recurringEventId` arba `seriesMasterId`, tada keičiama tik su master ETag / versija. Nepalaikomos tiekėjo taisyklės lieka tik skaitymui ir nėra supaprastinamos tyliai.
- „Šį ir būsimus“ neįjungta: abu tiekėjai tam neturi vienos saugios operacijos, o dviejų serijų skaidymas be atskiros atkuriamos eigos gali prarasti exceptions, cancellations ir dalyvių atsakymus.
- Patikra: `git diff --check`, `npm run typecheck`, 264/264 `npm test`, `npm run build` ir 37/37 `npm run test:e2e` scenarijai praėjo. Imitacinė API patvirtina identišką pakartojimą, prarasto atsakymo atkūrimą, pakeisto payload atmetimą, provider formos Graph recurrence atsakymą, abiejų tiekėjų recurrence payload, master versijos konfliktą ir vieno egzemplioriaus atskyrimą nuo visos serijos.
- Riba: tikros Google ir Microsoft paskyros šiame žingsnyje nekeistos; gyva Graph priėmimo patikra lieka paskutinis D5 punktas.

### 2026-09-25 — vartotojo testavimo klaidų taisymai (9 pataisymai)

- **Įvykio ištrynimas**: `ExistingEventEditor` neturėjo ištrynimo mygtuko. Pridėtas „Ištrinti įvykį" mygtukas su `window.confirm` ir DELETE užklausa į `/api/microsoft/events` arba `/api/google/events`. Serveris reikalavo `version` parametro — pradinė implementacija jo nesiuntė ir gavo 400; pataisa pridėta po galutinio review.
- **HTML aprašyme (Outlook)**: Microsoft Graph `body.content` grąžina pilną HTML dokumentą (`<html><head>…`). Pridėta `stripHtml()` funkcija `lib/calendar-events.ts`: pašalina dokumento metaduomenis, stilius, scenarijus ir likusias HTML žymes, išlaiko prasmingas eilučių pertraukas bei sąrašus ir dekodina vardinius bei skaitinius HTML entitetus.
- **Tamsi tema — mygtukai**: `.ghostButton` ir `.calendarToolbar button` turėjo `background:#fff` be dark mode varianto. Pridėtos 23 `[data-theme="dark"]` perrašos `app/globals.css`: naudojamos esamų CSS kintamieji `--surface`, `--panel`, `--ink`.
- **Mėnesio rodinio klikabilumas**: `Month` komponentas rodė įvykius ir užduotis kaip plain string'us — nebuvo galimybės jų atidaryti. Pertvarkyta į tipizuotą `Array<{type:"event"|"task"; value:…}>` masyvą; kiekvienas elementas gauna `onClick` su `e.stopPropagation()` ir `cursor:pointer`. Naudojami esami `EventActions` ir `TaskActions` kontekstai — be prop drilling.
- **Drag-drop vizualinis indikatorius**: Tempiant `TaskBlock` nebuvo jokio vizualinio požymio kur užduotis bus padėta. Pridėta `setDragHint` į `TaskActions` kontekstą; `TaskBlock.onPointerMove` fiksuoja tikslinę dieną ir laiko poziciją; `TimeGrid` atitinkamame `dayLane` rodo `<div className="dropHint">` — violetinis gestinis rėmelis (`pointer-events:none`).
- **Cross-day drag mirgėjimas**: CSS `transform:translate` perkeldavo `TaskBlock` vizualiai į kitą dienų stulpelį, bet DOM elementas likdavo originaliame — matėsi du blokiukai. Pridėta `crossedDay` boolean būsena: kai pointeris pereina į kitą `dayLane`, originalo `opacity` tampa 0; `dropHint` iš ankstesnio taisymo rodo tikslą.
- **Google Tasks datos rodymas**: Google Tasks užduotys su `due_date` (tik diena, be laiko) nebuvo matomos kalendoriuje — tik neplanuotų sąraše. Dabar rodomos `allDayCell` juostoje (dienos/savaitės/darbo savaitės rodiniuose) ir mėnesio rodinyje tą dieną. Stilizuotos kaip `.allDayDueTask` (violetinė, su dark mode variante), klikabelios atidaro užduoties redagavimą.
- **Pasikartojimų sekcijos matomumas**: `CalendarRecurrenceFields` komponentas jau egzistavo naujo įvykio formoje, bet neturėjo vizualinio pavadinimo — vartotojai nematydavo „Kartoti įvykį" perjungiklio. Pridėtas `<span className="fieldLabel recurrenceLabel">Pasikartojimas</span>` virš perjungiklio. Esamo nepasikartojanio įvykio pavertimas pasikartojantiems — praleista, nes `update()` ir `updateSeries()` neturi tokio kelio (atidėta).
- **Review pataisos**: neplanuotos užduoties tempimas dabar taip pat rodo į tikrą 15 min. žingsnį suapvalintą tikslinį laukelį; suplanuotos užduoties indikatorius naudoja tą pačią skaičiavimo funkciją ir telpa dienos ribose. Tamsioje temoje atsarginių kopijų mygtukai išlieka įskaitomi, o pagrindinis veiksmo mygtukas nepraranda violetinio fono. Outlook HTML aprašymas išlaiko eilučių pertraukas ir sąrašus, pašalina `head`, `style` bei `script` turinį ir saugiai dekodina skaitinius entitetus.
- **Patikra**: `git diff --check`, `npm run typecheck`, 265/265 `npm test`, `npm run build` ir 43/43 `npm run test:e2e` scenarijai praėjo. Papildomas 5/5 kalendoriaus regresijų rinkinys patvirtina Google ir Outlook trynimą su versija, išorėje pašalinto Google įvykio dingimą po atnaujinimo, skirtingas tiekėjų spalvas, mėnesio rodinio atidarymą, Google dienos užduotį, tempimo indikatorių ir tamsios temos kontrastą.

### 2026-09-25 — pasibaigusios kalendoriaus sesijos rodymas

- Gyvas Google kalendorių katalogas grąžino `401`, tačiau nustatymų kalendorių pasirinkimo komponentas klaidos objektą priėmė kaip sėkmingą sąrašą ir nulūžo skaitydamas neegzistuojantį `items`. Komponentas dabar tikrina HTTP būseną bei atsakymo formą ir vietoje runtime klaidos rodo tiekėjo sesijos pranešimą; neprijungto tiekėjo krovimo būsena neberodoma.
- Regresinis naršyklės scenarijus atidaro nustatymus su Google `401`, patvirtina matomą pakartotinio prisijungimo pranešimą ir tikrina, kad nebūtų `pageerror`.
- Patikra: `git diff --check`, `npm run typecheck`, 264/264 `npm test`, `npm run build` ir 38/38 `npm run test:e2e` scenarijai praėjo.
