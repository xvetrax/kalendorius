# Kasdienės patirties ir išmanaus planavimo įgyvendinimo planas

Atnaujinta: 2026-10-09. Būsena: **DX-1 ir DX-2 automatinė apimtis įgyvendinta; liko ribota DX-2 gyvų paskyrų priėmimo patikra**.

## Tikslas

Padaryti „Dienos planą“ vieta, kurią naudotojas atidaro kelis kartus per dieną: greitai supranta dabartinę situaciją, užfiksuoja naują darbą, gauna paaiškinamus planavimo pasiūlymus ir saugiai juos pritaiko. Esamos Google, Microsoft ir vietinių užduočių integracijos išlieka autoritetingi šaltiniai, o tikslus užduoties darbo laikas ir toliau saugomas programėlės `task_plans` modelyje.

Pagrindinis produkto skirtumas: viename privačiame plane suderinti keli darbo ir asmeniniai kalendoriai bei užduočių sąrašai, aiškiai parodyti realią dienos talpą ir pasiūlyti veiksmus nieko nekeičiant be naudotojo patvirtinimo.

## Nekeičiamos taisyklės

1. Google Tasks API perduoda tik dieną. Tikslus darbo laikas lieka vietiniame plane ir nėra vaizduojamas kaip Google saugomas laukas.
2. Google ar Microsoft duomenys nekeičiami vien dėl to, kad atidarytas „Mano dienos“ ekranas arba sugeneruoti pasiūlymai.
3. Visi pasiūlymai prieš įrašymą rodomi kaip peržiūra su priežastimi, paskyra, sąrašu, data, laiku ir trukme.
4. Pakeitimai pririšami prie naudotojo, jungties, kalendoriaus arba užduočių sąrašo ir perskaitytos versijos. Pasenusi peržiūra atmetama.
5. Naujos DB schemos migracijos yra pridedančios ir saugios esamiems duomenims. Pilnos kopijos bei atkūrimo schema atnaujinama tame pačiame etape.
6. Offline režimas lieka tik skaitymui. Offline mutacijų eilė į šį planą neįtraukta.
7. Kiekvienas užbaigtas etapas gauna tikslinius testus, bendrą regresijos ciklą, atskirą commit ir push į `origin`.

## DX-1 — „Mano diena“ ir greitas įvedimas

**Būsena:** ✅ užbaigta 2026-10-07. **Duomenų migracija:** nereikalinga.

Įgyvendinta atskira „Mano diena“ su artimiausiu įvykiu, šiandienos ir vėluojančiomis užduotimis, laisvais tarpais bei 09:00–17:00 talpos suvestine. Darbo valandos šiame etape yra viena aiškiai rodoma numatytoji reikšmė; naudotojo režimai ir individualios valandos priklauso DX-3.

Šoninis greitas įvedimas ir `Cmd/Ctrl + Shift + A` naudoja bendrą peržiūrą su deterministiniu lietuvišku parseriu, aiškiai pasirinkta paskyra bei sąrašu ir atskirais termino bei darbo laiko laukais. `Cmd/Ctrl + K` atidaro klaviatūra valdomą komandų paletę. Tikslus naujos užduoties darbo laikas vienu kūrimo veiksmu įrašomas į vietinį planą; Google tiekėjui jis neperduodamas.

PWA neprisijungusio plano ekranas tikrina tikrą programėlės serverio būseną. Mygtukas parodo patikros rezultatą, o grįžus ryšiui, pabudus įrenginiui arba vėl parodžius programėlės langą automatiškai grįžtama į programėlę.

### Sąsaja

- Pridėti atskirą **Mano diena** rodinį, kuris rodo:
  - artimiausią įvykį ir laiką iki jo;
  - šiandien suplanuotas bei tik dienos terminą turinčias užduotis;
  - laisvus tarpus tarp užimtų kalendoriaus blokų;
  - vėluojančias ir šiandien dar neatliktas užduotis;
  - dienos talpą: darbo valandos, užimta kalendoriuje, suplanuota užduotims ir likęs laikas.
