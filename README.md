# Dienos planas

Nemokama, vieno naudotojo, savarankiškai talpinama „Morgen“ alternatyva. Vienoje darbo erdvėje sujungiami „Outlook Calendar“, „Google Calendar“, „Microsoft To Do“, „Google Tasks“ ir vietinės užduotys.

## Ką jau moka

Aktualus auditas, funkcijų spragos ir įgyvendinimo etapai: [produkto planas](PRODUCT_PLAN.md). Tai dar kuriamas MVP; vien sėkmingas build nepatvirtina gyvų integracijų patikimumo.

- rodyti „Outlook“ ir „Google Calendar“ įvykius vienoje savaitėje;
- perkelti savo organizuojamus nepasikartojančius Google / Outlook įvykius tarp dienų, keisti trukmę pele ar klaviatūra bei redaguoti pavadinimą ir laiką;
- prieš susitikimo su dalyviais pakeitimą paprašyti patvirtinimo; rodyti tik skaitymui skirtų įvykių paaiškinimą ir nuorodą į originalą;
- visos dienos įvykius rodyti atskiroje kalendoriaus juostoje, įvykių paiešką taikyti dienos / savaitės / mėnesio kalendoriui;
- naudoti visas 24 valandas, persidengiančius įvykius ir užduotis rodyti greta, naktinius blokus skaidyti per dienas ir matyti dabartinio laiko liniją;
- kurti tikrus „Outlook“ įvykius, siųsti kvietimus ir pridėti „Teams“ nuorodą;
- pasirinkti Google Tasks arba Microsoft To Do sąrašą, skaityti visus puslapius, kurti, redaguoti, užbaigti, atkurti ir ištrinti užduotis;
- pasirinktinai kurti „Google Calendar“ susitikimus su „Google Meet“;
- planuoti vietines, „Microsoft To Do“ ir „Google Tasks“ užduotis bendrame kalendoriuje; darbo laikas saugomas vietoje, atskirai nuo tiekėjo datos;
- pasirinktinai susieti užduotį su Outlook `Show as: Free` bloku, jį atnaujinti perplanuojant ir pašalinti užbaigus užduotį šioje programėlėje;
- tempti neplanuotas užduotis į dienos / savaitės kalendorių, perkelti suplanuotas tarp dienų ir keisti trukmę tempiant apatinį kraštą;
- redaguoti užduoties pavadinimą, pastabas, terminą, prioritetą ir planą; trukmę keisti ir klaviatūros rodyklėmis;
- rodyti vietines užduotis ir prijungus abi išorines paskyras; pasirinkti naujos užduoties šaltinį bei sąrašą;
- naudoti dienos, darbo savaitės, savaitės ir mėnesio rodinius;
- suskleisti dešinę užduočių juostą, pasirinkti šviesią / tamsią / įrenginio temą ir išsaugoti pasirinkimus naršyklėje;
- telefone iškart matyti dienos kalendorių, perjungti užduotis / fokusą / nustatymus apatine navigacija ir planuoti užduotį redaktoriumi;
- atverti paiešką su ⌘ / Ctrl K, išvalyti ją su Escape ir redaguoti užduotį paspaudus jos pavadinimą darbų lentoje;
- valdyti projektus, prioritetus, trukmę, terminus, žymas ir pastabas;
- naudoti Kanban užduočių lentą bei 25 minučių fokusavimo laikmatį;
- matyti dienos suplanuoto darbo krūvį ir ieškoti užduočių;
- veikti viename „Docker“ konteineryje;
- užšifruoti „Google“ ir „Microsoft“ atnaujinimo žetonus prieš išsaugant SQLite bazėje;
- aiškiai rodyti abiejų integracijų būseną ir saugiai pašalinti vietoje saugomus OAuth žetonus mygtuku „Atjungti“;
- apsaugoti duomenis keičiančias API užklausas tos pačios kilmės patikra ir OAuth callback su vienkartine `state` reikšme.

## Paleidimas

