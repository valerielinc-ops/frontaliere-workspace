# Brief operativo — Terminare la migrazione articoli su nanako

> Documento autoportante per un ORCHESTRATORE Fable 5 in ultracode multi-agente.
> Non richiede il contesto della conversazione che l'ha prodotto.
> Scritto l'8 agosto 2026 alle ~15:45 UTC. Ogni numero è misurato da una
> ricognizione a 6 agenti eseguita oggi sui due repo e sulle superfici live —
> niente è dedotto dai nomi. Le fotografie invecchiano: `loop-sync-manifest.json`
> ha avuto 5 commit solo oggi. Rimisura ciò che è marcato ⏱.

---

## GOAL

Chiudere la migrazione degli articoli nel repo di nanako
(`nanakokyobashi-rgb/frontaliere-articles`) e **dimostrare con evidenze** che:

1. i due repo sono **distaccati**: il codice scende solo via mirror engine
   (PR automatica), i dati risalgono solo via HTTP, e il vecchio mirror
   distruttivo del corpus è cancellato;
2. il `generate article` di nanako produce articoli **subito visibili live** su
   `frontaliereticino.ch/articoli-*` — per **frontaliere E svizzera**, in
   **tutte e 4 le locale** (it/en/de/fr), sia nelle **pagine statiche** sia in
   quelle **idratate** (browser vero), realmente raggiungibili dagli utenti,
   con **tutte le superfici correlate**: hub, archivi `/tutti/`, sitemap, feed
   RSS, ticker, JS/chunk/locales, indici overlay CDN;
3. ciò che manca a nanako ed è rimasto solo dal lato di valerie
   (in primis i **gate di qualità della generazione**) è portato di là;
4. le pulizie sono fatte (branch orfani, workflow morto, articolo fantasma).

**È considerato raggiunto quando valgono TUTTE queste condizioni:**

- **G1 — Zero fantasmi**: ogni slug in `slugs.json` e in `sitemap-blog.xml` /
  `sitemap-blog-ch.xml` risponde **200 sull'apex** (variante con e senza header
  `Origin`) e sull'origin dello shard. Il fantasma noto
  (`grigioni-frontalieri-calano`, 404 da stamattina 07:02) è riparato, e in
  `fast-publish-article.yml` esiste un meccanismo di **retry/backfill** che
  impedisce alla classe di ripetersi (oggi un run fallito = pagina mai più
  pubblicata, senza segnale).
- **G2 — E2E misurato per entrambe le sezioni, SENZA deploy del sito**: una
  generazione reale (frontaliere E svizzera) tracciata commit→shard→pagina
  200→hub→sitemap→RSS→ticker→overlay CDN, con latenze annotate (baseline
  misurata oggi: ~60-115 s commit→200 quando il fast-publish riesce).
  **L'invariante fondante dell'implementazione è che NON si aspetta il deploy
  di valerie**: la prova include il registro delle run del sito nella finestra
  di misura, che deve dimostrare che nessun deploy/build del sito è partito
  tra il commit di generazione e la visibilità completa. Se una superficie
  diventa visibile solo grazie a una run del sito, l'invariante è violato e
  va trattato come difetto, non annotato e basta.
- **G3 — Matrice di visibilità 100% verde**: 2 sezioni × 4 locale ×
  {statico, idratato} sull'articolo più recente di ciascuna sezione + hub +
  archivio `/tutti/`, con la disciplina cache della trappola 9. L'idratato è
  verificato con **browser vero** (Playwright), non con grep sui bundle.
- **G4 — Distacco provato**: `tests/packages-articles-confinement.test.ts`
  verde; tree SHA di `engine/` identici nei due repo; `content/` identico o in
  ritardo solo del sync (≤1 ciclo); **nessun deploy del sito necessario** perché
  un articolo nuovo sia visibile (provato da G2); `mirror-articles-corpus.yml`
  **cancellato** (finestra aperta dal 2026-08-09 — vedi Fase C).
