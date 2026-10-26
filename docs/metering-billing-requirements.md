# Skaitiklių, mokesčių ir mokėjimų reikalavimai

## Būsena ir tikslas

2026-10-22 naudotojo atsakymais patvirtintos taisyklės. Pagal šią specifikaciją realizacija sujungta į main ir 2026-10-22 įdiegta privačioje GCP dev aplinkoje. API, servisų atsakomybės ir testų įrodymai aprašyti [accounting-api.md](accounting-api.md). Mokėjimai registruojami darbuotojo rankiniu būdu, automatiškai dengia seniausias skolas; nepanaudota suma yra avansas. Terminas dienomis nustatomas kiekvienoje sutartyje.

Tikslas: darbuotojas nustato sutarties sąlygas; klientas pateikia rodmenis; sistema juos patikrina, apskaičiuoja mėnesio mokestį, tvarko preliminarius skaičiavimus ir korekcijas; registruojami realūs mokėjimai ir skolos. Klientas mato tik savo duomenis.

## Patvirtintos verslo taisyklės

| ID | Taisyklė |
|---|---|
| R01 | Mokestis yra fiksuota dalis ir mokestis už visus atspausdintus puslapius. Įskaičiuotų nemokamų puslapių ši eiga nenaudoja. |
| R02 | Numatytieji A4 tarifai: nespalvotas 0,01 EUR, spalvotas 0,03 EUR. A3 atitinkamas tarifas dvigubas: 0,02 EUR ir 0,06 EUR. Sąlygos gali skirtis ir keistis pagal sutartį. |
| R03 | Keturi atskiri kaupiamieji skaitikliai: A4 nespalvotas, A4 spalvotas, A3 nespalvotas, A3 spalvotas. A3 rodmenys neįeina į A4 rodmenis. |
| R04 | Apskaitos laikotarpis – kalendorinis mėnuo. |
| R05 | Fiksuota dalis už nepilną mėnesį proporcinga nuomos dienoms ir kalendorinio mėnesio dienų skaičiui. |
| R06 | Fiksuota dalis taikoma visam sutartyje numatytam pradžios–pabaigos laikotarpiui, net sutartį užbaigus anksčiau. Ankstesnis užbaigimas negali savaime panaikinti likusių fiksuotų mokesčių. |
| R07 | Mėnesio pabaigos rodmenys pateikiami iki kito mėnesio 5 d. Rodmenų data ir pateikimo laikas saugomi atskirai. |
| R08 | Klientas pateikia savo sutarties rodmenis; darbuotojas gali pateikti jo vardu. Praėję patikras rodmenys priimami automatiškai, įtartini laukia darbuotojo peržiūros. |
| R09 | Neigiamų ar chronologiškai mažėjančių skaitiklių paprastas pateikimas nepriima. Skaitiklių pakeitimo ar nunulinimo pirmoje versijoje nėra. |
| R10 | Darbuotojas modeliui nustato mažiausią ir didžiausią tikėtiną kiekį per dieną. Konkretaus aparato ribos gali pakeisti modelio ribas. |
| R11 | Įtartinumas vertinamas pagal bendrą A4 ekvivalentų prieaugį per dieną: A4 = 1, A3 = 2. Tikrinamas ir neįprastai mažas, ir neįprastai didelis kiekis; nukrypimas yra peržiūros priežastis, ne automatinis kaltinimas klaidingais duomenimis. |
| R12 | Trūkstant tinkamų rodmenų skaičiuojama fiksuota dalis ir preliminarus sunaudojimas pagal paskutinį pilną faktiniais patvirtintais rodmenimis pagrįstą mėnesį. Keturi kiekiai vertinami atskirai, normalizuojami per nuomos dieną ir dauginami iš vertinamo laikotarpio nuomos dienų. |
| R13 | Jei tinkamo faktinio pilno mėnesio istorijos nėra, skaičiuojama tik fiksuota dalis; trūkstama istorija pažymima ir pranešama darbuotojui. |
| R14 | Preliminarus sunaudojimas niekada nesaugomas kaip tikras skaitiklio rodmuo. Preliminarūs skaičiavimai netampa naujo faktinio istorinio vidurkio šaltiniu. |
| R15 | Sutarties sąlygas galima keisti mėnesio viduryje be ribinių rodmenų. Puslapiai tarp tarifų galiojimo atkarpų paskirstomi proporcingai dienoms; fiksuota dalis taip pat skaidoma pagal sąlygų galiojimą. Paskirstymas pažymimas kaip apytikslis. |
| R16 | Sumos nurodomos be PVM. PVM procentas nustatomas sutarties sąlygose; jo negalima savavališkai laikyti nekintama konstanta. |
| R17 | Kiekviena skaičiavimo išklotinės eilutė apvalinama iki dviejų skaitmenų, 0,005 EUR apvalinant į 0,01 EUR. Bendra suma sudedama iš parodytų suapvalintų eilučių. Naudojama dešimtainė aritmetika, ne float/double. |
| R18 | Kliento patikslinimai automatiškai priimami tik praėję patikras. Saugomos ankstesnės rodmenų ir skaičiavimų versijos, autorius, laikas ir ryšys su pataisoma versija. |
| R19 | Pavėluoti faktiniai rodmenys sutikrinami su jau priskaičiuotu sunaudojimu. Senos išrašytos sąskaitos neperrašomos: skirtumas didina arba mažina naujų sąskaitų mokėtiną sumą. |
| R20 | Į mažąją pusę taikoma korekcija sąskaitą gali sumažinti iki 0 EUR. Nepanaudotas korekcijos likutis perkeliamas toliau, o pasibaigus sutarčiai turi likti matomas galutiniam atsiskaitymui. |
| R21 | Reikia registruoti realius kliento mokėjimus ir skolas. Priskaičiuotas mokestis, sunaudojimo korekcijos likutis ir gautas piniginis mokėjimas yra atskiri duomenys. |
| R22 | Sąskaitos negalima žymėti apmokėta vien dėl preliminaraus skaičiavimo, patvirtintų rodmenų ar atsiųsto Pub/Sub pranešimo. |