- Vienas pagrindinis veiksmas **Planuoti dieną** atidaro planavimo peržiūrą; šiame etape ji leidžia planuoti rankiniu būdu, be automatinio algoritmo.
- Dabartinis šoninis greitas pridėjimas išlieka, bet naudojamas bendras kūrimo komponentas.
- `Cmd/Ctrl + K` tampa komandų palete. Ji ieško užduočių ir įvykių bei vykdo komandas: „Nauja užduotis“, „Naujas įvykis“, „Šiandiena“, „Pradėti fokusą“, „Nustatymai“.
- `Cmd/Ctrl + Shift + A` atidaro greitą užduoties įvedimą iš bet kurio rodinio.

### Greito teksto interpretavimas

- Pirmoje versijoje naudoti deterministinį lietuviškų datų ir laiko parserį, be išorinio AI:
  - „rytoj“, „pirmadienį“, `14:30`, `30 min`, `1 val`;
  - aiški projekto arba sąrašo žyma pasirenkama tik iš esamų reikšmių;
  - neatpažintas tekstas lieka pavadinimu.
- Prieš išsaugant rodyti išskaidytus laukus. Enter patvirtina tik tada, kai peržiūra galiojanti; `Escape` uždaro nieko neįrašęs.

### Priėmimo kriterijai

- Rodinys teisingai sujungia kelias Google ir Microsoft paskyras, bet spalva nėra vienintelis kilmės požymis.
- Dienos talpa neįskaičiuoja visos dienos informacinių įvykių kaip 24 valandų užimtumo ir gerbia Outlook `free` būseną.
- Komandų paletė pilnai valdoma klaviatūra, turi fokuso ciklą ir ekrano skaitytuvo pavadinimus.
- Greitas įvedimas negali tyliai pasirinkti kitos paskyros ar sąrašo.

## DX-2 — saugus „Atšaukti“ ir veiksmų istorija

**Prioritetas:** antras. **Priklausomybė:** DX-1 bendri veiksmų komponentai.

**Būsena:** automatinė apimtis užbaigta 2026-10-09. Vietinės užduoties sukūrimas, užbaigimas, planavimas, perkėlimas, trukmės keitimas ir išplanavimas turi 15 sekundžių atšaukimo veiksmą. Tą patį vietinio plano atšaukimą gauna Google Tasks ir Microsoft To Do užduoties planavimas, perkėlimas, trukmės keitimas bei išplanavimas; atšaukimas nekeičia tiekėjo užduoties, nes tikslus darbo laikas saugomas tik `task_plans`.

Vienkartinio, redaguojamo, dalyvių ir Outlook veidrodžio neturinčio Google arba Microsoft kalendoriaus įvykio laiko perkėlimas bei trukmės pakeitimas atšaukiamas tik su autoritetingu tiekėjo ETag. Žurnalo `applying` būsena išlieka po neaiškaus tinklo atsakymo, o pakartojimas iš naujo perskaito įvykį ir arba užbaigia jau įvykusį atkūrimą, arba saugiai pritaiko jį vieną kartą. Vėlesnis išorinis pakeitimas, kita paskyra, kalendorius ar jungtis grąžina konfliktą.

Žurnalas yra patvarus, izoliuotas pagal naudotoją, ribojamas iki 50 įrašų ir saugomas septynias dienas. Pakartotas atšaukimas idempotentiškas, pasikeitusi versija grąžina konfliktą, o atkurta plano versija didinama. Nustatymuose rodoma metaduomenų istorija. Pilna kopija įtraukia galiojančią istoriją, naudotojo eksportas — tik jo nepasibaigusius įrašus, o atkūrimas panaikina trumpalaikes atšaukimo galimybes.

### Apimtis

- Po saugiai grąžinamo veiksmo 10–15 sekundžių rodyti pranešimą su **Atšaukti**:
  - vietinės užduoties sukūrimas ir užbaigimas;
  - užduoties planavimas, perkėlimas, trukmės keitimas ir išplanavimas;
  - įvykio arba užduoties perkėlimas tik tada, kai tiekėjo objektas nepasikeitė.
