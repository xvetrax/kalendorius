# Kelių naudotojų sistemos įgyvendinimo planas

Atnaujinta: 2026-09-26. Būsena: **suplanuota, įgyvendinimas nepradėtas**.

## Tikslas

Vienoje „Dienos plano“ instancijoje kiekvienas pakviestas žmogus turi savo paskyrą, vietines užduotis, nustatymus, Google ir Microsoft ryšius. Vieno naudotojo identifikatoriai, nuorodos ar OAuth operacijos negali atverti, pakeisti arba ištrinti kito naudotojo duomenų.

Pirmoji versija skirta uždaram draugų ratui:

- prisijungimas prie programėlės per Google arba Microsoft OpenID Connect;
- registracija tik su vienkartiniu administratoriaus kvietimu;
- rolės `admin` ir `member`;
- viena Google ir viena Microsoft paskyra vienam programėlės naudotojui;
- vietiniai programėlės slaptažodžiai nekuriami, todėl nereikia el. pašto siuntimo ir slaptažodžio atkūrimo paslaugos;
- administratoriaus sukurtas vienkartinis kvietimo arba paskyros atkūrimo adresas žmogui perduodamas tiesiogiai;
- viena bendra aplikacijos ir SQLite instancija, tačiau visi naudotojo duomenys turi aiškų savininką;
- serverio administratorius techniškai valdo DB ir šifravimo raktą, todėl draugams tai aiškiai nurodoma privatumo apraše.

Vieša savarankiška registracija, komandos, bendrinami kalendoriai ir keli to paties tiekėjo ryšiai paliekami vėlesniam etapui.

## Nekintamos saugumo taisyklės

1. Naudotojas nustatomas tik iš serverio patikrintos sesijos, niekada iš kliento atsiųsto `userId`.
2. Kiekviena vietinė užduotis, planas, nuotolinių duomenų talpykla, nustatymas, kalendoriaus kūrimo operacija ir OAuth ryšys turi `user_id` arba priklauso objektui, kuris turi `user_id`.
3. Duomenų užklausa be savininko filtro laikoma programavimo klaida. Paslaugų sluoksnis privalo reikalauti `UserContext`.
4. OAuth `state`, PKCE ir callback susiejami su konkrečia prisijungusia sesija bei vienkartine operacija. Callback negali perjungti kito naudotojo ryšio.
5. Programėlės sesijos ir kvietimų žetonai DB saugomi tik kaip kriptografinės maišos; Google ir Microsoft API atnaujinimo žetonai lieka šifruoti.
6. Administratoriaus rolė leidžia valdyti naudotojus, bet programėlės UI nesuteikia prieigos prie jų kalendorių, užduočių ar OAuth žetonų.
7. Dabartiniai duomenys laikomi testiniais ir nemigruojami. Kelių naudotojų režimas paleidžiamas su švaria naujos schemos DB; senas testinis failas gali būti paliktas tik kaip laikina techninė kopija ir vėliau pašalintas.
8. Prisijungimo tapatybė ir kalendoriaus / užduočių API leidimai yra atskiri ryšiai. Prisijungimas prašo tik OIDC tapatybės laukų, o Calendar / Tasks teisės prašomos vėliau aiškiu „Prijungti“ veiksmu.

## Tikslinė duomenų schema

