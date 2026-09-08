# Lezioni operative: delegare a Codex nel workspace frontaliere

Raccolte il 2026-09-08 durante una tornata di ~40 deleghe Codex
(`gpt-5.6-luna`, effort `xhigh`) per chiudere il backlog delle follow-up:
79 issue chiuse, ~40 PR aperte. Ogni voce qui sotto e' costata un errore reale.

Aggiungi in fondo, con la data e la misura che l'ha prodotta. Non scrivere
lezioni non misurate.

## 0. La skill del runtime non e' la fonte di verita' sui valori accettati

`--effort` accetta **anche `max`**. Il companion lo dichiara esplicitamente:
`[--effort <none|minimal|low|medium|high|xhigh|max>]`, e il suo messaggio
d'errore elenca la stessa lista.

La skill `codex-cli-runtime` del plugin si ferma pero' a `xhigh`. Il 2026-09-08
ho letto quella skill, l'ho presa per completa, e ho passato ~40 deleghe a
`xhigh` mentre era stato chiesto `max` — riportando per giunta all'utente che
«max non e' un valore accettato», che e' falso.

**Regola: prima di dichiarare che un valore non esiste, chiedilo allo strumento**
(`--help`, o il messaggio d'errore che elenca le scelte valide), non alla
documentazione che lo descrive. Una skill puo' essere piu' vecchia del runtime
che documenta, ed e' peggio di non avere documentazione: sembra autorevole.

## 0-bis. `identical` nel manifest non garantisce che i file siano identici

Il 2026-09-08 due copie dichiarate `identical` — `free-translate.mjs` fra sito e
corpus — divergevano di **127 righe gia' su `main`**, e un contratto interno
(`noteTranslationOutcome`) non esisteva in nessuno dei due: lo introduceva la PR
in corso, dal lato corpus, cioe' dal lato che per contratto non e' la sorgente.

Nessun check misura quella divergenza. Il drift check confronta solo i file
elencati e non dice nulla quando due `identical` si allontanano.

Conseguenza pratica per chi delega: **il `mode` dice dove va fatta la
correzione, non che le due copie siano allineate**. Prima di chiedere a un
agente di «portare la fix nell'altro repo», fagli confrontare le due copie: se
il difetto non esiste nella copia di destinazione, o esiste in forma diversa, la
richiesta e' mal posta e va riformulata invece che forzata. Un agente che si
ferma dicendo «la forma descritta non esiste qui» ha fatto la cosa giusta.

## 0-ter. L'hook locale sul body NON protegge le PR aperte da Codex

Domanda emersa il 2026-09-08: perche' le PR degli agenti vengono respinte dal
gate `pr-body-contract` (*«Voce N non porta una delle forme letterali del
contratto»*) se nella root c'e' gia' un hook `pr-body-check-gate.mjs`?

Perche' quell'hook ha `matcher: "Bash"`: intercetta il **tool Bash della
sessione Claude Code**, non i comandi che Codex esegue dentro il proprio
processo. Il `gh pr create` vero lo lancia Codex nella sua sandbox, e li' il
`PreToolUse` non arriva mai.

Il paradosso e' che l'hook *vede* comunque il comando con cui lanci Codex — e
infatti blocca se il **prompt** contiene la stringa di creazione PR (vedi punto
2) — ma li' dentro non c'e' nessun body: c'e' il prompt, e la PR non esiste
ancora. Il gate e' inoltre deliberatamente fail-open: «unrecognized
`--body`/`--body-file` shape → exit 0», per non bloccare mai una creazione che
non riesce a interpretare.

Risultato: **lo stesso script gira in due posti, ma l'hook locale copre solo il
percorso che non usi** (PR aperte a mano da te). Per le PR degli agenti l'unico
controllo che morde e' il gate CI remoto, che costa un giro di review — cioe'
quota condivisa col sito, proprio il costo che il messaggio del gate dice di
voler evitare.

**Come rimediare, in ordine di efficacia:**
1. **Metti la forma nel prompt e chiudila**: elenca gli stati letterali ammessi
   (`in questa PR` · `PR concatenata #N` col numero · `blocked: <causa>` ·
   `per scelta` · `by construction`) e di' esplicitamente che **ogni altra
   formulazione viene respinta**. Le violazioni viste oggi erano tutte
   invenzioni plausibili ma non canoniche: «deferred, non funnel-critical»,
   «follow-up — review 🟡», «PR concatenata» senza `#N`.
2. **Chiedi all'agente di eseguire il gate da solo prima di aprire la PR**:
   lo script accetta un body su file, quindi un agente puo' validarlo prima di
   creare la PR e correggersi senza spendere un ciclo di review.
3. Non contare sull'hook: per costruzione non vede quel comando.

## 0-quater. Una run CANCELLATA del check richiesto blocca il merge per sempre

Firma osservata sulla PR #1256 del corpus, con review `## LGTM`,
`Important: 0` e test passati:

```
mergeable=MERGEABLE   state=BLOCKED   rollup=FAILURE
  tests (node --test): CANCELLED
  tests (node --test): CANCELLED
  tests (node --test): null      <- rerun in corso
  test: SUCCESS · rebase: SUCCESS · detect: SUCCESS · dry-run: SUCCESS
```

`tests (node --test)` e' **l'unico** check richiesto dal ruleset di `main`.
Sulla head c'erano tre run omonime: una passata e due cancellate, e in quel
momento **l'ultima per `startedAt` era `CANCELLED`** (poi `null`, il rerun in
volo). E' quello a bloccare: GitHub valuta il required check sull'**ultima run
per quel nome**, non sullo stato aggregato.

