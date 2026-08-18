# Brief operativo — Chiudere ciò che resta dopo la migrazione articoli

> Documento autoportante per un ORCHESTRATORE in ultracode multi-agente.
> Non richiede il contesto della sessione che l'ha prodotto.
> Scritto la notte fra l'8 e il 9 agosto 2026. Ogni numero qui dentro è **misurato**
> in quella sessione, non dedotto dai nomi. Le fotografie invecchiano in fretta su
> questi repo (il ciclo agentico apre e mergia PR da solo, ~8-15 min l'una):
> **rimisura ciò che è marcato ⏱ prima di agire.**

---

## ⚑ ESECUZIONE DEL 9 AGOSTO POMERIGGIO — stato reale

Il piano è stato eseguito. Sintesi in una tabella, dettagli dentro ogni fase.

| Fase | Stato | Dove |
|---|---|---|
| **0.1** label `follow-up` | ✅ chiusa | 4 label create + PR corpus **#89** (mergiata) |
| **0.1b** deferred work delle 7 PR | ✅ chiusa, ma ha scoperto **#99** | nulla di recuperabile: tutti hard-exclude |
| **0.2a** i fix #76 e #77 | ✅ chiusi | PR **#88** e **#91** (mergiate), issue #76/#77 chiuse *col fix* |
| **0.2b** il fixer e i workflow | ✅ chiusa — **causa diversa da quella ipotizzata** | PR **#93** (mergiata) |
| **0.4** telemetria muta | ✅ chiusa dentro #93 | |
| **A** control character | 🟡 **riparata al 52%, verificata sulla pagina** | #94 aperta per il resto, **#95** per la causa |
| **B** ticker | ✅ chiusa e verificata | parità completa col corpus |
| **B** RSS (i dieci feed) | ✅ chiusa e **verificata sulla superficie** | PR sito **#5463** |
| **C** mirror morto | ⏸ **data spostata al 2026-08-15** | finestra sporcata da un commit del 08-08 |
| **D** gate | ✅ primo cluster portato | PR corpus **#100** (mergiata) |
| **E** pendenze non tracciate | ✅ tutte tracciate | 6 issue corpus + 7 issue sito |
| **#96** sezione svizzera | ✅ **SBLOCCATA, verificata end-to-end** | #106 + #108 + amnistia |

**La sezione svizzera pubblica di nuovo.** Dopo il merge di #106 e #108 è stata applicata
l'amnistia sugli strike (`reset-evergreen-strikes.mjs`, commit `3c398bb57`): strike
**151 → 81**, i **126 ban permanenti intatti**, azzerate solo le 70 keyword del pool
svizzero (52 delle quali erano già ritirate). Poi una generazione reale, dispatchata a
mano:

```
Pre-flight check su 110 keyword...
📚 Articolo evergreen: "terzo pilastro 3a svizzera vantaggi 2026 canton Basilea"
   ✅ Articolo IT generato
   🔎 Gate deterministici: 1 problemi (0 BLOCCANTI)
```

Prima erano `source-fidelity-low` con recall 0-11% su **ogni** articolo. Il commit
`Generate blog article (svizzera)` è delle 14:38:54Z — **il primo dopo 17 ore** — e
`swiss-articles.json` è passato da 649 a **650 articoli**, con `ultimo` 2026-08-09T14:38:53Z.
La catena completa è verificata: fix mergiata → amnistia applicata → articolo generato →
committato → **pubblicato sulla superficie dati**. Le quattro locali rispondono **200
sull'origin**.

> ⚠️ **E proprio quella generazione ha scoperto una variante NUOVA dell'articolo
> fantasma — issue #114.** Il `fast-publish` è uscito `failure` perché lo shard FR stava
> ancora buildando; poi la situazione si è **invertita** e a rispondere `404` era
> l'**italiano**, cioè la locale che il gate aveva visto verde.
>
> ```
> origin-articolisvizzera-it   200      <- l'origin e' sano
> apex (URL nuda)              404      cf-cache-status: HIT, cache-control: max-age=14400
> apex (?cb=<epoch>)           200      <- stessa origin, chiave di cache diversa
> ```
>
> **Non è la pagina a mancare: è il `404` a essere stato messo in cache per QUATTRO ORE**
> mentre la pagina nasceva. `reconcile-article-shards` non lo vede (lo shard *ha* la
> pagina) e il gate non lo previene (al suo controllo quella locale era `200`). La
> finestra di esposizione sono le prime 4 ore di vita dell'articolo — cioè quando Google
> lo scopre dalla sitemap appena aggiornata.
>
> **Il purge mirato riporta `success: true` e non evita niente**: `age` continua a
> crescere. È la forma peggiore, perché sembra aver funzionato. Un `purge_everything` lo
> risolverebbe e **non va fatto**: è esattamente ciò che
> `tests/cf-zone-purge-blast-radius.test.ts` esiste per impedire.

**La prova che la Fase 0 ha funzionato non è che le PR sono verdi: è che il ciclo ha
ripreso a lavorare da solo.** Poche decine di minuti dopo l'apertura, le issue nuove
erano già instradate — **#94 `agent:in-progress`** (il fixer ci sta lavorando), #98
`agent:fix`, #99 `agent:fix-queued`. Prima di oggi il fixer non poteva pushare un
workflow, il triage non mintava issue e la telemetria taceva.

---

## ⚑ SECONDA ESECUZIONE (pomeriggio tardi) — implementazione delle issue aperte

Cinque agenti su **aree di file disgiunte**, ciascuno con un verificatore avversariale.
Mergiate: **#103, #105, #106, #107, #109**. Aperte e verdi: **#104, #108, #110, #111**.

**Le due cose che contano più delle PR.**

**1. I verificatori hanno trovato difetti VERI in lavoro già mergiato, e in entrambi i
casi il difetto era nel rimedio.**

- **#105** (backstop del marker): `delivered` era misurato una volta per **sessione** e
  applicato **per-PR**. Su `error_max_turns` — la norma sui batch grandi — il backstop
  timbrava «zero outstanding items» sulle PR che la sessione **non aveva mai raggiunto**,
  e il collector le salta poi per sempre: *esattamente la perdita irreversibile che il
  file esiste per impedire*. Corretto in **#110**: la consegna la decide
  `stepOutcome === 'success' && !sandboxBroken`, cioè il segnale che era già cablato,
  già letto, e usato **solo dentro una stringa di log**.
- **#106** (svizzera): **falso verde**. Il guard di cablaggio faceva asserzioni globali
  sul file, e la seconda era soddisfatta dall'**altro** call-site: un'indirezione banale
  rimetteva il brief frontaliero nel prompt svizzero con **12/12 test verdi**. E lo strip
  del brief cambiava l'input di un secondo consumatore non dichiarato — il learner degli
  acronimi passava da `present` ad `absent`, fabbricando evidenza bloccante dal nulla.
  Corretto in **#108** con l'esenzione sull'URL, più semplice e senza effetti collaterali.

**2. Tre errori miei, tutti della stessa famiglia: un confronto parziale che risponde
alla domanda sbagliata.**

- Ho validato il manifest di #107 confrontando **`path` e `mode`** di ogni voce — 0 perse,
  0 cambiate — e il file **regrediva le `baseline` di quattro voci** aggiornate da #103.
  I campi che non guardavo erano esattamente quelli appena cambiati.
- Ho «rifuso» tre branch su `main` **riusando l'intero albero del branch** sopra il nuovo
  parent. Non è un rebase: **scarta i commit più recenti di `main`**. #104 sarebbe
  arrivata al merge riportando il manifest da 212 a **101 voci**, cioè revertendo #107 e
  #109 — ed era **verde**. Rifatto con l'overlay dei soli file voluti.
- Il reset dei branch a `main` li ha resi momentaneamente vuoti e un'automazione **le ha
  chiuse**. Riaperte: i branch avevano già i commit veri.

**La regola che ne esce, e che vale oltre questo repo**: quando si verifica che un
cambiamento è «solo additivo» su una struttura ricca, il confronto va fatto sul
**contenuto serializzato di ogni elemento**, non su due campi scelti. E un rebase
server-side si fa **sovrapponendo i file cambiati a `base_tree`**, mai riusando l'albero
del branch.

**3. `main` è stato rosso per un'ora, per interazione fra due PR mie entrambe verdi.**
#105 ha aggiunto uno script sotto `scripts/ci`; #107 ha dichiarato `scripts/ci` **root
censito** (sotto un root ogni file deve avere una voce). Il censimento era stato calcolato
prima che #105 atterrasse. Nessuna delle due era sbagliata: **il difetto era l'ordine di
merge**, e il collision detector non lo vede perché non toccano lo stesso file. Riparato
da **#109**; il rischio strutturale è scritto lì nel «Non implementato».

**4. La Fase A ha una scadenza più stretta di quanto si credesse.** Rimisurando i file
reali: **29 file / 582 occorrenze**, non 32/592 — e **10 occorrenze sono già andate
perse** perché il generatore ha riscritto tre `content/blog-meta-*.ts` e il sanificatore
ha tolto il byte lasciando la cifra orfana (`Il "territorio poroso"` → `Il 3territorio
poroso3`, `sarà` → `sar0`). **La finestra non si sta chiudendo: si è già chiusa in parte.**

E la tabella `(byte C0, cifra) → carattere` che la issue chiedeva **non esiste**: la
stessa `é` è scritta `0x0E+9`, `0x16+9`, `0x00+9` e `0x00+e9` in file diversi, e
`(0x07,'9')` sta al posto di **tre lettere diverse nello stesso file**. Una tabella
scritta a mano sarebbe una lista di indovinelli. **#111** ripara senza tabella: ricostruisce
la parola e la fa validare da due prove ancorate al corpus stesso (il lessico dei 15.139
file puliti, e la lettura esadecimale della coda quando è Latin-1), **fail-closed** su
ogni caso ambiguo. Dry-run: **303 riparate, 279 rifiutate**, e le rifiutate conservano il
byte C0 — cioè restano riparabili.

**La cosa più importante che è emersa, e che ribalta una conclusione di questo documento:
la Fase A non era chiusa.** Il criterio con cui è stata dichiarata completa — «0 pagine
live con byte C0» — misurava **il marker, non il difetto**. Vedi la Fase A, riscritta.

**Il metodo che ha pagato**, e che va riusato: ogni volta che una seconda lente ha
smentito la prima, ha scoperto un difetto vero. Qui è successo cinque volte —
i 6 `npm ci` che erano 9, il PAT «senza scope» che lo scope ce l'aveva, la Fase A
«chiusa», le 4 PR che «non avevano nulla di recuperabile» ma il cui triage non aveva
mai postato niente, e il gate RSS che sarebbe passato verde comunque.

---

---

## Da dove viene questo documento

L'8 agosto 2026 è stata eseguita la migrazione articoli su nanako (brief precedente:
`MIGRAZIONE-ARTICOLI-BRIEF.md`). Quel lavoro è **chiuso**: fantasmi azzerati con
rimedio sistemico in produzione, catena commit→live misurata su entrambe le sezioni
con l'invariante «nessun deploy del sito» dimostrato, gate di qualità portati sul
repo che genera, pulizie fatte, rendiconto su `nanakokyobashi-rgb/frontaliere-articles#28`
(tre commenti: principale, parte 2, correzione).

Questo documento raccoglie **ciò che è rimasto aperto**, incluse cose scoperte
*durante* la verifica e mai tracciate da nessuna issue. La produzione non è bloccata:
gli articoli escono, si vedono live in ~60-115 s, e le superfici generate dal corpus
sono sane. Sono bordi — ma sono i bordi che l'8 agosto ha dimostrato costare incidenti.