1. „Microsoft Entra admin center“ užregistruok aplikaciją ir pridėk Web redirect URI `http://localhost:3000/api/microsoft/callback`.
2. Pridėk delegated leidimus: `User.Read`, `Calendars.ReadWrite`, `Tasks.ReadWrite` ir `offline_access`; sukurk Client Secret.
3. Nukopijuok `.env.example` į `.env`, įrašyk Microsoft Client ID, Client Secret ir 64 simbolių šifravimo raktą (`openssl rand -hex 32`).
4. Jei nori ir Google, „Google Cloud Console“ tame pačiame projekte įjunk Calendar API ir Tasks API, sukurk Web OAuth klientą ir redirect URI `http://localhost:3000/api/google/callback`.
5. Paleisk `docker compose up --build` ir atidaryk `http://localhost:3000`.

`APP_ORIGIN`, `GOOGLE_REDIRECT_URI` ir `MICROSOFT_REDIRECT_URI` turi naudoti tą pačią kilmę bei tikslius callback kelius. HTTP leidžiamas tik `localhost` / `127.0.0.1`; viešam adresui naudok HTTPS. Programa visur naudoja 3000 prievadą, nebent tą pačią alternatyvą nuosekliai pakeiti visuose trijuose kintamuosiuose ir Docker portų susiejime.

## Patikrinimas

Vietiniam paleidimui reikia Node.js 24 ir `npm ci`. `.env.example` numatytasis `DATABASE_PATH=./data/planner.db` tinka ir vietoje, ir Docker. `npm start` įkelia projekto šaknies konfigūraciją, paruošia standalone statinius resursus ir išlaiko DB kelią nepriklausomą nuo build katalogo. Pakeitus `.env`, serverį paleisk iš naujo.

```bash
npm test
npm run typecheck
npm run build
npm run test:smoke
npm run test:calendars
npm run test:tasks
npm run test:e2e
npm start
```

`npm test` apima automatinius regresinius testus, įskaitant tikrą SQLite migraciją ir plano išlikimą, imitacines Google / Microsoft paslaugas, „Free“ bloko ryšį / pakartojimą, įvykių API maršrutus, versijų konfliktus, dalyvių patvirtinimą, abiejų tiekėjų OAuth lenktynes, kalendoriaus persidengimus, vidurnaktį, Vilniaus vasaros / žiemos laiko ribas bei saugų temos parinkimą ir nepasiekiamą naršyklės saugyklą. Testai nenaudoja tikrų paskyrų ar raktų.

`test:smoke` paleidžia tik lokalią produkcinę kopiją su laikina DB ir neprijungtomis integracijomis. Tikrina CSS / JS / favicon, OAuth klaidas, CSRF, atjungimo API bei užduoties sukūrimą, planavimą, perkėlimą, trukmę, išplanavimą ir užbaigimą. Tikrina, kad terminas nekinta ir pasenusi plano versija atmetama. Užbaigęs pašalina savo testinę DB.

`test:calendars` tikrina produkcinius kalendorių HTTP maršrutus su atskira laikina DB ir sintetiniu Google / Microsoft pakaitalu. Išorinės užklausos nepatenka pas tikrus tiekėjus. `node tests/calendar-smoke.mjs --preview` po tų patikrų palieka testinę programėlę `http://127.0.0.1:3101` naršyklės bandymams iki Ctrl+C. Šis pakaitalas įjungiamas tik atskiru Node testiniu paleidimu, ne programėlės nustatymu. Tai nėra tikrų integracijų veikimo įrodymas.

`test:tasks` tikrina produkcinius vietinių, Google Tasks ir Microsoft To Do užduočių maršrutus: kūrimą, planavimą, perkėlimą, trukmę, užbaigimą, atkūrimą ir ištrynimą. Naudojama laikina DB ir tik sintetiniai tiekėjai; išorinis tinklas užblokuotas. `node tests/tasks-smoke.mjs --preview` palieka tą kopiją `http://127.0.0.1:3102` naršyklės patikrai iki Ctrl+C.

