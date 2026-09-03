# Dettagli operativi del workspace frontaliereticino.ch

Questo documento conserva cronologia, misure, diagnosi e procedure estese che
non devono occupare il contesto iniziale di ogni sessione. Leggerne soltanto la
sezione pertinente quando `CLAUDE.md` la richiama o quando serve ricostruire il
motivo di una regola.

Due repo che si parlano via HTTP, non via import. Tutto quello che segue e' stato
verificato leggendo i repo, non dedotto dai nomi.

## Da dove si apre la sessione

La root del workspace e' **`~/Projects/frontaliere`**, ed e' da li' che vanno
lanciati Claude Code o Codex — non da dentro un repo, e non da `~/Projects`.

`.backlog/` (nella root) tiene lo stato delle sessioni lunghe — il resto del contenuto
della root (agenti, secret, gh-nanako, i due repo figli) e' spiegato in dettaglio piu'
sotto in questo stesso file.

Aprirla dalla root e' cio' che rende possibile il lavoro che **attraversa** i due
repo — ed e' il caso normale, non l'eccezione: per `mode: identical` la fix va sul
sito e scende al corpus (vedi «Il ciclo agentico e' condiviso»), e per il
`SiteShellContract` le due meta' vanno spedite nello stesso giro. Da dentro un
repo solo, l'altra meta' non e' nemmeno visibile.

I due repo **restano indipendenti**: hanno il loro `.git`, i loro branch, le loro
PR. La root non li contiene in git — li gitignora (vedi `.gitignore`). Un terzo
repo domani si aggiunge clonandolo qui dentro e aggiungendo una riga a quel file.

I percorsi di questo documento sono relativi alla root, quindi
`frontaliere-si-o-no/...` significa `~/Projects/frontaliere/frontaliere-si-o-no/...`.

## I due repo

| Cartella | Origin | Cos'e' |
|---|---|---|
| `frontaliere-si-o-no/` | `valerielinc-ops/frontaliere-si-o-no` | Il sito + la SPA (stack e conteggi in `package.json`/`.github/workflows`). |
| `frontaliere-articles/` | `nanakokyobashi-rgb/frontaliere-articles` | Copia mirrorata del corpus + engine, che pubblica la superficie dati. Vedi la sezione sotto: e' un mirror, non l'originale. |

C'e' anche un terzo repo, piu' piccolo e indipendente dal ciclo sopra:
`frontaliere-reddit-devvit/` (`nanakokyobashi-rgb/frontaliere-reddit-devvit`, privato,
push aggiunto il 2026-08-25) — l'app Devvit che posta i nuovi articoli del blog su
r/frontaliere, sostituendo il poster API-key bloccato dalla review Data Access
Request di Reddit. Nessun `.git` prima di quella data: era lavoro locale non
backuppato, spinto su un repo proprio perche' non c'e' motivo di tenerlo a rischio
di sparire con la macchina. `devvit upload` resta fermo su una reCAPTCHA
manuale allo step di registrazione app — non automatizzabile da qui.

Su **questa** macchina il clone del sito e' **completo**, non shallow: 94.023 commit
di storia, `.git` da 15 GB (misurato il 2026-08-18). Questo cambia in meglio diverse
cose che sul vecchio laptop erano trappole — vedi «Push e PR: qui il clone e'
completo». Se leggi da qualche parte che «il clone e' shallow e `git log` vede un
commit solo», quella riga descrive il laptop vecchio, non questo.

## Il confine tra i due — e perche' e' cosi'

Il corpus pubblica **JSON su HTTP**, e il sito non tocca mai questi sorgenti a
build time. E' quel confine a lasciare i due repo su cicli di deploy distinti:
un articolo atterra e va live senza che il sito faccia un deploy.

Non e' una preferenza stilistica. L'accoppiamento precedente spediva il registro
come modulo ES: pubblicato fuori build come bundle esbuild, il modulo esportava
una forma diversa da quella attesa, il pick risolveva `undefined`, e **ogni
pagina articolo e' rimasta sullo skeleton di caricamento senza un errore in
console**. Un documento JSON non ha una forma di modulo su cui litigare.
Se ti viene la tentazione di importare `frontaliere-articles/content/**` dentro
il sito, e' quella la storia che stai per ripetere.

### Il ciclo, che gira in DUE direzioni

Attenzione all'asimmetria, perche' il README del corpus da solo la nasconde:
il **codice** scende dal sito al corpus, i **dati** risalgono dal corpus al sito.

```
frontaliere-si-o-no/packages/articles          ← la sorgente di verita' del corpus + engine
   │
   │  mirror-articles-corpus.yml  (workflow_dispatch, MANUALE, serve ARTICLES_REPO_PAT)
   ↓
nanakokyobashi-rgb/frontaliere-articles        ← una copia mirrorata, non l'originale
   │
   │  publish-api.yml  (push su main che tocca content/, engine/, scripts/build-api.mjs)
   ├─> build-api.mjs  →  dist/api/  →  GitHub Pages
   ├─> upload su R2   →  cdn.frontaliereticino.ch  →  cf-purge-cache.mjs
   └─> repository_dispatch `articles-published`
          ↓
frontaliere-si-o-no/.github/workflows/sync-articles-sitemaps.yml
   (dispatch + cron 5:23 e 17:23 come rete di sicurezza + workflow_dispatch)
```

Quindi: **una modifica all'engine si fa in `packages/articles` del sito**, non nel
repo del corpus — li' verrebbe sovrascritta al mirror successivo. Il mirror e'
manuale (`workflow_dispatch`), quindi i due lati possono divergere in silenzio.

Il confine e' testato: `tests/packages-articles-confinement.test.ts` verifica —
via AST TypeScript, non regex — che `packages/articles` non importi mai nulla
fuori dalla propria cartella se non builtin Node e le proprie dipendenze
dichiarate. Tutto il resto passa da `SiteShellContract`
(`packages/articles/engine/siteShell.ts`).

La superficie pubblica sotto `dist/api/`: `manifest.json`, `articles.json`,
`swiss-articles.json`, `meta-<locale>.json`, `meta-ch-<locale>.json`,
`slugs.json`, le sitemap blog, dieci feed RSS, `news-ticker-live.json`.
Locali: `it`, `en`, `de`, `fr`.

**Leggi `manifest.json` per primo**: `commit` identifica lo stato esatto del
corpus e `counts` permette di rifiutare un set troncato prima di usarlo.

## Gli shard che NON vanno clonati

Circa 100 repo `frontaliere-<cantone>-<locale>` (26 cantoni × 4 locali) piu'
`frontaliere-articoli*-<locale>`, divisi tra i due account. Sono **target di
deploy generati**, serviti solo dal Worker Cloudflare — descritti "Worker-only"
nei loro README. Pesano 20-26 GB l'uno: `frontaliere-de` e' 23,8 GB,
`frontaliere-ticino-it` 19,6 GB. Non clonarli. Se ti serve vederne il
contenuto, usa l'API GitHub o `curl` sul sito pubblicato.

C'e' anche `valerielinc-ops/frontaliere-cdn` (~520 MB), l'asset host su GitHub
Pages/Fastly.

## Credenziali

Nessun secret sta nei file. Tutto vive in **Firebase Remote Config**, progetto
`frontaliere-ticino` — ~90 parametri: provider LLM, traduttori, Cloudflare/R2,
email, social, analytics.

Il setup e' **gia' fatto**. Il service account
(`gsc-service-account@frontaliere-ticino.iam.gserviceaccount.com`) sta in
`~/.config/frontaliere/sa-frontaliere-ticino.json` (chmod 600), gcloud e'
autenticato con quello, e `.bash_profile` esporta gia'
`GOOGLE_APPLICATION_CREDENTIALS`.

E' il service account **universale** del progetto, per scelta esplicita del
proprietario: nonostante il nome, non e' limitato alla Search Console. Ha 15
ruoli, tra cui `datastore.owner`, `firebaseauth.admin`, `cloudfunctions.admin`,
`storage.admin` e `resourcemanager.projectIamAdmin` — quest'ultimo lo rende
equivalente a un owner del progetto, perche' puo' assegnare ruoli a se stesso.

Trattalo di conseguenza: qualunque comando che lo usa gira con pieni poteri
sulla produzione, dati utente compresi. Per leggere Remote Config ne basterebbe
uno solo (`firebaseremoteconfig.viewer`), quindi il rischio non e' nel lavoro
quotidiano ma in un comando distratto. Niente `gcloud`/`firebase` distruttivi
senza sapere esattamente cosa toccano, e la chiave non esce da
`~/.config/frontaliere/`.

In ogni shell dove servono i secret:

```bash
source bin/rc-env.sh     # → 92 variabili su 113 parametri RC (misurato 2026-08-18)
```

`GOOGLE_APPLICATION_CREDENTIALS` **non** e' esportata nel profilo della shell,
come invece era sul laptop vecchio (`.bash_profile`). Sta nell'`env` di
`.claude/settings.json` della root, quindi vale nelle sessioni aperte qui e
**non** negli altri progetti sotto `~/Projects`. E' deliberato: quella variabile
punta a una chiave equivalente a un owner di produzione, e un export globale la
rende attiva anche dove non c'entra niente. Per le shell manuali non serve
comunque — `bin/rc-env.sh` mette lo stesso default da solo se la variabile non
c'e'.

(La shell dell'utente qui e' **zsh**, non bash: il `.bash_profile` del bundle di
migrazione non verrebbe nemmeno letto. `gcloud` arriva gia' dal `brew shellenv`
di `.zprofile`, quindi di quel file non serviva niente.)

Se il file della chiave sparisce, riscaricalo dalla console Firebase del
progetto `frontaliere-ticino` e rimettilo a quel percorso con `chmod 600`.

Il ponte Remote Config → env e' `frontaliere-articles/generator/scripts/load-rc-env.mjs`,
ed e' l'**unico**: un parametro che non compare nella sua mappa `RC_TO_ENV`
resta `undefined` per chi lo legge da `process.env`, per quanto sia impostato in
Remote Config. Se aggiungi un secret, mappalo li' o e' inerte.

Due comportamenti che confondono se non li conosci:

- Una variabile **gia' presente** nell'ambiente non viene sovrascritta dal
  valore di Remote Config. E' voluto (permette l'override nei workflow), ma in
  locale significa che una `export` vecchia in `.bash_profile` vince in
  silenzio.