**Una buona notizia da cui partire, perché è la prova che il lavoro regge**: il 9 agosto
alle 05:49 un `fast-publish` è fallito su `npm ci` e ha lasciato il bollettino del giorno
senza pagina — la stessa classe di guasto che l'8 agosto aveva prodotto un articolo
fantasma rimasto 404 per **8h57m**. Questa volta `reconcile-article-shards` (PR #57) lo
ha rilevato e ripubblicato **da solo in 63 secondi**, prima ancora che la issue venisse
aperta. Le 4 pagine locale rispondono 200. È il primo caso reale, e ha funzionato.

**Il contrappunto, ed è la ragione della Fase 0**: nello stesso momento si è scoperto che
il ciclo agentico ha tre buchi che lo rendono cieco su sé stesso — il più grave è che
**tutto il lavoro deferito nelle PR di ieri è evaporato**, perché la label che dovrebbe
trasformarlo in issue non esiste su quel repo.

---

## GOAL

Chiudere le pendenze qui sotto, **ciascuna con evidenza misurata**, senza rompere
ciò che funziona. È considerato raggiunto quando valgono tutte le condizioni di
completamento elencate per fase.

### NON-GOAL — leggi prima di agire

- **Non** toccare `content/**` a mano: lo scrive solo il generatore. Se un articolo
  ha un difetto nel contenuto, la fix va nel generatore o negli emitter.
- **Non** toccare `engine/` sul corpus: è mirrorato dal sito e verrebbe sovrascritto.
  L'engine si modifica in `frontaliere-si-o-no/packages/articles/engine/`.
- **Non** clonare gli shard (20+ GB i cantonali): si leggono via `gh api` e `curl`.
- **Non** mergiare a mano: entrambi i repo hanno auto-merge su `## LGTM`. Mai draft
  lasciate ferme.
- **Non** abbassare soglie di qualità per far passare un gate. Se un gate portato
  fallisce sul corpus attuale, documenta gli offender o congelali in una baseline
  **datata con issue di drenaggio** — mai annacquare il gate.
- **Non** aggirare il tetto anti-tempesta di `republish-dirty-content` (6 dispatch
  di fast-publish/ora). Esiste perché quei dispatch competono con la pubblicazione
  normale. Se serve più throughput, si aspetta il giro dopo.

---

## Architettura, in breve (quel tanto che serve)

Due repo che si parlano **via HTTP, non via import**.

| | |
|---|---|
| **SITO** `valerielinc-ops/frontaliere-si-o-no` | il sito + la SPA. Possiede l'engine. Clone locale `/Users/saggesel/Projects/frontaliere/frontaliere-si-o-no` |
| **CORPUS** `nanakokyobashi-rgb/frontaliere-articles` | genera gli articoli e pubblica la superficie dati. Clone locale `/Users/saggesel/Projects/frontaliere/frontaliere-articles` |

Il **codice** scende dal sito al corpus (`mirror-articles-engine.yml`, automatico, apre
una PR); i **dati** risalgono dal corpus al sito via HTTP. Un push su `main` del corpus
che tocca `content/**` fa partire *allo stesso secondo* due catene:

1. `fast-publish-article.yml` → HTML: renderizza le 4 pagine locale + hub + archivio e
   le pusha sugli 8 shard `frontaliere-articoli{frontaliere,svizzera}-{it,en,de,fr}`,
   poi purga Cloudflare e verifica.
2. `publish-api.yml` → dati: `build-api.mjs` pubblica la superficie JSON **alla radice**
   di `https://nanakokyobashi-rgb.github.io/frontaliere-articles/` (manifest, articles,
   swiss-articles, slugs, meta-*, sitemap, 10 RSS, ticker) + edge-push su R2.

Serving: apex `frontaliereticino.ch` = Worker Cloudflare →
`origin-articoli{frontaliere,svizzera}-<loc>.frontaliereticino.ch` = Pages degli shard.

**Leggi `manifest.json` per primo**: `commit` identifica lo stato del corpus, `counts`
permette di rifiutare un set troncato prima di usarlo.

---

## Trappole misurate — ognuna è costata un incidente

Le prime otto valgono per qualunque lavoro su questi repo; le ultime sono nuove
dell'8 agosto e non stanno in `CLAUDE.md`.

1. **`tsx`, non `node`** sul corpus (`npx -y tsx@4 <script>`): non ha `node_modules`.
   I test sono `node --test generator/tests/*.test.mjs`.
2. **Entrambi i cloni sono shallow.** Il sito ha HEAD locale **vecchio**: per lo stato
   attuale leggi il remoto (`gh api contents`, `raw.githubusercontent`), mai il
   filesystem. La storia di un file si legge con `gh api commits?path=...`.
3. **`git push` sul sito si pianta o muore di OOM** (misurato: 40-85 min, 1,9 GB RSS;
   e `pack-objects died of signal 9`). I flag anti-pianto **non bastano più**. Per
   pochi file: crea branch e commit **server-side** con `gh api` — `git/refs` poi
   `contents` (file singolo) o `git/blobs`+`git/trees`+`git/commits`. Zero
   trasferimento, un secondo. Un push già appeso va terminato a mano.
4. **Body PR con header obbligatori DIVERSI**: sito `## Implementato` +
   `## Non implementato`; corpus `## Implementato` + `## Non implementato (ancora)`.
   Un heading di qualunque livello **subito sotto** l'header svuota la sezione e fa
   fallire `contract` in 15 s: bullet sostanziosi prima di qualunque sottosezione.
5. **`scripts/ci/loop-sync-manifest.json` (corpus) decide DOVE si corregge** ⏱:
   `identical` → la fix va sul **SITO** e scende; `adapted`/`corpus-only` → sul corpus;
   non nel manifest → nessun vincolo. Cambia più volte al giorno: rileggilo da
   `origin/main` prima di OGNI file che tocchi.
   **Il caso peggiore è «non nel manifest» quando invece dovrebbe esserci**:
   `generator/scripts/create-article.mjs` del corpus è un **fork** di un file del sito e
   non è registrato, quindi le fix del sito non scendono da sole **e `loop-drift-check`
   non lo segnala** — lo stesso difetto è arrivato due volte in due giorni per questo
   (issue nanako#81, **chiusa dalla PR #82** che lo ha registrato: da ora il drift check
   lo copre). Quando trovi un file «gemello» fra i due repo, la prima domanda è se il
   manifest lo conosce: un file fuori dal manifest non è «senza vincoli», è **invisibile
   al guard che dovrebbe accorgersi della divergenza**.
6. **Disco quasi pieno** ⏱ (misurato a fine sessione: **3,0 GB liberi su 460**).
   `df -h` prima di ogni scrittura. Worktree SEMPRE sparse:
   `git worktree add --no-checkout <path> -b <branch> origin/main`, poi
   `printf '/*\n!/public/\n!/data/\n' | git sparse-checkout set --no-cone --stdin`,
   poi `git checkout`, poi symlink a `node_modules` (**mai** `npm install`).
   Dentro uno sparse `public/` e `data/` non esistono: la loro assenza non prova nulla.
7. **Il purge che conta è sull'URL ORIGIN, non sull'apex**, e Cloudflare tiene **DUE
   cache** per la stessa URL apex: con e senza header `Origin`. Ogni verifica apex si
   fa due volte: `curl -sI <url>` **e** `curl -sI -H 'Origin: https://frontaliereticino.ch' <url>`.
   Su `*.github.io` la variante `Origin` non esiste.
8. **`/bin/bash` è 3.2**: niente array associativi, niente `timeout`. E i log vitest
   del sito sono pieni di falsi rossi: filtra solo `FAIL ` (con lo spazio);
   `cancelled` appare come `fail`.

**Nuove dell'8 agosto — queste sono le più insidiose:**

9. **L'apex risponde 403 alla `fetch` di Node** (bot protection Cloudflare sullo
   user-agent di undici) mentre `curl` prende 200. Qualunque verifica programmatica
   di pagine va fatta sugli **host origin**. Se qualcuno «semplifica» un checker
   puntandolo all'apex, ogni probe diventa indeterminato — e con un fail-safe
   conservativo il risultato è un loop che non converge mai, **con la CI verde**.
10. **`git ls-tree` col default `core.quotePath=true` quota i path non-ASCII** e ne
    escapa i byte in ottali C (`"de/.../duba\303\257-bis-ticino/index.html"`).
    Confrontarli con slug UTF-8 raw produce un falso positivo per **ogni** slug con
    accento o umlaut: misurato, **68 falsi fantasmi su 69**. Usa
    `-c core.quotePath=false` e decodifica comunque i path quotati.
11. **I control character dentro JSON sono escapati** (``, `\b`), quindi un
    byte-scan sui file pubblicati **non li vede**. Cerca sempre entrambe le forme.
12. **Un rimedio che si auto-limita in silenzio è di nuovo il bug che doveva
    chiudere.** Se un workflow ha un cap o un tetto, gli item non processati devono
    entrare nella condizione che apre la issue — altrimenti «run verde, zero effetto»
    è indistinguibile da «non c'era nulla da fare».
13. **Per ripubblicare un articolo si usa il dispatch a main, MAI `gh run rerun` di un
    run vecchio**: il rerun riprende lo snapshot di quel commit e il suo
    `refresh-hub-landing` riscrive hub e archivi con lo stato di allora (misurato: ha
    fatto regredire hub IT/EN e tutti gli archivi di ore).
14. **`npm install` nella CI del corpus è fragile**: `ETIMEDOUT` sul registro ha
    causato sia l'articolo fantasma dell'8 agosto sia un check di PR fallito la sera
    stessa. Se un check fallisce con quell'errore è un flake:
    `gh run rerun <id> --failed --repo nanakokyobashi-rgb/frontaliere-articles`.
    (Vedi Fase D: meriterebbe una mitigazione.)

---

## Come si lavora qui (contratto operativo)

- `gh` è autenticato come `valerielinc-ops`: **admin sul sito, NON sul corpus**. Punta
  sempre `--repo nanakokyobashi-rgb/frontaliere-articles` esplicito sul corpus.
- Secret: `cd /Users/saggesel/Projects && source bin/rc-env.sh` **nello stesso comando
  Bash** che li usa (lo stato shell non persiste). Stampa solo le lunghezze, mai i
  valori. Il service account Firebase è owner di fatto del progetto: niente comandi
  distruttivi.
- Auto-merge in entrambi i repo: `tests` verde → `pr-review-loop` → `## LGTM` → merge,
  ~8-15 min. Se una review lascia finding, **sistemali e ripusha**: il ciclo
  ri-recensisce. Se il review-loop risulta `skipped` per una race, un nuovo push lo
  fa ripartire.
- `gh pr create` sul sito vuole `--head "$(git rev-parse --abbrev-ref HEAD)"` (clone
  shallow), e `gh pr view` senza argomenti non trova la PR: usa `gh pr list --head`.

---

## FASI

**Fai la Fase 0 per prima**: sblocca il ciclo agentico stesso, e senza di essa una parte
del lavoro che farai evaporerà come è già evaporato quello dell'8 agosto. Le fasi A e B
sono indipendenti e partono insieme. C dipende da una data. D ed E sono lavoro di fondo,
parallelizzabile.

### Fase 0 — Sbloccare il ciclo (PRIORITÀ, e nessuna è difficile)

Tre difetti del ciclo agentico del corpus, tutti **verificati il 9 agosto**, che
rendono inerti pezzi di automazione. Nessuno ha una issue propria: il ciclo non può
segnalare i propri buchi.

**0.1 — La label `follow-up` non esiste sul corpus. ⏱ Impatto: alto.**

```bash
gh api repos/nanakokyobashi-rgb/frontaliere-articles/labels/follow-up   # → 404
gh api repos/valerielinc-ops/frontaliere-si-o-no/labels/follow-up       # → esiste
```

`post-merge-followup.yml` gira ogni 3 ore, batcha correttamente le PR mergiate e lancia
Claude — e **non ha mai mintato una sola issue**, perché la label che dovrebbe applicare
non esiste. Risultato misurato: **0 issue `follow-up` sul corpus contro 100+ sul sito**,
e **nessuna** delle sezioni «## Non implementato (ancora)» delle 7 PR mergiate l'8 agosto
è diventata una issue o un commento. Tutto quel deferred work è evaporato in silenzio.

Fix: aggiungere `follow-up` (e verificare le `funnel-*` citate dai prompt) a
`scripts/ci/ensure-loop-labels.mjs` **sul corpus** — è `corpus-only`, quindi la fix va lì
— e lanciarlo. Poi vale la pena rileggere le «Non implementato (ancora)» delle PR
#56, #57, #59, #65, #70, #74, #75 e aprire a mano ciò che meritava una issue.

> ✅ **CHIUSA.** Le 4 label (`follow-up`, `funnel-monetization`, `funnel-seo`, `funnel-ux`)
> create subito a mano per sbloccare il ciclo, poi dichiarate in
> `ensure-loop-labels.mjs` dalla PR **#89** (mergiata) insieme a `automation` e `bug`.
>
> **Perché il guard non l'aveva presa, ed è la parte che vale.** `loop-labels.test.mjs`
> cercava le label nei flag di `gh` (`--add-label`). Nei sorgenti `follow-up` compariva
> **una volta sola e in un contesto di *filtro*** (`gh issue list --label follow-up`,
> dentro un esempio del prompt); la label che il triage **applica** viveva in una riga di
> prosa: ``Label: `follow-up` + UNO funnel-*``. Un guard che trova il riferimento
> sbagliato tace esattamente come uno che non trova niente. Stessa forma di
> `SiteShellContract`: **un contratto che non ha forma di import non è coperto dai guard
> che seguono gli import** — qui non era nemmeno un import, era una frase.
> Il guard ora legge anche `gh issue create --label` (distinguendolo da `list`) e i token
> nelle righe `Label: …` dei prompt. Falsificato: togliendo `follow-up` fallisce;
> togliendo tutte le `funnel-*` fallisce il controllo di famiglia.
>
> ⚠️ **Le cause erano TRE, non una.** La label era necessaria e non sufficiente:
> 1. **la label `follow-up` non esisteva** → chiusa da #89;
> 2. **il marker di idempotenza non veniva mai scritto** → #99, chiusa da #105 e #110;
> 3. **la quota Claude esaurita** → il gate di pre-flight fa fallire la run *di proposito*,
>    perché il watermark non avanzi («nessuna PR persa»). Comportamento corretto e
>    preesistente, che però tiene il triage fermo finché non si resetta.
>
> Attenzione a non scambiare l'una per l'altra: a fine giornata le issue nuove del corpus
> le apriva **`claude[bot]` dal fixer di `issue-fix`**, non il triage post-merge — che a
> quel punto non aveva ancora mintato nulla. Il segnale che distingue è il **marker**
> `## Post-merge follow-up triage` sulla PR: se manca, il triage non ha girato,
> qualunque cosa sia comparsa nel frattempo.
>
> **Vedi issue #99 per il dettaglio della seconda causa.**
> Il backfill dispatchato su #56 è girato `success`, ha eseguito Claude per davvero
> (19 turni, 629k token, $0.59) e **non ha prodotto niente**: zero commenti, zero issue.
> Su **30 PR mergiate, 0 hanno il commento `## Post-merge follow-up triage`**, che il
> prompt dichiara OBBLIGATORIO ed è il marker di idempotenza. Non c'è nessun backstop
> deterministico dopo lo step di Claude, quindi la sua violazione è invisibile e ogni
> run schedulata ri-triagia la stessa finestra.

**0.2 — Il fixer non può pushare fix ai workflow. ⏱ Impatto: alto.**

`claude[bot]` ha scritto i fix per **#76** e **#77**, e il push è stato **rifiutato**:

```
! [remote rejected] fix/issue-77 -> fix/issue-77
(refusing to allow a GitHub App to create or update workflow .github/workflows/... without workflows permission)
```