## Patvirtintos mokėjimų taisyklės

- R23: darbuotojas rankiniu būdu registruoja sumą, gavimo datą ir nuorodą. Registravimas turi idempotentinį operacijos identifikatorių ir audito autorių.
- R24: sistema dengia seniausias neapmokėtas kliento sąskaitas, leidžia dalinį padengimą, likutį saugo kaip avansą. Avansas ir nepiniginė sunaudojimo korekcija yra atskiri likučiai.
- R25: apmokėjimo terminas kalendorinėmis dienomis nustatomas sutartyje ir išsaugomas konkrečioje sąskaitoje. Tik nepadengta suma po termino yra pradelsta skola.
- Skolos padengimas ir mokėjimo paskirstymas atliekami vienu apskaitos serviso sandoriu, užrakinant kliento sąskaitą. Grynas skaičiavimo komponentas nepriklauso nuo mokėjimų saugyklos.


Pilnos PVM sąskaitos faktūros numeravimas, dokumentų išrašymo formalumai, PDF, mokėjimų paslaugų teikėjas ir banko API nėra savaime patvirtinti vien žodžiu „sąskaita“. Tai atskiras suderinamas dokumentų / integracijos sprendimas.

## Servisų atsakomybės – projektuojama architektūra

| Servisas | Vienintelis jo valdomų duomenų šaltinis |
|---|---|
| psi-rental-service | Sutartys, įranga, tarifų ir PVM sąlygų versijos bei jų galiojimas. |
| psi-metering-service (naujas) | Keturių skaitiklių bazinės ir periodinės reikšmės, tikrinimo ribos modeliui / aparatui, peržiūra, patikslinimų istorija ir patvirtinto sunaudojimo faktai. |
| psi-billing-service (naujas) | Kalendoriniai apskaitos laikotarpiai, sąlygų ir sunaudojimo projekcijos, faktiniai / preliminarūs skaičiavimai, išklotinės ir korekcijų likutis. Mokėjimų žurnalas, jų paskirstymai ir skola saugomi šiame servise, kad vieno kliento paskirstymas būtų atominis; jie atskirti nuo grynos mokesčio formulės moduliais ir portais. |
| psi-notification-service | Rodmenų priminimų, peržiūros užduočių ir apskaitos pranešimų gavimas bei vartotojo pranešimų dėžutė. |
| psi-api-gateway | Naujo API maršrutai; skaičiavimo ir mokėjimų verslo taisyklės čia nekeliamos. |
| PSI-BE | Integracijos kontraktai ir dokumentacija, Compose, Postman, sistemos E2E patikros. |
| GCP-IFRA | Naujų servisų, tapatybių, paslapčių nuorodų, Pub/Sub ir Scheduler Terraform. |

