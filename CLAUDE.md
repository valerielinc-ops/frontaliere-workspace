# Workspace frontaliereticino.ch

Regole essenziali caricate a ogni sessione. Cronologia, misure e procedure
estese sono in `.agents/references/workspace-operational-details.md`: leggine
solo la sezione pertinente quando una regola qui sotto non basta.

## Avvio e confini

- Apri Claude Code o Codex da `~/Projects/frontaliere`, non da un repo figlio e
  non da `~/Projects`. I path in questo file sono relativi a questa root.
- I repo figli restano indipendenti: ciascuno ha `.git`, branch e PR propri; la
  root li esclude dal proprio git.
- Prima di lavorare dentro un repo figlio, leggi anche le sue istruzioni locali.
- Il lavoro che attraversa i repo e' normale, ma il loro confine e' HTTP: non
  creare import diretti tra sito e corpus.

## Repository

| Cartella | Origin | Ruolo |
|---|---|---|
| `frontaliere-si-o-no/` | `valerielinc-ops/frontaliere-si-o-no` | Sito, SPA e sorgente del package articoli/engine. |
| `frontaliere-articles/` | `nanakokyobashi-rgb/frontaliere-articles` | Mirror pubblicatore del corpus e dell'API dati. |
| `frontaliere-reddit-devvit/` | `nanakokyobashi-rgb/frontaliere-reddit-devvit` | App Devvit indipendente per pubblicare i nuovi articoli su Reddit. |

Il clone del sito su questa macchina e' completo, non shallow. Non applicare le
vecchie ricette `--no-thin --force` o altri workaround da clone shallow senza
prima verificare `git rev-parse --is-shallow-repository`.

## Confine sito-corpus

- Il sito consuma JSON pubblicato via HTTP; non importa
  `frontaliere-articles/content/**` a build time.
- La sorgente del codice condiviso e' `frontaliere-si-o-no/packages/articles`.
  Le modifiche all'engine si fanno li' e poi scendono nel repo pubblicatore.
- Il repo `frontaliere-articles` pubblica `dist/api/` su GitHub Pages/R2 e
  notifica il sito. I workflow dei due repo possono divergere: prima di
  modificare mirror o deploy, leggi la sezione `Stato del mirror` del riferimento.
- `SiteShellContract` attraversa il confine senza un import verificabile. Se
  cambia il contratto, aggiorna e verifica nello stesso giro anche la meta'
  `host/` del repo pubblicatore.
- Leggi `dist/api/manifest.json` per primo: `commit` identifica lo stato del
  corpus e `counts` permette di rilevare un set troncato.

Non clonare i circa 100 repo shard `frontaliere-<cantone>-<locale>` o
`frontaliere-articoli*-<locale>`: sono target di deploy generati da 20-26 GB.
Per ispezionarli usa GitHub API o la superficie pubblicata.

## Credenziali e produzione

- I secret vivono in Firebase Remote Config, progetto `frontaliere-ticino`.
  Non copiarli in file del repository o nell'output della sessione.
- Il service account e' in
  `~/.config/frontaliere/sa-frontaliere-ticino.json` e ha poteri equivalenti a
  un owner di produzione. Non eseguire comandi `gcloud`/`firebase` distruttivi
  senza avere risolto esattamente target ed effetto.
- Quando servono le variabili, dalla root usa `source bin/rc-env.sh`. Il loader
  Remote Config -> env e'
  `frontaliere-articles/generator/scripts/load-rc-env.mjs`: un nuovo parametro
  deve essere aggiunto alla sua mappa `RC_TO_ENV`.
- Una variabile gia' presente non viene sovrascritta dal loader; `bin/rc-env.sh`
  aggiunge il controllo di successo che il loader, deliberatamente fail-open,
  non esegue.

Per dettagli su ruoli, autenticazione o recupero della chiave, leggi la sezione
`Credenziali` del riferimento prima di agire.

## Coordinatore GitHub locale