Entrambe chiudono con `<!-- FIX_OUTCOME: blocked-workflows-scope -->` e sono state messe
`fu-parked`: **il fixer non ci riproverà da solo**. Ogni difetto che vive in
`.github/workflows/**` è quindi fuori dalla portata dell'automazione.

Due strade, non alternative: (a) **portare a destinazione i due fix** — il `gh` locale è
autenticato come `valerielinc-ops` e **ha lo scope `workflow`**, quindi basta
ricostruirli dai commenti di `claude[bot]` e pusharli; (b) **cablare `issue-fix.yml`**
perché il push usi `GITHUB_PAT_NANAKO` (che ha lo scope) invece del token della GitHub
App. Senza (b) il problema si ripresenta al prossimo fix su un workflow.

> ✅ **CHIUSA — PR #93. Ma la causa era un'altra, e (b) era già fatto.**
>
> Misurato: `GITHUB_PAT_NANAKO` **ha** lo scope `workflow` (utente `nanakokyobashi-rgb`),
> e `issue-fix.yml` **già** faceva `git remote set-url origin` con quel PAT (riga 216).
> Il cablaggio c'era e non aveva effetto.
>
> La causa è `actions/checkout`, che col default `persist-credentials: true` scrive il
> token del runner in `http.https://github.com/.extraheader`. **Un header `Authorization`
> esplicito prevale sulle credenziali contenute nell'URL del remote**, quindi il
> `set-url` col PAT era decorativo e il push viaggiava con l'identità della GitHub App —
> che è esattamente ciò che dice il messaggio d'errore, e il motivo per cui lo scope del
> PAT non c'entrava nulla.
>
> **Dimostrato sperimentalmente contro github.com, in sola lettura:**
>
> | stato del repo | `git ls-remote` |
> |---|---|
> | credenziali valide solo nell'URL | **OK** |
> | URL valido **+** extraheader con token fasullo | **fallisce** → vince l'extraheader |
> | stesso stato, extraheader rimosso | **OK** → l'identità dell'URL torna a valere |
>
> Fix: `git config --unset-all http."https://github.com/".extraheader`, solo nel ramo in
> cui il PAT c'è. **Morale generale: quando una configurazione "c'è ma non funziona",
> chiedersi chi altro scrive nella stessa configurazione.**

I due fix, già scritti e descritti nei commenti delle issue:
- **#77** — `npm ci` senza retry in `fast-publish-article.yml`: `ETIMEDOUT` durante il
  postinstall di `onnxruntime-node` (scarica un binario nativo fuori dal registro e non
  ha retry proprio). Fix: `scripts/lib/npm-ci-retry.sh` + rewire di 6 workflow.
- **#76** — conflitto di rebase **non transiente** su
  `data/topic-candidates-evergreen-rejected.json` nello step *Commit and push* di
  `generate-article.yml`: il file è riscritto per intero a ogni run, i 5 retry rifanno
  identica la stessa operazione e falliscono uguale. Fix: su conflitto confinato ai soli
  file di bookkeeping riscritti per intero, prendere la copia upstream e proseguire.