| Lentelė | Paskirtis ir svarbiausi laukai |
| --- | --- |
| `users` | vidinis `id`, rodomas vardas, pagrindinis kontaktinis adresas, `role`, `status`, sukūrimo ir paskutinio prisijungimo datos |
| `auth_identities` | `user_id`, tiekėjas, patikrinto ID tokeno `issuer + subject`, rodomas el. paštas; unikalumas remiasi `issuer + subject`, ne el. paštu |
| `sessions` | atsitiktinio sesijos žetono maiša, `user_id`, galiojimas, paskutinis naudojimas, atšaukimo data; leidžia atsijungti iš vieno arba visų įrenginių |
| `invites` | žetono maiša, pasirinktinai gavėjo adresas, būsima rolė, galiojimas, sukūręs administratorius ir panaudojimo data |
| `auth_operations` | trumpai galiojantys OIDC prisijungimo ar tapatybės susiejimo bandymai: nonce, PKCE, state maiša, kvietimo ryšys ir pradinis callback kelias |
| `oauth_connections` | atskiras Calendar / Tasks ryšys: `user_id`, tiekėjas, tiekėjo paskyros ID ir adresas, šifruotas refresh token, leidimų rinkinys, ryšio generacija ir būsena |
| `user_settings` | sudėtinis raktas `user_id + key`; kalendorių pasirinkimai, sąrašai ir kitos asmeninės nuostatos |
| `security_events` | prisijungimas, nesėkmingi bandymai, kvietimas, paskyros atkūrimas, ryšio prijungimas / atjungimas, paskyros išjungimas; be žetonų ir asmeninio turinio |

Esamos `tasks`, `task_plans`, `remote_tasks`, `remote_task_lists` ir `calendar_event_creates` lentelės gauna savininko ryšį. Unikalūs raktai ir indeksai papildomi `user_id` arba `oauth_connection_id`, kad dviejų žmonių vienodi Google ar Microsoft identifikatoriai nekonfliktuotų.

Globalūs diegimo parametrai lieka aplinkos kintamuosiuose. Naujoje schemoje OAuth žetonai ir tiekėjo paskyrų ID nuo pradžių saugomi `oauth_connections`, o įjungti kalendoriai ir kitos asmeninės nuostatos — `user_settings`. Sena testinė `settings` lentelė neperkeliama.

## Įgyvendinimo etapai

### H0. Sutartis, inventorius ir švarios schemos projektas

- [ ] Užfiksuoti architektūros sprendimą: Google / Microsoft OIDC prisijungimas, kvietimai, rolės, viena API paskyra naudotojui, sesijos gyvavimo trukmė ir paskyros šalinimo taisyklė.
- [ ] Sudaryti visų `settings` raktų, lentelių, indeksų, API maršrutų ir tiesioginių DB užklausų nuosavybės lentelę.
- [ ] Suprojektuoti švarią schemą, kurioje naudotojui priklausantis įrašas iš karto turi privalomą savininką ir tinkamus sudėtinius unikalumo raktus.
- [ ] Dokumentuoti testinės DB atstatymo komandą, pirmo administratoriaus bootstrap ir `INVITES_ENABLED` valdymą.

Priimta, kai kiekvienas saugomas duomuo priskirtas globaliai arba naudotojui, o tuščioje DB galima saugiai sukurti pirmą administratorių.

### H1. Švari schema ir pirmojo administratoriaus bootstrap

- [ ] Tuščioje DB sukurti `users`, `auth_identities`, `sessions`, `invites`, `auth_operations`, `oauth_connections`, `user_settings` ir `security_events`.
- [ ] Visas užduočių, planų, talpyklų ir kūrimo operacijų lenteles iš karto kurti su `NOT NULL user_id` arba privalomu `oauth_connection_id`, išoriniais raktais ir naudotojui pritaikytais unikaliais indeksais.
- [ ] Pirmą administratorių leisti sukurti tik vieną kartą, kai `users` tuščia, pateikus stiprų vienkartinį `SETUP_TOKEN` ir sėkmingai prisijungus per pasirinktą OIDC tiekėją.
- [ ] Po pirmojo administratoriaus sukūrimo setup maršrutas turi būti nebeaktyvus net jei aplinkos kintamasis liko nustatytas.
- [ ] Dabartinę testinę DB pakeisti nauja tik po aiškios operatoriaus reset komandos; programos startas neturi tyliai trinti failo.

Priimta, kai švariame diegime pirmą administratorių galima sukurti vieną kartą, visi nauji įrašai turi savininką, o pakartotinis setup atmetamas.

### H2. OIDC tapatybės, kvietimai ir atšaukiamos sesijos