`test:e2e` po produkcinio build parenka laisvą vietinį prievadą, sukuria unikalią laikiną SQLite bazę ir paleidžia atskirą produkcinį serverį. Testai niekada neperima jau veikiančio `:3000` serverio. Baigus ar testams nepraėjus laikinas katalogas su DB pašalinamas. Rinkinys tikrina vietinių užduočių pilną CRUD ir išlikimą, nesėkmingo kūrimo rollback, matomus tinklo klaidų pranešimus, lėtą atsakymą, tikrą vienos dienos mobilų tinklelį, prieinamus formų laukus ir konkrečią 2026-03-29 Vilniaus 23 valandų DST dieną. Tiesioginis `playwright test` sąmoningai atmetamas; naudok npm komandą, kad testai negalėtų paliesti naudotojo DB.

## Atsarginės kopijos ir atkūrimas

Atverk **Nustatymai → Duomenys**. **Pilna kopija** išsaugo visas vietines užduotis, planus, tiekėjų talpyklą, nustatymus ir užšifruotus OAuth atnaujinimo žetonus, todėl failą laikyk kaip slaptažodį. Perkėlus pilną kopiją į kitą diegimą žetonams reikia to paties `TOKEN_ENCRYPTION_KEY`; kitu atveju atjunk ir iš naujo prijunk paskyras. **Eksportuoti (be žetonų)** sukuria perkėlimui tinkamą SQLite failą be Google ir Microsoft atnaujinimo žetonų.

**Atkurti iš kopijos** priima iki 100 MB SQLite failą. Prieš pakeisdama duomenis programa patikrina failo vientisumą, lenteles ir stulpelius, tada vienoje transakcijoje pakeičia visų programos lentelių duomenis. Klaidinga ar naujesnės nepalaikomos schemos kopija esamų duomenų nekeičia. Po sėkmingo atkūrimo puslapis persikrauna. Prieš programos atnaujinimą parsisiųsk pilną kopiją.

## Google Tasks leidimas

Google OAuth sutikimo ekrane pridėk `https://www.googleapis.com/auth/tasks` prie naudojamo Calendar leidimo. Jei projektas yra testavimo režimu, pridėk savo paskyrą prie testinių naudotojų. Tasks API įjungimas projekte ir naudotojo suteiktas Tasks leidimas yra du atskiri reikalavimai.

Anksčiau prijungtai Google paskyrai atverk **Nustatymai → Suteikti Tasks leidimą**. Prisijunk prie tos pačios paskyros ir pažymėk užduočių leidimą. Programa prašo pakartotinio sutikimo (`prompt=consent`) bei ankstesnių leidimų įtraukimo (`include_granted_scopes=true`) ir tikrina iš tikrųjų grąžintus leidimus. Atmetus papildomą sutikimą, ankstesnis ryšys lieka išsaugotas; suteikus tik Calendar leidimą, Google užduotys nerodomos kaip prijungtos. Jei Google negrąžina naujo atnaujinimo žetono, turimas panaudojamas tik patikrinus, kad tai ta pati paskyra.