- Il loader **esce 0 anche quando non carica niente** — non deve mai rompere un
  workflow. In locale un fallimento di auth e' quindi indistinguibile da un
  successo. `bin/rc-env.sh` aggiunge il controllo che manca.

Il file `.env.example` del sito contiene solo la config Firebase pubblica
(`VITE_FIREBASE_*`). Nessun secret li' dentro, per design.

## Comandi

```bash
# corpus articoli
cd frontaliere-articles
npx -y tsx@4 scripts/build-api.mjs   # genera dist/api/
```

Sito: comandi npm standard (`install`/`dev`/`test`/`build:fast`), vedi `scripts` in
`frontaliere-si-o-no/package.json`.

`tsx` e non `node` per il corpus: i sorgenti usano specificatori relativi senza
estensione, che Node ESM puro non risolve.

## Pushare e aprire PR: i due repo NON si comportano allo stesso modo

Sono di **due account diversi**, e questo cambia i comandi. `gh` e' autenticato come
`valerielinc-ops`, che pero' ha accesso a entrambi:

| repo | owner | push | admin | merge delle PR |
|---|---|---|---|---|
| `frontaliere-si-o-no` | `valerielinc-ops` | si' | **si'** | **mai a mano** — `tests` verde → `pr-review-loop` → auto-merge su `## LGTM` |
| `frontaliere-articles` | `nanakokyobashi-rgb` | si' | **no** | **come il sito**: `tests` verde → review → auto-merge su `## LGTM` |

