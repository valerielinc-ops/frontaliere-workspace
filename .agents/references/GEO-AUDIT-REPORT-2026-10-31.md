# GEO Audit Report: Frontaliere Ticino

**Data audit:** 2026-10-31
**URL:** https://frontaliereticino.ch
**Tipo di sito:** Ibrido (Publisher + tool gratuiti + job board), IT/EN/DE/FR, contenuti YMYL
**Pagine analizzate:** 47 a campione stratificato + 38 URL di sitemap controllati a parte, su 159.770 URL unici in 159 sotto-sitemap

---

## Executive Summary

**Punteggio GEO complessivo: 50/100 (Poor)**

L'infrastruttura è buona: i crawler AI entrano, il contenuto è prerenderizzato, `llms.txt` esiste. Il punteggio è basso per due motivi: i contenuti fiscali da citare contengono errori e contraddizioni, e il brand non esiste come entità fuori dal sito. Il primo problema è correggibile in giorni e va risolto prima di tutto il resto, perché più visibilità AI oggi significa diffondere anche indicazioni sbagliate su materie YMYL.

### Punteggi

| Categoria | Punteggio | Peso | Ponderato |
|---|---:|---:|---:|
| AI Citability | 58/100 | 25% | 14,5 |
| Brand Authority | 11/100 | 20% | 2,2 |
| Content E-E-A-T | 45/100 | 20% | 9,0 |
| Technical GEO | 83/100 | 15% | 12,5 |
| Schema & Structured Data | 61/100 | 10% | 6,1 |
| Platform Optimization | 61/100 | 10% | 6,1 |
| **Totale** | | | **50/100** |

I punteggi sono stime da segnali osservabili, non misure di citazioni reali (vedi "Limiti").

### Stato delle verifiche

- **Verificato direttamente su HTML o codice:** C1, C2, C3 (frasi citate), H1, H3, H4 (`baseSalary`, date job).
- **Da subagent, non ricontrollato:** gli altri finding, in particolare i conteggi di eventi passati, slug fuori tema (euristica) e assenza su Wikipedia/YouTube.
- **Falsi positivi scartati:** JSON-LD "rotto" in homepage (regex su un commento HTML) e canonical/robots mancanti (attributi senza virgolette). Canonical e robots sono corretti su 46/46 pagine in 200.

---

## Critical Issues

### C1. Box "Consiglio" invertito su tutte le pagine stipendio

Causa nel codice: `savingsCHF` è netto frontaliere meno netto residente (`services/calculationService.ts:283`), ma `advice` in `build-plugins/salaryHubContent.ts:518` tratta `> 0` come vantaggio del permesso B. L'errore è presente in IT, EN, DE, FR. Le righe 171 e 219 leggono il segno correttamente, quindi la stessa pagina si contraddice.

| Pagina | Netto B | Netto G | Il box dice | Corretto |
|---|---:|---:|---|---|
| `/calcola-stipendio/stipendio-netto-80000-chf/` | 56.440 | 47.789 | G più conveniente, "mantieni la residenza italiana" | B |
| `/calcola-stipendio/stipendio-netto-140000-chf-2-figli-vecchio-frontaliere/` | 103.160 | 115.760 | B rende di più, "valuta cambio residenza" | G |

È un consiglio sbagliato su una decisione di residenza, in una famiglia da 1.768 URL (`sitemap-salary-hub.xml`).
**Fix:** invertire il ternario nei quattro locali, con test di coerenza tra segno e testo.

### C2. Errori fiscali nella FAQ hub

`/domande-frequenti-frontalieri/`:

- "Aliquota piena" e "credito d'imposta fino all'80% del prelievo svizzero": la home del sito e la [scheda del Canton Grigioni](https://www.gr.ch/IT/istituzioni/amministrazione/dfg/stv/steuererklaerung/quellensteuer/Documents/GG%20Abkommen%20CH-IT%20Faktenblatt%20IT.pdf) indicano l'80% come ritenuta svizzera, non come tetto al credito.
- Cita "art. 66 L. 83/2023", ma la [legge ha 15 articoli](https://www.edizionieuropee.it/law/html/220/zn94_01_k50.html).
- "17 luglio 2023, data di entrata in vigore dell'Accordo": altrove il sito indica il 1° gennaio 2024.
- "Per il 2026 la franchigia sale a 10.000 €": altrove la cifra risulta già dal 2024; `llms-full.txt` riporta anche 7.500 € per i vecchi frontalieri.
- Ristorni 38,8% (FAQ) contro 40% (`/calcola-stipendio/`, `llms.txt`). Le [fonti federali](https://www.newsd.admin.ch/newsd/message/attachments/64729.pdf) danno 40% o 38,8% secondo il Cantone: va precisato, non uniformato alla cieca.
- La deduzione sanitaria da 3.000 € va riverificata sulle fonti primarie (L. 83/2023 art. 5 citato, comma 175, modifiche del D.Lgs. 117/2026).

**Fix:** verifica umana sulle fonti primarie, una sola fonte dati per i parametri fiscali, rigenerazione di FAQ e `llms*.txt` nelle 4 lingue, voci in `/correzioni/` (oggi "Nessuna correzione registrata finora").

### C3. Testo del regime sbagliato sulle pagine "vecchio frontaliere"

`distanceExplain` (`build-plugins/salaryHubContent.ts:164-165`) ignora `frontierType`: la pagina "vecchio frontaliere" spiega il regime "come nuovo frontaliere". La stessa frase afferma che il 20% viene retrocesso al comune italiano, che non trova conferma nelle fonti consultate e contraddice la descrizione dell'80% come ritenuta ridotta.
**Fix:** ramificare per `frontierType` e riscrivere il meccanismo dopo la verifica di C2.

---

## High Priority Issues

| # | Problema | Prova | Azione |
|---|---|---|---|
| H1 | Autore ospite presentato come persona, ma elencato tra le persona AI | `/autori/samuele-valente/` lo descrive come "professionista esperto"; `AdminPanel.tsx:4070-4073` lo elenca sotto "Profili autore (persona AI)". Bio/LinkedIn/CV non letti per intero | **Serve conferma del proprietario.** Se non è reale, rimuovere bio, LinkedIn e CV: su YMYL è il rischio di fiducia più serio |
| H2 | Byline con pseudonimi | "Di Marco Ferrari" non dichiara lo pseudonimo; lo fa solo `/autori/marco-ferrari/` ("non una persona reale") | Dichiararlo nella byline o firmare "Redazione (testo generato con IA)". Non creare autori né credenziali |
| H3 | Quattro articoli con slug placeholder, in sitemap e in `llms-full.txt` | `/articoli-frontaliere/kebab-case-3-5-words-max-40-chars/` (200) e altri 3; compare in SERP per la query principale | Rinomina con 301 e gate in pipeline |
| H4 | `baseSalary` stimato esposto come dato dell'annuncio; `validThrough` sospetto | Zurigo: 73.200-102.400 a uno studente 60-80%, `datePosted` 2024-05-07, `validThrough` 2026-12-29. Date di scadenza simili su quasi tutti gli annunci controllati, compatibile con build + 60 giorni (inferenza) | `validThrough` da dato reale. **Decisione del proprietario** per `baseSalary`: vedi nota sotto |
| H5 | Freschezza non dimostrata sulle pagine da citare | "Data di revisione non documentata" sulle FAQ; `dateModified = datePublished` su tutti gli articoli campionati | Date e revisore solo per revisioni avvenute davvero |
| H6 | Diluizione tematica | Lavoro 61,8% degli URL, stipendi e FAQ 1,5%; solo circa 40% degli slug articolo tocca fisco/lavoro (euristica); indicizzati pagelle Como-Napoli, Iran, burraco | Gate di rilevanza in pipeline; noindex ed esclusione da RSS/llms per il fuori tema |
| H7 | Eventi passati in sitemap | Fino a 6.067 su 8.120 URL datati; 8/8 campionati indicizzabili, senza `Event` | Fuori dalla sitemap a fine evento; `Event` con dati reali per quelli futuri |
| H8 | FAQ della home invisibile e non tradotta | 0/11 domande nel DOM statico; su /en/, /de/, /fr/ il blocco è in italiano (`index.html`) | Renderla visibile e localizzata, oppure rimuoverla |
| H9 | Entità assente | Nessun elemento Wikipedia/Wikidata, nessun canale YouTube trovato, nessuna citazione di stampa trovata | Vedi "Brand Authority" |
| H10 | Pagine giuste non trovate | FAQ "45 minuti" assente sul campione di query; telelavoro 25% senza pagina competitiva | Hub con risposta in 40-60 parole in apertura e link Fedlex/AFC |

**Nota su H4:** `frontaliere-si-o-no/AGENTS.md` (Non-Negotiable #3) rende `baseSalary` obbligatorio in ogni locale, con safe default. Togliere il campo sugli stipendi stimati, come propone il subagent schema, viola quella regola. Tenerlo mantiene il rischio di markup fuorviante, e il sito stesso dichiara altrove che l'annuncio non indica lo stipendio. Decide il proprietario: i due obiettivi non sono compatibili senza cambiare la regola.

---

## Medium Priority Issues

- **`llms.txt`:** 7.542 pagine dichiarate contro 159.770 in sitemap; articoli 3.000+/4.487/4.506 secondo il punto; 78.561 frontalieri superato da 79.121 (T2); disoccupazione ferma a dicembre 2025.
- **`llms-full.txt`:** 1,78 MB su 1,83 sono link, solo 57 KB di conoscenza. La tabella concorrenti §21 è errata su Fiscomania e Ibani: correggerla o rimuoverla.
- **Cambio:** 1,0960 (stipendi), 1,0874 (schema pagina cambio), circa 1,058 (bollettini). Serve un tasso datato unico.
- **Schema:** tutto `NewsArticle`, anche le guide evergreen; `Dataset.license` punta alla privacy policy; `exchangeRateSpread` testuale; `brand` con il numero civico ("Agip Eni 65"); SearchAction da rimuovere (`?q=` è in `Disallow`).
- **Sitemap:** 78/159 sotto-sitemap senza `lastmod`; 8.518 job senza `lastmod`; indice con la sola data di build.
- **Thin:** `/farmacie/` a una voce (199 parole); `/ricerca/` con risultati poco pertinenti (`architetto ticino` restituisce Emmen, Berna, un giardiniere).
- **Fonti:** 3 articoli su 11 senza link esterni pur dichiarando "fonti linkate nel testo", nessuna fonte ufficiale negli articoli campionati. Le FAQ invece hanno 62 link Fedlex.
- **Trasparenza:** nessun indirizzo o IDI in `/privacy/`; `/contattaci/` cita una consulenza senza nominare i professionisti; ricavi non dichiarati su `/compara-servizi/cambio-franco-euro/`.
- **`/autori/`:** 404, mentre 16 schede autore sono in sitemap.
- **Peso:** `/articoli-frontaliere/` 323 KB con testo al 4%.
- **Sicurezza:** HSTS senza `includeSubDomains`/`preload`, CSP con `unsafe-inline` e `unsafe-eval`, nessuna `Permissions-Policy`.

## Low Priority Issues

- Emoji 🔥 nei title; 10/47 title oltre 60 caratteri; offerte attive incoerenti (1.500, 988, 1.987).
- `robots.txt`: nomi obsoleti o non verificati (`Claude-Web`, `NeevaBot`, `CopilotBot`...), innocui perché coperti da `*`. Il commento su `?q=` promette un noindex che il `Disallow` rende illeggibile.
- `http://www` fa 2 redirect; 24 URL duplicati tra sitemap; 32% degli URL oltre 120 caratteri.
- `sameAs` con due Facebook e LinkedIn in due varianti; `logo` di tipo non uniforme.
- `Accept: text/markdown` restituisce HTML.

---

## Category Deep Dives

### AI Citability (58/100)

| Tipo | Score | Nota |
|---|---:|---|
| FAQ | 66 | Autonome, con norme e fonti |
| Tool | 60 | Metodo e FAQ nell'HTML |
| Articoli evergreen | 58 | Struttura utile, fonti deboli |
| Pagine stipendio | 55 | Tabelle ottime, conclusioni contraddittorie |
| News | 30 | Spesso fuori tema |

Buono: «8,7% AVS + 1,4% AI + 0,5% IPG = 10,6%».
Cattivo: «Il permesso G… resta più conveniente di ~CHF 8'651», accanto a G 47.789 e B 56.440.
Riscrittura: «Con 80.000 CHF, il nuovo frontaliere netta 47.789 CHF l'anno, 8.651 meno del residente con permesso B, prima dell'affitto svizzero.»

### Brand Authority (11/100)

| Piattaforma | Stato | Punti |
|---|---|---:|
| Wikipedia/Wikidata | Assente | 0/30 |
| Reddit | r/frontaliere moderato dal sito, nessun thread terzo trovato; accesso limitato | 3/20 |
| YouTube | Nessun canale trovato | 0/15 |
| LinkedIn | Pagina esistente | 3/10 |
| Settore e stampa | Nessuna citazione editoriale trovata | 5/25 |

Concorrenti emersi: Fiscomania, QuiFinanza, Ibani, CambiaValute (molto presente sul newsblog tio.ch), tassesvizzera.it.
Priorità: portare dataset e [Report 2026](https://frontaliereticino.ch/report/frontalieri-2026/) a USTAT, sindacati e testate di confine. Wikidata solo con fonti indipendenti; Wikipedia è prematura finché mancano citazioni di stampa.

### Content E-E-A-T (45/100)

Experience 8/25, Expertise 11/25, Authoritativeness 10/25, Trust 16/25. Il punto di forza è la disclosure sull'IA in `/metodologia/`, chiara e rara nel settore. Va mantenuta ed estesa alla byline.

### Technical GEO (83/100)

Crawler AI ammessi con 200 (solo user agent simulato), prerender su 47/47 campioni, sitemap entro i limiti, 38/38 URL controllati in 200 con canonical self, TTFB 0,12 s, Bing e IndexNow attivi. Amazonbot e Bytespider sono bloccati per scelta e non sono difetti.

### Schema & Structured Data (61/100)

| Template | Tipi |
|---|---|
| Home | Organization, WebSite, WebPage, FAQPage, HowTo, DefinedTermSet, Dataset, BreadcrumbList |
| Articoli | NewsArticle, BreadcrumbList, FAQPage |
| Job | JobPosting, BreadcrumbList, FAQPage, WebPage, Speakable |
| Stipendio | FAQPage, BreadcrumbList |
| Eventi | BreadcrumbList, FAQPage |
| Benzina | BreadcrumbList, WebPage, GasStation |
| Azienda | BreadcrumbList, Organization, ItemList |
| Ricerca | BreadcrumbList, WebPage, ItemList |

Marco Ferrari tipizzato `Organization` è una scelta onesta: non trasformarlo in `Person`.

### Platform Optimization (61/100)

| Piattaforma | Punti |
|---|---:|
| Bing Copilot | 72 |
| Google AI Overviews / AI Mode | 68 |
| ChatGPT search | 60 |
| Gemini | 55 |
| Perplexity | 52 |

---

## Quick Wins (questa settimana)

1. Invertire il box `advice` nei 4 locali e aggiungere il test (C1). Una riga per locale, su 1.768 URL.
2. Far dipendere `distanceExplain` da `frontierType` (C3).
3. Rinominare con 301 i 4 URL `kebab-case-*` e bloccare i placeholder in pipeline (H3).
4. Chiarire lo status di Samuele Valente (H1).
5. Rimuovere la tabella concorrenti §21 da `llms-full.txt` e SearchAction dalla home.

## Piano a 30 giorni

### Settimana 1: correttezza

- [ ] Quick win 1-5
- [ ] Verifica umana dei parametri fiscali sulle fonti primarie (C2)
- [ ] Fonte unica per parametri e cambio

### Settimana 2: fiducia

- [ ] FAQ e `llms*.txt` rigenerati nelle 4 lingue, voci in `/correzioni/`
- [ ] Byline con pseudonimo o Redazione, hub `/autori/`
- [ ] Date di revisione reali; decisione su `baseSalary`; `validThrough` da dato reale

### Settimana 3: focus

- [ ] Gate di rilevanza e noindex del fuori tema
- [ ] Eventi conclusi fuori dalla sitemap, `Event` per quelli futuri
- [ ] Hub telelavoro 25% e opzione LAMal/SSN
- [ ] `llms-full.txt` separato tra conoscenza e indice

### Settimana 4: entità

- [ ] Outreach con dataset e Report 2026
- [ ] Wikidata solo se ammissibile con fonti indipendenti
- [ ] Baseline Search Console e campione di query su ChatGPT e Perplexity

---

## Limiti

Non misurati: citazioni AI reali, Core Web Vitals (PageSpeed 429, CrUX senza chiave), Search Console, log di crawl, accesso dagli IP reali dei bot, stato degli annunci alla fonte. Reddit era inaccessibile. La ricerca web è solo USA. Alcune fonti normative sono secondarie: le correzioni di C2 richiedono verifica sui testi primari. Il campione copre 47 pagine su 159.770.

## Appendice: pagine analizzate

| Famiglia | Pagine | Esempio | Problemi principali |
|---|---:|---|---|
| Home | 4 | `/`, `/en/`, `/de/`, `/fr/` | FAQ invisibile e non tradotta, SearchAction |
| FAQ | 6 | `/domande-frequenti-frontalieri/` | C2, date di revisione |
| Stipendio | 4 | `/calcola-stipendio/stipendio-netto-80000-chf/` | C1, C3 |
| Tool e hub | 6 | `/compara-servizi/cambio-franco-euro/` | Cambio incoerente, ricavi |
| Istituzionali | 4 | `/chi-siamo/`, `/metodologia/` | Identità legale, `/autori/` 404 |
| Articoli | 11 | `/articoli-frontaliere/como-napoli-pareggio-2026/` | Fuori tema, date, fonti |
| Job e aziende | 6 | `/cerca-lavoro-zurigo/studenti-nutrizionista-…/` | `baseSalary`, `validThrough` |
| Eventi, farmacie, benzina, ricerca | 6 | `/eventi/berna/bern/camerata-bern-aufbruch-2026-10-24/` | Scaduti, thin |