**Perché #76 è la più urgente di tutte** ⏱: finora è sempre capitato su run che *non*
avevano generato un articolo (il commit conteneva solo bookkeeping), ma è **fortuna, non
design**. Il messaggio d'errore lo dice: `push failed after 5 attempts — the article is
registered locally but not pushed`. Su una run che ha generato davvero, **l'articolo si
perde**. 35 run fallite su quel workflow dal 2026-08-06.

> ✅ **ENTRAMBI CHIUSI.** Le due issue erano state **auto-chiuse alle 08:25 col fix mai
> applicato** (`npm-ci-retry.sh` non esisteva, `run: npm ci` e il rebase nudo erano ancora
> lì). Riaperte, risolte, richiuse dal merge — questa volta col codice dentro.
>
> - **#76** → PR **#88**: `scripts/lib/rebase-onto-remote.sh`, cablato in
>   `generate-article.yml` e `batch-faq-articles.yml`, + 6 test.
>   **Il bug trovato scrivendo i test vale più del fix**: la prima versione leggeva
>   l'exit status di `git rebase --continue` come un verdetto. Non lo è — non-zero copre
>   sia «il commit è ora vuoto» sia «avanzato bene, fermato sul conflitto **successivo**».
>   Trattandolo come solo il primo, abortiva un rebase a metà strada dal riuscire, e il
>   commit che scartava era **quello con l'articolo**: il guasto da prevenire,
>   reintrodotto dal rimedio. Ora nessuna decisione dipende da un exit status.
> - **#77** → PR **#91**: `scripts/lib/npm-ci-retry.sh` + rewire. **I punti di install
>   erano 9, non 6**: i tre in più usano `--ignore-scripts` (niente binario nativo, ma
>   esposti a un `ETIMEDOUT` del registro). Verificato su `main`: 9 workflow sul wrapper,
>   **0 `npm ci` nudi rimasti**.
>
> ⚠️ Resta scoperto ciò che quella PR non tocca — `npx -y tsx@4` in `publish-api.yml`,
> senza retry né cache, sul percorso di pubblicazione della superficie dati: **issue #98**.

**0.3 — La CI del repo SITO è rossa ogni giorno per un template del corpus. ⏱ Impatto:
alto — blocca ogni PR sul sito.** Tracciato da **corpus#79** (aperta con diagnosi
completa).

L'`excerpt` del Bollettino è una **stringa fissa** in
`generator/scripts/lib/daily-brief-content.mjs` (varia solo `${dateLabel}`) e viene
riusato verbatim come `seo.description` e `ogDescription`. Misurato sulla superficie
pubblicata: **265 caratteri** in italiano, 213 en, 240 de, 250 fr — contro il limite di
**170** imposto da `tests/seo-description-length.test.ts` **sul sito**. Da `d4bf017c`
(corpus PR #51, 2026-08-08T13:51Z) in avanti **ogni edizione quotidiana** nasce fuori
limite, quindi `vitest` è rosso su ogni PR del sito, ogni giorno, e l'auto-merge non
può mergiare nulla.

Verifica in un comando:
```bash
curl -s https://nanakokyobashi-rgb.github.io/frontaliere-articles/meta-it.json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(len(d[k]),k) for k in d if 'bollettino' in k and k.endswith('excerpt')]"
```

**Stessa forma di punto cieco delle altre**: il test del corpus
(`generator/tests/daily-brief-content.test.mjs`) controlla solo un **minimo**
(`> 100`); il **massimo** vive esclusivamente sul sito e scatta *dopo* il pull, quando
il contenuto è già dentro e blocca tutti. Il drift check non lo vede, perché confronta i
file allineati uno per uno e non nota **ciò che manca da un lato**.

**Come è stata risolta, e la decisione di prodotto che la governa.** La PR #80 (mergiata
il 9 agosto alle 08:39) ha sbloccato la CI spostando `clampSeoDescriptions` (160 char,
taglio a confine di parola) dentro `registerArticleFiles` — il punto che accomuna tutti i
produttori — e riscrivendo i quattro excerpt a ~155 caratteri. Il difetto strutturale
che ha scoperto è istruttivo: **il cap esisteva già**, ma viveva dentro lo step di
arricchimento del flusso AI, quindi lo prendevano solo gli articoli creati da `main()`;
`generate-daily-brief-article.mjs` importa `registerArticleFiles` direttamente e quello
step non lo attraversava mai. *Una regola imposta in UN produttore invece che nel punto
che li accomuna.*

Ma accorciare l'excerpt **toglie contenuto all'utente**, ed è la cosa sbagliata: il
limite di 160 è una costrizione della SERP di Google, non un tetto al valore che diamo al
lettore. La direzione decisa dal proprietario è **separare i tre campi**, perché servono
tre superfici con vincoli diversi:

```
excerpt         → ~250-280 char, ricco   → è ciò che l'utente LEGGE sul sito (card, liste)
seo.description → ~150-160 char, mirata  → è ciò che Google mostra nella SERP
ogDescription   → ~200-250 char          → è ciò che mostrano Facebook/LinkedIn
```

**FATTO** — PR **#83**, mergiata il 9 agosto (chiude corpus#79). Misure finali:
excerpt riportato ricco (vincolo `min: 200, max: 320`), `seoDescription` 152-154 caratteri
per locale, `ogDescription` 207-225, `seo.description ← seoDescription` (con un commento
in codice che dice «NOT `it.excerpt`» e perché), `clampSeoDescriptions` a **due soglie**
(altrimenti il cap avrebbe troncato la og lunga vanificando la separazione), e il vecchio
test che legava l'excerpt al budget della meta description **rimosso** perché non aveva
più senso.

Il dettaglio da non perdere: sull'excerpt il test impone un **minimo**, non un massimo —
e il commento accanto spiega perché, cioè che la failure mode osservata è «qualcuno
accorcia l'excerpt per far passare un test SEO». È la protezione contro il ripetersi di
ciò che è successo quella mattina.

La review del ciclo ha poi esteso la separazione **oltre il bollettino**, dove era
incompleta: `optimizeSeoMetadata` (il flusso AI, cioè la maggioranza del corpus) tagliava
ancora `ogDescription` a 160 hardcoded; il fallback per `seo` mancante riusava la
description già troncata; e — la più insidiosa — **il prompt al modello istruiva ancora
«≤ 160 caratteri»**, quindi il budget più ampio serviva solo quando il modello
disobbediva. Ora chiede 200-250 con un drift guard: *un prompt è un contratto senza forma
di import*, quindi un ritorno a 160 passerebbe con la CI verde.

**Due code aperte, entrambe con issue** (⏱ verifica lo stato):

- **corpus#85 — le edizioni già pubblicate non si rigenerano.**
  `generate-daily-brief-article.mjs` è idempotente, ma il ramo `exists` chiama solo
  `refreshBodyFiles` + `bumpUpdatedAt` + `bumpDateModified`: **non tocca mai**
  `content/blog-meta-*.ts` né i campi description, che si scrivono una volta sola dentro
  `registerArticleFiles` — ramo che quel percorso salta per costruzione. Sono **due**
  edizioni (2026-08-08 e 2026-08-09), entrambe con `description == ogDescription == 151`.
  Serve prima il codice che manca (`--force-meta` sull'entrypoint, o un
  `refresh-article-meta.mjs <id>` riusabile): non c'è un dispatch da lanciare.
  **La prossima edizione nasce già corretta senza interventi.**
- **corpus#86 — le `seoDescription` localizzate sono inerti.** Per `/en/`, `/de/`, `/fr/`
  la meta description viene ancora dall'**excerpt della locale troncato a 155**
  (`ogPagesPlugin.ts`: `localizedDesc = repairSerpSnippet(localizedMeta?.excerpt || …)`,
  poi `truncateHeadline(metaDescRaw, 155)`), e il parser dei chunk riconosce **solo**
  `title|excerpt|imageAlt`. Verificato: `meta-en.json` espone quei tre campi e basta.
  Quindi oggi **solo la `seoDescription` italiana** raggiunge davvero una SERP — l'entry
  SEO `blog-<id>` è IT-only. Le altre tre sono scritte, testate e non consumate. Fix su
  **due repo, in quest'ordine**: prima il corpus emette il campo nei chunk, poi l'engine
  lo legge e lo preferisce (e l'engine si modifica **nel sito**, `packages/articles/engine/`,
  mai sul corpus).

**Regola da portarsi dietro**: quando un test SEO fallisce, la domanda non è «quanto
accorcio», è «quale superficie sta misurando, e sto usando lo stesso testo per
superfici diverse?».

**Due corollari operativi, che valgono ogni volta che un DATO del corpus rende rosso il
sito** (e succede: qui è stato 1 test fallito su 107.242 a bloccare ogni PR, perché
`pr-review-loop` gira solo su `tests` verde):

- **La riparazione va nel corpus, mai sul sito.** `scripts/pull-articles-corpus.mjs` fa
  un mirror **verbatim** di `content/`: una correzione fatta in
  `packages/articles/content/**` del sito viene sovrascritta al sync successivo (~40
  minuti) e sembra una regressione nuova. Vale anche per i file SEO, che sul sito sono
  **symlink** verso quella stessa cartella. Dopo il merge la catena è automatica e dura
  ~2 minuti: `publish-api.yml` → dispatch `articles-published` →
  `sync-articles-sitemaps.yml`.
- **La fix al generatore non raggiunge un articolo già scritto**: va corretto anche il
  dato già registrato (rigenerandolo, non a mano). E la PR che era bloccata può aver
  bisogno di un **rebase**, perché il suo merge ref è vecchio:
  `gh workflow run pr-autorebase.yml` sul sito la riprende se ha `stale-review` o LGTM.

**0.4 — Un'asimmetria nell'auto-chiusura delle issue.** Impatto: basso, ma spiega rumore.
`close-recovered-failure-issues.mjs` pretende che la run verde sia partita **dopo**
l'apertura della issue. Per #77 il verde (05:50:08) precede l'apertura (06:26:36),
perché `reconcile-article-shards` aveva già riparato tutto prima che lo scanner girasse:
la issue resta aperta più a lungo dell'incidente. Si chiuderà al primo `fast-publish`
verde successivo. Se si vuole togliere il rumore, il punto è `scan-failed-runs.mjs`, che
apre l'issue senza controllare se nel frattempo la condizione è già rientrata.

### Fase A — Chiudere il drenaggio dei control character ⏱

**Contesto.** Un mangling nella catena LLM sostituiva caratteri non-ASCII con byte C0
grezzi (`(0x17,'0')`→à, `(0x08,'8')`→ì, ecc.): **592 byte in 32 file** di `content/`,
che finivano in sitemap (rendendola **non well-formed**: un parser strict poteva
rigettare tutte e 3120 le URL) e nel JSON-LD delle pagine live — dato strutturato che
i crawler parsano davvero. Una pagina ne portava perfino un `0x00`, che per specifica
HTML è un parse error.

**Già chiuso** (non rifarlo): sanificazione agli emitter con gate fail-closed (PR #65),
guard nel generatore su 6 script di scrittura (PR #75, issue #66), e il drenaggio delle
pagine storiche reso convergente (PR #74, issue #73).

**Cosa resta.** Le pagine già emesse *prima* di #65 sono byte su disco sugli shard e
restano sporche finché non vengono ri-renderizzate. All'ultima misura: **29 candidati
dal corpus → 15 con pagina live ancora sporca** (14 già chiusi).

Il drenaggio è `republish-dirty-content.yml` sul corpus, **`workflow_dispatch`-only**
per scelta (è un backlog, non una reazione a un evento):

```bash
# ricognizione, sempre prima
gh workflow run republish-dirty-content.yml --repo nanakokyobashi-rgb/frontaliere-articles \
  -f dry_run=true -f cap=15
# drenaggio
gh workflow run republish-dirty-content.yml --repo nanakokyobashi-rgb/frontaliere-articles \
  -f dry_run=false -f cap=15
```

Il tetto è **6 dispatch di fast-publish/ora**: con 15 articoli servono più giri
distanziati. Un run che riporta `già N dispatch nell'ultima ora — rimando` **ha fatto
la cosa giusta**, non è un difetto.

**Completo quando**: un `dry_run=true` riporta `0 con pagina live ancora sporca`.
**Criterio di allarme**: se di giro in giro quel numero **non scende**, non è il tetto
— è tornata la non-convergenza di #73, e va guardata prima di insistere.

🔴 **NON ERA CHIUSA. Riaperta il 9 agosto pomeriggio — issue #94 e #95.**

~~✅ CHIUSO il 9 agosto. Ricognizione finale: `28 candidati dal corpus → 0 con pagina
live ancora sporca`.~~ Quel risultato era corretto **e la domanda era sbagliata**.

**Il byte C0 non era il difetto: era il marker del difetto.** La catena LLM sostituiva
un carattere non-ASCII con **(byte C0 + una cifra ASCII)**. Il sanificatore di #65
rimuove il byte C0 — e **lascia la cifra dentro la parola**:

```
content/  :  b'comp\x169tences'     (= compétences)
pagina live: 'comp9tences'
```

Misurato sulla stessa pagina citata sopra come controprova di chiusura
(`.../fr/articles-frontalier/nestle-200-postes-de-travail-en-lombardie/`), su **entrambe**
le varianti di cache Cloudflare:

```
status = 200
byte C0 grezzi = 0        ← il criterio di chiusura, soddisfatto
parole rotte   = 14       comp9tences con7ues inaugur9e ind9termin ing9nieurs
                          int9rieure neolaure9s opportunit9s premi8re proc9dure
                          recherch9s situ9e soci9t tribu9s
```

Sonda sistematica che usa il corpus come oracolo: **27 pagine sondate, 18 con residuo
confermato byte a byte, 156 stringhe distinte** — ed è un limite *inferiore*, perché
l'estrazione non normalizza gli escape né la trasformazione markdown→HTML. Peggiori: FR
e DE, cioè il testo che nessuno rilegge. Sul DE saltano anche i marcatori di lista
(`0 Norm: Bundesgesetz…`, `c1us dem Direktor…`). Il JSON-LD della pagina FR è invece
pulito: la corruzione è nella **prosa del corpo**.

**C'è una finestra temporale, ed è la ragione dell'urgenza.** Finché il byte C0 è ancora
in `content/`, la riparazione è **ancorata ed esatta** — si sa quale carattere
ripristinare, perché la coppia (byte, cifra) lo identifica. Il guard di #75 lo strippa a
ogni scrittura nuova con un `console.error` ed exit 0: converte un difetto **trovabile**
in uno **invisibile a tutta la strumentazione costruita per trovarlo** (issue #95).

Nuove coppie censite oltre le 7 di #66: `(0x16,'9')→é`, `(0x16,'7')→ç`.
Nel corpus restano **592 byte C0 in 32 file, di cui 381 (64%) seguiti da una cifra**.

> ### Riparazione eseguita il 9 agosto sera — 303 su 582, e il resto è fail-closed
>
> `generator/scripts/repair-mangled-chars.mjs --write` (PR #111) su `main`, commit `335cafc2d`:
>
> ```
> file con marker : 29        occorrenze : 582 -> 279
> riparate        : 303       rifiutate  : 279  (byte C0 conservato: restano riparabili)
> ```
>
> Rifiuti: **184** senza prova nel lessico, **62** il marker non sostituiva una lettera,
> **18** troppi marker nel token, **15** ambiguo (due ricostruzioni entrambe valide).
>
> **La tabella `(byte, cifra) → carattere` non esiste**, ed è il motivo per cui lo script
> non ne ha una: la stessa `é` è scritta `0x0E+9`, `0x16+9`, `0x00+9` e `0x00+e9` in file
> diversi, e `(0x07,'9')` sta al posto di **tre lettere diverse nello stesso file**.
> Ricostruisce la parola e la fa validare da due prove ancorate al corpus (il lessico dei
> 15.175 file puliti, 227.058 token; la lettura esadecimale della coda quando è Latin-1).
>
> **Verificato end-to-end, non sul run verde**: sorgente → `meta-fr.json` (che contiene
> `compétences` 7 volte e `comp9tences` **zero**, col `manifest.commit` della riparazione)
> → pagina live. Sulle due pagine con un baseline misurato: **svincolo 10 → 0**,
> **nestle 23 → 4**. Le 4 residue sono esattamente quelle rifiutate.
>
> **Due trappole prese in faccia mentre lo facevo**, entrambe istruttive:
>
> 1. **Il drenaggio è cieco al difetto che deve riparare.** `republish-dirty-content` ha
>    riportato `0 con pagina live ancora sporca` mentre nestle ne aveva 23: il suo filtro
>    cerca **byte C0 sulla pagina**, e sulla pagina non ce ne sono mai — gli emitter li
>    sanificano da #65. È lo stesso criterio che fece chiudere #71 per sbaglio, riprodotto
>    dentro lo strumento che doveva rimediarvi. Il criterio giusto è la **parola rotta**.
> 2. **Ho letto l'esito della run invece degli esiti degli step.** I primi sei dispatch di
>    `fast-publish` sono usciti `success` senza pubblicare niente: `dry_run` ha
>    **`default: true`** («*a manual poke cannot publish by accident*») e io non avevo
>    passato `-f dry_run=false`. Lo step `Publish to shards and CDN` risultava `SKIPPED`, e
>    uno step saltato non fa fallire la run. Avevo perfino aperto un finding su un difetto
>    inesistente prima di guardare gli step. **Per ripubblicare a mano serve
>    `-f dry_run=false`, ed è la prima cosa da controllare quando "il dispatch non ha
>    effetto".**

Serviti tre giri: 10 articoli, poi un giro fermato dal tetto anti-tempesta (che ha fatto
la cosa giusta e l'ha detto), poi i 15 restanti in 19 minuti. **Il workflow resta
dispatch-only senza `schedule`**: se il conteggio risalirà — e risalirà solo se qualcosa
riapre il rubinetto a monte, dato che #75 e #83 lo hanno chiuso — va rilanciato a mano.

Trappola da conoscere per la prossima volta: un `until`-loop che attende il tetto
interrogando l'API **non può usare `--arg` su `gh api`** (è un flag di `jq`, non di `gh`):
il comando esce in errore, un fallback tipo `|| echo 99` lo legge come «tetto saturo» e il
loop non parte mai. Misura il conteggio con `gh api ... | python3` o `jq` a valle.

**Decisione da prendere** (non solo eseguire il drenaggio): questo workflow ha bisogno di
un `schedule` che lo droni da solo? Se sì, il tetto anti-tempesta lo rende già sicuro. Se
no, va scritto nella issue chi lo lancia e quando — altrimenti è un backlog senza padrone.

**Cosa NON viene ripulito, per scelta dichiarata**: i byte restano nel **sorgente** —
⏱ 29 file di `content/` li portano ancora. La PR #75 blocca solo le scritture *nuove*,
e `content/` non si tocca a mano (NON-GOAL). Non è un problema per le superfici
pubbliche, perché gli emitter sanificano in uscita con un gate fail-closed (#65): ogni
pubblicazione esce pulita comunque. Ma sapendolo si evita di rincorrere un conteggio
sul corpus aspettandosi che scenda: **scende solo quello sulle pagine live**, che è
infatti il criterio che il drenaggio usa dopo #74.

Tracciato da: issue **#71** (corpus).

### Fase B — Il canale del ticker, e il gemello RSS

**Contesto misurato.** Il ticker che i browser leggono
(`cdn.frontaliereticino.ch/data/news-ticker-live.json`, oggetto R2, fetchato da
`components/community/NewsFeed.tsx`) era fermo da **oltre 26 ore**. Root cause: il suo
unico scrittore reale è `scripts/publish-article-chunks.mjs`, invocato da
**`fast-publish-article.yml` del repo del SITO** — che ha `on: workflow_dispatch` e
nient'altro. Dopo il cutover gli articoli nascono sul corpus, quindi quel workflow non
parte più da solo: viveva di lanci manuali.

Falsa pista da non ripercorrere: lo step `step_push_cdn` del deploy **non** scrive quel
file. `_r2_sync` copia `dist/data/**`, mentre il file atterra nella **radice** di
`dist/` (Vite copia `public/` verbatim) — il log rclone di un deploy da 3,7 GB mostra
**un solo oggetto** copiato.

**Trappola di forma, critica**: il file committato è `{schema, articles: [...]}` ma
`isTickerArticleArray()` nel browser accetta **solo un array nudo**. Pubblicare il file
così com'è dà run verde, 200 sul CDN e **ticker congelato per sempre** sul top-5 di
build time, perché ogni client scarta il payload in silenzio.

**Stato**: PR **valerielinc-ops/frontaliere-si-o-no#5420** appoggia l'edge-publish su
`sync-articles-sitemaps.yml` (che gira a ogni pubblicazione) con l'unwrap e la
validazione. ⏱ Verifica se è mergiata. **Attenzione: il suo `vitest` è rosso per un
difetto che NON è suo** — il template del Bollettino, Fase 0.3 / corpus#79. Finché
quello non è sistemato la PR non può entrare, e non c'è niente da correggere qui.

**Un incidente da conoscere, perché quasi genera una fix sbagliata.** La PR è stata
bloccata da `tests/cf-zone-purge-blast-radius.test.ts` con questo messaggio:

```
AssertionError: sync-articles-sitemaps.yml invokes cf-purge-cache.mjs without --files=,
which is a zone-wide purge_everything. That wipes the 96%-hit CDN cache and drives the
R2 502 family (#5162).
```

Il messaggio **descrive un blast radius che il comando non ha mai avuto**: `--files=`
c'era, su una riga di continuazione con backslash, e a runtime la shell concatena.
Il fallimento era reale ma la causa è un **falso positivo del guard**, che per i
workflow filtra riga per riga:

```js
lines.filter((l) => /cf-purge-cache\.mjs/.test(l) && !/--files=/.test(l))
```

Chi avesse creduto al messaggio avrebbe «riparato» un purge zone-wide inesistente.
La fix corretta è stata mettere il purge su **una riga sola**, con un commento che
registra il vincolo perché un riordino futuro non lo rompa. (Il difetto del guard è
tracciato in Fase E: la metà sugli *script* è già file-scoped proprio per evitare
questo, quella sui *workflow* no.)

**Cosa limita davvero la staleness del ticker per il client** — controintuitivo, ed è
la ragione per cui il purge conta meno di quanto sembri: `NewsFeed.tsx` legge via
`cdnFreshUrl()`, che appende `?v=<token>` con `CDN_FRESHNESS_BUCKET_MS = 5 min`. Quella
chiave **non è raggiungibile dal purge del publisher** per costruzione (commento in
`NewsFeed.tsx`, #4974). Ciò che tiene fresco il client è il `max-age=300`, allineato di
proposito allo stesso bucket da 5 minuti. Il purge resta perché pulisce la variante a
URL nudo per gli altri consumatori e perché `publish-article-chunks.mjs` ne emette uno
identico dopo il proprio PUT: la **parità fra i due scrittori** è il principio su cui
la fix è costruita.

**Lezione generale**: prima di aggiungere un purge in questi repo, leggi
`tests/cf-zone-purge-blast-radius.test.ts` — e leggi *il codice* del guard, non solo il
messaggio che produce.

**Completo quando**: dopo un articolo nuovo, `curl -sI` sull'oggetto R2 mostra un
`last-modified` successivo alla pubblicazione, e il primo elemento coincide con quello
del corpus. **La prova vera arriva solo al primo articolo pubblicato dopo il merge.**

> ✅ **CHIUSA E VERIFICATA il 9 agosto.** #5420 mergiata alle 09:16:11Z. Misurato alle
> ~12:30 sull'oggetto R2 che legge il browser:
>
> ```
> last-modified: Sun, 09 Aug 2026 11:33:50 GMT   ← posteriore al merge E all'ultima
> manifest generatedAt: 2026-08-09T11:30:41Z        pubblicazione del corpus
> top-level = list, 5 elementi                   ← la forma che isTickerArticleArray() accetta
> parità con il corpus: True                     ← tutti e 5 gli id combaciano, in ordine
> ```
>
> L'unwrap funziona (il corpus emette `{schema, articles}`, il CDN serve l'array nudo) e
> il criterio di completamento del brief è soddisfatto su entrambe le lenti: la data
> *e* il contenuto.

**Il gemello, non ancora affrontato — e sono dieci, non uno.** ⏱ Misurato il 9 agosto:
`/rss.xml` dell'apex è indietro di **5h08m** rispetto al corpus (4 item mancanti).
`EDGE_PUSHED_FILES` in `infra/cloudflare-worker/locale-router.js` ha esattamente 10
chiavi e **non contiene un solo feed RSS**: sono tutte sitemap. Quindi **tutti e dieci i
feed** entrano nella superficie pubblica solo al deploy successivo del sito.

Attenzione a non incolpare il pezzo sbagliato: **non è il sync**. Le run di
`sync-articles-sitemaps.yml` sono verdi e il repo del sito ha già i feed freschi (il log
dice «published artifacts already current»). Il collo di bottiglia è la **catena di
deploy del sito**, che dura oltre 2 ore e si auto-cancella per churn.

Il lavoro, se si decide che 5 ore di ritardo sui feed non vanno bene: 10 entry in
`EDGE_PUSHED_FILES` con `cdnKey: /edge/<file>` e content-type `application/rss+xml`,
10 rotte in `wrangler.toml`, l'upload nello step già esistente di `publish-api.yml` sul
corpus (accanto a quello delle sitemap), e un redeploy del Worker. **Superficie pubblica
di feed: PR propria, non un'aggiunta a un'altra.**

**Direzione architetturale** (valutare, non implementare a cuor leggero): ticker e RSS
pubblicati all'edge dal `publish-api.yml` del **corpus**, come già le sitemap — «chi
produce l'artefatto lo pubblica». Due frizioni reali da risolvere prima: (a) il corpus
emette l'involucro e dovrebbe replicare l'unwrap, duplicando un contratto di forma che
oggi vive da una parte sola; (b) soprattutto, `scripts/pull-articles-api.mjs` **valida**
il payload e lo appaia al `commit` del manifest via `articles-sync-pin.mjs` — spostare
lo scrittore significa spostare **anche quella validazione**, non solo il PUT.

> 🟡 **PR sito #5463 aperta.** Rimisurato alle 12:05: **2h57m26s** di ritardo e **5 item
> su 50 mancanti** dai feed `frontaliere`; i feed svizzeri hanno delta **zero** — e non
> per merito, ma perché la sezione non pubblica da 14h (issue corpus #96). Su R2
> `/edge/sitemap-blog.xml` esisteva ed era vecchio di 40 secondi; **`/edge/rss.xml`
> rispondeva 404: mai scritto da nessuno.**
>
> Il colpo più netto: **i 5 articoli mancanti rispondono 200 e sono già annunciati da
> `/sitemap-blog.xml` sullo stesso apex, nello stesso minuto.** L'incoerenza è interna a
> un host solo (la sitemap la serve il Worker, l'RSS è passthrough di Pages).
>
> **La frizione (a) è FALSIFICATA**: per l'RSS non c'è nessun involucro da replicare —
> l'unwrap riguarda solo il ticker, i feed sono byte-identici sui due lati. La (b) è
> confermata e costosa. Guadagno dello spostamento sul corpus: ~2 minuti su 2h57m →
> **decisione: lo scrittore resta sul sito**, dove vive la validazione.
>
> **Il test che serviva, e che il guard esistente non sapeva esprimere**: `deploy.yml`
> invoca `publish-edge-files.mjs` **nudo** su trigger `push`, quindi `coveredPaths()` gli
> accredita ogni chiave futura — la PR sarebbe passata verde **anche senza** il nuovo step.
> Aggiunto `has a publisher other than deploy.yml`. Falsificato: neutralizzando lo step,
> 10 test falliscono. Con tutto a posto, 73/73.
>
> ✅ **MERGIATA alle 13:11:56, e l'effetto è verificato sulla superficie pubblica** — non
> sullo stato del workflow. La prima run di `sync-articles-sitemaps` dopo il merge
> (`31315198211`) ha eseguito lo step nuovo con esito `success`, e:
>
> | | prima | dopo |
> |---|---|---|
> | `/edge/rss.xml` su R2 | **404** (mai scritto) | **200**, `last-modified` 13:15:02 |
> | GUID mancanti dall'apex | 5 su 50 | **0 su 50** |
> | `x-github-request-id` sull'apex | presente (= passthrough Pages) | **assente** (= Worker → R2) |
> | `cache-control` | `max-age=600` | `public, max-age=300` |
> | `lastBuildDate` apex vs corpus | 2h57m | **identico** (13:11:17) |
>
> **Una trappola di misura da non ripetere.** Subito dopo il merge l'apex sembrava ancora
> indietro di 4h39m — ma era la **cache edge da 5 minuti** che teneva la risposta
> pre-fix. Con un cache-buster (`?cb=<epoch>`, che passa comunque dal Worker perché la
> rotta è wildcard) il `lastBuildDate` era già allineato. **I GUID lo avevano già detto:
> 0 mancanti mentre le date divergevano ancora.** Due metriche in disaccordo, e quella
> giusta era quella sul contenuto — la stessa lezione della Fase A, al contrario.
>
> ⚠️ **Una trappola nuova, di processo, che vale la pena scrivere.** Lavorando con più
> agenti in parallelo sono nate **due PR per lo stesso lavoro a cinque minuti di
> distanza** (#5461 e #5463), entrambe con lo stesso autore perché condividono il token
> `gh`. #5461 è stata chiusa come duplicato: #5463 la contiene ed è l'unica delle due ad
> avere il test. Il rischio non è il lavoro doppio — è che **il collision detector non le
> vede come collisione**, avendo lo stesso autore e file identici. Se si fa fan-out di
> agenti su questi repo, o gli si vieta di aprire PR (e le apre l'orchestratore), oppure
> si assegna a ciascuno un'area disgiunta. Qui era stato scritto «sola lettura» e non è
> bastato.
>
> **E non basta nemmeno la seconda volta.** Nel giro successivo l'istruzione è stata
> rafforzata fino a un riquadro con «REGOLA NUMERO UNO», l'elenco esplicito dei comandi
> vietati e l'avvertimento che una PR aperta sarebbe stata chiusa. Un agente ha comunque
> aperto **due issue** (corpus #101 e #102). Erano pertinenti e il fixer ne ha già presa
> una, quindi sono state lasciate — ma la lezione è netta:
>
> **su questi repo un'istruzione testuale non è un controllo di accesso.** Se il fan-out
> non deve scrivere, l'unico modo affidabile è togliere il permesso (token senza scope di
> scrittura, o agenti senza `Bash`), non chiederlo. Chi pianifica un fan-out qui deve
> mettere in conto che *qualcosa* verrà scritto sui repo, e assicurarsi che sia
> **innocuo se sbagliato**: aree disgiunte, e mai due agenti sullo stesso file.

### Fase C — Cancellare il mirror morto (dal 2026-08-14, repo SITO)

`.github/workflows/mirror-articles-corpus.yml` è il vecchio mirror distruttivo
(faceva `rm -rf content`), oggi **inerte**: solo `workflow_dispatch`, trigger veri
commentati «DISABLED AT CUTOVER», ultima run #90 del 2026-08-02.

Doveva essere cancellato il 2026-08-09, **ma la finestra era sporca**. Il criterio
(§5 passo 8, emendato da §13.2 di `docs/articles-generator-migration.md`) chiede **una
settimana intera** senza commit di produttori su `packages/articles/content` **e** pull
`sync-articles-sitemaps` verdi nella stessa finestra. L'incidente #5289 (catena
auto-trigger BFS, ~22h, 19 run) ha lasciato 5 commit `feat(article):` fino al
**2026-08-07T05:35:50Z** e 5 pull rossi fino al **2026-08-07T06:38:12Z**.

**Prima data utile: 2026-08-14.** Ricontrollo — deve restituire **vuoto**, con i sync
verdi nella stessa finestra:

> ⏸ **RICONTROLLATO il 9 agosto: la finestra si è sporcata di nuovo. Prima data utile
> ora 2026-08-15.**
>
> La query non restituisce vuoto: c'è `cb0ce3537` del **2026-08-08T18:21:02Z**
> (autore `Valerie`, «sei fix strutturali… (#5360)») che tocca
> `packages/articles/content/seo/seo-blog-5.ts` con +3/−3. È l'intervento d'emergenza che
> accorciava le description del Bollettino **sul sito**.
>
> I sync `sync-articles-sitemaps` sono tutti verdi nella finestra (20 run consecutive
> `success` fino alle 11:31 di oggi), quindi la seconda metà del criterio regge: blocca
> solo il commit.
>
> **Due letture, entrambe difendibili** — la decisione è del proprietario:
> - *letterale* (la query di questo documento filtra solo `Sync article sitemaps`):
>   il commit conta → finestra da 2026-08-08T18:21Z → **2026-08-15**;
> - *sullo scopo* («niente **produttori**»): una fix SEO a mano non è un produttore che
>   scrive articoli → **2026-08-14** resta valida.
>
> **Raccomandazione: aspettare il 15**, costa un giorno e toglie l'ambiguità.
>
> Nota a margine, verificata: quel commit **è stato sovrascritto dal mirror**, come
> previsto. Sito e corpus ora hanno `seo-blog-5.ts` byte-identico (4.090.182 byte,
> `cmp` senza output) e l'edizione 08-08 porta `description == ogDescription == 151` su
> entrambi i lati — cioè lo stato che **corpus#85** descrive, confermato da una misura
> indipendente. È anche la riprova del corollario: *una riparazione fatta sul sito in
> `packages/articles/content/**` viene sovrascritta.*

```bash
gh api 'repos/valerielinc-ops/frontaliere-si-o-no/commits?path=packages/articles/content&since=2026-08-07T05:36:00Z&per_page=100' --paginate \
  -q '.[] | "\(.sha[0:9])\t\(.commit.author.name)\t\(.commit.message | split("\n")[0])"' \
  | grep -v 'Sync article sitemaps'
```

Su `packages/articles/engine` i commit sono **attesi** (main possiede l'engine, §13.4)
e non bloccano.

Se il criterio regge: **una PR sola** sul sito che rimuove il workflow e chiude §5.7 nel
documento (§9.6 e §12.5 sono già aggiornati con data e query corrette, PR #5421).
Nessun `mode` del manifest vincola il file. **Nessun automatismo lo farà scattare**: o
lo fa una sessione, o resta lì (inerte, quindi a costo zero — ma resta).

### Fase D — I gate di qualità non ancora portati

**Contesto.** I guard di qualità del contenuto vivevano solo sul SITO, mentre a
generare è il corpus. L'8 agosto ne sono stati portati sette (PR #56 e #59): factuality,
fabrication, locale, duplicati, wordcount, headline validation, title casing. Offender
reali trovati: **0** su fabrication (15.076 file) e wordcount (3.769 corpi); **9**
headline oltre 110 caratteri, congelati in una baseline **datata** con issue di
drenaggio (**#58**).

**Il punto cieco che li rende necessari**: `loop-drift-check` confronta i file del
manifest uno per uno e **non vede l'assenza di un test da un lato**. Una libreria che
gira in produzione senza la sua suite è invisibile al drift check.

**Censimento dei restanti** (path sul sito, priorità = «un articolo generato dal corpus
può violarlo senza che nessuno se ne accorga?»):

| Gate | Portabilità | Priorità | Sforzo |
|---|---|---|---|
| **sanitizers** (`tests/article-sanitizers.test.ts`) | `adapted`, la lib è **già sul corpus** | **alta — e la PR #75 NON l'ha coperto** (vedi sotto) | basso |
| body-typescript-syntax | `adapted` (esbuild via `npx -y`) | **alta** — un corpo rotto rompe `build-api.mjs`, cioè la superficie pubblica | basso |
| slugs-sitemap-sync | `corpus-only` (riscrittura: il target è `dist/api/`) | alta — le sitemap le pubblica il corpus, oggi senza gate | medio-alto |
| slug-derivation | `adapted` (serve la tecnica sandbox) | alta — slug sbagliati = canonical errati / 404 | medio |
| category-diversity | `adapted` banale | alta come domanda, gate **soft** (fallisce solo al 100%) | basso |
| ticker-data | `adapted` parziale | media-alta | medio |
| tax-guard | `adapted` con riserva (cifre allineate al calcolatore del sito) | media | basso |
| archive-chronological | `adapted` (servono i hook di `node:test`) | media | basso-medio |
| density | `adapted` banale | media-bassa (gate soft) | basso |
| defect-history | **bloccato**: la lib `article-defect-history.mjs` non è sul corpus | — | — |
| seo-fallback · schema-translators · hero-image-discover · contextual-links · meta-descriptions | **non portabili** (plugin Vite / alias TS / template del sito) | n/a | — |

**Attenzione a non credere che `sanitizers` sia già fatto** ⏱. La PR #75 ha aggiunto un
guard **solo sui control character C0** in sei script di scrittura. Il cluster
`sanitizers` è un'altra cosa: `generator/scripts/lib/article-sanitizers.mjs` gira a ogni
generazione sul corpus e **non ha un solo test da questo lato** — la sua suite è rimasta
sul sito. Resta il primo da portare, e il porting va fatto *sapendo* che la parte C0 è
già coperta a monte.

**Tecniche già collaudate per il porting** (riusale, sono in `main` sul corpus):
`generator/tests/lib/expect-shim.mjs` (matcher vitest minimi su `node:assert`);
l'estrazione in sandbox del blocco puro quando l'import trascinerebbe la closure npm;
e una **sanity anti-falso-verde** su ogni gate full-corpus (`> 3000` file, `8` file
meta) — in un worktree sparse `content/` non esiste, e un gate che passa su zero file
scanditi è il falso verde più facile da produrre qui.

**Una PR per cluster coeso**, worktree separati, parallele.

> 🟡 **Primo cluster portato — PR corpus #100 (`sanitizers`).** 39 test, 6 suite, 39 pass
> in 78 ms, eseguiti contro la lib reale del corpus **prima** di aprire la PR.
> Le due copie della lib sono byte-identiche (601 righe, stesso sha256) e lo specificatore
> di import resta invariato. Unica differenza di sorgente: cadono i 4 cast TypeScript
> `null as unknown as string`, che `node --test` rigetta (non fa transpiling).
> Falsificato: neutralizzando `stripCompetitorPromotion` nella lib, 7 test falliscono.
>
> Corretta anche la docstring di `expect-shim.mjs`, che dichiarava `.not` supportato solo
> per `toBe`/`toContain` mentre l'implementazione lo supporta per tutti (non è cablato per
> matcher: ricostruisce l'oggetto con `negated: true`). Il porting usa `.not.toMatch` 15
> volte.
>
> **Due premesse del censimento non reggono alla misura** — chi continua deve saperlo:
> - **`body-typescript-syntax`: «un corpo rotto rompe `build-api.mjs`» è FALSO.**
>   `build-api.mjs` non contiene la stringa `blog-body` nemmeno una volta e carica 6 file
>   di `content/` (registri + meta). Un corpo rotto non tocca la superficie pubblica:
>   nasce qui e detona **sul sito**. E il gate non può vivere in `tests.yml`, che è
>   dependency-free per progetto e gira solo su PR — mentre **gli articoli atterrano per
>   push diretto su `main`**. Va messo come preflight in `publish-api.yml`.
>   Misurato: 15.140 corpi, **0 offender**, 2,9s.
> - **`category-diversity`**: il test del sito fa `return` se il file dati non esiste —
>   **un falso verde puro**, da correggere *nel* porting, non dopo.
>
> **Il finding più grande della Fase D non è nessuno dei due gate**: `generator/scripts/lib/`
> ha **36 gemelli** del sito, di cui **31 byte-identici e 5 già divergenti**, e
> **nessuno è nel manifest** → invisibili a `loop-drift-check`. Issue **#97**.
> (La PR #92 del ciclo ne ha registrati 7 di `generator/scripts`, non questi.)

### Fase E — Le pendenze che nessuno traccia

Sono emerse dalla verifica dell'8 agosto e **non hanno una issue** ⏱ (verifica: potrebbe
essercene nata una nel frattempo). Per ciascuna: aprire una issue ben diagnosticata è
già metà del lavoro, perché il ciclo agentico del corpus le prende da solo.

> ✅ **TUTTE TRACCIATE il 9 agosto.** Sette su otto erano ancora vere; due hanno cambiato
> natura sotto verifica, **e in entrambi i casi in peggio**.
>
> | # | esito | dove |
> |---|---|---|
> | E1 telemetria muta | **risolta**, non solo tracciata | PR corpus **#93** |
> | E2 guard anti-purge | confermata: asimmetria reale, ma oggi **verde per fortuna** (0 falsi positivi su 195 workflow) | sito **#5460** |
> | E3 `npm install` fragile | risolta per i 9 `npm ci` (PR #91); resta `npx -y tsx@4` | corpus **#98** |
> | E4 `article-duplicate-detection` | confermata: 4 soglie su 4 divergenti, e testa una funzione che non esegue | sito **#5456** |
> | E5 sezione svizzera | **la diagnosi del brief era sbagliata** — vedi sotto | corpus **#96** |
> | E6 `manifest.files` caratteri | confermata nei numeri, **zero consumatori** → resta una nota, non una issue | — |
> | E7 `fu-parked` | **peggio dell'ipotesi**: non restano ferme per sempre, vengono **chiuse `not planned` dopo 10 giorni**; il filtro che decide chi si salva è un regex sulla parola «workflow» | sito **#5455** |
> | E8 auto-chiusura | **peggio dell'ipotesi**: non è rumore, chiude issue di bug **strutturali** col fix mai applicato (#76, #77) | sito **#5454** |
>
> **E5 — il «tarpit evergreen» non era la causa.** Ultimo articolo svizzero
> 2026-08-08T21:38 (due lenti concordi al secondo: `swiss-articles.json` e i commit di
> `content/blog-body-ch/`). La causa vera, dal log della run `31301620110`: per gli
> evergreen la "fonte" contro cui il gate di fedeltà grada l'articolo è
> `EVERGREEN_FACTS_BRIEF`, **interamente frontaliero** — Accordo Frontalieri, IRPEF
> italiana, Convenzione del 1976 — iniettato **senza alcun branch su `IS_FRONTALIERE`**.
> Un articolo su «dichiarazione imposte canton Ginevra» omette giustamente quei fatti,
> prende recall 19% < 50%, viene bloccato e si becca uno strike. A tre strike la keyword
> muore: **94 candidati su 110 (85%) sono già morti così**. Non è la famiglia di keyword
> «salario medio professioni»: è **ogni** keyword nazionale. La fix è section-aware, e
> **non** passa dall'abbassare soglie (NON-GOAL).
>
> **Altre tre issue aperte oltre le otto**, emerse dalla verifica:
> corpus **#94**/**#95** (Fase A, vedi sopra), corpus **#99** (il triage post-merge non
> posta mai il marker), corpus **#97** (36 gemelli fuori dal manifest),
> sito **#5457** (il sito non ha nessuna sanificazione dei control character: 6 renderer
> scoperti, e `rerender-article-hubs` ha girato stamattina — regressione **armata**, non
> danno in corso), sito **#5458** (`deploy.yml` riscrive gli `/edge/*` da un checkout
> vecchio di 2h30m), sito **#5459** (la CTA pool emette `nav:first-day` che il nostro
> sanitizer distrugge: 51 articoli IT in bilico, e sono il 94% del rumore su ogni misura
> dei sanitizer).
>
> **Worktree (E5 del brief): potati.** I quattro erano tutti su PR mergiate; recuperati
> ~440 MB. Restano ~2,2 GB liberi su 460: la macchina è ancora il vincolo.
>
> 🔶 **Uno però NON va potato, ed è un caso da manuale della sezione «Lo stato orfano».**
> `frontaliere-si-o-no/.claude/worktrees/body-leak` (377 MB, branch
> `fix/runtime-body-identity`) supera **tutti** i controlli che dichiarano spazzatura un
> residuo — non esiste su `origin`, zero commit avanti rispetto a `origin/main`,
> **`status: added` == 0** — e ciononostante **contiene lavoro vero**: due file
> *modificati e non committati*, +77/−15.
>
> È una fix sostanziosa a `services/staticArticleFallback.ts` e
> `services/runtimeArticleResolution.ts`: c'è **una sola stash per documento** e
> sopravvive alla navigazione client-side, quindi chiedere il body statico senza dire
> *quale* articolo ci si aspetta restituisce il corpo della landing page per ogni
> articolo successivo. Il diff introduce `expectedPath` per chiuderlo.
>
> **La lezione, che va aggiunta al criterio del documento**: `git diff --stat <base>...<head>`
> e `status: added == 0` guardano lo stato **committato**. Un worktree con modifiche in
> working tree non ha né commit né PR, quindi passa per residuo vuoto da ogni controllo
> — ed è il caso in cui cancellare costa di più. **Prima di rimuovere un worktree,
> `git status --porcelain` e `git stash list`, sempre.**
>
> Diff messo al sicuro in `~/Projects/ORPHAN-body-leak-uncommitted.patch`. **Aggiornamento:
> nel frattempo un'altra sessione lo ha ripreso, committato ed esteso** — è la PR sito
> **#5465** (+449/−23 su 7 file, inclusi i due che avevo salvato). Il lavoro è al sicuro,
> il patch resta come rete.
>
> ### Il disco è una risorsa CONTESA fra sessioni, e questo cambia le regole
>
> Misurato in questa sessione: da 2,2 GB liberi a **305 MB in circa un'ora**, senza che
> fossi io a consumarli. La causa: **altre sessioni Claude attive sulla stessa macchina**
> avevano creato quattro nuovi worktree sul sito (`f-cache`, `f-disc`, `f-prop`, `f-rep`,
> ~377 MB l'uno). A 305 MB si è a un passo dal blocco descritto in «Stato macchina».
>
> **Cosa NON si può fare**: potare i worktree altrui. Verificato uno per uno — due avevano
> modifiche non committate, uno 8 commit e una PR aperta, due erano appena creati. Nessuno
> era prunabile con la regola meccanica.
>
> **Cosa si può fare**: le directory temporanee delle sessioni **morte** sotto
> `/private/tmp/claude-501/-Users-usuari-Projects/<uuid>/`. Ne ho recuperati 175 MB.
>
> **La trappola, che è costata un quasi-errore**: la `mtime` della *directory* non si
> aggiorna quando si scrive in un file annidato. Una sessione con `dir-mtime` di **ieri**
> risultava morta — e invece aveva un file scritto **nello stesso minuto**. Il controllo
> che regge è sul file più recente *dentro* l'albero:
>
> ```bash
> find "$d" -type f -exec stat -f '%m %N' {} \; | sort -rn | head -1
> ```
>
> Con la sola `mtime` della directory avrei cancellato lo scratch di una sessione viva.

1. **Telemetria muta nel fixer del corpus.** In `issue-fix.yml` lo step *Mark Claude
   terminal outcome* legge la variabile `ISSUE` mentre il job usa `ISSUE_NUMBER`:
   stampa `ISSUE non impostata → niente telemetria da postare` e **la telemetria
   granulare non viene mai pubblicata**. È esattamente il segnale che spiegherebbe un
   fixer che gira e non produce nulla — cosa che è successa (run `31282772673`,
   6 minuti, conclusion `success`, zero artefatti). Segnalato solo in un commento su
   una issue ormai chiusa.
2. **Falso positivo nel guard anti-purge del sito.** In
   `tests/cf-zone-purge-blast-radius.test.ts` le due metà del guard non sono
   simmetriche: quella sugli **script** è file-scoped (e il commento spiega che è
   proprio per non sbagliare quando il path si risolve su una riga e `--files=` sta su
   un'altra, come in `purge-changed-cdn-assets.mjs`), mentre quella sui **workflow**
   filtra **riga per riga**. Un comando multi-riga con `--files=` su una riga di
   continuazione risulta un'invocazione nuda, e il guard emette un messaggio che
   annuncia un `purge_everything` che non esiste. Ha già quasi prodotto una fix
   sbagliata (Fase B). La fix vera è rendere la metà workflow file-scoped o
   ricomporre le continuazioni prima di filtrare, così il messaggio torna a
   descrivere ciò che accade. **Nessuna issue lo traccia.**
3. **`npm install` fragile nella CI del corpus** (trappola 14): nessuna mitigazione.
   Vale un retry con backoff o una cache, o togliere la dipendenza dove il passo usa
   solo builtin. Ogni flake del registro è oggi un potenziale articolo fantasma.
4. **`article-duplicate-detection` sul SITO pinna soglie obsolete.** Il test là replica
   un `checkForDuplicates` vecchio (0.60/0.45/0.35/0.40 con stemmer inline) che **non
   esiste più in nessuno dei due repo**. La versione portata sul corpus è riscritta
   sull'algoritmo reale con attese misurate. È un `site-behind` da segnalare a chi
   tiene il sito: oggi quel test dà una falsa sicurezza.
5. **Worktree aperti** ⏱: **quattro, per 817 MB complessivi**, tutti con la PR già
   mergiata e nessun lavoro recuperabile — su **3,0 GB liberi su 460** è spazio che
   conta. Sul corpus `.wt/fx1-sanitize` (213 MB), `.wt/d1-backfill` (21 MB) e
   `.claude/worktrees/agentic-loop`; sul sito `.claude/worktrees/v7-ticker` (376 MB),
   che **serve finché la PR #5420 non è mergiata**. Rimuovi con
   `git worktree remove --force <path>` + `git branch -D <branch>`, **solo dopo** aver
   verificato che la rispettiva PR sia mergiata (l'hook di SessionStart del sito pota
   da solo i worktree mergiati, ma non quelli del corpus).
6. **La sezione svizzera è a secco** ⏱: nessun articolo dalle 21:38 dell'8 agosto,
   solo commit «Record rejected topic candidates» a ripetizione. **Non è colpa dei gate
   portati** (#56/#59 sono stati mergiati alle 16:23/16:33 e due articoli svizzeri sono
   usciti *dopo*, alle 18:13 e 21:38): è esaurimento di candidati a monte, aggravato
   dalla quota giornaliera dei modelli free. La diagnosi completa dell'8 agosto indicava
   un «tarpit» evergreen (la famiglia «salario medio professioni svizzera 2026 canton X»
   fallisce quasi sempre il gate fattuale delle percentuali letterali ed è in testa
   all'ordine di selezione, così brucia il budget prima di arrivare a 34 keyword vive a
   0 strike). **Se resta a secco un'altra giornata**, il punto da aprire sono le fonti e
   l'ordine di selezione dei candidati svizzeri — **non** i gate, e non abbassando
   soglie.
7. **Il campo `files` del manifest misura CARATTERI, non byte** — le dimensioni non
   tornano con `content-length` per i file con accenti (`articles.json`, puro ASCII,
   combacia; `slugs.json` no). Irrilevante finché nessuno lo usa come checksum di
   integrità: se qualcuno lo fa, non funzionerà.
8. **Issue `fu-parked`** ⏱: diverse issue aperte hanno quella label (**#71** compresa,
   che traccia il drenaggio della Fase A). Domanda da chiudere: il ciclo riprende le
   `fu-parked` da solo, o restano ferme per sempre? Se restano ferme, il drenaggio
   della Fase A non ha nessuno che lo porti avanti — e va lanciato a mano.

---

## Metodo — le due regole che hanno pagato l'8 agosto

**Ogni claim di visibilità va falsificato da una seconda lente.** Due volte una misura
ha smentito l'altra, e ogni volta la contraddizione ha scoperto un difetto vero:
69 «fantasmi» della detection contro 1 solo dello sweep HTTP (era il quoting dei path
non-ASCII, trappola 10); e «4 control character su 2 articoli» contro 592 su 32 (i byte
dentro JSON sono escapati, trappola 11). **I numeri che non combaciano sono un regalo.**

**Il run verde non è la prova.** Verifica sempre l'*effetto* sulla superficie che
l'utente o il crawler vede, non lo stato del workflow. Tre volte l'8 agosto un run
`success` non aveva fatto nulla: il fixer senza artefatti, il drenaggio fermato dal
tetto, e il ciclo che ripubblicava sempre gli stessi dieci id. Solo in uno dei tre casi
era un difetto — ma per saperlo bisognava guardare.

---

## Stato al momento della consegna (9 agosto, ~10:00 UTC)

Fotografia dei due repo, da rimisurare prima di partire.

**Chiuso e verificato in questa sessione**: il drenaggio dei control character (0 pagine
live sporche su 112 verificate, issue #71 chiusa con l'evidenza); il canale del ticker
(PR sito #5420 mergiata — ma vedi sotto); la separazione dei tre campi descrittivi
(#83); la registrazione del fork `create-article.mjs` nel manifest (#82); il blocco
della CI del sito (#80).

**Issue aperte sul corpus** ⏱ — tutte `fu-prio:low` o `fu-parked`, quindi **ferme**
finché la Fase 0.1 non sblocca il ciclo:

| # | cosa | note |
|---|---|---|
| **#85** | le 2 edizioni del Bollettino già pubblicate restano con l'excerpt corto | serve il codice che manca, non un rilancio (#84 chiusa come duplicato) |
| **#86** | le `seoDescription` di en/de/fr non arrivano alle pagine | lavoro su due repo, in ordine: prima il corpus emette, poi l'engine legge |
| #40, #28 | backlog storici | |
| #25 | crawler transient (ledger) | |

**Da verificare per prima cosa**: l'oggetto R2 del ticker era ancora fermo al
2026-08-08T19:15 dopo il merge di #5420. È atteso — si aggiorna al **primo articolo
pubblicato dopo il merge** — ma è quella la prova che chiude la Fase B:

```bash
curl -sI https://cdn.frontaliereticino.ch/data/news-ticker-live.json | grep -i last-modified
```

Se dopo un articolo nuovo resta fermo, la fix non ha funzionato e va riaperta.

## ⚑ TERZO GIRO — le `needs-human`, quelle che il ciclo non prende mai

Tre agenti su `#86` (corpus), `#5454` e `#5457` (sito). Tutte e tre le consegne hanno
**falsificato una premessa dell'incarico**, e i verificatori hanno trovato **tre falsi
verdi** in lavoro che avevo già pushato o mergiato.

| issue | falsificazione | esito |
|---|---|---|
| **#86** | le `seoDescription` localizzate **non esistono da nessuna parte** (grep = 0 su tutti e 8 i `blog-meta-*.ts`): il lavoro non era esporle, era farle **uscire dalla generazione** | PR **#117** mergiata, + **#119** per il falso verde |
| **#5454** | il meccanismo ha **ri-chiuso #77 quattro minuti dopo che l'avevo riaperta a mano**: non rispetta nemmeno l'intento umano esplicito | PR sito **#5487** |
| **#5457** | la regressione «disfare la #94» **non era armata**: sito e corpus hanno `content/` byte-identico (15.204 file, 0 differenze). Il pericolo vero è un altro | corpus **#118** mergiata; PR sito **#5488 CHIUSA** |

**#5488 è stata chiusa, non mergiata**, e la ragione vale più della PR: il gate proposto
**rifiutava la home viva**. Misurato su `curl https://frontaliereticino.ch/` (162 KB):
`isPublishable = false`, **10 findings, tutti falsi**. Il confinamento «solo dentro
stringhe quotate» si rompe con **due apostrofi** — un `'` in un commento apre una regione
singola-quotata fittizia che si mangia le regex successive, e i loro `\b` diventano
control character. Un gate fail-closed con quel falso positivo **fa danno invece di
prevenirlo**.

Altri cinque difetti, tutti trovati dalla seconda lente e tutti registrati su #5457:
il merge **auto-innescava** un re-render dell'intero corpus garantito rosso (la PR toccava
un file nei `paths:` del proprio trigger); un solo landing rifiutato **congelava 8 shard**,
l'opposto di quanto dichiarava il suo header; l'`exit 1` finale **saltava purge e
sitemap**, lasciando l'apex a servire la copia vecchia; e il test strutturale era un
**falso verde** — lasciando il gate cablato ma ignorandone il valore di ritorno, 20/20
passavano e il gate diventava decorativo.

### I tre falsi verdi, tutti della stessa forma

1. **#117** — i test provavano che la lib emette i campi, **non che sia lei a scrivere i
   registri**. Rimettendo l'emettitore vecchio in `create-article.mjs`: **625 pass, 0
   fail**, e la produzione non emette più niente. Il cricchetto resta dormiente per
   sempre, perché senza edizioni col campo `armedFrom` è `undefined` e il test stampa
   «cricchetto dormiente» e passa.
2. **#5487 / F1** — degradando `fetchIssueComments` da `null` a `[]`: **33/33 verdi**, e
   una fetch fallita per rate limit diventa «nessun verdetto» → «transiente» → la issue
   strutturale viene chiusa. La distinzione *non ho potuto leggere* vs *ho letto, era
   vuoto* è load-bearing e non era coperta.
3. **#5487 / F2** — il ramo di hold che chiama **anche** `resolveGithubIssue`: 33/33
   verdi, log `closed=0 held=1`, e la issue chiusa lo stesso. Le asserzioni prendevano
   «manca il `continue`», non «chiude comunque».

**La forma comune**: un test che guarda il pezzo giusto ma non che sia *collegato*, e una
degradazione che torna al comportamento vecchio **con un log plausibile**. È la stessa
famiglia di `SiteShellContract` e di #65.

### Il ragionamento migliore del giro

Per **#5457** l'agente ha misurato, nello stesso istante, che la pagina live rende il
titolo **correttamente** mentre `meta-it.json` porta quello rotto (`Il 3territorio
poroso3`). Conclusione: **un gate che *sanifica* avrebbe sostituito un titolo live
corretto con quello rotto** — avrebbe fabbricato la regressione che doveva impedire. Da
qui un gate che **rifiuta di pubblicare** invece di ripulire.

E ha trovato perché la divergenza è potuta esistere: la dichiarazione «*if either copy is
touched, touch both*» sta sulla copia del **corpus**, non del sito. **Il lato che doveva
agire non aveva modo di leggerla.**

### Una conseguenza che ho dovuto rincorrere, e che vale come regola

Mergiare **#118** (che promuoveva `sanitize-control-chars.mjs` a `identical` *in previsione*
della PR gemella) e **chiudere #5488** ha lasciato il manifest ad asserire il falso:
`identical` con una `baseline.site` per un file che sul sito **risponde 404**.
`loop-drift-check` avrebbe prodotto un `site-behind` permanente su una coppia inesistente —
e il rumore ricorrente è precisamente ciò che fa smettere di guardare i segnali.

Riparato da **#124** (torna `corpus-only`, `baseline.site: null`, con la `reason` che
registra *perché*). Poi l'audit sull'intero manifest: **178 voci `identical`/`adapted`
verificate contro l'esistenza reale del file sul sito → 1 sola sbagliata**, quella. Non è
una classe, è la conseguenza di una sequenza specifica.

**La regola**: non promuovere una voce del manifest *in previsione* di una PR gemella. Il
manifest descrive ciò che **è**, non ciò che sarà — e se la gemella non arriva, resta a
dichiarare una cosa falsa che nessun test prende.

## Cosa resta aperto dopo il 9 agosto pomeriggio

In ordine di urgenza. Tutto è tracciato: nessuna di queste vive solo qui dentro.

**1. La corruzione del testo negli articoli — corpus #94 e #95.** Riparata al 52%
(**582 → 279** occorrenze) e verificata sulla pagina (`svincolo` 10 → 0, `nestle` 23 → 4).
Il detector del drenaggio è stato corretto (**#129**): cercava il **byte**, che sulle
pagine emesse dopo #65 non c'è mai, e riportava sempre `0`. Ora cerca la **parola rotta**,
con il corpus come oracolo — non un pattern generico, ma *quella* parola nata da un marker
in *quell'articolo*. Da `0` a `2` pagine sporche rilevate.

**I 279 rifiutati, classificati** (e il danno vero è molto più piccolo del numero):

| n | categoria | riparabile come |
|---|---|---|
| **201** | il marker sta *attaccato* alla parola, non dentro (`"territorio` → `3territorio`) | rigenerare il chunk meta dal **corpo** |
| **68** | più marker nello stesso token | rigenerare l'articolo |
| **8** | sostituzione singola pulita | serve un dizionario FR/DE |
| **2** | altra corruzione nel token | rigenerare l'articolo |

**Sulle superfici vere il residuo è minuscolo**: **2 pagine live** (quelle che #129 ora trova)
e **2 stringhe** nella superficie dati (`3territorio poroso3`, `dell6educazione` in
`meta-it.json`) — gli altri match a cifra sono legittimi (`1maggio`, `2mila`, `3mila`).
I 201 **non arrivano all'HTML**: vivono nei chunk meta, non nel corpo renderizzato.

**Il canale giusto è il CORPO come oracolo per i META**, non un dizionario:

```
content/blog-meta-it.ts               -> 'l 3territorio poroso3'   ROTTO
content/blog-body/it/lavena-...ts     -> 'Il territorio poroso'    CORRETTO
```

Il testo corretto **è già nel repo**, stessa lingua, stesso articolo. Il chunk meta è una
derivazione del corpo: quando il meta porta un residuo e il corpo no, il corpo decide —
nessuna inferenza, nessun rischio di inventare. E sono proprio le occorrenze che
`repair-mangled-chars.mjs` non può toccare, perché lì il byte è già sparito. Si incrocia
con **#85**, che chiede già un `refresh-article-meta` riusabile: è lo stesso codice.

*(Avevo prima suggerito la versione **IT** dello stesso articolo come oracolo per i corpi
FR/DE: misurato, **0 su 8** — sono lingue diverse, il testo italiano non contiene le parole
francesi. Suggerimento sbagliato, corretto sulla issue.)*

**#95, la causa a monte, è CHIUSA** — PR **#131**. Il fixer l'aveva abbandonata (run tutte
`skipped`, label `agent:fix` cadute), quindi l'ho presa io.

Il difetto non era lo strip: era che **toglie il marker che rende esatta una riparazione
futura**. Ora si registra *prima* di distruggere, con il contesto che conserva la coppia
`(byte, carattere seguente)` — è quella coppia, non il byte da solo, a dire quale
carattere è andato perso. Sette choke point cablati su un reporter condiviso, `::error::`
invece di un warning perso fra mille, evidenza in JSONL.

**Non fa fallire la generazione**, di proposito: il rubinetto a monte (#66) è ancora
aperto e bloccare lì fermerebbe la produzione per una manciata di caratteri. La decisione
si prenderà *sui dati che quel file produce*.

### Il conto finale di #94, dopo tre misure successive

Il numero «279 rifiutati» si scioglie quasi tutto guardando le superfici vere:

| dove | quanto | come si chiude |
|---|---|---|
| chunk meta | **2 campi** (`3territorio`, `dell6educazione`) | rigenerare i due articoli |
| pagine live | **2** (`nestle`, `finanze-ticino-consuntivo`) | dizionario FR per 8 occorrenze, o rigenerare |
| corpi FR | 68 multi-marker + 2 altra corruzione | rigenerare quegli articoli |

E i due residui nei meta sono **punteggiatura** perduta (una virgoletta, un apostrofo), non
lettere accentate: ecco perché il repair ancorato al lessico non li vedeva nemmeno quando
il byte c'era — `3territorio` non è una parola storpiata, è una parola giusta con un
carattere di troppo davanti.

**Nessuno dei tre richiede codice nuovo.** Il codice che mancava — il detector che li trova
(#129) e il guard che smette di distruggere le prove (#131) — è mergiato. Resta una
rigenerazione mirata, che il repo sa già fare.

**2. La sezione svizzera ferma — corpus #96.** Produzione a zero su metà del sito da
oltre 14h al momento della misura, con l'85% del pool di candidati già ritirato per
strike ingiusti. Ogni run che passa ne ritira dell'altro.

**3. Il triage post-merge che non produce nulla — corpus #99.** Finché resta, ogni
`## Non implementato (ancora)` continua a evaporare: è la Fase 0 che si riapre da sola.

**4. Le due PR in volo**: sito **#5463** (RSS all'edge) e corpus **#100** (gate
sanitizers). Nessuna delle due va mergiata a mano — l'auto-merge le prende su `## LGTM`.

**5. Il resto dei gate (Fase D)** e le issue sito #5454-#5460, che il ciclo del sito
prende da solo.

**6. Fase C**, dal **2026-08-15** (non 14), col ricontrollo qui sopra.

### Tre cose che questa sessione non ha fatto, e perché

- **Non ho ripulito i 592 byte C0 in `content/`**: `content/**` non si tocca a mano
  (NON-GOAL). La riparazione va scritta come codice nel generatore/emitter — ed è
  esattamente ciò che #94 chiede, con la forma della sostituzione già censita.
- **Non ho portato gli altri gate** oltre `sanitizers`: due premesse del censimento non
  reggevano alla misura (vedi Fase D) e riprogettare dove vanno messi è lavoro che
  merita la sua PR, non una coda a questa.
- **Non ho toccato `fu-parked` sulle issue esistenti**: #5455 mostra che la meccanica è
  diversa da come la si pensava (chiusura per age-out, non stallo eterno), e cambiarla a
  mano prima di aver corretto il filtro sposterebbe solo il problema.

## Ordine consigliato di attacco

> **Superato dall'esecuzione del 9 agosto pomeriggio.** L'ordine qui sotto è quello
> originale, lasciato per memoria; per cosa fare adesso vedi «Cosa resta aperto» qui
> sopra. I punti 1, 2 e 3 sono chiusi (con la Fase A **riaperta** su una causa diversa).

1. ~~**Fase 0**~~ ✅ — sblocca il ciclo E la CI del sito. La label `follow-up` è una riga di codice; i due fix
   bloccati dallo scope sono già scritti e vanno solo portati a destinazione. Senza
   questa fase, parte di ciò che farai dopo evaporerà allo stesso modo.
2. ~~**Fase A** — il drenaggio C0~~ **fatto il 9 agosto** (0 pagine sporche, verificato).
   Resta solo da sapere che il workflow è dispatch-only, se mai servisse di nuovo.
3. **Fase B** — verifica se #5420 è atterrata e se il ticker si aggiorna al primo
   articolo nuovo; poi decidi sul RSS (è una PR propria).
4. **Fase D** — i gate, uno o due cluster per volta, in PR parallele.
5. **Fase E** — apri le issue mancanti: sono otto pendenze che oggi non esistono da
   nessuna parte se non in questo documento. Aprirle è metà del lavoro, perché il ciclo
   le prende (una volta fatta la Fase 0).
6. **Fase C** — dal 14 agosto, con il ricontrollo.

## ⚑ CHIUSURA (9 agosto, ~23:50) — verifica finale e cosa resta armato

Stato misurato, non dedotto: **main verde su entrambi i repo** (0 check falliti),
**tutte e 21 le PR di questa sessione mergiate** (corpus #88 #89 #91 #93 #100 #104
#105 #106 #107 #108 #109 #110 #111 #117 #118 #119 #124 #129 #131; sito #5463 #5487),
checkout puliti, disco 5,9 GB. Le due PR aperte (corpus #122, sito #5484) sono del
ciclo autonomo, non mie.

**La sezione svizzera pubblica di nuovo**: `swiss-articles.json` è a **661** contro
i 649 di stamattina — dodici articoli in poche ore, a intervalli di 10-20 minuti,
dopo 17 ore di secca. È la conferma sulla superficie pubblica che la fix di #96
regge in produzione, non solo che un run è verde.

### #132 non è un fantasma — ed è un'istanza di #114

`fast-publish` 31333805957 è fallita sullo step *Verify the article is actually
readable*: FR in `building`, IT/EN/DE `200`. Verificato dopo: **quattro locali
`200` su origin e su apex**, e la URL nuda dà `cf-cache-status: MISS` su entrambe
le varianti `Vary: Origin`. Nessuno ha chiesto quella pagina durante la finestra,
quindi la cache non si è avvelenata. Resta aperta di proposito: lo structural-hold
introdotto in #5487 la tiene lì finché #114 — la sua causa strutturale — non è
chiusa. È il comportamento voluto, non una pendenza dimenticata.

### #114 — la diagnosi era sbagliata nella issue, ora c'è quella giusta

Il corpo di #114 attribuiva il guasto a un purge mirato che riporta `success: true`
senza evittare. Letto il codice, il meccanismo è un altro, e riparabile.

**Prima ipotesi, mia, falsificata**: «il purge non tocca il gemello `origin-*`».
Falsa. `fast-publish-article.yml` alle righe 482-483 purga già *entrambe* le chiavi,
e il commento lo dice — «EVERY path this run pushed, apex + origin». Scartata.

**Quello che succede davvero**: c'è **un solo** step di purge, e sta **prima** della
verifica. Lo step successivo interroga in polling `https://origin-$shard-$loc…`
(riga 604, `poll_origin "$u" 12`, fino a 12×15s e altri 12 dopo un rebuild) con
`curl` sull'URL nudo. Quell'URL è byte per byte la chiave che il Worker usa per il
proprio fetch verso l'origin (`upstream.hostname = origin`, `cacheEverything: true`,
`cacheTtl = ORIGIN_CACHE_TTL = 7200`). Finché lo shard è `building`, **ogni poll
scrive un 404 nell'esatta entry che il Worker leggerà**, con TTL 2h — e nessun purge
segue: il gate è l'ultimo step che tocca l'edge. **È la verifica ad avvelenare la
cache**, dopo l'ultimo purge.

Questo spiega anche le due misure che restavano orfane: il purge manuale fatto dopo
il guasto copriva le varianti `Vary: Origin` **dell'URL apex**, non il gemello — evitta
l'apex, il Worker rifetcha l'origin, trova lì il 404 avvelenato e **ristampa** una 404
apex fresca (ecco «purge riuscito, `age` che ricresce»); e `?cb=` funzionava perché la
query è preservata fino all'origin, quindi cambia anche quella chiave.

Le due mosse che lo chiudono, entrambe piccole e nel workflow del corpus: dare a
`poll_origin` una query di cache-bust (toglie la causa *sistematica*, perché il gate
garantisce la finestra a ogni pubblicazione lenta), e un secondo purge `if: always()`
in coda alla verifica sulla stessa lista già costruita (copre il caso fortuito del
crawler). Scritto per intero nel commento su #114.

### Perché non ho chiuso il resto

Nessuna delle issue aperte è in realtà già risolta — verificato una per una, non
per titolo:

- **#102** — i **quattro** test portati dal sito (`article-sanitizers`,
  `fast-publish-cdn-offload-order`, `news-sitemap-whitelist`,
  `pr-collision-detector-drafts`) erano tuttora **assenti** dal manifest (217 voci: 122
  `identical`, 55 `adapted`, 39 `corpus-only`, 1 `not-ported`). Aperta a ragione, e il
  fixer l'ha presa alle 02:4x con la **PR #137**, che li registra tutti e quattro più
  `reconcile-article-shards.yml`.
  *Correzione a una mia misura*: avevo scritto «cinque», includendo
  `seo-description-cap.test.mjs`. È sbagliato — quel file esiste **solo nel corpus**, il
  sito non ha nessun gemello, quindi non è un test portato e non deve entrare per questa
  via. Il numero veniva dall'aver estratto tutti i nomi `.test.mjs` dal corpo di #102.
  Resta vera, e più piccola, l'osservazione strutturale: `generator/tests` **non è un
  root censito** (i root sono `scripts/ci`, `scripts/lib`, `generator/scripts/lib`,
  `host`), quindi un test davvero portato che atterrasse lì resterebbe invisibile al gate
  di scope. Non urgente — #137 copre i casi noti — ma è il prossimo buco della stessa
  famiglia.
- **#125** — chiede un grado che distingua «non serve sul sito» da «serve e manca»;
  `not-ported` non è quello. Aperta a ragione, già `agent:fix-queued`.
- **#94, #127** — restano per lavoro che non è codice (rigenerazioni; una dispatch con
  quota). **#113** è in coda al fixer. **#25, #28, #40, #85, #101** sono backlog e
  `fu-parked` per scelta.

Chiuderle a mano sarebbe stato dichiarare fatto ciò che non lo è. **La follow-up che
conta è #114**: è l'unica pendenza con impatto utente misurabile (un crawler che passa
nella finestra prende 404 per due ore su un articolo appena pubblicato), e da oggi
porta la diagnosi giusta invece di quella che manda a caccia del purge.

### La verifica ha falsificato il mio «main verde» — e aveva ragione

Avevo letto `gh api repos/<sito>/commits/main/check-runs` e concluso «zero check
falliti». **Quell'oracolo è vuoto**: su quel repo restituisce zero check-run, quindi
«zero falliti» è vacuo, non verde. `gh run list --branch main` dice altro: il publish
**31332098687** (19:36 UTC) è `failure` con cinque gate rossi — `audit:max-bfs-depth`,
`audit:orphan-sitemap-pages`, `audit:title-length`, `audit:text-html-ratio`, `audit:h*`,
con offender 12>5, 15>5, ~75 vs 12 — e **l'ultimo publish riuscito è delle 15:19 UTC**.

Regola che ne esce, salvata in memoria: *un oracolo che risponde «nessun problema» va
interrogato anche su cosa dovrebbe trovare quando il problema c'è; se non sa produrre
un positivo, il suo negativo non vale niente.* È la stessa forma dello step `SKIPPED`
dentro una run `success` che mi aveva fatto aprire un finding su un difetto inesistente.

**Ma nessuna di queste è una pendenza scoperta** — verificato issue per issue, il ciclo
le aveva già aperte tutte prima di me:

| trovato misurando | già tracciato da |
|---|---|
| publish rosso su `audit:max-bfs-depth` | **#5428** (06:43) e **#5434** (famiglie BFS) |
| i dieci feed sull'apex ~76 min dietro il corpus | **#5497** (21:37, `/edge/*` su R2 più vecchio del committato) |
| la coda dei feed non riparata | **#5453** + PR **#5484** aperta |
| `deploy.yml` che riscrive `/edge/*` e non purga | **#5458**, **#5483** |

**Correzione a una mia misura precedente**: avevo scritto che `/edge/rss.xml` risponde
200 senza `x-github-request-id`. L'URL era sbagliato — `/edge/rss.xml` è la **chiave sul
CDN**, non un path dell'apex, e da Pages un 404 lì è atteso. Sull'URL vero, `/rss.xml`,
il Worker serve il feed con `content-type: application/xml; charset=utf-8` e senza header
GitHub: **#5463 è vivo in produzione**. Il ritardo di ~76 minuti è a monte, sull'upload
su R2, ed è #5497.

### Due difetti veri nel MIO lavoro, trovati dalla seconda lente

**1. Il guard di #131 copre un sanitizer su cinque → issue #133.** Il test di cablaggio
cerca `sanitizeText(` + `writeFileSync(` e asserisce `seen.length >= 7`. Ma
`sanitize-control-chars.mjs` esporta altri quattro sanitizer che strippano la stessa
classe C0, e chi li usa scrive senza passare dal report:

| file | sanitizer | write | report |
|---|---|---|---|
| `scripts/build-api.mjs` — **la superficie pubblicata** | `sanitizeDeep`, `sanitizeXmlDocument`, `sanitizeJsonText` | 7 | **0** |
| `scripts/publish-article-fast.mjs` | `sanitizeHtmlDocument` | 4 | **0** |
| `scripts/refresh-hub-landing.mjs` | `sanitizeHtmlDocument` | 2 | **0** |
| `scripts/build-blog-index.mjs` | `sanitizeDeep` | 2 | **0** |

Il guard è **auto-confermante**: l'ho scritto conoscendo i sette file del ramo
`sanitizeText` e con soglia `>= 7`, quindi cerca la forma che quei sette hanno, li trova
tutti e passa. Non poteva scoprire chi ha una forma diversa. *Un guard che verifica solo
l'insieme da cui è stato derivato non misura la copertura: misura sé stesso.* Stessa
famiglia di `SiteShellContract` e `alert-pat-down.mjs`.

**2. Il detector di #129 trova 10 pagine live sporche, non 2** — correzione postata su
#94 con l'elenco. `de` e `fr` dominano (4 e 5), l'italiano compare due volte:
coerente con l'ipotesi che il rubinetto #66 colpisca soprattutto le locali tradotte.
`lavena-ponte-tresa-territorio-poroso` è sporco su tutte e quattro ed è il caso
irrecuperabile (`Il "territorio poroso"` → `Il 3territorio poroso3`): lì serve la mano.

### Terza volta: gli agenti «di sola lettura» hanno scritto sui repo

Le due verifiche erano istruite a **non scrivere**. Alle 21:51 e 21:54, durante il loro
run, hanno aperto **#5498** e **#5499** sul sito, pushando due branch orfani che stavano
nei worktree locali. Contengono lavoro vero — `added` > 0, 735 e 941 righe con 645 di
test — quindi per il criterio di `CLAUDE.md` non sono residui, e le lascio al ciclo
(review → `## LGTM` → auto-merge), che è l'unica via consentita.

Ma il punto resta, ed è la terza occorrenza in questa sessione: **su questi repo
un'istruzione testuale non è un controllo di accesso.** Se una fase deve essere di sola
lettura, va resa tale togliendo il permesso, non chiedendolo.

Il file orfano `scripts/ci/corpus-ahead-check.mjs` (387 righe, assente da entrambi i
main) è stato copiato in `~/Projects/_orfani-2026-08-09/` prima di ogni altra cosa, così
non dipende dalla sopravvivenza del worktree.

Infine un fenomeno che spiega perché stasera tutto sembra fermo e che *non* è un guasto:
alle 21:28 UTC parte la flotta dei «Crawler Group» (dieci gruppi in parallelo, 26-27
crawler l'uno) e per ~30 minuti la coda Actions del sito tiene 27 run non completate,
fra cui il publish, l'auto-merge e — con una certa ironia — il *Pages Publish-Lag
Watchdog*, cioè il guardiano di questo stesso ritardo. È ricorrente e si riassorbe;
va saputo prima di diagnosticare uno stallo che non c'è.

## Riferimenti

- **Rendiconto completo dell'8 agosto: `nanakokyobashi-rgb/frontaliere-articles#28`,
  nei commenti** (tre: principale, parte 2 con gate e canali, correzione sui control
  character). Le sezioni «Non implementato (ancora)» delle PR #56 e #59 rimandano a «un
  rendiconto G9 della migrazione» senza link: è questo, e sta lì. Non cercarlo altrove.
- Backlog storico: stessa issue #28, e **#40** (dopo la bonifica delle PR sospese).
- `docs/articles-generator-migration.md` nel repo SITO: §5.7, §9.6, §12.5, §13.2, §13.4
  per il mirror e il criterio di cancellazione.
- `CLAUDE.md` in `~/Projects`: architettura, credenziali, comandi.