Kiekvienas naujas vykdomas servisas turi atskirą Git saugyklą, Dockerfile, Maven projektą, CI/CD, savo DB schemą ir ribotą prisijungimo rolę. Jokios bendros programinės Java bibliotekos, svetimų servisų JPA esybių, svetimų lentelių SQL užklausų ar bendro kelių servisų DB sandorio.

Sąveikai naudojami versijuoti HTTP / JSON ir Pub/Sub kontraktai. Publikuojančiame servise įvykis įrašomas su jo domeno pakeitimu per transactional outbox. Gavėjai turi patvarią inbox deduplikaciją. Pakartotas ar ne eilės tvarka pristatytas įvykis negali pakartotinai priskaičiuoti mokesčio, įskaityti mokėjimo ar sunaudoti korekcijos likučio.

Sutarčių sąlygos ir patvirtinti rodmenys perduodami kaip versijuotos projekcijos; apskaita išsaugo konkrečias panaudotas versijas. Trūkstant reikiamų duomenų išskiriamas laukimas / preliminarus skaičiavimas, o ne tariamas galutinis rezultatas. Kliento tapatybės ir įrangos ryšiai nustatomi iš patikimų servisų duomenų, ne vien iš kliento pateikto ownerSubject.

## OOP ir SOLID realizacijos ribos

- Domeno būsenos keičiamos operacijomis su invariantais, ne viešais laukais ar neribotais setteriais.
- Skaitikliai, tarifų galiojimo intervalai, keturių kategorijų sunaudojimas ir pinigai modeliuojami atskirais tipais.
- Grynas skaičiavimo komponentas nepriklauso nuo HTTP, JPA, Pub/Sub, sisteminio laikrodžio ar svetimo serviso implementacijos.
- Priėmimo politika, preliminaraus sunaudojimo įvertinimas, mokesčio skaičiavimas ir korekcijų panaudojimas turi atskiras atsakomybes. Mokėjimo paskirstymas nėra mokesčio formulės dalis.
- Mažos portų sąsajos įvedamos realiems adapteriams: savo duomenų saugyklai, sąlygų / vartotojo patikrai, įvykių perdavimui ir laiko šaltiniui.
- Controller atlieka HTTP ir DTO darbą. ArchUnit tikrina ribas; domeno ir integraciniai testai tikrina pačias taisykles.

## Skaičiavimo pagrindas

Vienos kategorijos faktinis sunaudojimas tarp dviejų priimtų to paties skaitiklio atskaitų yra galutinis minus pradinis rodmuo. A3 dvigubas tarifas ir A3 dvigubas svoris įtartinumo tikrinimui yra skirtingos operacijos; kainoje A3 negalima padauginti iš 2 du kartus.

Vienos sąlygų galiojimo atkarpos fiksuota dalis:

`mėnesinis_mokestis × tos_atkarpos_sutarties_dienos / kalendorinio_mėnesio_dienos`

Kai galiojimo atkarpai trūksta ribinio faktinio rodmens:

`viso_intervalo_kategorijos_kiekis × atkarpos_dienos / intervalo_dienos × atkarpos_kategorijos_tarifas`

Tarpinių proporcijų negalima savavališkai apvalinti iki sveikų puslapių ir taip prarasti sunaudojimo. Matoma piniginė eilutė apvalinama tik pagal R17. Išklotinėje išsaugoma paskirstymo priežastis ir šaltinio intervalas.

