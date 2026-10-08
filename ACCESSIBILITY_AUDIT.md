# Prieinamumo auditas

Atnaujinta: 2026-10-07.

## Automatiškai patikrintas pagrindas

- Klaviatūra iškart pasiekiama nuoroda **Pereiti prie pagrindinio turinio**.
- Interaktyvūs elementai turi aiškų `:focus-visible` apvadą, o modalai uždaro fokusą savo viduje, užsidaro su `Escape` ir grąžina fokusą į juos atidariusį valdiklį.
- DST kartojamos valandos pasirinkimas turi tokį patį fokuso valdymą.
- Mėnesio kalendoriuje datos, įvykiai ir užduotys yra atskiri semantiniai mygtukai su prieinamais pavadinimais; neliko įdėtų vienas į kitą interaktyvių elementų.
- Būsenos pranešimas naudoja mandagų `aria-live` regioną ir atskirą uždarymo mygtuką.
- Pagrindiniai telefono antraštės, modalų, kalendoriaus ir sąrašų valdikliai turi bent 44 × 44 px lietimo taikinį; tempimo rankenos padidintos įrenginiuose su grubiu žymekliu.
- Palaikomi `prefers-reduced-motion` ir `forced-colors` režimai.
- Playwright scenarijai tikrina skip nuorodą, dialogo fokuso ciklą, `Escape`, fokuso grąžinimą, mėnesio valdiklių semantiką, prieinamus pavadinimus, mobilių valdiklių dydį ir horizontalų perpildymą.

Automatinis 2026-10-07 regresijos ciklas: 374/374 Node testai, 74/74 Playwright scenarijai, TypeScript, produkcinis build, HTTP, Calendar, Tasks ir Docker web / worker / backup-restore smoke patikros praėjo.

## Likusi fizinių įrenginių patikra

Automatinė patikra nepakeičia realaus ekrano skaitytuvo, klaviatūros ir lietimo bandymo. Kiekvienoje eilutėje reikia įrašyti datą, įrenginį / OS, naršyklę, rezultatą ir rastų problemų nuorodas.

| Platforma | Būtina patikra | Būsena |
| --- | --- | --- |
| macOS | Safari ir įdiegta PWA; visa eiga tik klaviatūra; VoiceOver antraštės, formos, kalendorius, modalai ir pranešimai | neatlikta |
| Windows | Edge arba Chrome; Tab / Shift+Tab / Enter / Space / Escape; Narrator pavadinimai ir dialogai; 200 % mastelis | neatlikta |
| Android | Chrome ir įdiegta PWA; TalkBack braukimas; 44 px taikiniai; užduoties tempimas, slinkimas ir redaktoriai | neatlikta |
| iPhone | Safari ir Home Screen PWA; VoiceOver; safe-area; orientacijos keitimas; modalai ir offline planas | neatlikta |

### Vienodas scenarijus visoms platformoms

1. Prisijungti, atverti dienos, savaitės ir mėnesio rodinius bei pasiekti visus pagrindinius veiksmus.
2. Klaviatūra arba ekrano skaitytuvu sukurti, atverti, išsaugoti ir uždaryti užduotį bei įvykį.
3. Patikrinti, kad fokusas matomas, tvarka logiška, modalas neišleidžia fokuso ir uždarytas grąžina jį į pradinį mygtuką.
4. Patikrinti datų, paskyrų, kalendorių, būsenų, klaidų ir pranešimų ištarimą.
5. Telefone patikrinti lietimo taikinius, slinkimą, orientacijos keitimą ir tai, kad sąsaja neturi horizontalaus puslapio perpildymo.
6. Įjungti didesnį tekstą, 200 % mastelį, sumažintą judesį, tamsią temą ir sistemos didelio kontrasto režimą.
7. Nutrūkus ryšiui patikrinti, kad offline planas aiškiai įvardytas kaip tik skaitomas ir neturi neveikiančių redagavimo veiksmų.

Fizinis auditas laikomas užbaigtu tik užpildžius visas keturias platformų eilutes ir atskirais patikrintais commitais pašalinus aptiktas kliūtis.