- **G5 — Gate di qualità sul generatore**: i guard di qualità contenuto oggi
  esistenti SOLO sul sito girano anche nella CI del corpus (almeno il cluster
  prioritario: fabrication, factuality, locale gates, duplicati, wordcount,
  headline/title — vedi Fase D), registrati in `loop-sync-manifest.json` col
  mode giusto.
- **G6 — Ciclo agentico del corpus vivo**: la issue #54 (GITHUB_PAT vuoto da
  Remote Config, cascade e triage FERMI ⏱) è risolta o escalata `needs-human`
  con diagnosi completa. Senza questo, l'auto-merge del corpus non gira e
  nessuna PR di questo piano atterra.
- **G7 — Pulizie fatte**: branch locali orfani triagiati con la regola
  meccanica (`status: added == 0` → spazzatura), worktree mergiati potati,
  branch remoti morti (rescue/* del 29-07, claude/* della migrazione,
  test-push-after-repack) chiusi o taggati snapshot; **mai** una PR come
  archivio.
- **G8 — Ogni PR mergiata dall'auto-merge** su `## LGTM` con `tests` verde,
  nessun merge a mano, nessuna draft lasciata ferma.
- **G9 — Rendiconto**: esito, evidenze e latenze in un commento sulla issue
  `nanakokyobashi-rgb/frontaliere-articles#28` (backlog porting) + aggiornati
  §9.6/§12.5 di `docs/articles-generator-migration.md` (repo SITO) quando §5.7
  è eseguito.

### NON-GOAL

- **Non** toccare `content/**` a mano (lo scrive solo il generatore).
- **Non** clonare shard: né i cantonali (20+ GB) né gli 8 shard articolo
  (10-204 MB) — si leggono via `gh api` e curl.
- **Non** generare articoli-test o contenuto finto in produzione: le prove E2E
  usano i generatori veri (sono già in produzione) o il refresh idempotente del
  daily-brief. Se il vaglio topic svizzero rifiuta tutto (oggi: 5 run a vuoto
  dalle 06:53 ⏱), NON abbassare le soglie per far uscire qualcosa: la prova E2E
  svizzera si fa sull'ultimo articolo reale (05:19 UTC, catena già misurabile
  a posteriori) + un dispatch documentato.
- **Non** rifare il rendering markdown-lite del bollettino né il template
  email: è un lavoro GIÀ tracciato in una issue dedicata aperta oggi (cercala
  sul sito: statica vs idratata + email indistinguibile dalla newsletter).
  Non duplicarla, al massimo linkala.
- **Non** toccare Pages/settings degli shard (admin=false sul lato nanako per
  l'utente gh) né la generazione di rimbalzo (altro lavoro).

---

## ARCHITETTURA MISURATA — leggila prima di orchestrare

### Le due vie di pubblicazione partono dallo STESSO push, in parallelo

Un push su `main` del corpus che tocca `content/**` fa partire **allo stesso
secondo** (misurato: 13:59:46Z entrambe):

1. **`fast-publish-article.yml`** (674 righe) → HTML. Deriva l'id dal diff
   (`content/blog-body{,-ch}/<loc>/<id>.ts`; `-ch` ⇒ svizzera), renderizza con
   `npx tsx scripts/publish-article-fast.mjs` le 4 pagine locale + bridge +
   archivio `/tutti/` + refresh della griglia hub (`refresh-hub-landing.mjs`,
   blocco `ssg-article-grid`, create-or-refresh), poi **UN solo push per
   locale** (articolo+hub insieme — due push ravvicinati creavano build Pages
   concorrenti di cui una `errored`) verso gli 8 shard
   `nanakokyobashi-rgb/frontaliere-articoli{frontaliere,svizzera}-{it,en,de,fr}`
   via `scripts/lib/push-article-shard-incremental.sh` (plumbing su clone
   `--filter=blob:none`, merge-aware, mai cancella). Poi upload asset su R2 e
   **purge Cloudflare di apex E origin** (l'origin è quello decisivo, vedi
   trappola 8), verifica hard origin-200 con recovery delle build Pages
   `errored` a 0 ms, verifica soft apex. Kill switch in ordine: file
   `.github/FAST_PUBLISH_DISABLED` → var `FAST_PUBLISH_ARMED=false` → input
   `dry_run`.
2. **`publish-api.yml`** (312 righe) → dati. `build-api.mjs` → superficie JSON
   alla **radice** di `https://nanakokyobashi-rgb.github.io/frontaliere-articles/`
   (manifest, articles, swiss-articles, meta-*, meta-ch-*, slugs, 3 sitemap,
   news-candidates, 10 RSS, ticker) + `build-blog-index.mjs` →
   `blog-index-<sezione>-<locale>.json`. Push edge su R2: le sitemap con chiave
   `edge/<nome>` (il Worker le serve da lì: il passthrough apex strippava gli
   hreflang, 15230→0), gli indici blog con chiave `data/` (la SPA li legge da
   `cdn.frontaliereticino.ch/data/...`), `max-age=600` + purge. Infine
   `repository_dispatch articles-published` al sito (cron 5:23/17:23 come rete).

**Catena di serving**: apex `frontaliereticino.ch` = Worker Cloudflare
(`infra/cloudflare-worker/locale-router.js`) → `origin-<shard>-<loc>.frontaliereticino.ch`
= GitHub Pages dello shard. Le pagine articolo NON stanno sul Pages del corpus.

### Le superfici lettore del sito (chi mostra cosa)

- **Liste hub SPA**: primo paint dal bundle (`import { ARTICLES } from
  '@/data/blog-articles-data'` — symlink dentro `packages/articles/content/`),
  poi overlay runtime da `cdn.frontaliereticino.ch/data/blog-index-<sez>-<loc>.json`
  (add-only, fail-open, finestra 150 + fallback `-full`). La stessa path
  same-origin sull'apex è un 404: l'overlay vive SOLO sul CDN.
- **Landing hub statiche**: le scrive il CORPUS (refresh-hub-landing a ogni
  fast-publish). Il build del sito NON è sul serving path degli hub articolo
  (`ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` acceso dal 29-07;
  `deploy-shard-sections.sh` esclude le sezioni articolo).
- **Il sito dipende ancora da `packages/articles/content`** (via symlink
  tracciati) per: liste SPA, titoli/excerpt (chunk `blog-meta-*`), corpi
  (`blog-body*`), ricerca (`SiteSearch.tsx:47`), correlati JobBoard (:4776),
  prerender statico (staticPagesPlugin:1723,1769; sectionPagesPlugin:62;
  seoHubsPlugin), pagine autore, news-sitemap-whitelist, riscrittura immagini,
  chunk naming vite. Per questo il sync **ricommitta il corpus di nanako dentro
  il sito** (`sync-articles-sitemaps.yml` → `scripts/pull-articles-corpus.mjs`,
  misurato: corpus 13:59:42 → sito 14:05:07). `articles.json` NON porta i
  titoli: l'API non può sostituire il pull.
- **Widget inline**: allowlist di 3 ID in `BlogArticles.tsx:44-53`
  (2 fuel-price + 1 border-wait), nessuna sintassi marker nel body.

### Stato del distacco, misurato oggi ⏱

- `engine/`: **byte-identici** (tree SHA `aa0a22b0` su entrambi; 25 file;
  `index.ts`/`articleSections.ts` stessi blob). Mirror engine sano: PR
  `engine-lockstep-auto` (#8, #14, #26 tutte mergiate), run ogni 6h in 12-18s.
- `content/`: **byte-identici** in questo istante (tree `376ef0b7`, 15.100
  file per lato). Direzione: nanako produce, il sito tira indietro.
- `mirror-articles-corpus.yml`: **inerte** (solo `workflow_dispatch`, trigger
  veri commentati «DISABLED AT CUTOVER», ultima run 02-08). La cancellazione
  (§5.7) è pianificata «non prima del 2026-08-09» in
  `docs/articles-generator-migration.md` §9.6/§12.5/§13.2/§13.4 e nei commenti
  di #4974. **Nessuna issue/PR aperta la esegue: nessun automatismo lo farà da
  solo.** §13.2 dice come va giudicata: per subtree — `content/` può avere solo
  commit del sync, `engine/` zero commit non-mirror.
- La metà `host/` del `SiteShellContract` vive SOLO sul corpus, col gate
  runtime `generator/tests/shell-contract-coverage.mjs` (boot vero, 41 membri
  derivati, floor 20) in `generator-ci.yml`.

### I DUE DIFETTI LIVE trovati oggi (parte del lavoro, non curiosità)

- **P1 — L'articolo fantasma.** `grigioni-frontalieri-calano` (commit 769218af
  07:02:38Z): `publish-api` riuscito → è in sitemap, `articles.json`,
  `slugs.json` e **linkato dall'hub live** (link rotto visibile agli utenti);
  `fast-publish` run 31245282583 fallito in 29 s (npm install, postinstall
  onnxruntime-node, ETIMEDOUT) → **la pagina è 404 da 8,5 ore** e nessun
  meccanismo la ritenta: i fast-push successivi portano solo il proprio
  articolo, mai backfill. Il 404 è pure negative-cached (trappola 8).
- **P2 — Il ciclo agentico del corpus è FERMO.** Issue #54 (priority:urgent,
  oggi): `GITHUB_PAT` vuoto dopo `load-rc-env.mjs` — cascade merge/deploy/
  followup e triage bloccati. Verifica lo stato APPENA parti: senza ciclo,
  le PR del corpus non si auto-mergiano e G8 è irraggiungibile.

---

## TRAPPOLE MISURATE — ognuna è costata un incidente

1. **`tsx`, non `node`** sul corpus (`npx -y tsx@4 <script>`); il corpus non ha
   `node_modules`.
2. **ENTRAMBI i clone locali sono shallow** — anche il corpus (26 commit
   visibili; `git log --grep` locale è inaffidabile: la storia vera di un file
   si legge con `gh api commits?path=...`). Il sito ha HEAD locale vecchio
   (`d13a92ab5`): per lo stato attuale leggi il remoto (`gh api contents`,
   `git ls-remote`).
3. **`git push` normale sul sito si PIANTA** (40-85 min, 1,9 GB RSS). Rimedio:
   `git -c pack.window=0 -c pack.threads=1 push --no-thin --no-verify --force origin <branch>`.
   `gh pr create` vuole `--head "$(git rev-parse --abbrev-ref HEAD)"`;
   `gh pr view` senza argomenti non trova la PR; `--force-with-lease` dà
   «stale info».
4. **Body PR con header obbligatori DIVERSI**: sito `## Implementato` +
   `## Non implementato`; corpus `## Implementato` + `## Non implementato (ancora)`.
   Un `###` subito sotto l'header svuota la sezione (si chiude al primo heading
   di qualunque livello) e `contract` fallisce in 15 s.
5. **`loop-sync-manifest.json` decide DOVE si corregge** (⏱ 77 voci: 34
   `identical` → fix sul SITO che poi scende, 27 `adapted` → corpus ok, 16
   `corpus-only`). Cambia più volte al giorno: rileggilo prima di OGNI file che
   tocchi. Se porti un file nuovo nel ciclo, registralo col mode giusto.
6. **Engine si tocca nel SITO** (`packages/articles/engine/`), mai sul corpus
   (sovrascritto al mirror). Se tocchi il contratto, la metà `host/` va
   spedita nello stesso giro (il gate dei 41 membri ti copre, ma solo su PR
   corpus).
7. **Disco quasi pieno** ⏱ (~5 GB liberi su 460, con punte a 0 che hanno già
   bloccato lavoro). `df -h` prima di OGNI scrittura. Worktree SEMPRE sparse
   (~367 MB vs 3,9 GB pieno): `git worktree add ... -b <branch> origin/main`,
   poi `printf '/*\n!/public/\n!/data/\n' | git sparse-checkout set --no-cone --stdin`,
   poi symlink a `node_modules` (MAI `npm install`). Dentro uno sparse,
   `public/` e `data/` NON esistono: l'assenza non prova niente
   (`git show HEAD:<path>`). **Massimo 5-6 worktree concorrenti.**
   Playwright: i browser NON sono scaricati; `npx playwright install chromium`
   costa ~1-2 GB — fallo UNA volta, in un posto solo, dopo un `df -h`.
8. **Il purge che conta è sull'URL ORIGIN, non sull'apex.** Il Worker
   negative-cacha i 404 origin per 2h (`ORIGIN_CACHE_TTL=7200`,
   `cacheEverything`); un purge solo-apex «riesce» e non cambia nulla
   (misurato: 8 URL apex purgati, 404 con age crescente; aggiunto l'origin,
   200 age=0 subito). Dopo QUALUNQUE riparazione di pagina: purge di
   `frontaliereticino.ch/<rel>` E `origin-<shard>-<loc>.frontaliereticino.ch/<rel>`.
9. **Cloudflare tiene DUE cache per la stessa URL**: con e senza header
   `Origin` (misurato: HIT age 5749 vs MISS age 0 nello stesso secondo). curl
   «nudo» non dice nulla su ciò che vede la SPA. Ogni verifica apex si fa DUE
   volte: `curl -sI <url>` e `curl -sI -H 'Origin: https://frontaliereticino.ch' <url>`.
   (Su `nanakokyobashi-rgb.github.io` la variante Origin NON esiste: lì curl
   basta.)
10. **La verifica idratata richiede un browser vero.** L'HTML statico cita solo
    l'entry module; i chunk reali stanno in `__vite__mapDeps` e si caricano a
    runtime. Il grep sui bundle depista anche per id ≠ slug: negli hub en/de/fr
    l'id italiano compare SOLO nell'URL immagine, gli href usano slug
    localizzati.
11. **`last-modified` degli shard è inutilizzabile** per datare un go-live:
    ogni deploy riscrive archivio e hub e rinnova i timestamp di tutto lo shard.
    Il primo go-live si data con `pushed_at` dello shard e i log del run.
12. **PAT e permessi**: `gh` è autenticato come `valerielinc-ops` (admin sul
    sito, NON admin sul corpus) — punta SEMPRE `--repo` esplicito sul corpus.
    Nei workflow del corpus il PAT di Remote Config **non può fare workflow
    dispatch** (403, è il motivo per cui la catena usa i push come eventi);
    solo `GITHUB_PAT_NANAKO` dispatcha. Secret in shell: `source bin/rc-env.sh`
    da `~/Projects` (92 variabili; il loader esce 0 anche a vuoto, rc-env.sh
    aggiunge il check). Service account = owner di fatto del progetto Firebase:
    **Firestore in sola lettura**, niente comandi distruttivi.
13. **`/bin/bash` è 3.2** negli script: niente array associativi, niente
    `timeout`. E i log vitest del sito sono pieni di falsi rossi: filtra solo
    `FAIL ` (con lo spazio); `cancelled` appare come `fail`.
14. **Auto-merge in entrambi i repo** (`tests` verde → review → merge su
    `## LGTM`, ~8-15 min; osservata 2 volte una race del pr-review-loop —
    review partita e skippata in coppia, documentata in nanako#40). MAI merge a
    mano, MAI draft ferme. Ma vale solo se il ciclo è VIVO (vedi P2/G6).

---

## PLAN — orchestrazione per il minimo wall-clock

Sei un orchestratore ultracode: usa il tool Workflow con fan-out aggressivo.
**Tutto ciò che è read-only parte SUBITO e insieme** (fase A+B in parallelo,
10-16 agenti concorrenti va bene); le scritture usano worktree sparse isolati
(cap 5-6, trappola 7); le uniche barriere vere sono: (i) P2 risolto prima di
aprire PR sul corpus, (ii) G2/G3 finali dopo che P1 è riparato. Ogni claim di
visibilità va **verificato avversarialmente**: un secondo agente con lente
diversa (cache, locale, idratazione) deve poter falsificare il primo.

### Fase A — Triage vitale (subito, ~minuti)

- **A1 · P2**: stato del ciclo corpus ORA. `gh issue view 54 -R nanako...`;
  ultime run di triage/merge cascade. Diagnosi: il parametro RC del PAT è
  vuoto? scaduto? rinominato? Se è un problema di credenziale che solo il
  proprietario può ruotare → label `needs-human` + commento con la diagnosi
  completa e STOP delle PR corpus finché non torna verde (le PR del sito non
  sono bloccate). Non inventare PAT, non toccare Remote Config in scrittura
  senza certezza assoluta di cosa stai scrivendo.
- **A2 · P1 riparazione immediata**: `gh run rerun 31245282583 -R nanako...`
  (il fallimento era un ETIMEDOUT transitorio di npm). Se il rerun è verde:
  purge apex+origin dell'URL (trappola 8) e verifica 200 nelle 4 locale. Se il
  rerun non è possibile/fallisce: leggi `fast-publish-article.yml` per la via
  di dispatch manuale (occhio: `dry_run` default true) o attendi il backfill
  della Fase D1. Verifica anche che non esistano ALTRI fantasmi: confronta
  TUTTI gli slug di `slugs.json` (frontaliere+swiss) con un HEAD sulle pagine
  (campione completo, è qualche migliaio di curl -sI — falli fare a un agente
  con concurrency, sull'apex senza Origin basta per il 404-check, ma i 404
  trovati vanno ricontrollati anche con Origin e sull'origin host).

### Fase B — Matrice di verifica (parallela ad A, tutta read-only)

Fan-out di agenti di verifica, uno per cella o per riga:

- **B1 · Pagine articolo**: per ciascuna sezione {frontaliere, svizzera},
  l'articolo più recente: 4 locale × {apex senza Origin, apex con Origin,
  origin host} → 200, `NewsArticle`, `datePublished`, hreflang, immagine CDN.
- **B2 · Hub e archivi**: hub delle 2 sezioni × 4 locale (statico: blocco
  `ssg-article-grid` contiene gli articoli di oggi) + archivio `/tutti/`
  (ordinamento cronologico, l'ultimo articolo c'è).
- **B3 · Superficie dati** ⏱: manifest (counts coerenti: articles==sitemapBlogUrls;
  swiss 647 vs sitemap-ch 644 è VOLUTO — 3 slug shadowed via
  `content/swiss-article-canonical-overrides.json`), articles/swiss-articles/
  slugs/meta-*/meta-ch-*, 3 sitemap, 10 RSS (il più recente di ogni sezione
  presente nei feed giusti e ASSENTE da quelli sbagliati), news-candidates
  (≤200, finestra 48h), ticker (primo elemento = ultimo articolo),
  `cdn.frontaliereticino.ch/data/blog-index-{frontaliere,swiss}-<loc>.json`
  freschi (newest == ultimo articolo).
- **B4 · Idratazione (browser vero)**: dopo `npx playwright install chromium`
  (UNA volta, df -h prima): per le 2 sezioni × 4 locale, apri l'articolo più
  recente e l'hub; verifica che il body renda (non skeleton), che la lista hub
  contenga l'ultimo articolo (overlay CDN funzionante), che la console non
  abbia errori di chunk/i18n mancanti, e che i chunk `blog-meta-<loc>` /
  `blog-body*` si carichino. Screenshot come evidenza. (È qui che si vede ciò
  che curl non può vedere — trappole 9-10.)
- **B5 · Distacco**: confinement test (sito) verde al HEAD remoto; tree SHA
  engine/content confrontati tra i due HEAD remoti; grep che nel build del sito
  non entri nulla del corpus se non via `packages/articles` pullato; conferma
  che gli 8 shard articolo sono tutti di nanako e che `section-shard-owners.json`
  li dichiara.
- **B6 · Indipendenza dal deploy del sito (l'invariante fondante)**: due prove.
  (i) *Storica*: per gli articoli usciti oggi, incrocia i timestamp
  commit→shard→200 con `gh run list` del SITO nella stessa finestra — nessuna
  run di build/deploy del sito deve stare sul percorso (il sync sitemaps NON
  conta: pulla superfici già pronte, non builda). (ii) *Censimento del
  residuo*: elenca le superfici lettore che ANCORA si aggiornano solo con un
  rebuild del sito — oggi note: la ricerca interna (`SiteSearch.tsx:47` importa
  dal bundle), i correlati del JobBoard (:4776), il primo paint delle liste SPA
  (mitigato dall'overlay CDN — verifica che l'overlay copra il gap), prerender
  statici delle sezioni non-articolo, pagine autore. Per ciascuna: latenza
  reale (quanto resta stantia tra un deploy e l'altro?) e verdetto — accettata
  e documentata, o da spostare su una fonte runtime. Le superfici PRIMARIE
  (pagina articolo, hub, archivio, sitemap, RSS, ticker, overlay liste) devono
  risultare deploy-indipendenti per costruzione, con evidenza.

Ogni cella produce: URL/comando, atteso, osservato, verdetto. Un agente
«completeness critic» chiude la fase: cosa NON è stato guardato?

### Fase C — Cancellare il mirror morto (dal 2026-08-09, repo SITO)

- Verifica il criterio §13.2 per subtree ⏱: `engine/` zero commit non-mirror
  dal cutover; `content/` solo commit del sync (`gh api commits?path=...`).
- Se soddisfatto e la data è ≥ 2026-08-09: UNA PR sul sito che rimuove
  `.github/workflows/mirror-articles-corpus.yml`, aggiorna
  `docs/articles-generator-migration.md` (§5.7 eseguito, §9.6/§12.5 chiusi) e
  cita le evidenze. Auto-merge come sempre. Se la data non è ancora arrivata:
  prepara il branch, NON aprire draft — apri la PR appena scatta la finestra.
- Attenzione al manifest (trappola 5): il workflow è del sito, ma se compare
  nel manifest del ciclo, rispetta il mode.

### Fase D — Portare ciò che manca a nanako (PR parallele su worktree isolati)

- **D1 · Backfill/verify nel fast-publish** (corpus): aggiungi al workflow (o a
  uno step post-publish) una riconciliazione `slugs.json ↔ shard`: gli slug
  annunciati senza pagina vengono ripubblicati (o almeno aprono una issue con
  label del ciclo). È il fix sistemico di P1. Test relativo in
  `generator/tests/`.
- **D2 · Gate di qualità della generazione** (il gap più grosso): oggi girano
  SOLO sul sito, mentre a generare è nanako. Cluster prioritario da portare
  nella CI del corpus: `article-fabrication-guard`,
  `article-factuality-gates`, `article-locale-gates`,
  `article-duplicate-detection`, `article-body-wordcount`,
  `blog-headline-validation`/`blog-title-casing`. Per ciascuno: guarda il mode
  nel manifest (nessuno di questi era registrato al momento della misura ⏱ —
  ricontrolla); decidi `adapted` o `corpus-only`; UNA PR per cluster coeso, in
  worktree separati, parallele. I restanti (sanitizers, density, tax-guard,
  category-diversity, defect-history, seo-fallback, slug-derivation,
  schema-translators, hero-image-discover, contextual-links,
  slugs-sitemap-sync, body-typescript-syntax, meta-descriptions, ticker-data,
  archive-chronological) → censimento con stima e priorità nel rendiconto G9,
  portali solo se il tempo lo consente.
- **D3 · Svizzera a secco** ⏱: 5 run consecutive «Record rejected topic
  candidates» oggi. Diagnosi read-only del vaglio (perché rifiuta? soglie?
  fonti candidate esaurite?) → SOLO diagnosi e raccomandazione nel rendiconto.
  Non allentare soglie di qualità per far uscire volume (vedi NON-GOAL).

### Fase E — E2E finale (dopo A2/D1, barriera vera)

- **Frontaliere**: il prossimo articolo generato dal cron (4 slot/ora: minuti
  7 e 52 frontaliere, 22 e 37 svizzera) o un refresh idempotente del
  daily-brief. Traccia: commit → run fast-publish + publish-api (stesso
  secondo) → pushed_at shard → 200 origin → 200 apex (entrambe le varianti
  Origin) → hub → sitemap/RSS/ticker/overlay. Annota le latenze.
- **Svizzera**: idem sul primo articolo svizzero che esce; se il vaglio resta
  a secco per tutta la finestra di lavoro, documenta la catena sull'articolo
  delle 05:19 di oggi (evidenze a posteriori: commit c6897c28 → shard
  05:20:25-33 → live) + un dispatch di `generate-article.yml` sezione svizzera
  col suo esito (anche un rifiuto topic è un esito valido: prova che il
  generatore gira).
- Rilancia le celle B interessate (matrice di nuovo verde sull'articolo nuovo).
- **In parallelo alla misura, registra `gh run list` del SITO sull'intera
  finestra**: la prova E2E vale solo se dimostra che nessun deploy di valerie
  è servito (cella B6-i sull'articolo nuovo). Se nella finestra parte per caso
  un deploy del sito, ripeti la misura sul ciclo successivo: l'invariante va
  provato pulito.

### Fase F — Pulizie (parallele a D/E, a basso rischio)

- Branch locali del sito: 28 creati oggi da una flotta (fix/*, feat/*) che NON
  esistono su origin con quei nomi. Per ciascuno la regola meccanica dello
  stato orfano: `git diff --stat origin/main...<branch>` + la domanda
  «contiene file `added` che main non ha?». Attento al falso negativo misurato:
  `w/p5360` È su origin come `fix/structural-locale-html` — matcha per SHA
  (`git ls-remote origin | grep <sha>`), non per nome. Cancella solo ciò che è
  provabilmente contenuto in main o già pushato sotto altro nome; nel dubbio,
  tag `snapshot/<nome>` server-side e via.
- Worktree: pota i mergiati (`git worktree list` + stato branch). Branch remoti
  morti (gh-pages 05-29, cdn-assets 06-03, test-push-after-repack 07-14,
  7× rescue/* 07-29, 3× claude/* 08-01/03): se il contenuto è in main → delete;
  se no → tag snapshot poi delete. MAI aprirci PR.
- Aggiorna nanako#40 punto 1 se D1/D2 lo toccano (collision detector con draft:
  il fix #5364 è sceso solo sul sito — verificare se il corpus l'ha ricevuto ⏱).

### Sequenza temporale attesa

A e B partono insieme (B non dipende da niente; A1/A2 sono 2 agenti).
D parte appena A1 dà il verdetto sul ciclo (le PR corpus hanno senso solo con
auto-merge vivo; quelle sito partono comunque). C alla data giusta. E chiude.
Con auto-merge a ~8-15 min/PR e PR parallele, il critical path realistico è:
diagnosi P2 → PR D1/D2 in parallelo → E2E. Se P2 richiede il proprietario,
tutto il resto si completa lo stesso e G6 resta l'unico punto aperto nel
rendiconto.

---

## Aspettative da tenere oneste

- **Il distacco è già quasi vero**: engine e content sono byte-identici oggi,
  il mirror morto è inerte, la catena publish→live fa ~1 minuto. Il lavoro vero
  è nei bordi: il backfill che non esiste (P1 è la prova), i gate di qualità
  rimasti sul repo sbagliato, il workflow da cancellare, e la VERIFICA seria
  (idratata, per-locale, cache-aware) che nessuno ha mai fatto tutta insieme.
- **Il ciclo fermo (P2) è il rischio numero uno del piano**: senza PAT non si
  auto-mergia nulla sul corpus. Verificalo per primo, escalalo subito se serve
  il proprietario.
- **Un run di CI del corpus con test di qualità nuovi può scoprire difetti
  negli articoli esistenti** (3.119 + 647): se un gate portato fallisce sul
  corpus attuale, il default è documentare gli offender nel rendiconto e
  scoprire se è un difetto vero o una differenza di contesto — non annacquare
  il gate per farlo passare.
- **La sezione svizzera che rifiuta i topic non è un bug da «aggiustare»**:
  è il vaglio che fa il suo lavoro in un giorno povero di candidati. La
  risposta giusta è capire e riferire, non forzare.