- Le chiamate GitHub degli agenti passano dal coordinatore condiviso in
  `bin/github-coordinator.mjs`; lo shim comune e' `~/.local/bin/gh`.
- Gli agenti non devono usare canali GitHub esterni al coordinatore: niente REST
  o GraphQL diretto (`fetch`, SDK, `curl`, `wget`), pagine UI/browser GitHub,
  Actions dispatch dalla UI o polling HTML, nemmeno come workaround per timeout
  o rate limit. Il REST interno al coordinatore e' consentito: l'agent deve
  invocare solo `gh ...` tramite lo shim oppure `bin/gh-frontaliere ...`.
- Per Actions usa `gh workflow run`, `gh run list` e `gh run view` attraverso il
  coordinatore; non trasferire dispatch o polling nel browser e non usare
  `gh pr checks --watch`. Se una richiesta va in timeout o quota, controlla
  `bin/gh-frontaliere status`, lascia applicare backoff/coda e ritenta tramite
  lo stesso processo; non cambiare canale.
- Per attendere lo stato di una PR, workflow o deploy usa le subscription
  event-driven: `bin/gh-frontaliere events subscribe ...` seguito da
  `bin/gh-frontaliere events listen <subscription-id>` gestito dal supervisor
  dell'agent. Non eseguire loop di `gh run view`, `gh pr view` o `gh pr checks`.
  Esempio: `bin/gh-frontaliere events subscribe --repo owner/repo --resource pull_request --number 42 --wait-for merged,failed --agent-id <id>`.
  Il listener riceve l'evento normalizzato e invia l'ack; la subscription e gli
  eventi pendenti sopravvivono al riavvio del daemon. La risposta di `subscribe`
  espone `expiresAt`, `remainingMs`, `waitState`, `estimatedWaitMs` e il livello
  di confidenza storico: l'ETA è informativa, la scadenza è il vero limite
  operativo.
- Il supervisor deve trattare una subscription attiva come `waiting-external`,
  non come goal bloccato: dopo `subscribe` avvia un solo `events listen`, svolge
  altro lavoro e attende il callback. Non ripetere `gh pr view`, `gh run view`,
  `gh pr checks` o `events status` per fare polling. Alla scadenza il listener
  riceve `event_subscription_expired` e il goal va marcato `timed-out` con la
  prossima azione esplicita; una sola riconciliazione è ammessa solo se il
  coordinatore segnala un webhook mancante.
- Usa `bin/gh-frontaliere events summary` o `events status` (compatto di
  default; `--full` solo per diagnosi) per un controllo sintetico di pending,
  listener orfani, duplicati ed ETA. Anche `bin/gh-frontaliere status` è
  compatto di default: evita `--full` nei cicli dell'agent. Se
  `sharedObserverRecommended` è
  `true`, non creare un altro osservatore per lo stesso target: il supervisor
  deve riutilizzare/accorpare l'osservazione già presente.
- L'ingress GitHub si avvia con `bin/github-webhook` e deve stare dietro TLS e
  un tunnel/reverse proxy pubblico; il coordinatore verifica sempre
  `X-Hub-Signature-256` con `FRONTALIERE_GH_WEBHOOK_SECRET`. Gli eventi webhook
  sono deduplicati per `X-GitHub-Delivery` e consegnati at-least-once.
- La configurazione pubblica attuale usa Cloudflare Tunnel sotto
  `frontaliereticino.ch`: `https://gh-default.frontaliereticino.ch/github/webhook`
  inoltra alla porta locale `18787` e `https://gh-nanako.frontaliereticino.ch/github/webhook`
  alla `18788`. I receiver sono launch agent macOS persistenti; non mettere il
  token del tunnel o il secret webhook nei repository.
- Se un webhook manca, solo il coordinatore può eseguire una riconciliazione
  una-shot con `bin/gh-frontaliere events reconcile <subscription-id>`; non è un
  permesso per l'agent di riprendere il polling.
