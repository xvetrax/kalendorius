# Kelių naudotojų sistemos planas

Atnaujinta: 2026-09-27. Būsena: **įgyvendinama `feature/multi-user` šakoje**.

## Tikslinis veikimas

Programėlės URL yra viešai pasiekiamas. Neprisijungęs žmogus mato „Prisijungti su Google“ ir „Prisijungti su Microsoft“. Pirmą kartą sėkmingai patvirtinus OIDC tapatybę automatiškai sukuriama atskira programėlės paskyra ir tuščia darbo erdvė. Kvietimų nuorodų nėra.

Prisijungimo tapatybė suteikia tik prieigą prie programėlės. Prisijungęs žmogus nustatymuose atskirai prijungia norimas Google ir Microsoft paskyras su Calendar / Tasks leidimais. El. pašto sutapimas paskyrų nesujungia; vidinė tapatybė visada siejama pagal patikrintą `issuer + subject`.

`PUBLIC_SIGNUP=true` leidžia kurti naujas paskyras. Nustačius `false`, esamos paskyros gali prisijungti, bet nežinoma tapatybė neberegistruojama. `INITIAL_ADMIN_EMAIL` nurodo pirmojo administratoriaus adresą; jei jis nenustatytas, administratoriumi tampa pirmoji paskyra.

## Įgyvendinta

- [x] DB lentelės `users`, `auth_identities`, `sessions`, `auth_operations`, `oauth_connections`, `user_settings` ir `security_events`.
- [x] Visos vietinės užduotys, planai, nuotolinių duomenų talpyklos ir kalendoriaus kūrimo operacijos turi privalomą `user_id`.
- [x] Google ir Microsoft OIDC authorization-code + PKCE srautai, DB sesijos ir atsijungimas.
- [x] Viešas paskyros sukūrimas pirmo patvirtinto OIDC prisijungimo metu.
- [x] Antrą prisijungimo tapatybę galima aiškiai susieti tik iš aktyvios sesijos.
- [x] Programėlės prisijungimas atskirtas nuo Calendar / Tasks OAuth leidimų.
- [x] Google ir Microsoft ryšiai, nustatymai, užduotys bei kalendoriai izoliuoti pagal naudotoją.
- [x] Administratoriaus naudotojų sąrašas, rolės keitimas, paskyros išjungimas ir sesijų atšaukimas.
- [x] Paskutinio aktyvaus administratoriaus apsauga.
- [x] Administratoriaus pilna kopija ir naudotojo eksportas be OAuth bei sesijų paslapčių.
- [x] Sena vieno naudotojo DB aiškiai atmetama; startas jos tyliai netrina.
- [x] Senas bendras `APP_PASSWORD`, setup tokenas ir kvietimų API pašalinti.

## Likę patikrinimai ir darbai

- [x] Pilnas `typecheck`, 292 Node testų, produkcinio build, trijų smoke rinkinių ir 44 Playwright scenarijų ciklas po viešos registracijos pakeitimo.
- [ ] Dviejų atskirų Playwright naršyklės kontekstų scenarijus, įrodantis UI ir API duomenų izoliaciją.
- [ ] Gyvas Google bei Microsoft OIDC prisijungimas su produkciniais callback URI.
- [ ] Gyvas atskiras Calendar / Tasks prijungimas kiekvienam iš dviejų naudotojų.
- [ ] Piktnaudžiavimo ribojimas reverse proxy sluoksnyje prieš plačiai viešinant URL.
- [ ] Privatumo ir duomenų saugojimo aprašas viešam naudojimui.
- [ ] Atsarginių kopijų bei atkūrimo priėmimo bandymas Docker aplinkoje.

## Priėmimo scenarijai

1. Du žmonės atidaro tą patį URL, vienas prisijungia per Google, kitas per Microsoft, ir abiem automatiškai sukuriamos atskiros paskyros.
2. Abu sukuria vienodo pavadinimo vietines užduotis, jas planuoja tuo pačiu laiku ir nė vienas nemato kito įrašo.
3. Abu savarankiškai prijungia Google arba Microsoft kalendorius; žetonai, kalendorių pasirinkimai ir užduočių sąrašai nesusimaišo.
4. Žinant kito naudotojo objekto ID, GET, POST, PATCH ir DELETE neatskleidžia ir nekeičia svetimų duomenų.
5. Išjungus vieną paskyrą, jos sesijos nebeveikia, o kitų naudotojų sesijos ir duomenys lieka nepakitę.
6. Pilna administratoriaus kopija išlaiko visų eilučių savininkus; asmeninis eksportas neturi kito naudotojo duomenų ar paslapčių.

## Commit ir tikrinimo tvarka

Kiekvienas užbaigtas bei patikrintas darbo paketas turi atskirą aiškų commit ir siunčiamas į `origin`. Tiksliniai testai vykdomi darbo metu, o visas `npm run typecheck`, `npm test`, `npm run build`, smoke ir E2E rinkinys — po didesnės susijusių pakeitimų grupės bei prieš paleidimą naudotojams.