> **Correzione, 2026-09-08.** La prima stesura di questa lezione attribuiva il
> blocco al `rollup=FAILURE`. **E' falso**, e un'altra sessione l'ha smentito con
> la misura decisiva: #1256 risulta ora **MERGED con
> `statusCheckRollup.state = FAILURE`** — le due `CANCELLED` sono ancora sulla
> head, il rollup e' ancora rosso, e la PR e' mergiata. Se il rollup rosso
> impedisse di soddisfare il required check, non avrebbe potuto mergiare.
>
> Il rollup rosso resta il motivo per cui la **diagnosi** costa — e' l'artefatto
> che contraddice `gh pr checks` — ma e' il sintomo che inganna, non il blocco.
>
> **Chi costruisce un rilevatore su `rollup=FAILURE` genera falsi positivi in
> massa**, a partire da #1256 stessa: rilancerebbe run su PR gia' mergiate e
> sane.

**Da dove vengono**: la coda di concorrenza. Ogni edit del body e ogni giro dei
fixer avvia una run nuova che cancella la precedente. Su #1256 si erano
susseguiti tre eventi ravvicinati (review, ❌-check-fixer, 🔴-fixer) e ne erano
rimaste due tronche. Effetto perverso: **piu' il ciclo lavora su una PR, piu' e'
probabile che la blocchi** — colpisce cioe' proprio le PR che hanno avuto
findings.

**Perche' costa**: `gh pr checks` mostra il `pass` della run buona e non fa
vedere che il rollup e' rosso per le altre due. A occhio la PR sembra sana. Per
diagnosticarla serve il rollup:

```
gh api graphql -f query='{repository(owner:"O",name:"R"){pullRequest(number:N){
  mergeable mergeStateStatus
  commits(last:1){nodes{commit{statusCheckRollup{state contexts(last:20){nodes{
    ... on CheckRun{name conclusion}}}}}}}}}}'
```

Il rollup serve solo a **capire** perche' `gh pr checks` ti sta ingannando: non
usarlo come predicato.

**Predicato corretto per un rilevatore**: ordina per `startedAt` le run che
portano il **nome del check richiesto** sulla head, e guarda **solo l'ultima**.
Blocca se e' `CANCELLED`, oppure `null` da piu' di N minuti. Il nome cambia per
repo: `vitest (unit + integration)` sul sito, `tests (node --test)` nel corpus.
Rimedio: `gh run rerun <run-id>` su quella run.

**Perche' capita molto piu' nel corpus** (misure di un'altra sessione, stessa
giornata): `tests (node --test)` ha **111 occorrenze failure/cancel su 399** in
sette giorni, e il corpus conta **245 PR con duplicati cross-trigger contro ZERO
del sito** — `generator-ci.yml` e `pr-autorebase.yml` girano sulla stessa SHA da
trigger diversi (`push`+`pull_request`, `pull_request`+`pull_request_review`).
Sono occasioni di cancellazione che il sito non ha, perche' ha fuso tutto dentro
`tests.yml`. Coerente con l'osservazione che il fenomeno colpisce le PR su cui il
ciclo ha gia' lavorato di piu'.

La popolazione istantanea puo' essere vuota (a fine giornata: zero PR aperte
colpite in entrambi i repo), quindi **la prevalenza va misurata sullo storico**,
non su una fotografia.