- `gh` resta il comando compatibile da usare normalmente: la coda, il limite di
  concorrenza (8 letture di default, ridotte automaticamente con poco margine
  di rate limit), la deduplicazione GET, la cache breve e il backoff sono
  applicati prima del binario reale. Non invocare direttamente
  `/opt/homebrew/bin/gh` o `curl https://api.github.com`.
- `gh pr checks --watch` e' vietato: un solo osservatore condiviso deve seguire
  una PR. Controlla il daemon con `bin/gh-frontaliere status` (oppure
  `--compact` esplicito).
- I coordinatori `default` e `nanako` sono servizi launchd persistenti con label
  `ch.frontaliere.github-coordinator-default` e
  `ch.frontaliere.github-coordinator-nanako`; il launcher carica Remote Config
  anche quando un client deve avviare il daemon automaticamente. Dopo una
  modifica agli script riavvia i due servizi con `launchctl kickstart -k` e
  verifica `bin/gh-frontaliere status --compact`.
- Le cancellazioni di run Actions (`gh run cancel` oppure il POST al relativo
  endpoint) richiedono sempre due passaggi: la prima richiesta viene bloccata e
  produce un `request_id`; l'agent deve fermarsi e chiedere al proprietario una
  seconda conferma, senza invocare autonomamente il comando di conferma. Dopo
  aver verificato target e comando, il proprietario esegue da un terminale
  interattivo `bin/gh-frontaliere confirm-cancel <request-id>` e digita la frase
  esatta mostrata. Le richieste pendenti scadono dopo 5 minuti e non passano da
  REST o UI GitHub. Il token GitHub non distingue agent e proprietario: il
  terminale interattivo e la verifica esplicita sono quindi il confine operativo
  della seconda approvazione.
- In caso estremo il daemon puo' usare una corsia anonima separata, solo per
  letture REST pubbliche e solo dopo `x-ratelimit-remaining: 0` autenticato.
  Ha un budget locale conservativo di 45 richieste/ora; non vale per GraphQL,
  search, mutation o percorsi privati.
- I hook vengono caricati all'avvio della sessione: dopo questa modifica le
  sessioni Codex/Claude gia' aperte vanno riavviate. Verifica con `command -v
  gh` e `bin/gh-frontaliere status`.
- I token restano nel keychain/ambiente e non entrano nel protocollo del socket,
  nei log o negli artifact. `bin/gh-nanako` seleziona una coda separata per
  l'identita' del corpus; non usarla per distribuire il carico.

## Comandi e worktree

Corpus/API:

```bash
cd frontaliere-articles
npx -y tsx@4 scripts/build-api.mjs
```

Usa `tsx`, non `node`: i sorgenti hanno specificatori ESM relativi senza
estensione. Per il sito usa gli script di
`frontaliere-si-o-no/package.json` (`test`, `build:fast`, ecc.).

Il sito e' grande: non crearne un secondo clone e non materializzare `public/`
e `data/` in ogni worktree. Crea worktree sparse con:

```bash
frontaliere-si-o-no/scripts/dev/fast-worktree.sh <nome> [--add <path>]
```

I worktree condividono il `node_modules` principale: non eseguire `npm install`
al loro interno. L'assenza di `public/` o `data/` in un worktree sparse non
prova che il file non esista nel repository; usa `git show`, `git ls-tree` o
materializza soltanto il path necessario.

## Git, PR e merge

- `gh` e' autenticato come `valerielinc-ops`. Per il corpus specifica sempre
  `--repo nanakokyobashi-rgb/frontaliere-articles` quando il comando non viene
  eseguito sicuramente dal suo checkout.
- Il sito ha admin; il corpus ha write ma non admin. Gli shard non vanno
  modificati a mano. Se eccezionalmente serve l'identita' del proprietario,
  usa `bin/gh-nanako` soltanto dopo aver caricato Remote Config.
- Su entrambi i repo: test verdi -> review automatica -> auto-merge dopo
  `## LGTM`. Non mergiare a mano una PR che il ciclo sta seguendo.