- Sukurti naudotojui priklausantį riboto dydžio `action_journal` registrą: operacijos ID, tipas, objekto tapatybė, prieš / po versija, saugus kompensuojantis veiksmas ir galiojimo laikas.
- Įrašo trynimas iš Google ar Microsoft, dalyvių atsakymai, serijos skaidymas ir neaiškios tiekėjo baigtys nerodomos kaip grąžinamos, jei nėra patikimo kompensuojančio veiksmo.
- Nustatymuose arba veiksmų meniu rodyti trumpą paskutinių veiksmų istoriją be OAuth paslapčių ir pilnų tiekėjo duomenų objektų.

### Saugumo taisyklės

- Atšaukimas iš naujo perskaito dabartinę versiją. Jei objektą pakeitė kita programa, grąžinimas atmetamas ir siūloma atnaujinti duomenis.
- Operacijos ID yra idempotentiškas. Pakartotas tas pats atšaukimas negali pritaikyti pakeitimo du kartus.
- Pasibaigę žurnalo įrašai periodiškai išvalomi ir neįtraukiami į naudotojo eksportą; pilna administratoriaus kopija išsaugo tik dar galiojančius įrašus arba aiškiai juos pašalina atkūrimo metu.

### Priėmimo kriterijai

- Dvigubas paspaudimas, tinklo timeout ir serverio perkrovimas nesukuria dvigubo kompensuojančio veiksmo.
- Kito naudotojo žurnalo ID visada grąžina 404.
- Pasenęs Google arba Microsoft ETag nekeičia vietinio plano ir išorinio objekto.

## DX-3 — darbo, asmeniniai ir fokusavimo režimai

**Prioritetas:** trečias. **Priklausomybė:** DX-1.

### Duomenų modelis ir sąsaja

- Naudotojo nustatymuose pridėti režimų rinkinį:
  - pavadinimas ir spalvinė žyma;
  - įjungtos paskyros, kalendoriai ir užduočių sąrašai;
  - darbo dienos, darbo pradžia ir pabaiga;
  - numatytasis kalendoriaus rodinys bei informacijos tankis;
  - pasirinktiniai minimalūs tarpai tarp įvykių.
- Pateikti numatytuosius režimus **Visi**, **Darbas**, **Asmeniniai** ir **Fokusas**, bet nespręsti paskyros paskirties vien pagal el. pašto domeną.
- Aktyvus režimas aiškiai rodomas antraštėje ir prisimenamas naudotojo nustatymuose, ne tik konkrečioje naršyklėje.
- Režimas yra filtras bei planavimo kontekstas. Jis nekeičia tiekėjo duomenų ir nieko neperkelia tarp paskyrų.

### Priėmimo kriterijai

- Pašalinus arba perjungus OAuth jungtį, režimas saugiai pašalina nebegaliojančias nuorodas.
- Keli vienodai pavadinti kalendoriai atskiriami pagal pilną jungties ir kalendoriaus tapatybę.
- Režimo pakeitimas atnaujina „Mano dieną“, kalendorių, užduotis ir būsimus planavimo pasiūlymus vienodai.

## DX-4 — paaiškinami išmanaus planavimo pasiūlymai

**Prioritetas:** pagrindinė išskirtinė funkcija. **Priklausomybės:** DX-1, DX-2 ir DX-3.

### Algoritmas

- Serveris iš autoritetingo dabartinio vaizdo sudaro laisvus intervalus pagal:
  - aktyvaus režimo darbo valandas;
  - užimtus Google ir Microsoft įvykius;
  - Outlook `free/busy` būseną;
  - jau suplanuotas užduotis;
  - naudotojo buferį tarp blokų;
  - DST ir vietinę IANA laiko zoną.
- Užduotys vertinamos pagal terminą, prioritetą, trukmę, jau nukeltų kartų skaičių ir pasirinktą režimą. Pirmoje versijoje nenaudoti nepaaiškinamo ML balo.
- Atsakymas pateikia 1–3 variantus ir kiekvieno paaiškinimą, pavyzdžiui: „iki termino liko 1 diena“, „telpa visas 45 min. blokas“, „po susitikimo paliktas 15 min. tarpas“.
- Pasiūlymai rodomi kalendoriuje kaip permatomi blokai. Galima patvirtinti po vieną arba visą peržiūrą.