**`gh` va sempre puntato esplicitamente sul corpus.** Da un worktree di
`frontaliere-articles`, `gh` inferisce il repo dal remote e di solito funziona, ma
qualunque comando lanciato da altrove (o con `-R` sottinteso) finisce sul repo del
sito senza avvisare:

```bash
gh pr create --repo nanakokyobashi-rgb/frontaliere-articles --base main --head <branch> ...
gh pr list   --repo nanakokyobashi-rgb/frontaliere-articles --state open
gh run list  --repo nanakokyobashi-rgb/frontaliere-articles --workflow=publish-api.yml
```

### Su 11 repo di nanako, `gh` normale e' in sola lettura — e sembra un bug

Misurato il 2026-08-18 su tutti e 114 i repo dei due account:

| account | repo | diritti di `valerielinc-ops` |
|---|---|---|
| `valerielinc-ops` | 93 | **ADMIN su tutti e 93** |
| `nanakokyobashi-rgb` | 21 | WRITE su 10, **READ su 11** |

Gli 11 in sola lettura sono shard: `frontaliere-{uri,vallese,vaud}-{de,fr,en}` piu'
`frontaliere-{vallese,vaud}-it`. Non e' una regola — `frontaliere-uri-it` e'
scrivibile e i suoi fratelli no: e' un invito da collaboratore applicato a mano e
in modo incompleto. Non ci sono inviti pendenti da accettare (verificato).