## 0-quinquies. Un token cercato come stringa invece che come verdetto

La classe di errore piu' frequente della giornata: **tre volte, in due sessioni
diverse, su misure indipendenti**. Ogni volta la forma e' la stessa — si cerca la
presenza di un token nel testo, quando cio' che conta e' il **verdetto** che quel
token esprime.

I tre casi, tutti del 2026-09-08:

| Cercato come stringa | Cosa includeva per sbaglio |
|---|---|
| `grep '## LGTM'` | le **menzioni in prosa** («manca il `## LGTM`»), cioe' il contrario di un'approvazione |
| la parola `Important` | i verdetti **`Important: 0`**, cioe' le review pulite contate come giri con finding |
| `rollup=FAILURE` come blocco | PR **gia' mergiate e sane** (vedi 0-quater) |

Il ciclo, dove la distinzione e' stata fatta bene, mostra il rimedio: il
preflight del 🔴-fixer **pretende un delimitatore** (`:`, `—`, `-`) subito dopo
«Important», e il commento nel workflow spiega perche' — senza, «la stessa regex
matchava anche la prosa di negazione del reviewer (*zero 🔴 Important findings*,
PR #3330): "Important" li' e' un aggettivo che dice che non ce ne sono, non il
marker». E' la stessa ragione per cui su #1256 il fixer ha correttamente
skippato: due 🔴 decorativi, di cui uno diceva «nessun 🔴 aperto».

**Regola**: cerca il verdetto nella sua forma strutturata — col delimitatore, col
valore, sull'oggetto giusto — non il token nel testo. E chiediti sempre **su
quale insieme** stai misurando: una query su *tutte* le review di una PR conta
anche quelle superate, quando la domanda riguarda solo l'**ultima sulla head
corrente**. Anche quello e' un errore di verdetto, non di regex.

## 1. Il subagent forwarder non ti dice come e' andata

`codex:codex-rescue` e' un puro forwarder: una sola invocazione `task`, poi
ritorna. Se il task supera i 600 s di foreground, il runtime lo sposta in
background e il subagent ritorna **solo l'ID del job**, marcandosi `completed`.

Quel `completed` significa «ho inoltrato», non «il lavoro e' finito». Il
risultato vero arriva anche ore dopo, in una notifica separata. Non chiudere un
gruppo, non contare una PR e non rilanciare un agente sulla base di quel primo
`completed`.

## 2. Il gate `PreToolUse` legge il testo del tuo prompt

`sibling-check-gate.mjs` gira come hook `PreToolUse` sul tool Bash e ispeziona
la stringa del comando. Il prompt che passi all'agente **finisce dentro quel
comando**: se contiene certe sequenze letterali (per esempio il comando di
creazione di una PR con il flag del repository), il gate scatta e il lancio
muore prima ancora che Codex parta.

Colpisce anche te, non solo gli agenti: scrivere questo stesso file con un
heredoc e' stato bloccato, perche' il testo del documento contiene le formule
che il gate cerca. Usa lo strumento di scrittura file, che non passa da Bash, e
descrivi i comandi a parole quando li metti dentro un prompt.

## 3. Codex mescola le istruzioni dei due repo

Legge `CLAUDE.md`/`AGENTS.md` di tutto il workspace e applica al repo su cui
lavora vincoli che appartengono all'altro.

Caso misurato: una run sul CORPUS si e' fermata prima del commit perche'
«manca `.git/info/pii-blocklist.txt`, obbligatorio per il PII scan
pre-commit». Nel corpus quel file non esiste, non c'e' hook `pre-commit`,
`AGENTS.md` non lo nomina e un grep su `origin/main` rende zero: quel gate vive
**solo nel sito**. Lavoro completo e verificato, fermo a un passo dal commit,
per un vincolo inesistente. Successo due volte nella stessa giornata con lo
stesso file — la prima cercandolo dentro un worktree, dove `.git` e' un file e
non una directory, quindi `.git/info/` non esiste affatto.

**Regola: un blocco dichiarato da un agente si verifica come si verifica una
misura.** Non produce alcun rosso: solo una PR che non avanza e un turno pagato
per intero.

**Come e' finita, il 2026-09-08.** Tre agenti di fila si sono fermati su quel
file, l'ultimo con due correzioni gia' verificate (rosse pre-fix, verdi
post-fix) ferme prima del commit. La soluzione giusta non era convincerli a
saltare il controllo, ma **dare loro il file**: la blocklist del sito contiene
8 pattern di dati personali (username, luogo, path della home) e nessuna
credenziale, quindi replicarla in
`frontaliere-articles/.git/info/pii-blocklist.txt` estende al corpus la stessa
protezione che il sito ha gia', e il PII scan gira davvero invece di essere
aggirato. `.git/info/` non e' tracciato, quindi e' configurazione locale per
clone: **su una macchina nuova il file va ricreato**, o il blocco si ripresenta.

## 4. Un `by construction` di un solo agente non e' una prova

Due agenti lanciati sullo stesso gruppo hanno dato verdetti **opposti** sullo
stesso item (#7292): il primo ha concluso `by construction` — «il guard si basa
gia' sull'identita' canonica del modulo, nulla da fare» — il secondo ha
implementato la guardia mancante. Entrambe le PR verdi e mergiate.

Chiudere una issue su un `by construction` dichiarato da un singolo agente
riproduce esattamente il difetto del `maybe-resolved` del bot: una issue chiusa
su un difetto vivo. Se il verdetto e' «gia' a posto», pretendi la riga o il test
che lo dimostra, non la frase.

## 4-bis. Non ordinare a un agente di procedere «nonostante» un gate

Corollario del punto 3, imparato subito dopo. Verificato che la
`pii-blocklist` non esiste nel corpus, ho scritto all'agente: «quel gate non e'
richiesto qui, procedi con commit e push». **L'agente ha rifiutato**, e ha
fatto bene: un messaggio che dice a un altro agente di andare avanti nonostante
un controllo di sicurezza e' indistinguibile da un tentativo di aggirarlo, e la
regola giusta e' che nessun messaggio fra agenti autorizzi a cambiare
comportamenti di sicurezza o permessi.

La formulazione utile e' **dare la prova, non l'ordine**: «nel repo X il file
non esiste, `AGENTS.md` non lo nomina, non c'e' hook `pre-commit` e un grep su
`origin/main` rende zero — verifica e decidi tu». Se dopo la prova l'agente
resta fermo, il blocco va risolto altrove, non insistendo.

## 5. Il disco e' il vincolo prima della quota

Un worktree del sito costa ~270 MB. Con ~30 worktree in parallelo il disco e'
andato a zero: `ENOSPC` ha ucciso **cinque gruppi mentre lavoravano** — uno
aveva gia' i test verdi e stava aprendo la PR — e ha fatto crashare anche la
scrittura di stato del companion Codex, che non e' un errore del task e non
dice nulla di utile su cosa stesse facendo.

Il tetto reale e' 5-6 worktree in parallelo. Rimuovi il worktree appena il
branch e' su `origin` (il lavoro e' salvo li'), senza aspettare il merge.

## 6. Il nome del worktree diventa il nome del branch

E i predicati dei workflow guardano il nome del branch. Il `preflight` del
`pr-redflag-fixer` del corpus ingaggia solo se l'autore e' un Bot **oppure** se
il branch inizia per `fix/`: branch `codex/*` e `followup-*` lo fanno uscire
`skipped` in silenzio, anche su una PR con undici finding rossi Important.
Otto run consecutive `skipped` e nessun segnale da nessuna parte.

Se vuoi che il ciclo raccolga le PR degli agenti, chiedi nomi di branch che i
suoi predicati riconoscono.

**Il conto di quanto costa sbagliarlo, misurato a fine giornata.** Il predicato
del SITO non e' un difetto — e' una scelta: il 🔴-fixer commenta
`REDFLAG_OUT_OF_SCOPE` e si ferma «per design» quando l'autore e' umano e il
branch non e' `fix/*`. Il messaggio lo dice esplicitamente: *«Se il finding resta
aperto senza un commit nuovo, serve intervento manuale.»*

Effetto pratico osservato lo stesso giorno, sulle stesse ore:

| PR | branch | esito |
|---|---|---|
| #1256 | `fix/o6-...` | il fixer ingaggia (`REDFLAG_FIX_ROUND: 1`) e la ripara **da solo** |
| #8020 | `followup-events-cache-site` | `REDFLAG_OUT_OF_SCOPE`: serve un agente dedicato |

Stessa giornata, stesso tipo di finding, costo diverso: una riparata gratis dal
ciclo, l'altra pagata con una delega. **Un nome di branch che inizia per `fix/`
sposta il lavoro dal tuo budget a quello del ciclo.** Chiedilo nel prompt fin
dalla prima delega, non dopo.

(Nel corpus il predicato era invece un difetto — un `if:` di job che faceva
uscire il job `skipped` in silenzio anche con 11 finding aperti — ed e' stato
riparato dalla PR #1254. Le due cose non vanno confuse: nel sito lo scope-check
vive in uno step e commenta, nel corpus viveva nell'`if:` e spariva.)

## 7. Il censimento invecchia mentre lo leggi

Ho rilanciato un gruppo perche' «non aveva ancora una PR»: l'aveva aperta nel
frattempo. Risultato, due agenti sullo stesso scope e due PR complementari ma
ridondanti. Prima di rilanciare, ricontrolla lo stato di quel gruppo specifico,
non la fotografia che hai in mano.

## 8. Cosa ha funzionato, e conviene rifare

- **Un brief condiviso su file.** Un unico documento coi vincoli comuni
  (worktree, manifest, contratto del body, regole Actions) e prompt brevi che
  lo referenziano: prompt molto piu' corti, nessuna regola persa.
- **La lista «NON toccare» esplicita.** Nessun agente ha toccato i file
  riservati ad altri, in ~40 deleghe parallele. Ma i tuoi vincoli diventano
  `blocked:` nel body delle PR e sembrano blocchi tecnici: annota sulla issue
  che quel blocco e' di orchestrazione, non del codice.
- **Chiedere di rimisurare prima di lavorare.** Su tre issue verificate, tre
  numeri erano scaduti: 4.086 rotte duplicate -> 2.740; «6 offender su EN» -> 0;
  6.068 job -> 8.676. Una scheda senza il **comando** che ha prodotto la misura
  invecchia senza che nessuno se ne accorga.
- **Raggruppare per file bersaglio**, preso dalla riga `Suggested action` della
  issue. L'area funzionale e' troppo lasca (al primo tentativo ha prodotto un
  secchio da 44 issue); il file bersaglio da' gruppi da ~3 issue, cioe' un solo
  ciclo di review invece di tre. La review e' il costo dominante, non
  l'implementazione.

## 9. La scheda arriva gia' marcia — e Codex la implementa con diligenza

Misura di un'altra sessione, 2026-09-08, cinque task Codex su cinque schede:
**quattro schede su cinque contenevano una premessa falsa.** Non le produce
Codex: arrivano cosi'. Ma se non le trovi prima di dispacciare, Codex
implementa la cosa sbagliata in modo impeccabile.

Le quattro, per tipo:
- una **premessa causale falsa**: «ri-flaggare fa scendere `complete`, quindi il
  ritmo e' una decisione» — `isIncomplete()` non legge mai `needsRetranslation`,
  e su quella premessa la scheda costruiva un'intera sezione di scaglionamento;
- un **numero scaduto**: «6.068 job da ri-flaggare», erano 8.676, perche' la
  stima precedeva una PR mergiata il giorno prima;
- una **descrizione del comportamento falsa**: «lo snapshot non viene mai
  ri-fotografato», mentre il codice lo ri-fotografa a ogni giro, e sui dati
  erano **zero** i job nello stato descritto contro «1 vivo» dichiarato;
- **riferimenti `file:line` scaduti** in due schede su cinque, spostati di 30-40
  righe da PR successive.

Il rimedio misurato: **eseguire il predicato della scheda sui dati prima di
scriverne una per l'agente**. Costa 2-5 minuti di scan e ha riscritto il
bersaglio in 3 casi su 5. Corollario che corregge il punto 8: il campo
`COMANDO` non basta allegarlo, **va rieseguito** — una scheda aveva il comando
giusto e il numero sbagliato.

## 10. Un vincolo enumerato non lascia spazio a un vincolo immaginato

Nella stessa sessione, cinque task e **zero** blocchi inesistenti — contro i tre
del punto 3. La differenza sta nella forma della scheda: quelle dicevano in
negativo cosa NON fare **e con quale motivo misurato** («non toccare questo
file, e' conteso»; «non toccare l'artefatto, la rigenerazione lo cancella in
silenzio»), invece di lasciare che l'agente inferisse i vincoli leggendo i due
`AGENTS.md` del workspace.

Enumerare i vincoli costa poche righe di prompt e chiude la classe di errore
piu' cara: l'agente che si ferma da solo su una regola che non lo riguarda.

## 11. Il tetto vero e' la macchina, e sta piu' in basso del disco

Il punto 5 dice che il disco cede a ~30 worktree. L'altra sessione ha misurato
il lato opposto: **3.798 pagine libere di RAM con UN SOLO job Codex attivo** piu'
una scansione locale da 400 MB. A due job sarebbe andata in OOM.

`ENOSPC` a 30 e quasi-OOM a 1+1 sono lo stesso vincolo visto da due lati. Prima
di scegliere il parallelismo, guarda cosa fa *anche* il processo che tieni tu in
primo piano, non solo quanti agenti lanci.

**Conferma diretta, stessa giornata.** Piu' task Codex sono stati uccisi con
`exit 143` a meta' lavoro, e la causa accertata e' stata **pressione di memoria
di sistema**, non un errore di Codex ne' del prompt. Misura al momento del
guasto: `vm_stat` dava **5.611 pagine libere (~0 GB)** e 0,7 GB inattive, con 33
worktree ancora vivi fra i due repo e il disco al 98%.

Due indicazioni operative:
- `exit 143` (SIGTERM) e `exit 144` da un task Codex vanno letti come «la
  macchina non ce la faceva», non come «il task era sbagliato»: prima di
  riscrivere il prompt, guarda `vm_stat` e `df`;
- **rimuovi i worktree appena il branch e' su `origin`**, senza aspettare il
  merge. Una passata di pulizia su entrambi i repo ne ha liberati 23 e ha
  riportato il disco dal 98% al 92% — spazio che era occupato da lavoro gia'
  salvato altrove.

## 12. In serie, ogni task riscrive la scheda del successivo

Cinque task in serie: 3 PR mergiate, 1 in review, **0 uccise** — contro 5 gruppi
uccisi a meta' nel batch parallelo da 30.

Il beneficio inatteso non e' la stabilita': e' che la misura prodotta da un task
arriva in tempo per correggere la scheda del successivo. La scoperta che
`isIncomplete()` ignora `needsRetranslation` e' emersa mentre il task precedente
girava, e ha cambiato la scheda di quello dopo; in parallelo quella scheda
sarebbe gia' partita sbagliata.

**Quando i ticket condividono il modello del dominio — non solo i file — la
serialita' non e' una rinuncia al throughput: e' come si evita di pagare cinque
volte lo stesso errore.** Il parallelo conviene solo su lavoro davvero
disgiunto, dove nessuna misura di un gruppo cambia la premessa di un altro.

## 13. Su un rosso, togli l'ANSI prima di decidere se e' vero

`grep "FAIL "` sul log grezzo di una run rende una riga vuota, e sembra un falso
rosso. Con lo strip si legge `Test Files 1 failed | 8 passed`:

```
gh run view <run-id> --repo <slug> --log-failed | perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' | grep -E "Test Files|FAIL |Require approving"
```

Su due PR consecutive questo ha distinto un review gate mancante da un test
genuinamente rotto. Senza lo strip la seconda sarebbe stata chiusa come falso
positivo — cioe' un rosso vero archiviato per un artefatto di formattazione.

## 14. Non lasciare un agente in polling: il rate limit lo uccide

Un task su una PR con molti finding e' stato **terminato dall'esterno (exit 143)**
mentre girava in un ciclo `sleep 30; gh pr checks`, dopo aver gia' pushato il
commit finale. L'API Actions aveva iniziato a rendere 403 per rate limit, e il
rerun REST era impossibile.

Due conseguenze pratiche:
- il lavoro **non era perso** — era su `origin`, e i check sono ripartiti da
  soli. Prima di rilanciare un agente su una PR il cui task e' morto, guarda il
  branch remoto: quasi sempre e' piu' avanti di quanto dica l'ultimo messaggio.
- nel prompt, di' esplicitamente di **non insistere in loop** sul polling: se il
  rate limit blocca, aggiornare il body riattiva un run (l'evento `edited` e'
  sufficiente) e costa un turno invece di dieci.

## 15. La PR di review-fix separata funziona meglio di accumulare

Su un gruppo da nove issue, l'agente ha aperto una **seconda PR dedicata alle
correzioni della review** invece di accumularle sulla prima: entrambe hanno
ottenuto `LGTM` e sono state auto-mergiate. Su una PR gia' larga, continuare ad
aggiungere commit di fix la rende illeggibile e allunga ogni giro di review.

## 16. Anche una issue «non letta» puo' contenere lavoro vero

Una follow-up era marcata «non letto» nel titolo e nessuno l'aveva mai aperta.
Istruito a leggerla per prima e a dichiarare **con la prova** se non fosse
azionabile, l'agente ha trovato lavoro reale: ratchet per occorrenze, prefissi
locali e sottopercorsi da correggere. Non dare per scontato che una issue senza
storia sia vuota.

## 17. Misura il conflitto, non fidarti dello stato

Una PR risultava `DIRTY`. In questo repo quello stato puo' essere solo cache: la
misura vera e' `git merge-tree --write-tree origin/main origin/<branch>`, che
esce non-zero solo su un conflitto reale. Li' il conflitto c'era davvero — ma il
punto e' che le due cose vanno distinte prima di far lavorare qualcuno.

Corollario dello stesso caso: **prima di risolvere un conflitto, chiedi se quella
PR serve ancora**. Le issue coperte erano gia' state chiuse da una PR gemella
mergiata poco prima (duplicato nato dal punto 7), quindi rebasare avrebbe
riapplicato lavoro gia' su `main` — rumore per la review e rischio per il codice.
La domanda giusta e' «questo diff aggiunge qualcosa che `main` non ha?», non
«come risolvo il conflitto?».

---

# Aggiunte del 2026-09-08 — sessione di orchestrazione della mappa «ciclo che risolve»

Contesto diverso dalla tornata qui sopra: **12 deleghe** a `gpt-5.6-luna` con
effort `max`, non per drenare il backlog ma per implementare i ticket di una
mappa wayfinder. Risultato: **10 PR mergiate**, tutte con `## LGTM` e zero
Important sulla review finale. Tutte le voci qui sotto sono costate un errore
misurato.

## 9. Il costo piu' grosso e' stato il mio brief, non l'agente

**Non rendere assoluto lo «fermati se una premessa e' falsa».** Scritto cosi',
ferma Codex anche su un dettaglio che non regge il ragionamento. Misura: **due
giri persi** prima che una riga di codice fosse scritta. Al primo giro si era
fermato perche' un mio `grep` era stato troncato da un `head` e affermavo che
uno script non avesse chiamanti — aveva ragione lui. Al secondo si e' fermato
perche' delle cinque PR che citavo, due erano rosse per un'altra ragione: vero,
ma irrilevante per il difetto da riparare.

La forma che funziona e' dichiarare **quali due o tre affermazioni, se cadono,
invalidano tutto**, e dire esplicitamente che il resto e' contorno probatorio da
correggere e superare. Dopo quella correzione lo stesso job e' arrivato alla PR
mergiata in un giro.

## 10. Codex smonta bene le premesse sbagliate: e' un pregio, va autorizzato

Nelle 12 deleghe ha falsificato **due mie premesse su due** in cui avevo torto,
citando il codice. In un terzo caso ha corretto la mia diagnosi in meglio: avevo
detto «lo step di rebase e' stato cancellato», lui ha trovato che esiste ma e'
gattato sulla condizione che manca — piu' preciso e piu' utile.

Scrivi nel brief che ha il permesso di fermarti, e nel giro dopo digli che
aveva ragione. Costa una riga e cambia il comportamento.

## 11. Un blocco dichiarato dall'agente va verificato come una misura

Conferma indipendente della lezione 5 di sopra, da un caso diverso. Il gate
`PreToolUse` del body risolve un `--body-file` relativo contro la directory
**tracciata** della sessione. Codex non ne ha una: ogni suo comando e' un
`zsh -lc "cd <worktree> && ..."` lanciato dalla directory di partenza, quindi
quel `cd` muore col comando. Il gate leggeva ENOENT e bloccava **anche con il
body corretto**, dando come causa «contratto violato».

Codex ci arrivava da solo al secondo tentativo, riscrivendo il body su path
assoluto: contratto rispettato, ma un giro sprecato ogni volta e un messaggio
d'errore che indicava la causa sbagliata. Riparato dalla PR #7937, che fa
risolvere a entrambi i gate il `cd <worktree> &&` letterale del comando e
distingue «path illeggibile» da «contratto violato».

Il precedente che rende urgente questa classe e' nel docblock di
`hook-target-cwd.mjs`, incidente del 2026-08-25: davanti a un verdetto sbagliato
del gate, l'agente **lo aggiro'** chiamando l'API GitHub invece della CLI. Un
gate che sbaglia non viene riparato, viene circumnavigato.

## 12. Scrivi il body della PR una volta sola, alla fine

Misurato in produzione sulla PR #7902: la run `tests` #13371 e' partita su
`synchronize`, e le #13372, #13374, #13375 sono partite su `edited`, ciascuna
cancellando la precedente sullo stesso SHA. **Tre riscritture del body hanno
bruciato tre run da 10-18 minuti** e impedito alla verifica di concludere.

Causa: `tests.yml` aveva `edited` fra i `types` e `cancel-in-progress: true`
sullo stesso gruppo di concorrenza, quindi un evento che non puo' aver cambiato
il verdetto sul codice faceva girare tutto e ammazzava chi stava per darlo.

Riparato dalla PR #7938 — `edited` ora ha una lane di concorrenza separata ed
esegue solo il check del contratto — ma **la disciplina resta buona igiene**:
un agente che itera sul body insieme al codice non converge mai, perche' ogni
sua correzione azzera la verifica che sta aspettando.

## 13. Un job interrotto a meta' lascia lavoro non committato

Successo **2 volte su 12**. Il worktree resta con le modifiche, niente commit,
niente push, e nel frattempo `main` si muove. Nel caso peggiore: sette workflow
modificati, branch rimasto **26 commit indietro**, e due PR avevano nel
frattempo toccato uno di quei sette file.

La sequenza che funziona: salva il diff, guarda di quanti commit il branch e'
indietro, e **se `main` ha toccato gli stessi file riparti pulito** da
`origin/main` dando al nuovo giro il vecchio diff come *riferimento da leggere
ma non applicare*. Rebasare attraverso i conflitti costa piu' che rifare.

## 14. `pkill -f "<job-id>"` uccide anche il tuo waiter

Se aspetti un job con `while pgrep -f "job-id <id>"; do sleep; done`, la riga di
comando del waiter **contiene lo stesso id**. Un `pkill -f "<id>"` li ammazza
insieme. Misura: due waiter persi, e i job veri sopravvissuti — cioe' l'opposto
di quello che volevo. Usa `pkill -f "task-worker.*<id>"`.

## 15. Lo `status` del companion mente da un'altra sessione

`codex-companion.mjs status` filtra i job per `CODEX_COMPANION_SESSION_ID` e
risponde «No jobs recorded yet» **anche mentre il worker gira**. Non e' un job
morto. Verifica con `pgrep -f "task-worker.*<id>"` e leggi il log vero sotto
`$TMPDIR/codex-companion/<workspace-hash>/jobs/<id>.log`.

## 16. Il parallelismo: 5 e' pulito, 7 riempie il disco

Risposta diretta alla domanda sul grado di parallelismo. **Con 5 job
concorrenti**: nessun conflitto, nessun `ENOSPC`, merge regolari. **Salendo a
7**: il disco e' passato da 25 GiB liberi a **3,4 GiB in circa un'ora**, con
14 worktree aperti. Nessun job ucciso, ma un margine che non regge un secondo
giro.

Coerente con l'esperimento a ~30 worktree finito in `ENOSPC` con cinque gruppi
uccisi: **il tetto reale sta fra 5 e 6**, ed e' il disco a fissarlo, non la
quota.

Il recupero che ha funzionato, in ordine di resa: svuotare le cache applicative
e di build (Spotify, Chrome, playwright-mcp, `go-build`, `pip`, Homebrew) ha
reso **~13 GiB**; cancellare i log di sessione Codex e Claude piu' vecchi di 7
giorni, ~750 MB. **Non cancellare** le directory che sembrano cloni orfani senza
guardarle: tre cloni `frontaliere-articles-g*` da 4,3 GiB in totale avevano tutti
modifiche non committate e mtime del giorno.

Il pezzo grosso resta da fare: `frontaliere-si-o-no/.git/objects/pack` e' **23
GB** e un repack ne libera circa 18 (misurato in un'occasione precedente), ma
va fatto **a flotta ferma**: serve spazio temporaneo, perche' il pack nuovo si
scrive prima che il vecchio venga cancellato.

## 17. La lista «NON toccare» ha retto anche qui

Confermo la voce 8 di sopra su un campione diverso: **zero conflitti fra agenti
in 12 deleghe**, con fino a 7 job simultanei, elencando per nome i file
riservati ad altri. Un caso di collisione l'ho evitato a monte spostando il
predicato nuovo in un **modulo separato** invece che dentro il file condiviso,
riducendo il diff sul file conteso a poche righe.

Un agente ha applicato la regola meglio di come l'avessi scritta: gli avevo
detto di non toccare certi workflow, e ha deciso da solo di leggerli **dai
commit remoti invece che dal checkout locale**, per non misurare uno stato che
un altro agente stava modificando sotto i piedi.