### Įrašymo sutartis

- Planavimo peržiūra turi stabilų operacijos ID, naudotų užduočių ir kalendorių versijas bei galiojimo laiką.
- Prieš pritaikymą serveris iš naujo tikrina, ar laikas vis dar laisvas ir užduotys nepasikeitė.
- Pritaikymas vienoje vietinėje transakcijoje keičia `task_plans` ir pranešimų darbus. Google Tasks gauna tik tinkamą dienos terminą, jei naudotojas aiškiai jį pakeitė; tikslus pasiūlytas laikas tiekėjui nesiunčiamas.
- Dalinis kelių pasiūlymų pritaikymas neleidžiamas: pasikeitus vienam blokui grąžinama nauja peržiūra, kad nebūtų pusiau perplanuotos dienos.

### Priėmimo kriterijai

- Rezultatas deterministinis tam pačiam įvesties rinkiniui ir paaiškinamas be serverio logų.
- Testai apima 23 ir 25 valandų dienas, pusvalandžio DST zoną, įvykius per vidurnaktį, visos dienos įvykius, kelias paskyras ir vienodus tiekėjų ID.
- Algoritmas niekada nesiūlo laiko už režimo ribų ar ant užimto bloko ir neskaldo užduoties, kol naudotojas neįjungė būsimos skaidymo funkcijos.

## DX-5 — dienos uždarymas ir savaitės apžvalga

**Prioritetas:** po išmanaus planavimo. **Priklausomybės:** DX-1 ir DX-4.

- Dienos pabaigoje parodyti: atlikta, liko, perkelta ir kiek realios talpos buvo panaudota.
- Leisti vienu ekranu užbaigti, perkelti arba grąžinti į neplanuotas likusias užduotis; kiekvienas veiksmas išlaiko DX-2 atšaukimo taisykles.
- Savaitės apžvalgoje rodyti tik naudotojui naudingas įžvalgas:
  - planuotas ir atliktas užduočių laikas;
  - dažnai perkeliamos užduotys;
  - perkrautos dienos ir nepanaudoti laisvi tarpai;
  - darbo ir asmeninio režimo balansas pagal laiką, be darbdavio stebėjimo metrikų.
- Skaičiavimus daryti iš naudotojo duomenų. Telemetrija į išorinę paslaugą nesiunčiama.

### Priėmimo kriterijai

- Ataskaita aiškiai atskiria kalendoriaus užimtumą, užduočių planą ir faktinį užbaigimą; ji neteigia, kad suplanuotas laikas buvo iš tikrųjų dirbtas.
- Naudotojas gali išjungti ritualą ir priminimą neprarasdamas savo duomenų.

## DX-6 — vizualinis vientisumas ir PWA patogumai

**Prioritetas:** vykdyti dalimis kartu su DX-1–DX-5, galutinį auditą atlikti po funkcijų.

### Vizualinė sistema

- Sukurti bendrus dizaino tokenus tarpams, spinduliams, šešėliams, tipografijai, būsenoms ir interaktyvių elementų dydžiams; šalinti besidubliuojančias senas CSS taisykles tik su regresiniais ekrano testais.
- Pridėti **Patogų** ir **Kompaktišką** tankį. 44 × 44 px dažnų lietimo veiksmų plotas išlieka net kompaktiškame režime.
- Sukurti nuoseklias įkėlimo karkaso, tuščias, klaidos, pasenusios tiekėjo kopijos ir dalinio įkėlimo būsenas.
- Naudoti trumpus perėjimus tarp rodinių tik kaip progresyvų patobulinimą ir gerbti `prefers-reduced-motion`.

### PWA patogumai

- Manifesto nuorodos: **Mano diena**, **Nauja užduotis**, **Pradėti fokusą**. Jos remiasi stabiliais programos deep link, o neprisijungęs naudotojas grąžinamas per `/login?next=...`.
- Palaikomose sistemose rodyti programos ženklelį tik su aiškiu veiksmų skaičiumi, pavyzdžiui, šiandien likusios svarbios užduotys. Nenaudoti ženklelio vien reklaminei reaktivacijai.
- Fokusavimo metu pasiūlyti Screen Wake Lock, bet tik po naudotojo veiksmo ir su aiškia išjungimo būsena.
- Web Share Target palikti atskiram DX-6b etapui, nes priimtas turinys turi pereiti tą pačią greito įvedimo peržiūrą bei CSRF apsaugą.