- [ ] Sukurti atskirus „Prisijungti su Google“ ir „Prisijungti su Microsoft“ authorization-code + PKCE srautus, prašančius tik `openid`, `email` ir `profile` tapatybės teisių.
- [ ] Patikrinti OIDC discovery / JWKS, parašą, `issuer`, `audience`, `nonce`, `state`, kodo vienkartinumą ir laiką. Vidinę tapatybę sieti pagal patikrintą `issuer + subject`, ne pagal el. pašto tekstą.
- [ ] Dabartinį stateless bendrą slapuką pakeisti atsitiktine DB sesija. Slapuke laikyti tik neperprantamą žetoną, nustatyti `HttpOnly`, `Secure`, `SameSite=Lax` ir galiojimą.
- [ ] Įgyvendinti prisijungimą, atsijungimą iš vieno / visų įrenginių, neaktyvios paskyros blokavimą ir visų sesijų rotaciją po saugumo pakeitimo.
- [ ] Įgyvendinti vienkartinius kvietimus: žmogus atidaro kvietimą, pasirenka Google arba Microsoft ir po sėkmingo OIDC callback tapatybė atomiškai pririšama naujam naudotojui.
- [ ] Prisijungusiam naudotojui leisti saugiai pridėti antrą prisijungimo tiekėją. Niekada automatiškai nesujungti paskyrų vien todėl, kad sutampa el. paštas.
- [ ] Administratoriui leisti sukurti vienkartinį paskyros atkūrimo kvietimą, jeigu žmogus prarado vienintelę išorinę tapatybę.
- [ ] Prisijungimo bei žetonų bandymų ribojimą saugoti patvariai arba vykdyti patikimame reverse proxy sluoksnyje; IP naudoti tik kaip signalą, ne kaip tapatybę.

Priimta, kai du atskiri naršyklės kontekstai per skirtingas Google / Microsoft tapatybes prisijungia kaip skirtingi naudotojai, sesijas galima atšaukti, o pakartotas ar pasibaigęs kvietimas neveikia.

### H3. Privalomas naudotojo kontekstas ir vietinių duomenų izoliacija

- [ ] Sukurti vieną `requireUser()` / `UserContext` ribą puslapiams ir API. Proxy gali atlikti ankstyvą patikrą, bet kiekviena duomenų operacija serveryje turi iš naujo patvirtinti sesiją.
- [ ] Pakeisti DB ir paslaugų funkcijas taip, kad jos negalėtų skaityti ar rašyti užduočių, planų, nustatymų ir talpyklų be `userId`.
- [ ] Pirmiausia perjungti vietinių užduočių CRUD, planavimą, fokusavimo sesiją ir asmenines nuostatas.
- [ ] Objektui priklausančiose PATCH / DELETE operacijose taikyti savininko filtrą pačioje SQL užklausoje; svetimam arba neegzistuojančiam objektui grąžinti vienodą atsakymą.
- [ ] Pašalinti globalius `setting()` / `saveSetting()` naudojimus iš naudotojo duomenų kelių.

Priimta, kai naudotojas A, žinodamas naudotojo B objektų ID, negali jų perskaityti, pakeisti, ištrinti ar nustatyti jų egzistavimo pagal atsako skirtumus.

### H4. Google ir Microsoft OAuth izoliacija

- [ ] Prisijungimo OIDC ir duomenų prieigos srautus laikyti logiškai bei duomenų bazėje atskirai. Prisijungimas neturi automatiškai gauti Calendar / Tasks refresh tokeno.
- [ ] Tik paspaudus „Prijungti Google“ arba „Prijungti Microsoft“ prašyti Calendar / Tasks ir `offline_access` leidimų; tiekėjo pakartotinio sutikimo eiga lieka atskira.
- [ ] Tiekėjų adapteriams perduoti `OAuthConnectionContext`; nebeleisti globaliai pasirinkti aktyvios paskyros.
- [ ] OAuth connect operaciją įrašyti serveryje su `user_id`, tiekėju, nonce, PKCE verifier, galiojimu ir pradine sesija. Pasirašytame `state` nepasitikėti vien kliento duomenimis.
- [ ] Callback metu patikrinti tą pačią prisijungusią paskyrą ir operaciją, tada atomiškai įrašyti konkretaus naudotojo šifruotą žetoną bei ryšio generaciją.
- [ ] Perkelti būseną, kalendorių pasirinkimus, To Do / Google Tasks sąrašus, token refresh užraktus, atjungimą ir pakartotinį Google Tasks sutikimą į naudotojo ryšio sritį.
- [ ] Į visas kalendoriaus ir užduočių tapatybes įtraukti `oauth_connection_id`; išlaikyti dabartinę apsaugą nuo vėluojančio token refresh ir paskyros pakeitimo.
- [ ] Atjungiant paskyrą šalinti tik to naudotojo talpyklą ir susijusius blokus, neliečiant kitų naudotojų.