Su quegli 11, un `gh` o un `git push` torna **403**, che su un repo pubblico si
legge come un problema di token e non lo e': il token e' giusto, e' l'account a non
avere il diritto. Il rimedio e' il PAT del proprietario, che sta in Remote Config:

```bash
bin/gh-nanako api repos/nanakokyobashi-rgb/frontaliere-uri-de --jq .permissions
bin/gh-nanako pr list --repo nanakokyobashi-rgb/frontaliere-uri-de
```

`GITHUB_PAT_NANAKO` e' **admin su tutti e 21** i repo di nanako, con scope
`repo`, `workflow`, `admin:org` e `delete_repo`. Quindi l'autonomia piena c'e',
ma passa da un'identita' diversa — e per questo `bin/gh-nanako` non e' il default:
sul corpus e sui 10 shard scrivibili il `gh` normale basta, e lascia le tracce
sull'account giusto.

In pratica la distinzione conta poco: gli shard sono target di deploy generati e
non si toccano a mano (vedi «Gli shard che NON vanno clonati»). Se serve
sistemare la cosa alla radice, e' il proprietario a dover aggiungere
`valerielinc-ops` come collaboratore su quegli 11 — non e' automatizzabile da qui,
perche' richiede admin che questo account non ha.

**Sul corpus ORA c'e' l'agente** (aggiornato il 2026-08-08). La riga che diceva
«niente review automatica, niente fixer, l'auto-merge copre solo
`engine-lockstep-auto`» descriveva il repo prima della PR #13, che ha portato
l'intero ciclo del sito: `pr-review-loop`, `auto-merge-on-lgtm`, `auto-merge-sweep`,
`pr-autorebase`, `pr-redflag-fixer`, `issue-fix`, `issue-triage`, `stale-pr-rescuer`,
`recycle-stale-prs`, `loop-drift-check`. Misurato: la PR #37 e' stata aperta,
revisionata da `claude` con `## LGTM` e **auto-mergiata in 8 minuti**, senza che
nessuno la toccasse.

Quindi non serve piu' mergiare a mano, e soprattutto **non si mergia a mano una PR
che l'auto-merge sta per prendere**. Resta vero il rischio opposto, che e' la
ragione della sezione «Lo stato orfano» piu' sotto: cio' che il ciclo *salta*
— le draft — non lo prende nessuno.

Su `admin=false` per il corpus: non si possono cambiare i settaggi del repo ne'
toccare Pages degli shard. Se serve, e' lavoro del proprietario.

### Push e PR: qui il clone e' completo, e le trappole del vecchio laptop NON valgono

Il laptop vecchio aveva il sito in clone shallow (`--depth=1`), e da li' nascevano
tre trappole che **su questa macchina non si presentano**, perche' il clone e'
completo (94.023 commit, `.git` 15 GB, `git rev-parse --is-shallow-repository` →
`false`, misurato il 2026-08-18):