- Il body delle PR deve contenere esattamente `## Implementato` e
  `## Non implementato (ancora)`. Inserisci bullet sostanziosi prima di
  qualsiasi sottosezione.
- Ogni bullet di `Non implementato (ancora)` deve dire
  `in questa PR`, `PR concatenata #N`, `blocked: <causa>` oppure esplicitare
  `per scelta`/`by construction`; `fuori scope` da solo non basta.

Prima di diagnosticare permessi, push insoliti o gate PR, leggi la sezione
`Pushare e aprire PR` del riferimento.

## Sincronizzazione del ciclo agentico

`frontaliere-articles/scripts/ci/loop-sync-manifest.json` decide dove correggere
un file condiviso:

| `mode` | Dove correggere |
|---|---|
| `identical` | Nel sito, poi lascia che la modifica scenda. |
| `adapted` | Nel corpus. |
| `corpus-only` | Nel corpus. |
| assente | Nessun vincolo di mirror. |

Non correggere direttamente nel corpus un file `identical`: crea
`corpus-ahead`. Quando chiudi un `site-ahead`, controlla anche file, workflow e
test nominati dal codice ma non importati; il drift check confronta solo i file
elencati e non vede queste dipendenze implicite.

Prima di modificare un file condiviso, esegui
`bin/where-to-fix <percorso>` per verificare il repo corretto.

## Residui e snapshot

Prima di recuperare un branch o worktree apparentemente orfano, confronta il
diff con la base e la lista file della PR. Se non esistono file `status: added`,
ispeziona le poche aggiunte residue prima di concludere che contengano lavoro
nuovo. Uno snapshot va in un tag `snapshot/<nome>`, mai in una PR draft usata
come archivio. La procedura completa e il caso storico sono nella sezione
`Lo stato orfano di una sessione morta` del riferimento.

## Hook della root

Gli hook devono restare attivi dalla root in `.claude/settings.json` e in
`.codex/hooks.json`; puntano agli script del sito per gate PR, pulizia worktree,
registrazione e attesa delle PR. Un blocco del gate e' feedback da correggere,
non un errore da aggirare.

Se modifichi gli hook nel sito, aggiorna anche entrambe le configurazioni della
root. Per il contratto completo leggi la sezione `Hook: sollevati nella root`
del riferimento.

## Stile compresso: caveman e ponytail

I plugin `caveman` e `ponytail` sono attivi in permanenza: `defaultMode: "full"`
in `~/.config/caveman/config.json` e `~/.config/ponytail/config.json`, piu'
`.caveman.json` nella root che fissa la stessa scelta per questo workspace.
Comprimono la prosa; codice, comandi, nomi di API e stringhe d'errore restano
verbatim.

Vanno spenti con `/caveman off` e `/ponytail off` in tre casi:

- Mentre componi il body di una PR. Il contratto vuole `## Implementato` e
  `## Non implementato (ancora)` con bullet sostanziosi, e un body compresso
  viene respinto da `scripts/ci/pr-body-check-gate.mjs`.
- Mentre analizzi il fallimento di una PR: gate rosso, review, check-runs.
- Mentre analizzi il fallimento di un test vitest.

Nei due casi di analisi la ragione e' la stessa: la diagnosi si fa citando
l'output esatto, mentre caveman sopprime i dump di log lunghi. Qui la
distinzione fra un rosso vero e un falso rosso sta proprio in quelle righe.

Riaccendi con `/caveman full` e `/ponytail full` quando l'analisi e' chiusa.

Per vedere cosa occupa la context window usa `unclog` (installato con `uv tool
install unclog`): elenca agenti, skill, comandi e server MCP col loro costo in
token e segnala gli MCP non invocati da 30 giorni. E' di sola lettura e non
fa rete; la rimozione e' un passo interattivo separato.

## Estendere il workspace

Per aggiungere un repo usa la skill `add-repo-workspace` disponibile in
`.agents/skills/add-repo-workspace/` per Codex e in
`.claude/skills/add-repo-workspace/` per Claude Code.