## DX-7 — white-label pagrindas

**Prioritetas:** tik po patvirtinto kasdienio naudojimo. **Tai nėra kelių nuomininkų SaaS etapas.**

- Perkelti produkto pavadinimą, trumpą pavadinimą, logotipus, spalvų temą, pagalbos adresą, privatumo nuorodą ir PWA manifesto tekstus į validuojamą serverio konfigūraciją.
- Vienas diegimas turi vieną brand identitetą, domeną, DB, OAuth klientus, šifravimo raktą ir VAPID identitetą.
- Sukurti automatinę konfigūracijos bei ikonų validaciją build metu ir aiškų diegimo dokumentą.
- Kliento administratoriui nesuteikti prieigos prie kitų naudotojų kalendorių, užduočių ar OAuth žetonų. Galima tik agreguota, privatumo nepažeidžianti sistemos sveikata ir aktyvių paskyrų skaičius.
- Licencijavimą, mokėjimus, bendrą kelių klientų DB ir organizacijų administravimą planuoti atskirai, kai atsiras pirmas realus white-label poreikis.

## Įgyvendinimo paketai

| Paketas | Apimtis | Pilno testavimo vartai |
| --- | --- | --- |
| ✅ A | DX-1 „Mano diena“, bendra greito įvedimo forma ir komandų paletė | praėjo: typecheck, 382 Node, build, 79 E2E, HTTP, kalendorių, užduočių ir Docker smoke |
| 🟡 B | DX-2 atšaukimas ir veiksmų žurnalas | automatinė vietinių planų ir tiekėjų ETag kompensacijų apimtis praėjo; liko ribotas gyvų Google / Microsoft paskyrų bandymas |
| C | DX-3 režimai ir darbo laiko nuostatos | papildomai kelių paskyrų izoliacija, pašalintų jungčių valymas ir DST |
| D | DX-4 planavimo peržiūra bei atominiu būdu pritaikomi pasiūlymai | papildomai deterministinio algoritmo, konfliktų, 23/25 val. dienų ir neaiškios baigties testai |
| E | DX-5 apžvalgos ir DX-6 galutinis vizualinis / PWA poliravimas | papildomai realūs macOS, Windows, Android bei iPhone prieinamumo ir PWA scenarijai |
| F | DX-7 white-label konfigūracija | papildomai dviejų atskirų brand build bei Docker diegimų patikra |

Kiekvienas paketas įgyvendinamas didesne vientisa apimtimi, o pilnas testų rinkinys leidžiamas užbaigus paketą. Paketo viduje atliekami tik tiksliniai testai, reikalingi greitam grįžtamajam ryšiui.

## Sąmoningai atidėta

- Native macOS, Windows, Android ir iOS kodo bazės.
- LLM pagrįstas teksto interpretavimas ar automatinis sprendimų priėmimas.
- Užduočių skaidymas į kelis laiko blokus.
- Offline kūrimas, redagavimas ir sinchronizavimo konfliktų eilė.
- Komandinis kalendorių dalinimasis, vadovo stebėsena ir darbuotojų produktyvumo reitingai.
- Mokėjimai, prenumeratų planai ir bendras kelių klientų SaaS duomenų sluoksnis.

## Kitas vykdomas žingsnis

Su gyvomis Google ir Microsoft paskyromis ribotai patikrinti DX-2b vienkartinio įvykio perkėlimą, trukmės pakeitimą, atšaukimą ir išorinės versijos konfliktą. Patvirtinus ETag elgseną pereiti prie **DX-3** režimų bei darbo laiko nuostatų. Trinimas, RSVP, serijos skaidymas, mišrūs įvykio pakeitimai ir Outlook veidrodį turinčių užduočių veiksmai lieka sąmoningai neatšaukiami.