Priimta, kai vienu metu prijungtos dviejų žmonių Google ir Microsoft paskyros nesumaišo žetonų, pasirinkimų, įvykių, užduočių ar atnaujinimo užraktų.

### H5. Paskyros ir administravimo sąsaja

- [ ] Prisijungimo puslapyje rodyti Google ir Microsoft mygtukus; pirmo administratoriaus vedlį rodyti tik kai DB nėra naudotojų.
- [ ] Nustatymuose rodyti dabartinę programėlės paskyrą, susietas prisijungimo tapatybes, aktyvias sesijas, atskirus Calendar / Tasks ryšius ir paskyros ištrynimą.
- [ ] Administratoriui sukurti atskirą naudotojų ekraną: kvietimas, rolės pakeitimas, išjungimas, sesijų atšaukimas ir vienkartinė paskyros atkūrimo nuoroda.
- [ ] Neleisti pašalinti ar pažeminti paskutinio aktyvaus administratoriaus.
- [ ] Visuose įkėlimo ir klaidų ekranuose atskirti programėlės sesijos pabaigą nuo Google arba Microsoft leidimo pabaigos.

Priimta, kai administratorius gali pakviesti draugą, draugas prisijungia pasirinkta išorine paskyra ir mato visiškai tuščią savo darbo erdvę dar nesuteikęs kalendoriaus ar užduočių teisių.

### H6. Atsarginės kopijos, eksportas ir paskyros gyvavimo ciklas

- [ ] Pilną visos instancijos kopiją ir atkūrimą palikti tik administratoriui; atkūrimą vykdyti priežiūros režime, atšaukiant visas sesijas.
- [ ] Paprastam naudotojui pateikti tik jo duomenų eksportą be OAuth ir sesijų paslapčių.
- [ ] Paskyros ištrynimą atlikti vienoje valdomoje operacijoje: atšaukti sesijas, atjungti tiekėjus, išvalyti susietus duomenis ir įrašyti minimalų saugumo audito faktą.
- [ ] Atnaujinti kopijos schemos validavimą ir naujesnės arba vieno naudotojo senos schemos atmetimą su aiškiu pranešimu; testiniai seni duomenys neimportuojami.
- [ ] Aprašyti duomenų saugojimą, serverio administratoriaus galimybes ir atsarginės kopijos šifravimo atsakomybę.

Priimta, kai vieno naudotojo eksportas neturi kito naudotojo eilučių ar paslapčių, o pilnas backup / restore išlaiko visų naudotojų nuosavybę.

### H7. Izoliacijos ir saugumo patikra

- [ ] Sukurti parametrizuotus autorizacijos testus kiekvienam API metodui su naudotojais A ir B, įskaitant numanomus ID, sąrašus, versijų konfliktus ir trynimą.
- [ ] Patikrinti OAuth login CSRF, callback perėmimą, `state` pakartojimą, PKCE, vėluojantį refresh, atjungimo lenktynes ir paskyros pakeitimą.
- [ ] Patikrinti OIDC parašą bei claim'us, kvietimų ir atkūrimo žetonų maišą, galiojimą, vienkartinumą, sesijų atšaukimą ir paskutinio administratoriaus apsaugą.
- [ ] Dviejuose Playwright naršyklės kontekstuose sukurti vienodus objektų pavadinimus ir patvirtinti visišką UI bei tinklo atsakymų izoliaciją.
- [ ] Nuo tuščios DB paleisti setup, visus vienetinius / integracinius testus, typecheck, produkcinį build ir Docker smoke testą.
- [ ] Atlikti atskirą saugumo peržiūrą prieš įjungiant kelių naudotojų režimą.