| Sintomo sul laptop vecchio | Qui |
|---|---|
| `gh pr create` abortiva con «you must first push the current branch» anche a branch gia' pushato | non succede — ma `--head "$(git rev-parse --abbrev-ref HEAD)"` resta innocuo e vale la pena tenerlo |
| `git push --force-with-lease` falliva con «stale info» | funziona: c'e' storia condivisa e ci sono le remote-tracking ref |
| `git push` normale si piantava 40-85 minuti a 1,9 GB di RSS (#5258), per colpa di `pack-objects --thin --shallow` | non si applica: la causa era proprio l'assenza di basi utili nel pack shallow |

Quindi qui si pusha normalmente. **Non** riesumare
`git -c pack.window=0 ... --no-thin --force` per abitudine: quei flag includono un
`--force` che su un clone sano serve solo a fare danni.

Resta vero, e va misurato prima di allarmarsi: `.git` a 15 GB e' molto, e i
remote-tracking ref morti inchiodano un pack ciascuno — c'e' un ricordo dedicato
al repack che ne ha liberati ~18 GB. Ma e' manutenzione, non un blocco al push.

Se un giorno il clone tornasse shallow (ri-clonato con `--depth=1` per spazio), le
tre righe della colonna di sinistra tornano tutte valide insieme: il discriminante
e' `git rev-parse --is-shallow-repository`, non l'impressione.

### Il body della PR: `(ancora)` lo vogliono TUTTI E DUE

| repo | header obbligatori |
|---|---|
| `frontaliere-si-o-no` | `## Implementato` + `## Non implementato (ancora)` |
| `frontaliere-articles` | `## Implementato` + `## Non implementato (ancora)` |

**Questa riga diceva il falso fino al 2026-08-10** — sosteneva che il sito
volesse `## Non implementato` senza `(ancora)`, e ci sono cascati otto PR di
fila in una sola sessione. La verita' e' che i due gate del sito non sono
d'accordo fra loro:

- `pr-body-contract.yml` ha una regex che matcha **anche senza** `(ancora)`
  → il check `contract` passa verde;
- `scripts/lib/pr-body-sections-check.mjs` pretende `(ancora)`
  (`NON_IMPL_ANCORA_RE`, e un errore dedicato `missing-ancora`), e
  `AGENTS.md` del sito prescrive la stessa forma.

Quindi omettere `(ancora)` sul sito **non fallisce il gate**: torna come finding
del reviewer, cioe' un giro di review in piu' — che sul sito costa una `vitest`
da ~18 minuti. Usa `(ancora)` su entrambi i repo, sempre.

Trappola dell'estrazione, valida su entrambi: la sezione si chiude al **primo
heading di qualunque livello**, quindi un `###` subito sotto l'header la rende
vuota — bullet sostanziosi prima di qualunque sottosezione.

E dal 2026-08-10 (corpus #144) la sezione non e' piu' un elenco di scuse ma un
**piano di completamento**: ogni bullet vuole uno stato letterale
(`in questa PR` / `PR concatenata #N` / `blocked: <causa>`), oppure un esplicito
`per scelta`/`by construction`. Un bullet che dice solo «fuori scope» viene
bocciato.

### Il ciclo agentico e' condiviso: guarda il `mode` prima di correggere

`frontaliere-articles/scripts/ci/loop-sync-manifest.json` registra ~72 file del
ciclo con un `mode`, e **il mode decide DOVE si fa la correzione**:

| mode | dove |
|---|---|
| `identical` | **sul sito**, poi scende. Toccarlo sul corpus crea un `corpus-ahead` su un file dichiarato uguale |
| `adapted` | sul corpus va bene: e' gia' diverso per costruzione |
| `corpus-only` | sul corpus, nessun segnale |
| non nel manifest | nessun vincolo |

Il difetto del collision detector era **osservato sul corpus**, ma il file e'
`identical`: la fix e' dovuta andare sul sito (#5364) e scendere dopo — cosa che
`loop-drift-check` ha fatto da solo, aprendo la issue #41 che il fixer ha chiuso
con la PR #43.

**Il punto cieco**: il drift check confronta i file del manifest **uno per uno**.
Non vede l'assenza di un test da un lato, ne' i file che un file allineato
**nomina senza importarli**. `alert-pat-down.mjs` e' arrivato sul corpus
`identical` dichiarando in un commento che `gh-pat-expiry-monitor.yml` e'
«l'unico punto di chiusura» del suo alert — e quel workflow li' non esisteva:
la issue `priority:urgent` che apre non poteva essere chiusa da niente, e col
dedup sul titolo sarebbe restata accesa per sempre. Stessa forma di
`SiteShellContract`: un contratto che **non ha forma di import** non e' coperto
dai guard che seguono gli import, e passa con la CI verde.

A ogni `site-ahead` chiuso: *il file allineato ne nomina altri? esiste un test
da questo lato?*

## Lo stato orfano di una sessione morta

Capita di aprire una cartella e trovarci il residuo di una sessione finita male:
un worktree con un checkout vecchio, un index pieno di cancellazioni staged, un
branch mai pushato. La domanda «e' lavoro vero o e' spazzatura?» ha una risposta
**meccanica** che costa trenta secondi, e va data prima di qualunque altra cosa:

```bash
git diff --stat <base>...<head>          # quanti file, e in che direzione
gh api repos/<owner>/<repo>/pulls/<n>/files --paginate \
  -q '.[] | "\(.status)\t\(.additions)\t\(.deletions)\t\(.filename)"'
```

Il segnale che chiude la questione e' **`status: added` == 0**. Un albero che non
contiene un solo file che `main` non abbia gia' non puo' portare lavoro nuovo: al
massimo porta una versione *diversa* di qualcosa che esiste. Restano allora da
guardare solo i file con `additions > 0`, che sono pochi, e la domanda diventa
«questa versione e' piu' nuova o piu' vecchia di quella su main?». Se e' piu'
vecchia — e in un residuo lo e' sempre — non c'e' niente da recuperare.

E' andata cosi' con la PR #33 del corpus (2026-08-08): 291 file, 196 inserzioni,
19.521 cancellazioni, e **zero file aggiunti**. Le 196 inserzioni erano il doppio
push per locale gia' rimosso da #10, l'engine senza `ARTICLE_FOOTER_ROOT` (la
regressione `audit:footer-root-presence` 23 → 3608) e registri con `runCounter`
piu' basso. Le 250 rimozioni erano l'intero ciclo agentico e 150 articoli
pubblicati nel frattempo. Un orologio indietro di due giorni, non uno stato da
analizzare.

**Uno snapshot va in un tag, MAI in una PR.** Se i byte servono davvero, si
conservano server-side senza trasferire niente e senza tenere armato niente:

```bash
gh api repos/<owner>/<repo>/git/refs \
  -f ref='refs/tags/snapshot/<nome>' -f sha='<head-sha>'
```

Nessun workflow dei due repo ha trigger `tags:` (verificato), quindi un tag e'
inerte. Una PR no: e' una *richiesta di merge*, e usarla come archivio le fa fare
l'unica cosa che non deve fare. Concretamente, finche' #33 e' rimasta aperta i
suoi 22 file `.github/workflows/**` e 7 `scripts/lib/**` stavano nel grafo delle
collisioni, e nessuno degli strati che chiudono le PR ferme poteva toccarla:
`stale-pr-rescuer` salta le draft per scelta, e `recycle-stale-prs` agisce solo
su `stale-review`, che una draft non riceve mai. Sarebbe restata li' per sempre.

Le due falle sono state chiuse — `frontaliere-si-o-no#5364` (le draft escono dal
grafo delle collisioni) e `frontaliere-articles#37` (una draft ferma da >48h
prende `needs-human` e finisce nel digest giornaliero). Ma la regola resta la
regola: la decisione si prende subito, con il check sopra.

## Hook: sollevati nella root, perche' e' da li' che si apre la sessione

Claude Code carica `.claude/settings.json`; Codex carica `.codex/config.toml` e
`.codex/hooks.json` **dalla cartella in cui la sessione parte**, non dalle
sottocartelle. Aprendo da `~/Projects/frontaliere`, quello di
`frontaliere-si-o-no/` non viene letto: i suoi gate sarebbero stati muti, il che
e' peggio che non averli — un guard che sembra un guard senza esserlo.

Per questo la root li **ripete** in `.claude/settings.json` e
`.codex/hooks.json`, con i path che puntano dentro il repo del sito. I medesimi
script accettano i payload hook di entrambi gli agenti:

- **PreToolUse su Bash**: `scripts/ci/sibling-check-gate.mjs` e
  `scripts/ci/pr-body-check-gate.mjs`. Possono bloccare un comando; l'output e'
  feedback, non un errore da aggirare. Verificato il 2026-08-18 che dalla root
  si comportano come da dentro il repo: risolvono i propri path da
  `import.meta.url`, agiscono solo su `gh pr create`, e sono fail-safe (qualunque
  errore interno → exit 0, non bloccano). Un comando innocuo passa, un body senza
  header viene bloccato con exit 2, un body corretto passa.
- **SessionStart / SessionEnd**: potano i worktree mergiati e gli orfani.
- **PostToolUse su Bash**: registra le PR appena aperte nella watch list della
  sessione.
- **Stop**: non lascia terminare il turno finche' una PR aperta dalla sessione
  non ha raggiunto uno stato terminale; su errore di rete o auth degrada
  fail-open.
- **env**: gli `SKIP_*` dei collector lenti, `FAST_BUILD` e
  `NODE_OPTIONS=--max-old-space-size=12288`.

Il gate del PR body vale per **entrambi** i repo, non solo per il sito: i due
vogliono gli stessi header (vedi «Il body della PR»), quindi averlo attivo dalla
root e' un guadagno anche sul corpus.

**Se modifichi gli hook nel repo del sito, aggiornali anche nelle due configurazioni
della root**: sono copie, e nessuno le confronta. E' il prezzo di poter aprire la
sessione dalla root; il `cloud-session-secrets.sh` invece resta solo nel repo,
perche' serve alle sessioni
cloud che partono da li' e in locale e' comunque un no-op.

## Stato del mirror (aggiornato il 2026-08-05)

**I due mirror ora sono due, e si comportano in modo diverso** — e' la cosa da
sapere prima di toccare qualunque cosa qui:

| Cosa scende | Workflow | Trigger |
|---|---|---|
| `engine/` (+ `index.ts`, `articleSections.ts`) | `mirror-articles-engine.yml` | **automatico**: `push` sui path dell'engine + `schedule` 6h |
| `content/` | `mirror-articles-corpus.yml` | **manuale**, dispatch-only, in via di cancellazione (non prima del 2026-08-09) |

Il mirror dell'engine apre una **PR** su nanako, non pusha sul suo `main`, e ha
una allowlist fail-closed sul diff staged: non puo' nominare `content/`, che era
la meta' distruttiva del vecchio mirror (`rm -rf content`). E' quello split a
renderlo automatizzabile.

**Perche' e' stato creato (2026-08-05).** Fino al cutover del 2026-08-02 il
corpus mirror era l'unico portatore del codice. Disabilitarlo — giustamente,
perche' nanako ora *genera* il corpus e un `rm -rf content` lo cancellerebbe —
ha lasciato `engine/` senza via di discesa, **senza che niente lo dicesse**.
Nove commit hanno toccato l'engine, i quattro piu' recenti non sono mai
arrivati, e poiche' e' nanako a rendere le pagine articolo, ogni articolo
pubblicato nel frattempo e' uscito dall'engine pre-fix. Si vedeva solo come
`audit:footer-root-presence` passato da 23 a 3608.

**La trappola da conoscere**: `tests/packages-articles-confinement.test.ts`
dimostra via AST che nulla sotto `packages/articles` importa fuori — ed e'
quello a rendere l'engine copiabile. Ma copre gli **import**, e
`SiteShellContract` **non ha forma di import**: spedire l'engine senza la sua
meta' `host/` da' `TypeError: <membro> is not a function` a render time, dietro
una CI verde. E' successo davvero: nanako riportava 40/40 e parity 8/8 mentre lo
faceva, perche' `node --test` non importa TypeScript e leggeva l'engine come
testo. Ora c'e' un gate runtime che avvia il bootstrap vero (41 membri).
**Se tocchi il contratto, la meta' `host/` va spedita nello stesso giro.**

Su cio' che viene mirrorato i due lati erano **allineati** al 2026-08-04:
`content/` (14.748 file) e `engine/` (19 file), zero differenze byte a byte.

Il repo del corpus ha in piu' cio' che al sito non serve — `generator/`,
`scripts/`, `data/`, `host/`, `public/`, `services/`, il proprio README — e un
`package.json` che dichiara 7 dipendenze (`@huggingface/transformers`,
`firebase-admin`, `google-trends-api`, `jsdom`, `playwright`, `sharp`, `undici`)
che il package confinato del sito non ha, perche' servono a quelle cartelle li'.
Non e' drift: e' lo scaffolding del repo pubblicatore.

Ricontrolla con:

```bash
diff -rq frontaliere-si-o-no/packages/articles/content frontaliere-articles/content
diff -rq frontaliere-si-o-no/packages/articles/engine  frontaliere-articles/engine
```

## Stato macchina (rimisurata il 2026-08-18, laptop nuovo)

Le cifre di questa sezione **sono cambiate tutte** con il cambio di laptop. Se una
riga altrove nel documento contraddice quelle qui sotto, vince questa sezione.

| | laptop vecchio (2026-08-05) | **qui** |
|---|---|---|
| disco libero | 1-9 GB, con punte a **0** che bloccavano il lavoro | **42 GB** su 460 (91% pieno) |
| clone del sito | shallow, 1 commit | **completo**, 94.023 commit |
| `.git` del sito | 21 GB, poi ~3 dopo repack | **15 GB** |
| working tree del sito | 3,9 GB | **~9 GB** (24 GB in tutto con `.git`) |
| `public/` + `data/` tracciati | 1,8 + 1,7 GB | **4,4 + 2,3 GB** |
| `node_modules` | 1,4 GB, presente | **1,7 GB, presente** |
| browser Playwright | **non scaricati** | **presenti** (chromium-1228 + headless shell) |

Quindi `npm run test:e2e` qui **puo' girare**, mentre sul laptop vecchio non poteva:
era una delle limitazioni piu' fastidiose e non c'e' piu'.

Resta vero che 42 GB liberi non sono molti quando il repo ne occupa 24: `df -h`
prima di qualunque operazione che scrive tanto, e nessun secondo clone del sito.

**I worktree vanno comunque creati sparse.** Non piu' perche' il disco e' agli
sgoccioli, ma perche' `public/` e `data/` sono **6,7 GB tracciati in git** che non
servono quasi mai: un checkout pieno per worktree li ricopia tutti.

Dal 2026-08-19 c'e' un comando solo, che fa tutto e **verifica** il risultato
invece di fidarsi (un `--no-checkout` che materializza l'albero pieno lo stesso
e' gia' successo, il 15-08, due volte):

```bash
frontaliere-si-o-no/scripts/dev/fast-worktree.sh <nome> [--add <path>]
```

Misurato: **214 MB / 6.978 file in 2 secondi**, contro 6,7 GB / 41.707 file.
I percorsi esclusi li legge da `scripts/ci/checkout-buckets.json`, la stessa
tabella che usano i workflow in CI — una sorgente di verita' sola.

A mano, se serve deviare dalla ricetta:

```bash
git worktree add --no-checkout .claude/worktrees/<nome> -b <branch> origin/main
cd .claude/worktrees/<nome>
printf '/*\n!/public/\n!/data/\n' | git sparse-checkout set --no-cone --stdin
git checkout
ln -s ../../../node_modules node_modules   # NON lanciare npm install
```

`--no-checkout` non e' facoltativo: senza, git scrive i 6,7 GB **prima** che tu
possa applicare la sparsita', e li hai gia' pagati.

Serve un file sotto `data/` o `public/`? Leggilo senza materializzare la
cartella: `git show HEAD:data/<file>`, oppure `git ls-tree -r --name-only HEAD
-- public/` per elencarla. Se ti serve davvero sul filesystem, materializza la
**sottocartella** (`git sparse-checkout add public/assets`), mai il path intero.

Con `--no-cone` si puo' re-includere **un singolo file**, non solo una
sottocartella — utile quando ne serve uno solo di quei 2,3 GB:

```bash
printf '/*\n!/public/\n!/data/\n/data/article-redirects.json\n' \
  | git sparse-checkout set --no-cone --stdin
```

Corollario da conoscere prima di scrivere un test: importare un build-plugin
tira dentro a module-scope ~12 file sotto `data/` e `public/assets/`. Quindi
**ogni test che importa un plugin e' rosso in worktree sparse e verde in CI**
(`tests/noindex-builders.test.ts` lo e' gia' oggi). Se devi testare un plugin
senza materializzare `data/`, scansiona il sorgente invece di importarlo.

Attenzione al corollario: dentro un worktree sparse `public/` e `data/`
**non esistono**, e l'assenza di un file li' dentro non e' la prova che il file
non sia nel repo. E' l'errore diagnostico piu' facile da fare qui.

`npm install` del sito e' gia' fatto (`node_modules` 1,7 GB, condiviso via
symlink dai worktree). npm ha bloccato 10 install script (`allow-scripts`), ma
esbuild, sharp e vite funzionano lo stesso: i binari arrivano dai pacchetti
opzionali per piattaforma.

Il corpus non ha `node_modules`: builda con `npx -y tsx@4`. Senza
`firebase-admin` installato, `load-rc-env.mjs` usa il percorso REST — funziona
ed e' previsto dal design.

Non clonare altri shard.

## Aggiungere un terzo repo qui dentro

Procedura spostata nella skill `add-repo-workspace` (`.claude/skills/add-repo-workspace/SKILL.md`),
invocata su richiesta invece di restare sempre in contesto.
