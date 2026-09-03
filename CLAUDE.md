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