Priimta tik kai nėra žinomo kelio iš naudotojo A į naudotojo B duomenis, žetonus, eksportą ar operacijas.

### H8. Kontroliuojamas paleidimas draugams

- [ ] Išsaugoti seną testinę DB tik kaip trumpalaikį techninį failą, paleisti naują švarią DB ir sukurti pirmą administratorių per vienkartinį setup.
- [ ] Bent vieną savaitę naudoti naują instanciją be papildomų narių.
- [ ] Sukurti antrą testinį naudotoją be išorinių paskyrų, tada su atskiromis bandomosiomis Google ir Microsoft paskyromis.
- [ ] Įjungti kvietimus 2–3 draugams, stebėti tik techninius saugumo įvykius ir atsarginių kopijų sėkmę.
- [ ] Tik po šio etapo pašalinti seną bendro `APP_PASSWORD` kodą ir testinės DB techninę kopiją.
- [ ] Viešai registracijai atskirai suplanuoti el. pašto patvirtinimą, savitarnos paskyros atkūrimą, privatumo dokumentus, piktnaudžiavimo kontrolę ir Google OAuth produkcinę patikrą.

Priimta, kai keli pakviesti žmonės vienu metu gali kasdien naudoti tą pačią instanciją, o atjungimas, perkrovimas, kopija ir atnaujinimas nepaveikia kitų paskyrų.

## Commit ir tikrinimo strategija

Kiekvienas užbaigtas bei patikrintas darbo paketas turi atskirą commit ir iš karto siunčiamas į `origin`. Siūlomos ribos:

1. architektūros sutartis ir DB inventorius;
2. švari kelių naudotojų schema ir pirmo administratoriaus setup;
3. OIDC tapatybės, kvietimai ir sesijos;
4. vietinių duomenų nuosavybės riba;
5. Google OAuth, Calendar ir Tasks izoliacija;
6. Microsoft OAuth, Calendar ir To Do izoliacija;
7. administravimo UI, eksportas ir paskyros šalinimas;
8. dviejų naudotojų E2E, Docker ir diegimo dokumentacija.

Po kiekvieno paketo vykdomi tik jam prasmingi tiksliniai testai. Pilnas `npm run typecheck`, `npm test`, `npm run build` ir E2E rinkinys vykdomas po didesnės susijusių paketų grupės bei prieš paleidimą draugams. Nepavykęs patikrinimas taisomas tame pačiame pakete prieš commit.

## Galutiniai priėmimo scenarijai

1. Administratorius pakviečia du žmones. Abu tuo pačiu metu prisijungia skirtinguose įrenginiuose.
2. Abu sukuria vienodo pavadinimo vietines užduotis, jas planuoja tuo pačiu laiku ir nė vienas nemato kito įrašo.
3. Abu prijungia savo Google ir Microsoft paskyras. Kalendoriai, užduotys, spalvos, sąrašų pasirinkimai ir OAuth būsenos nesusimaišo.
4. Naudotojas A bando visus naudotojo B žinomus objektų identifikatorius per GET, POST, PATCH ir DELETE; negauna duomenų ir negali jų pakeisti.
5. Atjungus arba ištrynus A paskyrą, B sesija, ryšiai ir duomenys lieka nepakitę.
6. Pilna administratoriaus kopija atkuriama švarioje instancijoje ir išlaiko savininkus. A asmeninis eksportas neturi B duomenų ar jokių refresh / session žetonų.
7. Nauja instancija patikimai sukuriama nuo tuščios DB; setup negalima pakartoti jau esant administratoriui, o sena vieno naudotojo schema aiškiai atmetama.
8. Produkcinis Docker atnaujinimas ir grįžimas pagal dokumentuotą procedūrą išlaiko duomenis bei sesijų saugumą.
