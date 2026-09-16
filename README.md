# Dienos planas

Nemokama, vieno naudotojo, savarankiškai talpinama „Morgen“ alternatyva. Pagrindinė integracija yra „Outlook Calendar“ + „Microsoft To Do“, o „Google Calendar“ galima prijungti papildomai.

## Ką jau moka

Aktualus auditas, funkcijų spragos ir įgyvendinimo etapai: [produkto planas](PRODUCT_PLAN.md). Tai dar kuriamas MVP; vien sėkmingas build nepatvirtina gyvų integracijų patikimumo.

- rodyti „Outlook“ ir „Google Calendar“ įvykius vienoje savaitėje;
- perkelti savo organizuojamus nepasikartojančius Google / Outlook įvykius tarp dienų, keisti trukmę pele ar klaviatūra bei redaguoti pavadinimą ir laiką;
- prieš susitikimo su dalyviais pakeitimą paprašyti patvirtinimo; rodyti tik skaitymui skirtų įvykių paaiškinimą ir nuorodą į originalą;
- visos dienos įvykius rodyti atskiroje kalendoriaus juostoje, įvykių paiešką taikyti dienos / savaitės / mėnesio kalendoriui;
- naudoti visas 24 valandas, persidengiančius įvykius ir užduotis rodyti greta, naktinius blokus skaidyti per dienas ir matyti dabartinio laiko liniją;
- kurti tikrus „Outlook“ įvykius, siųsti kvietimus ir pridėti „Teams“ nuorodą;
- skaityti, kurti bei užbaigti „Microsoft To Do“ užduotis;
- pasirinktinai kurti „Google Calendar“ susitikimus su „Google Meet“;
- planuoti vietines ir „Microsoft To Do“ užduotis atskirai nuo termino, nekeičiant Outlook `Free/Busy`;
- pasirinktinai susieti užduotį su Outlook `Show as: Free` bloku, jį atnaujinti perplanuojant ir pašalinti užbaigus užduotį šioje programėlėje;
- tempti neplanuotas užduotis į dienos / savaitės kalendorių, perkelti suplanuotas tarp dienų ir keisti trukmę tempiant apatinį kraštą;
- redaguoti užduoties pavadinimą, pastabas, terminą, prioritetą ir planą; trukmę keisti ir klaviatūros rodyklėmis;
- rodyti vietines užduotis ir prijungus Microsoft; pasirinkti naujos užduoties šaltinį;
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
4. Jei nori ir Google, „Google Cloud Console“ įjunk Calendar API, sukurk Web OAuth klientą ir redirect URI `http://localhost:3000/api/google/callback`.
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
npm start
```

`npm test` turi 53 automatinius testus, įskaitant tikrą SQLite migraciją ir plano išlikimą, imitacines Google / Microsoft paslaugas, „Free“ bloko ryšį / pakartojimą, įvykių API maršrutus, versijų konfliktus, dalyvių patvirtinimą, abiejų tiekėjų OAuth lenktynes, kalendoriaus persidengimus, vidurnaktį, Vilniaus vasaros / žiemos laiko ribas bei saugų temos parinkimą ir nepasiekiamą naršyklės saugyklą. Testai nenaudoja tikrų paskyrų ar raktų.

`test:smoke` paleidžia tik lokalią produkcinę kopiją su laikina DB ir neprijungtomis integracijomis. Tikrina CSS / JS / favicon, OAuth klaidas, CSRF, atjungimo API bei užduoties sukūrimą, planavimą, perkėlimą, trukmę, išplanavimą ir užbaigimą. Tikrina, kad terminas nekinta ir pasenusi plano versija atmetama. Užbaigęs pašalina savo testinę DB.

`test:calendars` tikrina produkcinius kalendorių HTTP maršrutus su atskira laikina DB ir sintetiniu Google / Microsoft pakaitalu. Išorinės užklausos nepatenka pas tikrus tiekėjus. `node tests/calendar-smoke.mjs --preview` po tų patikrų palieka testinę programėlę `http://127.0.0.1:3101` naršyklės bandymams iki Ctrl+C. Šis pakaitalas įjungiamas tik atskiru Node testiniu paleidimu, ne programėlės nustatymu. Tai nėra tikrų integracijų veikimo įrodymas.

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

Terminas (`due_at`) ir suplanuoto darbo pradžia (`scheduled_at`) yra nepriklausomi. Užduotis su terminu iš pradžių lieka neplanuota. Tempimas ir trukmės keitimas saugomi serverio SQLite lentelėje `task_plans`; Microsoft užduoties terminas keičiamas tik aiškiai redaguojant termino lauką. Nuotolinės užduoties ryšys apima tiekėją, paskyrą, sąrašą ir ID.

Spustelėk užduotį redagavimui. Apatinis kalendoriaus bloko kraštas keičia trukmę po 15 minučių; sufokusavus jį veikia ↑ / ↓. Planavimą galima panaikinti redaktoriuje arba grąžinti bloką į neplanuotų užduočių sritį. Užduotis ir jos terminas išlieka.

Papildomas Outlook blokas kuriamas tik pasirinkus. Programėlė saugo jo ID ir kūrimo `transactionId`, todėl perplanavimas atnaujina susietą bloką. Blokas visada `free`, be dalyvių ir priminimo. Sutrikus ryšiui vietinis planas lieka išsaugotas, o redaktorius rodo pakartojimo klaidą. Pakartojimui turi būti prijungta ta pati paskyra. Microsoft pusėje užbaigtų / ištrintų užduočių automatinis susietų blokų sutvarkymas dar kuriamas.

Pirmo paleidimo migracija senų vietinių užduočių dviprasmišką `due_at` išsaugo ir kaip terminą, ir kaip ankstesnį planą, pažymėdama jį redaktoriuje. Patikrink abi reikšmes. Ankstesnių Microsoft terminų atkurti automatiškai negalima, nes jų pradinės reikšmės MVP nesaugojo.

## Artimiausias funkcijų etapas

- platesnis Google / Outlook įvykių redaktorius ir pasikartojimų valdymas;
- Google Tasks ir keli Microsoft To Do sąrašai;
- kelių dienų tempimas, automatinis slinkimas tempiant ir pilnas DST laiko pasirinkimas;
- išsamesnis klaviatūros ir jutiklinis valdymas;
- prieigos žetonų galiojimo talpykla bei tikrų abiejų paskyrų patikra;
- kelių kalendorių pasirinkimas ir spalvos;
- pasikartojantys įvykiai;

Ši versija skirta asmeniniam naudojimui ribotos prieigos aplinkoje. API jau tikrina keičiančių užklausų kilmę (CSRF), tačiau viešam diegimui dar reikia pačios programėlės naudotojo prisijungimo ir HTTPS. Integracijos prijungimas nėra programėlės prieigos apsauga.