Sutikrinant pavėluotus rodmenis lyginama jais pagrįsta sunaudojimo vertė su tam pačiam intervalui jau priskaičiuota sunaudojimo verte. Fiksuota dalis ir realūs mokėjimai į tą palyginimą neįtraukiami kaip spausdinimo sunaudojimas. Ankstesnių tarifų / PVM versijos neištrinamos. Konkreti PVM eilučių ir jų korekcijų reprezentacija užfiksuojama skaičiavimo kontrakte prieš realizaciją.

## Esamo kodo pakeitimų vietos

- RentalContract jau turi monthlyFee, includedMonoPages, includedColorPages, monoPagePrice, colorPagePrice, pradinius ir galutinius dviejų kategorijų rodmenis. Šių laukų neužtenka keturių kategorijų apskaitai ir sąlygų versijoms.
- Dabartinis ContractService išleidžia sutarties įvykius su būsena ir rentalRequestId, bet ne visais naujai apskaitai reikalingais sąlygų duomenimis. Reikia aiškaus suderinamo įvykio / snapshot kontrakto.
- Senų dviejų kategorijų rodmenų negalima tyliai laikyti keturiais ar išgalvoti nežinomų A3 pradinių reikšmių. Pritaikymo / inicializavimo kelias turi būti aiškus ir testuojamas.
- Senas nuomos „COMPLETED“ įvykis neturi automatiškai sustabdyti R06 numatytų fiksuotų mokėjimų iki suplanuotos pabaigos.

## Privalomi priėmimo scenarijai

1. Pilnas mėnuo: 31 EUR fiksuota dalis, 100 A4 mono, 50 A4 spalvotų, 10 A3 mono, 5 A3 spalvotų duoda 34,00 EUR be PVM, taikant numatytuosius tarifus.
2. Nepilnas mėnuo: 31 EUR mėnesinis mokestis ir 10 sutarties dienų 31 dienos mėnesyje duoda 10,00 EUR fiksuotą dalį.
3. Ankstyvas užbaigimas nepanaikina likusių sutartyje numatytų fiksuotų dalių; naujas puslapių sunaudojimas po faktinio įrangos grąžinimo nepriskiriamas senam klientui.
4. A3 apmokestinamas tik vieną kartą dvigubu tarifu. Nespalvotam ar tik A4 aparatui netinkamų kategorijų įrašai nepriimami.
5. Neigiami ir chronologiškai mažėjantys rodmenys atmetami. Pataisa turi išlaikyti chronologinę tvarką su ankstesne ir vėlesne galiojančia atskaita.
6. Įtartinai mažas ir didelis normalizuotas kiekis patenka į peržiūrą. Aparato nustatymas turi pirmenybę prieš modelio nustatymą.
7. Nesant naujų rodmenų panaudojamas tik pilnas patvirtintas faktinis istorinis mėnuo, ne ankstesnė prognozė; nėra istorijos – tik fiksuota dalis ir pranešimas.
8. Mėnesio vidurio sąlygų keitimas išsaugo seną versiją ir proporcingai paskirsto puslapius, neišgalvodamas faktinių tarpinių rodmenų.
9. Pataisa, priimta po ankstesnio priskaičiavimo, išsaugo seną dokumentą ir sukuria atsekamą korekciją naujam priskaičiavimui.
10. 50 EUR mažinantis korekcijos likutis ir 30 EUR naujas mokestis duoda 0 EUR mokėtiną sumą ir 20 EUR likutį kitai sąskaitai; tai nėra gautas piniginis mokėjimas.
11. Įvykio pakartojimas / pakartotinė užklausa negali sukurti antros tos pačios korekcijos ar pritaikyti jos du kartus. Lygiagretus laikotarpio uždarymas taip pat turi būti saugus.
12. Klientas negali skaityti ar taisyti svetimų rodmenų, mokesčių, korekcijų ar mokėjimų. Darbuotojo / administratoriaus operacijos tikrinamos ir aplikacijos sluoksnyje.
13. Laikotarpių ir ribinių dienų testai apima 28, 29, 30 ir 31 dienos mėnesius. Konkreti dienų įskaitymo ir versijų galiojimo ribų konvencija turi būti aiški prieš migracijas.
14. Kiekvienas paskelbtas skaičiavimas išsaugo naudotas sąlygų, rodmenų, paskirstymo ir apvalinimo versijas, kad jo rezultatą būtų galima atkartoti.