Nustatymai atskiria trūkstamą leidimą nuo išjungtos Tasks API. Įjungęs API Google Cloud projekte paspausk **Atnaujinti duomenis** — pakartotinis sutikimas tam nereikalingas. Leidimų atšaukimas ar nebegaliojantis žetonas reikalauja prisijungti iš naujo. Gyvi OAuth scenarijai dar turi būti patikrinti su tikra paskyra. [Oficiali OAuth eiga](https://developers.google.com/identity/protocols/oauth2/web-server).

## Sąsaja ir pasirinkimai

Nustatymuose pasirink šviesią, tamsią arba įrenginio temą; ten pat yra paskyrų prijungimas / atjungimas ir papildomo Outlook „Free“ bloko parinktis. Užduočių juostos mygtukas viršuje atlaisvina vietą kalendoriui. Temos ir darbalaukio juostos pasirinkimai saugomi tik toje naršyklėje. Jei naršyklės saugykla užblokuota, pasirinkimas veikia iki perkrovimo.

Telefone pagal nutylėjimą atidaroma diena. Juosta atidaroma viršutiniu mygtuku; planą redaguok paspaudęs užduotį. Tempimas iš užduočių sąrašo palaikomas pele / rašikliu; jutiklinis tempimas iš sąrašo sąmoningai neįjungtas, kad netrukdytų slinkti. Pilnas jutiklinio kalendoriaus tempimo patikrinimas lieka ateities darbams.

Kalendoriaus data parenkama naršyklėje, o ne įrašoma produkcinio surinkimo metu. Tai apsaugo nuo pasenusios datos ir React hidratavimo neatitikimo kitą dieną ar kitoje laiko zonoje. ⌘ / Ctrl K atveria paiešką; atidarytame redaktoriuje šis trumpinys fokuso neperima. Escape uždaro dialogą arba išvalo aktyvią paiešką.

## Kalendoriaus laiko modelis ir redagavimo ribos

Dienos / savaitės tinklelis apima 00:00–24:00, planavimas apvalinamas kas 15 min. (paskutinė pradžia 23:45). Pradžioje rodoma sritis nuo maždaug 07:00; iki nakties nuslink žemyn. Vienu metu vykstantys įvykiai ir užduotys dalijasi stulpeliais. Per vidurnaktį trunkantis darbas rodomas kiekvieną paliestą dieną, ir mėnesio rodinyje. Trumpuose blokuose prioritetas teikiamas pavadinimui; tikslų laiką matysi redaktoriuje.

Kelių dienų blokai ir laikrodžio persukimo dienų blokai šiame etape keičiami redaktoriumi, ne tempiant. 23 / 25 val. dienos pažymimos antraštėje; neegzistuojantis arba pasikartojantis Vilniaus valandos laikas atmetamas planuojant tinklelyje. Kartojamos valandos atskiros juostos ir jos egzemplioriaus pasirinkimas redaktoriuje dar neįgyvendinti. Tai nėra pilnas visų laiko zonų / DST scenarijų palaikymas.

Šiame etape keičiami tik tavo organizuojamų nepasikartojančių įvykių pavadinimas, pradžia ir pabaiga numatytajame kalendoriuje. Tempimas ir krašto tempimas veikia dienos / savaitės rodiniuose. Dalyvių, aprašymo, Teams / Meet nuorodos ir priminimų masyvai neperrašomi. Susitikimui su dalyviais prieš išsaugojimą būtinas atskiras patvirtinimas. Pasikartojančius, visos dienos, specialių tipų ir ne savo organizuojamus įvykius redaguok per nuorodą „Atverti originalą“.

Prieš PATCH serveris perskaito dabartinį įvykį, patikrina paskyros ryšį, teises ir versiją. Vieno įvykio pakeitimai vykdomi nuosekliai; Google siunčiamas `If-Match`, Outlook — kai atsakyme yra `@odata.etag`. Pasenusi versija ar tiekėjo 412 parodomi kaip 409 konfliktas; tyliai perrašyti naujesnių duomenų nebandoma. Outlook sąlyginio atnaujinimo elgsena tikrame Graph dar turi būti patvirtinta, todėl pilna išorinių lenktynių apsauga nelaikoma baigta.

API pagrindas: [Google PATCH](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [Google versijų tikrinimas](https://developers.google.com/workspace/calendar/api/guides/version-resources), [Microsoft įvykio atnaujinimas](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0).

## Užduoties terminas ir planas

Vietinis / Microsoft terminas (`due_at`), Google užduoties diena (`due_date`) ir suplanuoto darbo pradžia (`scheduled_at`) yra nepriklausomi. Google Tasks API grąžina tik dieną; jos `due` laukas nėra tikslus darbo laikas ir nėra pristatomas kaip termino laikas. Google darbo pradžia, trukmė ir prioritetas saugomi tik čia. Projektai ir žymos visiems šaltiniams taip pat vietiniai. [Google užduoties modelis](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks). Užduotis su terminu iš pradžių lieka neplanuota. Tempimas ir trukmės keitimas saugomi serverio SQLite lentelėje `task_plans`; Microsoft užduoties terminas keičiamas tik aiškiai redaguojant termino lauką. Nuotolinės užduoties ryšys apima tiekėją, paskyrą, sąrašą ir ID.

Spustelėk užduotį redagavimui. Apatinis kalendoriaus bloko kraštas keičia trukmę po 15 minučių; sufokusavus jį veikia ↑ / ↓. Planavimą galima panaikinti redaktoriuje arba grąžinti bloką į neplanuotų užduočių sritį. Užduotis ir jos terminas išlieka.

Papildomas Outlook blokas kuriamas tik pasirinkus. Programėlė saugo jo ID ir kūrimo `transactionId`, todėl perplanavimas atnaujina susietą bloką. Blokas visada `free`, be dalyvių ir priminimo. Sutrikus ryšiui vietinis planas lieka išsaugotas, o redaktorius rodo pakartojimo klaidą. Pakartojimui turi būti prijungta ta pati paskyra. Šaltinyje užbaigus Google ar Microsoft užduotį, duomenų atnaujinimas panaikina vietinį planą; atkūrus užduotį senas laikas negrąžinamas. Jei ji turi Outlook bloką, redaktorius pasiūlo išsaugoti ir pakartoti jo pašalinimą. Skaitymas pats išorinių įvykių nekeičia. Šaltinyje ištrintų užduočių susietų Outlook blokų automatinis sutvarkymas lieka neįgyvendintas.

Pirmo paleidimo migracija senų vietinių užduočių dviprasmišką `due_at` išsaugo ir kaip terminą, ir kaip ankstesnį planą, pažymėdama jį redaktoriuje. Patikrink abi reikšmes. Ankstesnių Microsoft terminų atkurti automatiškai negalima, nes jų pradinės reikšmės MVP nesaugojo.

Tiekėjų duomenys atnaujinami mygtuku **Atnaujinti duomenis** arba perkrovus puslapį. Nepavykus užklausai paskutiniai išsaugoti to sąrašo duomenys pažymimi kaip pasenę; vietinis planavimas veikia, kai ta pati paskyra tebėra prijungta ir turi reikiamą leidimą. Pakeitus paskyrą ankstesnių užduočių duomenys nerodomi. Google pavaldžios užduotys matomos ir planuojamos atskirai, jų hierarchija keičiama Google Tasks. Priskirtos Docs / Chat užduotys šiame etape neįtraukiamos. Google nuoroda atveria tiekėjo grąžintą užduotį arba Tasks programą; Microsoft nuoroda atveria To Do programą.

## Microsoft To Do priminimai

Microsoft užduoties redaktoriaus apačioje yra atskiras priminimo valdymas: įjungimas, data ir laikas, išjungimas. Spausk **Išsaugoti priminimą**. Priminimo pakeitimas neįrašo neišsaugotų pagrindinio redaktoriaus laukų ir nekeičia termino, vietinio plano, kartojimo ar pasirenkamo Outlook bloko. Pranešimus pristato Microsoft; programėlė nesiunčia naršyklės pranešimų. Naudojamas jau suteiktas `Tasks.ReadWrite` leidimas. [Microsoft užduoties atnaujinimo API](https://learn.microsoft.com/en-us/graph/api/todotask-update?view=graph-rest-1.0).

Įvedamas šalia lauko nurodytos naršyklės laiko zonos laikas; serveriui perduodamas tikslus UTC momentas. Neegzistuojanti arba pasikartojanti DST valanda atmetama. Jei Microsoft grąžina laiką be UTC poslinkio su šiuo metu nekonvertuojama zona, rodomas originalus laikas ir zona; norint jį pakeisti reikia įvesti naują laiką. Išjungimas išsaugo ankstesnę tiekėjo datos reikšmę, bet nustato `isReminderOn=false`.

Serveris prieš pakeitimą perskaito dabartinę užduotį ir tikrina paskyrą bei versiją. Pasikeitus duomenims ar nutrūkus ryšiui, prieš kartodamas spausk **Atnaujinti** priminimo skiltyje. Automatinio pakartojimo nėra. Užbaigtų ir specialių tik skaitymui skirtų sąrašų užduočių priminimo keitimas išjungtas. Patikrinta sintetinėmis API; tikrų Microsoft pranešimų pristatymas ir Graph `If-Match` elgsena lieka gyvų paskyrų patikrai. Be tiekėjo sąlyginio pakeitimo garantijos išlieka išorinio pakeitimo tarp GET ir PATCH galimybė.

## Užduočių sąrašai

Užduočių juostoje arba nustatymuose pasirink **Tvarkyti sąrašus**. Galima sukurti Google Tasks arba Microsoft To Do sąrašą ir pervadinti valdomą sąrašą. Naują sąrašą pasirinkus kaip paskirties vietą, kitos užduotys kuriamos jame. Vietinės užduotys laikomos viename vietiniame sąraše.

Prieš šalinimą rodoma dabartinė užduočių suma, reikia tiksliai įvesti sąrašo pavadinimą. Šalinamas sąrašas su jo užduotimis ir vietiniais planais; pervadinimas planus išsaugo. Serveris prieš pakeitimą iš naujo perskaito sąrašą, prieš šalinimą — ir visus užduočių puslapius. Pasikeitus duomenims reikia naujos peržiūros. Jei užklausos baigtis neaiški, pirmiausia atnaujink sąrašus ir patikrink rezultatą prieš kartodamas kūrimą.

Įtaisytų ir ne savo Microsoft sąrašų administravimas išjungtas. Google sąrašai su priskirtomis Docs / Chat užduotimis netrinami, nes tiekėjas pašalintų ir originalus. Sąrašai su esamais ar nebaigtais kurti Outlook blokais taip pat netrinami: pirmiausia panaikink susiejimus užduočių redaktoriuose. Jei užduotis jau ištrinta šaltinyje ir redaktorius nebeprieinamas, jos bloko sutvarkymas lieka kitam etapui. [Microsoft sąrašo teisės](https://learn.microsoft.com/en-us/graph/api/resources/todotasklist?view=graph-rest-1.0), [Google sąrašo šalinimas](https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/delete).

Patikra atliekama su izoliuotomis imitacinėmis API. Tai negarantuoja atominio šalinimo, jei kitoje programoje sąrašas pasikeičia tarp paskutinio perskaitymo ir tiekėjo DELETE; gyvų paskyrų ir Google sąrašo `If-Match` elgsena dar nepatvirtinta. Jei tiekėjas pašalina sąrašą, bet atsakymas prarandamas, vietiniai planai išsaugomi, kol rezultatas nėra patvirtintas; našlaičių valymas lieka nebaigtas.

## Artimiausias funkcijų etapas

- platesnis Google / Outlook įvykių redaktorius ir pasikartojimų valdymas;
- Google hierarchijos ir eilės keitimas, perkėlimas tarp sąrašų, To Do kartojimas / žingsniai;
- kelių dienų tempimas, automatinis slinkimas tempiant ir pilnas DST laiko pasirinkimas;
- išsamesnis klaviatūros ir jutiklinis valdymas;
- prieigos žetonų galiojimo talpykla bei tikrų abiejų paskyrų patikra;
- kelių kalendorių pasirinkimas ir spalvos;
- pasikartojantys įvykiai;

Ši versija skirta asmeniniam naudojimui ribotos prieigos aplinkoje. API jau tikrina keičiančių užklausų kilmę (CSRF), tačiau viešam diegimui dar reikia pačios programėlės naudotojo prisijungimo ir HTTPS. Integracijos prijungimas nėra programėlės prieigos apsauga.
