# Lezioni operative: delegare a Codex nel workspace frontaliere

Registro condiviso fra le sessioni che delegano lavoro a Codex in questo
workspace. Ogni voce e' costata un errore reale ed e' scritta per essere
riusata da chiunque deleghi, non come cronaca di chi l'ha pagata.

**Come si scrive una voce.** La regola per prima, in forma impersonale; poi la
misura che la giustifica, col comando o il dato che la produce. Niente prima
persona, niente riferimenti a «questa sessione»: il caso serve come prova, non
come racconto. Non scrivere lezioni non misurate, e aggiungi in fondo con la
data.

Provenienza: il nucleo (punti 0-17) e' stato raccolto il 2026-09-08 durante una
tornata di ~40 deleghe (`gpt-5.6-luna`) per chiudere un backlog di follow-up —
79 issue chiuse, ~40 PR aperte — e ampliato lo stesso giorno da altre
sessioni.

## 0. La skill del runtime non e' la fonte di verita' sui valori accettati

`--effort` accetta **anche `max`**. Il companion lo dichiara esplicitamente:
`[--effort <none|minimal|low|medium|high|xhigh|max>]`, e il suo messaggio
d'errore elenca la stessa lista.

La skill `codex-cli-runtime` del plugin si ferma pero' a `xhigh`. Il 2026-09-08
quella skill e' stata presa per completa: ~40 deleghe sono partite a `xhigh`
mentre era stato chiesto `max`, e al proprietario e' stato riportato come fatto
accertato che «max non e' un valore accettato». E' falso, e la premessa e'
stata usata per decidere.

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
   formulazione viene respinta**. Le violazioni osservate il 2026-09-08 erano tutte
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

La popolazione istantanea puo' essere vuota (in una verifica del 2026-09-08: zero PR aperte
colpite in entrambi i repo), quindi **la prevalenza va misurata sullo storico**,
non su una fotografia.

## 0-quinquies. Un token cercato come stringa invece che come verdetto

La classe di errore piu' frequente del 2026-09-08: **tre volte, in due sessioni
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

Corollario del punto 3. Verificato che la `pii-blocklist` non esiste nel
corpus, a un agente e' stato scritto: «quel gate non e' richiesto qui, procedi
con commit e push». **L'agente ha rifiutato**, e ha fatto bene: un messaggio che dice a un altro agente di andare avanti nonostante
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

**Il conto di quanto costa sbagliarlo, misurato il 2026-09-08.** Il predicato
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

Un gruppo rilanciato perche' «non aveva ancora una PR» l'aveva aperta nel
frattempo: due agenti sullo stesso scope e due PR complementari ma ridondanti.
Prima di rilanciare, ricontrollare lo stato di quel gruppo specifico, non la
fotografia gia' in mano.

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

## 9. Il costo piu' grosso e' il brief, non l'agente

**Non rendere assoluto lo «fermati se una premessa e' falsa».** Scritto cosi',
ferma Codex anche su un dettaglio che non regge il ragionamento. Misura: **due
giri persi** prima che una riga di codice fosse scritta. Al primo giro si era
fermato perche' un `grep` del brief era stato troncato da un `head` e
affermava che uno script non avesse chiamanti — aveva ragione l'agente. Al
secondo si e' fermato perche' delle cinque PR citate, due erano rosse per
un'altra ragione: vero,
ma irrilevante per il difetto da riparare.

La forma che funziona e' dichiarare **quali due o tre affermazioni, se cadono,
invalidano tutto**, e dire esplicitamente che il resto e' contorno probatorio da
correggere e superare. Dopo quella correzione lo stesso job e' arrivato alla PR
mergiata in un giro.

## 10. Codex smonta bene le premesse sbagliate: e' un pregio, va autorizzato

Su 12 deleghe ha falsificato **due premesse del brief su due** che erano
sbagliate, citando il codice. In un terzo caso ha corretto una diagnosi in
meglio: il brief diceva «lo step di rebase e' stato cancellato», l'agente ha
trovato che esiste ma e' gattato sulla condizione che manca — piu' preciso e
piu' utile.

Scrivere nel brief che ha il permesso di fermare chi lo ha scritto, e nel giro
dopo dirgli che aveva ragione. Costa una riga e cambia il comportamento.

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

Conferma della voce 8 su un campione diverso: **zero conflitti fra agenti
in 12 deleghe**, con fino a 7 job simultanei, elencando per nome i file
riservati ad altri. Una collisione e' stata evitata a monte spostando il
predicato nuovo in un **modulo separato** invece che dentro il file condiviso,
riducendo il diff sul file conteso a poche righe.

Un agente ha applicato la regola meglio di come era scritta: gli era stato
detto di non toccare certi workflow, e ha deciso da solo di leggerli **dai
commit remoti invece che dal checkout locale**, per non misurare uno stato che
un altro agente stava modificando sotto i piedi.

## Nota sulla numerazione

Le sezioni 14 e 15 compaiono due volte: il registro viene scritto da piu'
sessioni in parallelo. Non rinumerare, perche' altri documenti citano i punti
per numero; aggiungere in fondo.

## 18. Una misura lunga senza stadio intermedio persistito si rifa' da capo

Una scansione che scarica molti artefatti e li aggrega in un solo passaggio
non ha un punto di ripresa: **ogni correzione del metodo obbliga a
riscaricare e riparsare tutto**.

Misura: un job che leggeva 2.734 log di run a ~130 log/minuto — ~21 minuti di
solo parsing per passata — ne ha eseguite **tre integrali in 6h15m**. Le tre
cause erano tutte legittime e tutte diverse: (1) l'enumerazione incontrava il
**limite implicito di 1.000 risultati** dell'API e perdeva run senza dirlo;
(2) la paginazione e' stata rifatta giorno per giorno per recuperarle; (3) i
conteggi sono stati rifatti dopo la correzione di un predicato (punto
0-quinquies). Nessuna delle tre era lavoro sprecato per negligenza: due su tre
erano correzioni che hanno reso la misura valida.

**Nel brief di una misura che scarica molti artefatti, chiedere uno stadio
grezzo persistito** — un JSONL di record normalizzati, una riga per unita' —
separato dalla fase di aggregazione. Correggere un predicato diventa allora un
ricalcolo di secondi invece di una scansione da capo.

E' l'analogo, per gli script di misura, del checkpoint del punto 12: li' serve
a non perdere il lavoro pagato di un agente troncato, qui a non ripagare il
tempo di scansione.

## 19. Il messaggio di chiusura di un agente non e' il suo rapporto

Il messaggio finale e' una sintesi scritta a memoria a fine turno; il rapporto
e' il prodotto verificato. **Possono contraddirsi, e chi relaziona il
messaggio propaga l'errore.**

Caso misurato: un job ha chiuso dichiarando una coda *«reale e concentrata»*;
il rapporto che aveva appena scritto diceva *«reale e piccola»* e aggiungeva
testualmente di non vedere «molte PR sopra 4-5 giri». I numeri davano ragione
al rapporto. La differenza non e' cosmetica: «concentrata» suggerisce una
classe da riparare strutturalmente, «piccola» dice che i casi estremi vanno
capiti uno per uno — cioe' due decisioni opposte.

**Leggere il file, sempre**, anche quando il messaggio sembra esaustivo, e
soprattutto quando sembra esaustivo. Se il rapporto e' lungo, leggerne almeno
l'apertura (finestra e snapshot) e la sezione dei bersagli.

## 20. Autorizzare l'agente a smentire la premessa, esplicitamente

Un brief che afferma una premessa la fa assumere. Un brief che **autorizza a
smentirla** la fa verificare, e l'agente e' spesso nella posizione migliore
per farlo perche' sta gia' leggendo i dati.

Formule che hanno prodotto correzioni reali:

> Se una di queste risulta falsa, dillo chiaramente: e' un risultato utile
> quanto una conferma.

> Dove una misura contraddice quanto ti ho scritto sopra, dillo
> esplicitamente.

Esempi di cosa hanno fatto emergere, tutti su premesse dell'orchestratore o
del proprietario:

- **un'identita' resa diversamente da due API**: GraphQL espone il login di un
  bot senza il suffisso, REST con `[bot]`. Filtrando col nome REST, la misura
  sottocontava proprio la grandezza da misurare;
- **una quantificazione sbagliata di un ordine di grandezza**: «6-7 check
  contro 2» era in realta' **13 contro 6**, perche' il conteggio corretto e'
  sui check-run pubblicati sulla SHA, inclusi gli `skipped`;
- **la spiegazione piu' comoda, smentita**: due workflow sospettati di usare
  modelli o cap diversi usavano **lo stesso modello, lo stesso effort e gli
  stessi cap**, spostando la causa altrove.

## 21. Chiedere la scomposizione, non il confronto della grandezza sospetta

Corollario del punto 20. **Un brief che chiede «verifica che A sia peggio di
B» nasconde il caso inverso**, perche' orienta la misura su una sola
grandezza e su un solo verso.

Misura: richiesta la scomposizione di una durata invece del solo totale, la
coda e' risultata identica nei due sistemi (3,0 s mediani), lo stadio
sospettato piu' lento nel sistema sospettato (211 s contro 130 s) — e **uno
stadio che nessuno stava guardando 4,6x piu' lento nell'altro** (399 s contro
86 s), con un divario che in mediana pesava piu' di quello cercato. Col solo
confronto del totale quel numero non sarebbe emerso.

**Formulare l'ipotesi in modo simmetrico**: non «verifica che A sia piu'
lento», ma «scomponi la durata nei suoi stadi e di' dove va il tempo nei
due». Vale identico per un costo: chiedere la ripartizione, non il totale.

## 22. I log dei job stanno in due directory diverse

Il companion scrive i log sotto `<stateRoot>/<workspace>-<hash>/jobs/`, dove
`stateRoot` dipende da una variabile d'ambiente del plugin:

- impostata: `~/.claude/plugins/data/codex-openai-codex/state/...`
- altrimenti, il fallback: `$TMPDIR/codex-companion/...`

**Job lanciati dalla stessa sessione possono finire in posti diversi**, a
seconda dell'ambiente della shell da cui parte il comando. Se `tail` non trova
il log, non concludere che il job non e' partito:

    find ~/.claude/plugins/data "$TMPDIR" -name "<job-id>.log" 2>/dev/null

Va letto insieme al punto 15: lo `status` del companion nega il job da
un'altra sessione, quindi il log e' l'unico oracolo, e sapere **dove** sta e'
la meta' che manca. Il fatto che il job giri si verifica comunque con
`pgrep -f "<job-id>"`.

## 23. Instradare i job concorrenti su bucket di rate limit diversi

Il rate limit GitHub e' condiviso fra tutti gli agenti della macchina, e le
risorse hanno bucket separati: **Actions** (run, job, log) e' la piu' scarsa e
va in 403 per prima; **core** (pull, review, issue) regge di piu'; **GraphQL**
e' un bucket a se'.

Misura: con un job che scaricava archivi di log Actions da ore, un secondo job
instradato su GraphQL non ha incontrato un solo 403, e il controllo finale
mostrava GraphQL ancora a 5.000/5.000 mentre il core era sceso a 3.883.

> **Correzione, 2026-09-08 sera.** La riga sopra usa `gh api rate_limit` come
> oracolo per GraphQL, e **non lo e'**. Un terzo job, poche ore dopo, ha letto
> dallo stesso endpoint **GraphQL 5.000 residue e core 3.974** e ha ricevuto
> comunque, dalla query successiva:
>
>     gh api graphql -f query='query { viewer { login } }'
>     RATE_LIMIT / graphql_rate_limit — API rate limit already exceeded
>
> GraphQL non conta richieste ma **punti**, calcolati sulla dimensione della
> query, e il contatore esposto da `rate_limit` non riflette ne' quel consumo
> ne' i limiti secondari. Una query che pagina 60 PR con 40 check-run ciascuna
> costa moltissimi punti pur restando **una** richiesta.
>
> **L'instradamento su bucket diversi resta valido; l'oracolo no.** Per GraphQL
> il solo controllo affidabile e' **la risposta della query stessa**: tratta
> `graphql_rate_limit` come condizione attesa, non come anomalia, e falla
> gestire dallo script — fermarsi e riferire il parziale, come al punto 23.
> Corollario generale: **un contatore che dice «hai credito» non e' una prova
> di credito**; la prova e' la chiamata che riesce.

**Prima di lanciare una misura mentre un'altra e' in volo, guardare su quale
risorsa gira la prima e instradare la seconda altrove.** Nel brief va scritto
esplicito quale bucket usare, di controllare periodicamente

    gh api rate_limit --jq '.resources'

e la regola che evita il 403 invece di subirlo:

> Se ti avvicini all'esaurimento fermati e riferisci quello che hai: un
> rapporto parziale con la finestra dichiarata vale piu' di un 403.

## 24. Vietare per nome il comando di riparazione dentro il brief di una misura

«Non modificare niente» non copre le azioni che un agente legge come
**diagnostiche**. Se il fenomeno da misurare ha un rimedio a un comando,
quel comando va nominato fra i divieti: un agente diligente puo' lanciarlo per
«verificare» la propria ipotesi, alterando il dato.

Esempio, in un brief che misurava run cancellate:

> Non fare `gh run rerun` di niente, nemmeno per verificare: e' una misura,
> non una riparazione.

Stessa logica del punto 10: un vincolo enumerato non lascia spazio a un
vincolo immaginato.

## 25. Un vincolo di stop va scritto sulla conseguenza temuta, non sull'esistenza del fatto che la produrrebbe

Un brief che ordina di fermarsi davanti a un fatto — «se esiste un
consumatore che enumera le run per branch, fermati» — ferma l'agente anche
quando quel fatto **non produce** la conseguenza temuta. Il vincolo va scritto
sulla conseguenza: «fermati se quel consumatore, dopo la modifica, non trova
piu' la run». Insieme al vincolo va nominata la verifica che distingue i due
casi, altrimenti l'agente diligente non ha modo di superare lo stop.

Misura, 2026-09-08: un giro intero perso. Il brief chiedeva di togliere il
trigger `push` di `generator-ci.yml` nel corpus (462 occorrenze su 237 PR,
cioe' 1,95 run per PR sulla stessa SHA, 1.802,22 minuti-runner in sette
giorni) e imponeva lo stop davanti a qualunque lettore per branch. Un lettore
vero esiste — `.github/workflows/pr-redcheck-fixer.yml:496-498`, che fa
`gh run list --workflow=generator-ci.yml --branch "$HEAD_REF"` e poi filtra per
`headSha` — e l'agente si e' fermato senza toccare nulla, come ordinato.

Il fatto era vero e la conseguenza falsa. Le run innescate da `pull_request`
portano **lo stesso `head_branch` e lo stesso `head_sha`** di quelle innescate
da `push`, quindi quel lettore le enumera e le seleziona identicamente. La
verifica costa una chiamata REST:

    gh api "repos/<owner>/<repo>/actions/workflows/<file>.yml/runs?per_page=40" \
      --jq '.workflow_runs[] | [.event, .head_branch, (.head_sha|.[0:8])] | @tsv'

**Seconda regola dallo stesso caso: la rimozione di un trigger va sostituita
da una restrizione su popolazione enumerata**, perche' la popolazione servita
dal trigger non coincide quasi mai con quella dichiarata. Qui cinque SHA su
~50 avevano **solo** una run da `push`, due delle quali sul branch del mirror
automatico dell'engine, che viene pushato senza PR aperta: la rimozione
avrebbe tolto loro il gate in silenzio. La riparazione e' diventata
`push: branches: [<branch del mirror>]` invece della rimozione del trigger:
piu' stretta, e con una popolazione enumerata invece che implicita.

Corollario, dallo stesso caso: quando due percorsi producono un duplicato,
**non risolverlo con la concorrenza**. Un gruppo di concorrenza sulla SHA
farebbe cancellare una delle due run, e una run `cancelled` del check e' gia'
stata in questo workspace la causa di PR bloccate pur essendo `MERGEABLE` con
review approvante (punto 0-quater). Un duplicato costa minuti; un `cancelled`
costa un merge.

**Nota che conferma il punto 23 su un campione nuovo.** Nello stesso momento
in cui una query GraphQL riceveva `API rate limit already exceeded`,
`gh api rate_limit` riportava `core 4996/5000` e `graphql 5000/5000`. Il
contatore non e' una prova di credito: la prova e' la chiamata che riesce.

## 26. Un evento usato come battito d'orologio non si filtra con la sua semantica

Un workflow puo' usare un evento non per cio' che l'evento *significa*, ma
solo perche' arriva spesso: un `pull_request_review` che innesca uno sweep
repo-wide non sta dicendo «questa PR e' cambiata», sta dicendo «e' passato del
tempo». Filtrarlo con la semantica dell'evento — «lancia solo se la review
approva» — toglie il battito alle classi che con quella review non c'entrano
nulla.

**Il discriminante, prima di filtrare un trigger:** guarda se il job usa
l'identita' della PR dell'evento (`github.event.pull_request.number`,
`$HEAD_REF`) o se ignora l'evento e rilegge tutto. Nel secondo caso il trigger
e' un orologio, e l'unica riduzione legittima e' un debounce sul *tempo
dall'ultimo giro*, non un predicato sul contenuto dell'evento. Se il debounce
richiede stato persistito, il conto va rifatto: minuti-runner spesi su uno
sweep frequente comprano una garanzia di latenza, e spenderli puo' essere piu'
economico che rallentare le PR.

Misura, 2026-09-08, corpus PR #1269. `pr-autorebase.yml` fa 458 run su 252 PR
e 505,95 minuti-runner in sette giorni, e il brief proponeva di limitarne
l'innesco alle sole review approvanti. Il reviewer ha falsificato la premessa
citando il codice: `pr-autorebase.mjs` non lavora sulla PR dell'evento, e il
suo `nearMerge` copre **quattro** classi (`## LGTM`, `collision-risk`,
`stale-review`, piu' `stuck-red`). Le tre senza LGTM sarebbero rimaste al solo
cron `22,52 * * * *`, cioe' proprio la rete che il commento in testa al
workflow dichiara soggetta al throttling GitHub sui cron ad alta frequenza.
Il fixer automatico ha riportato il guard alla forma non filtrata, il secondo
review run ha approvato e la PR e' stata mergiata senza quella parte. Qui i
505,95 minuti a settimana comprano la garanzia di latenza sulle PR near-merge.

Corollario: **un argomento di sicurezza va verificato contro cio' che il
codice fa con l'evento, non contro cio' che l'evento dichiara.** L'argomento
che aveva fatto accettare il filtro era corretto **sul verdetto** (una ricerca
testuale di `## LGTM` e' un sovrainsieme del verdetto, quindi non puo'
sopprimere un'approvazione vera) e **irrilevante sul meccanismo**.

## 27. Un gate che decide se qualcosa BLOCCA va scritto con la direzione di fallimento

Quando un predicato decide se un finding, un test o un check **blocca**, la
regola non e' «sia corretto»: e' **dove cade quando non sa rispondere**. Ogni
caso non risolvibile — dato troncato, comando a mani vuote, parser incerto,
path ambiguo — deve cadere sul ramo BLOCCANTE. L'asimmetria e' netta:
declassare a torto manda in produzione un difetto con l'approvazione addosso,
bloccare a torto costa un giro di review.

**Nel brief, la regola va scritta come invariante e come test**, non come
raccomandazione: un caso per ciascun ramo di fallimento che asserisca l'esito
bloccante. Un test di sola esistenza non la cattura — in questo repo un test
di esistenza e' gia' stato verde su un gate rotto.

Misura, 2026-09-08, su due brief scritti nella stessa ora, uno con la regola
dichiarata e uno senza:

- **col default dichiarato** (gating dell'assemble sul sito, PR #8047): tutti
  i rami non risolvibili rendono `required: true`, con `degraded: true` e un
  warning CI. Mergiata al primo verdetto utile.
- **senza** (declassamento dei finding fuori dal diff, corpus PR #1271): il
  reviewer ha trovato **tre `Important` tutti della stessa classe fail-open**.
  `fetchChangedFiles()` reimplementava la fetch dei file della PR ignorando il
  tetto rigido di 3.000 file della REST — che il repo gia' gestiva in
  `scripts/ci/lib/fetchPrFiles.mjs` con `REST_FILES_HARD_CAP` e
  `{files, complete, reason}` — quindi su una PR di rigenerazione del corpus
  (14.888 file sotto `content/`, che ordinano prima di `scripts/`) i file di
  codice cadono oltre il cap, ogni finding risulta «fuori dal diff», il gate
  diventa verde e l'auto-merge passa col difetto mai indirizzato. Un `gh` a
  mani vuote produce lo stesso esito. Idem per un tree non recuperabile.

Corollario, dallo stesso caso: **prima di scrivere una fetch, cerca se il repo
ne ha gia' una che conosce il limite**. Il modulo che evita esattamente quella
troncatura esisteva ed era stato scritto per quel motivo.

## 28. Un tetto sui giri di review va tarato dove la coda si separa dal corpo della distribuzione

Un tetto sui giri serve a fermare i loop che non convergono, e va tarato sulla
distribuzione misurata dei giri, non su un numero plausibile: va sopra la
mediana, e sotto la coda taglia dentro l'iterazione ordinaria e fabbrica punti
morti — PR ferme con
finding reali, piccoli e dentro lo scope. La fermata deve inoltre chiedere
**quali** finding restano e se sono nuovi o gli stessi: un tetto che ferma
senza quella domanda non distingue una PR che non converge da una che stava
per chiudere.

Misura: un tetto «se dopo due giri il rosso non si chiude, fermati», messo in
un brief per evitare i loop, ha fermato una PR al terzo giro con tre finding
reali, piccoli e tutti dentro lo scope della PR — iterazione ordinaria, non un
loop. Il dato che lo avrebbe tarato correttamente era gia' misurato: su 750 PR
in sette giorni, le PR con almeno 3 giri sono 29 su 490 nel sito (5,9%) e 30
su 260 nel corpus (11,5%). **Un tetto a 2 taglia dentro il corpo della
distribuzione, non sulla coda.** La coda vera comincia sopra i 5 giri, dove le
PR sono 2 nel sito e 6 nel corpus. Un tetto serve comunque, perche' l'outlier
osservato e' arrivato a 15 giri.

## 29. Una tecnica non si dichiara inefficace sulla popolazione che ha appena drenato

Prima di dichiarare che una tecnica non paga, va chiesto se la popolazione su
cui la si misura e' stata **appena drenata da quella stessa tecnica**. Una coda
vuota dopo un drenaggio riuscito e' indistinguibile da una coda che non c'e'
mai stata, se si guarda solo la fotografia di oggi. Il discriminante e' il
**flusso di ingresso**, non lo stock: quanti elementi raggruppabili *entrano* a
settimana, non quanti ce ne sono adesso.

Secondo vincolo, sullo **scope della misura**: va coperta la famiglia dove la
tecnica si applica, non la label piu' comoda da interrogare. Le famiglie che si
raggruppano meglio — errori ricorrenti dei crawler, fallimenti di validazione
del deploy, issue aperte automaticamente con una firma strutturata nel titolo —
non portano la label `follow-up`, quindi un funnel costruito su quella label
misura il sottoinsieme sbagliato.

**Regola generale**: una ricetta di raggruppamento va validata sulla
**distribuzione viva** prima di scrivere una riga, e la domanda giusta non e'
«quante issue ci sono» ma «quante sopravvivono a ogni stadio del funnel».
Il conteggio a monte non predice i gruppi a valle.

Corollario per chi delega: **autorizzare esplicitamente l'agente a fermarsi
prima di implementare** se la distribuzione non paga. Senza quella riga nel
brief, la macchina si costruisce lo stesso e raggruppa a vuoto; con quella
riga, la misura qui sotto e' arrivata prima del codice.

Misura, 2026-09-09, come fotografia delle sole issue con label `follow-up`.
La ricetta valutata: «raggruppa le follow-up per il file citato nella riga
`Suggested action`, ~191 issue in ~60 gruppi da 3, cosi' paghi un ciclo di
review invece di tre». Popolazione viva:

| repo | follow-up aperte | con `Suggested action` | con >=1 file risolvibile | con UN SOLO file (raggruppabili) | gruppi | distribuzione |
|---|---:|---:|---:|---:|---:|---|
| sito | 131 | 123 | 72 | 37 | 33 | 29x1, 4x2 |
| corpus | 81 | 64 | 29 | 15 | 15 | 15x1 |

**Nessun gruppo da 3**, gruppo massimo 2, e le quattro coppie del sito sono
eterogenee per classe di difetto. Risparmio teorico 4 cicli di review,
risparmio sicuro **zero**. Il collo non e' il criterio ma il **funnel**: di 131
follow-up solo 37 arrivano a essere raggruppabili, perche' molte non hanno la
riga, molte ne citano piu' d'uno e molte citano un file non risolvibile. La
premessa era stata scritta quando il backlog era piu' grande e piu'
concentrato; il drenaggio l'ha dispersa.

**Conclusione ritirata.** Dagli stessi numeri era stato concluso che «il batch
per file bersaglio non paga piu': la ricetta non regge sui dati attuali»: e' un
fatto locale, e sbagliato come verdetto sulla tecnica. La popolazione era esaurita **proprio perche' il raggruppamento
aveva appena funzionato** — il giorno prima oltre 100 issue erano state chiuse
raggruppandole a mano — quindi il funnel misurato e' il **residuo** di una
tecnica riuscita, non la prova che la tecnica non serve. I numeri della tabella
restano validi come fotografia al 2026-09-09; la conclusione «non paga» no.

## 30. Un agente di misura sostituisce il predicato che gli hai dato, e il numero sbagliato sembra un successo

Chiesto a un agente di misurare una coorte usando `isIncomplete(job)` — la funzione canonica
di 130 righe esportata dal codice di produzione — e `jobQueuedAtMs(job)` per l'eta'. L'agente
ha reimplementato entrambi: soglie a mano su `titleByLocale`/`descriptionByLocale` al posto
del primo, `job.crawledAt` nudo al posto del secondo.

Risultato: **99,5%** contro una baseline di 73,9%. Sembrava un balzo di 25 punti.
La stessa coorte, misurata col predicato vero da un secondo agente, dava **81,3%**.
I 18 punti di differenza erano interamente artefatto della riscrittura: `isIncomplete` contiene
controlli — fra cui `titleLooksUntranslated` — che una soglia di lunghezza non replica, e
`jobQueuedAtMs` ha una catena di fallback (`firstSeenAt` -> `postedDate` -> `crawledAt` ->
`datePosted`) di cui `crawledAt` e' solo un anello, quindi la coorte stessa era diversa.

**Why:** un predicato reimplementato e' quasi sempre **piu' lasco** dell'originale, perche'
l'agente replica i controlli che vede e non quelli che non ha letto. Un predicato piu' lasco
produce un numero migliore. Quindi l'errore non si presenta come errore: si presenta come
progresso, ed e' esattamente il numero che si voleva vedere.

**How to apply:**
- Nel brief, **nomina il predicato come funzione da importare**, col file e la riga, e scrivi
  esplicitamente «non reimplementarlo». Spiega *perche'* non basta riscriverlo: quante righe e'
  e quale controllo non ovvio contiene.
- Spiega **come importarlo senza side effect** (estrarre il sorgente da `git show` in uno
  scratchpad e importare la copia), altrimenti l'agente che sbatte contro un import fallito
  reimplementa per andare avanti.
- Pretendi nel rapporto **il predicato realmente eseguito, verbatim**, non solo il numero.
  E' l'unico modo per accorgersi della sostituzione: il numero da solo non la rivela mai.
- Autorizza esplicitamente il fallimento: «se non riesci a importarlo, fermati e dillo, meglio
  nessun numero che un numero non confrontabile». Senza quella riga l'agente preferisce
  consegnare qualcosa.

## 31. Due agenti sulla stessa claim danno zero e quarantuno: vince quello che non ha riscritto il predicato

Sulla stessa issue, a un giorno di distanza, due misure indipendenti dello stesso stato hanno
reso **0 job** e **41 job su 16 crawler**. La differenza non era il tempo: era che una delle
due aveva ricostruito a mano il predicato descritto a parole nella issue invece di eseguire
quello del codice.

Uno zero e' il risultato piu' pericoloso che un agente di misura possa consegnare, perche' e'
indistinguibile da «difetto risolto» ed e' l'esito che chiude un ticket.

**How to apply:** prima di chiudere una issue su uno zero, **fai rendere all'agente anche il
conteggio del denominatore** — quanti record ha scandito, quanti hanno il campo, quanti
passano il primo dei congiunti. Uno zero con denominatore zero e' un bug del misuratore; uno
zero con denominatore grande e' un fatto. Chiedere i due numeri costa una riga di brief e
smaschera la classe intera. Vedi [[30]] per il caso gemello dove la sostituzione produce un
numero troppo buono invece di uno zero.

## 32. Una condizione di destinazione puo' essere insoddisfacibile: misurane il massimo storico prima di lavorarci

Una delle tre condizioni di chiusura di una mappa chiedeva che una metrica salisse e un'altra
scendesse **per 7 esecuzioni consecutive**. Misurata sui 100 punti strumentati realmente
esistenti — 99 transizioni su 24 giorni — la catena massima mai raggiunta era **5**, e quella
corrente 0. La metrica saliva in 59 transizioni su 99 e l'altra scendeva in 67 su 99: due
eventi indipendenti al ~60-68%, quindi sette di fila hanno probabilita' inferiore all'1%.

La causa non era il lavoro: un processo esterno (crawler che immettono record nuovi) alzava il
contatore «incompleti» per ragioni scorrelate. La condizione chiedeva implicitamente che quel
rumore tacesse per sette giri.

Sulla **stessa serie**, la quota `complete/(complete+incomplete)` su media mobile a 3 punti
aveva una salita consecutiva massima di **22**, ed era passata da 57,2% a 75,5%. La convergenza
c'era, e abbondante: era il criterio a non poterla vedere.

**Why:** un criterio di destinazione formulato su una **differenza punto a punto** e' fragile a
qualunque rumore additivo in ingresso; formulato su un **rapporto** o su una media mobile, non
lo e'. La differenza fra i due non si vede leggendo la formulazione, si vede solo misurando il
massimo storico.

**How to apply:** appena una destinazione e' espressa come «per N volte consecutive», misura
**subito** il massimo storico di quella catena sui dati che gia' esistono, prima di dispacciare
un solo task per raggiungerla. Se il massimo storico e' sotto N, il lavoro non e' «non ancora
finito»: e' diretto a un bersaglio che non esiste, e va rinegoziato col proprietario portando
il massimo storico, la formulazione alternativa e **il suo** massimo storico — cosi' la
riformulazione non sembra un ammorbidimento, che e' l'unica ragione per cui verrebbe rifiutata.

## 33. Il tetto del job e' un vincolo di progetto, non un incidente

Tre run di uno stesso workflow morte a **355 minuti esatti** in tre giorni consecutivi, sempre
quella lanciata dallo stesso cron. Non era eviction della coda di concorrenza: era
`timeout-minutes: 350` piu' i cinque minuti di grazia di GitHub. Il tetto non era alzabile —
per un job su runner hosted il massimo e' 360 minuti.

Il costo vero non era la run persa. Era **dove** moriva: dopo il commit dei risultati ma prima
del commit della observability. Il punto dati che serviva a misurare la convergenza veniva
prodotto e mai scritto, una volta su sei.

**How to apply:**
- Una `conclusion: cancelled` ripetuta si diagnostica confrontando `startedAt` e `completedAt`
  **del job**, non della run: la durata della run include l'attesa in coda e nasconde la firma.
  Una durata costante al minuto e' un tetto, non un caso.
- In un workflow lungo, la domanda non e' «quanto dura» ma **«quali step stanno dopo l'ultimo
  commit»**: quelli sono il lavoro che si perde per intero a ogni morte. Se fra loro c'e' uno
  step che scrive una misura, il guasto e' doppio e il secondo e' invisibile.
- Il rimedio non e' `timeout-minutes` sul singolo step, che uccide un processo a meta'
  scrittura: e' un budget a orologio letto dallo script, che si ferma da solo e persiste quello
  che ha completato. Se un altro script della stessa pipeline ce l'ha gia', **passa quello come
  modello nel brief** invece di lasciare che l'agente ne inventi una forma nuova.

## 34. La funzione giusta con la semantica sbagliata: un predicato di accodamento non e' una metrica di qualita'

Dopo aver imposto in un brief «usa `genderFormOffence`, non riscriverla» — che e' la regola del
punto 30 — l'agente ha obbedito alla lettera e ha reso **42,72%** contro una baseline di 30,0%.

Il predicato era quello giusto e l'agente non aveva sbagliato niente di quanto chiesto. Ma
`genderFormOffence(job)` guarda **solo il titolo sorgente**: rende non-nullo quando il titolo
tedesco d'origine contiene una forma di genere, e ignora del tutto le traduzioni prodotte.
Il titolo sorgente **non cambia mai**, nemmeno dopo una ritraduzione perfetta.

Quel numero quindi **non puo' scendere per costruzione**. Usato come metrica di destinazione,
avrebbe tenuto la condizione aperta per sempre, e ogni ciclo di lavoro fatto per abbassarlo
sarebbe stato speso contro un bersaglio immobile.

La funzione serviva a **scegliere cosa rimettere in coda** — un predicato di *accodamento*. La
condizione chiedeva **quanto e' sbagliato l'output** — un predicato di *qualita'*. Due domande
diverse che la stessa parola («offesa») copriva.

**Why:** il punto 30 dice «non riscrivere il predicato», ed e' giusto. Ma applicato senza la
domanda a monte produce l'errore simmetrico: si esegue fedelmente una funzione che misura
un'altra cosa. Il primo errore rende un numero troppo buono, questo rende un numero che non si
muove; entrambi passano inosservati perche' il codice eseguito e' inappuntabile.

**How to apply:**
- Prima di adottare una funzione esistente come metrica, chiedi: **cosa deve cambiare in questi
  dati perche' il numero scenda?** Se la risposta e' «un campo che nessuno riscrive mai» — un
  input, un sorgente, un identificatore — la funzione non e' una metrica, e' un filtro.
- Una metrica di qualita' deve leggere **l'output** del processo che stai misurando, non il suo
  input. Nel brief scrivilo esplicitamente: nomina il campo che la misura deve guardare, non
  solo la funzione da chiamare.
- Il controllo che smaschera la classe intera, e costa una riga: **un predicato di destinazione
  deve poter valere zero.** Se non esiste nessuno stato raggiungibile dei dati in cui vale zero,
  non e' una destinazione.

## 35. Le misure vanno a Codex come le implementazioni, non a un subagent che legge a memoria

Istruzione del proprietario, 2026-09-09: nel workspace frontaliere **nessun subagent Claude**.
Non solo le implementazioni — anche le **misure** e le **schede**. L'orchestratore fa solo le
letture brevi e decisive che gli servono per decidere; tutto il resto parte come task Codex.

La ragione non e' formale. Nella stessa sessione due subagent di misura avevano gia' sbagliato
in modi che appartengono alla loro natura: uno aveva **riscritto** il predicato canonico invece
di importarlo, rendendo 99,5% al posto di 81,3% (vedi punto 30); un altro aveva reso **zero** su
una claim che valeva 41 (punto 31). Un agente che lavora leggendo excerpt ricostruisce il
predicato dalla descrizione; Codex, che apre il file e lo importa, non ha quel margine.

**How to apply:** una misura delegata a Codex si scrive come una scheda di implementazione —
bersaglio con file e riga, predicato da importare e non riscrivere, formato dell'output, e il
denominatore da rendere insieme al numeratore. Per attivita' brevi si puo' usare il plugin
ufficiale invece di un task lungo. Quello che l'orchestratore tiene per se' e' solo cio' che sta
in una chiamata: uno `git show`, un conteggio, lo stato di una run.

## 36. «Fermati se i numeri non tornano» ferma anche quando il criterio E' soddisfatto

In una scheda erano scritte due cose che sembravano la stessa: il **criterio di successo**
(«la fascia bersaglio al 100% e nessun'altra sotto il 12,7% di oggi») e la **previsione** di una
simulazione (una tabella di percentuali attese per ogni fascia). In fondo la scheda diceva: «se
la tua misura non riproduce questi numeri, fermati e riportalo invece di inseguirli».

L'agente ha misurato **30,0%** su una fascia dove la previsione diceva ~32,7%, si e' fermato, e
ha lasciato tutto non committato. Aveva ragione secondo l'istruzione. Ma il criterio vero era
soddisfatto con margine — la fascia bersaglio era passata dal 12,7% al **100%**, il minimo fra
tutte le fasce era **25,8%**, il doppio della soglia — e una fascia era perfino **migliorata**
in un modo che nessuno aveva previsto.

Lo scarto non era un difetto: la simulazione era girata su una coda di 15.986 elementi, la
misura su una di 9.763. Code diverse, frazioni diverse.

Costo: un giro di dispatch in piu' per far consegnare lavoro gia' finito e gia' corretto.

**Why:** la clausola «fermati se i numeri non tornano» e' giusta e va tenuta — e' quella che
impedisce a un agente di ritarare un tetto finche' la tabella non combacia, che e' il modo in
cui si fabbricano numeri. Ma se nella stessa scheda convivono una previsione e un criterio senza
che sia detto **quale dei due decide**, la clausola si attacca alla previsione, che e' la cosa
piu' simile a «i numeri».

**How to apply:** in una scheda che porta sia una previsione sia un criterio, **etichettali** e
di' esplicitamente quale comanda. La forma che funziona:

> Il criterio di accettazione e' X. La tabella qui sotto e' una **previsione** da una
> simulazione su uno snapshot diverso: serve da riferimento, **non** da criterio. Se il criterio
> e' soddisfatto ma la previsione no, **consegna** e spiega lo scarto nel body. Fermati solo se
> il **criterio** non e' soddisfatto.

E siccome una previsione nasce quasi sempre su dati piu' vecchi di quelli su cui l'agente
misurera', **dichiara la dimensione dello snapshot** da cui viene: e' l'informazione che rende
lo scarto spiegabile invece che sospetto.

## 37. La `cwd` scivolata fa dire a git «il file non esiste», non «sei nel repo sbagliato»

In una sessione con piu' repo affiancati, un `cd` dentro un comando composto lascia la shell
degli strumenti in quella directory per **tutte le chiamate successive**. Il sintomo arriva dopo,
su un comando che non c'entra:

```
fatal: path 'scripts/lib/job-traffic-priority.mjs' does not exist in 'origin/main'
```

Letto di corsa dopo un merge, quel messaggio dice «il file e' stato cancellato dalla PR appena
mergiata» — che e' un allarme grosso, e in una verifica post-merge e' esattamente l'ipotesi che
si ha in testa. La causa vera era che la directory corrente era una cartella di appoggio, e
`origin/main` di *quel* contesto e' un altro albero.

**Why:** il messaggio nomina il **path** e il **ref**, cioe' le due cose che hai scritto tu, e
tace sull'unica che non hai scritto — il repository in cui sta guardando. Nessuna delle due
informazioni stampate e' sbagliata, quindi non c'e' niente che stoni.

**How to apply:** nelle verifiche post-merge usa sempre `git -C <path-assoluto-del-repo>` invece
di affidarti alla directory corrente. Costa sei caratteri e rende il comando riproducibile da
qualunque stato della shell. E se un `git show origin/<ref>:<file>` dice che un file non esiste,
**prima di credere che sia stato cancellato stampa `pwd`**: la spiegazione noiosa viene prima di
quella allarmante.

## 38. `git show <ref>:<file>` su un ref non risolto rende altro, e sembra un file rotto

Verifica post-PR di un branch appena pushato da un agente:

```
git fetch -q origin "$B"
git show "origin/$B:scripts/relocalize-pending-jobs.mjs"
```

`git fetch origin <branch>` scrive in `FETCH_HEAD`, **non** crea il ref locale
`origin/<branch>`. Il `git show` successivo non ha reso il file: ha reso **il commit**, cioe' un
diff. Uscita 0, nessun errore.

Il risultato letto di corsa e' allarmante nel modo peggiore: 326 righe invece di 2.274, 14 KB
invece di 108 KB, e dentro righe che cominciano per `+` e `-` e assertion di test dentro quello
che dovrebbe essere uno script di produzione. La lettura naturale e' «l'agente ha committato un
file di patch sopra il sorgente e ha distrutto lo script». Falso: il branch era sano, il file
aveva 2.291 righe.

**Why:** l'errore non si annuncia. Non c'e' `fatal:`, non c'e' exit diverso da zero, e l'output
e' plausibile come contenuto di *qualche* file. E' lo stesso genere di trappola del punto 37 —
git risponde a una domanda diversa da quella che credi di aver posto, senza dirtelo.

**How to apply:**
- Per leggere un file da un branch remoto, **risolvi il ref esplicitamente**:
  `git fetch origin <branch>:refs/tmp/<nome>` e poi `git show refs/tmp/<nome>:<path>`.
- **Prima di trarre conclusioni, guarda la forma di cio' che hai letto**: conta le righe e
  stampa la prima. Una prima riga `commit <sha>` dice che stai leggendo un commit; un conteggio
  righe che si discosta di un ordine di grandezza da `origin/main` dice che non stai leggendo
  quel file.
- Vale in particolare quando la conclusione sarebbe grave. Un sospetto di rottura catastrofica
  merita una seconda lettura **prima** del rapporto, non dopo: la spiegazione noiosa —
  ho letto la cosa sbagliata — e' quasi sempre quella giusta.

## 39. I giri di review hanno due cause opposte, e confonderle porta alla riparazione sbagliata

Prima di intervenire su una PR che non converge, stabilire **dove cadono i
finding rispetto al diff**: la riparazione e' diversa e sta in due punti opposti
della catena.

- **Finding FUORI dal diff corrente**: il reviewer allarga la superficie a ogni
  giro e la convergenza e' impossibile per costruzione. Si ripara nella review,
  declassando il finding fuori scope a lavoro coniato invece che bloccante.
- **Finding DENTRO il diff, su codice appena scritto**: e' il fixer che
  introduce un difetto nuovo mentre ne ripara uno. Si ripara nella qualita'
  della fix, non nella review. Stringere il cap dei giri qui **peggiora**: fa
  mergiare il difetto.

Misura di riferimento, 2026-09-09, PR sito #8082 (tre giri, tre SHA diverse,
cinque commit, un `Important` per giro, nessun rerun):

1. iterazione per code point (`[...text]`) con offset in indici UTF-16;
2. namespace di una chiave non uniforme fra due rami;
3. il flag `m` su una regex di sezione che rompe la lettura su ogni input reale.

**Le tre hanno la stessa firma: semantica di stringa che i test non coprono.**
La suite passava a ogni giro; il reviewer ha trovato tre regressioni vere.

**Regola operativa che ne segue:** una fix che cambia una regex, un calcolo di
offset o la forma di una chiave deve portare un test su un **input realistico**,
non sul caso che l'autore ha in mente. Il terzo finding sarebbe stato rosso con
un solo file di configurazione vero nel fixture. Un test costa meno di un giro
di review, che sul sito ha una mediana di 384.354 token.

**Corollario sul giudizio:** un numero alto di giri non e' di per se' spreco. Su
codice che finisce in una posizione critica — un hook davanti a ogni comando, un
gate required — i giri che intercettano regressioni reali sono il prezzo giusto,
e vanno confrontati col costo del difetto che avrebbero fatto passare.

# Aggiunte del 2026-09-09 — audit Company Alerts

## CA-1. Non si dichiara `exactly-once` per la sola presenza di una mappa di deduplica

Per dichiarare `exactly-once` si devono provare separatamente interruzione fra
provider e writeback, concorrenza, esito `ambiguous` e identità mancante; una
`sentJobIds` map è memoria post-invio e non una riserva atomica.

Misura: su quattro scenari B, `candidateAfterWritebackFailure` è 1/1, i
candidati concorrenti sono 2/2 e i candidati id-less sono 1/1. Prova:

```bash
jq '.measures.dedupFailureModes, .actualPredicates' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/B/aggregate/metrics.json
```

## CA-2. Non si tratta un HTTP 2xx come acknowledgement senza un ack esplicito

L'esito del provider si conserva come `accepted`, `failed` o `ambiguous`; un
body `{}` non autorizza a marcare l'offerta inviata e fake acceptance, provider
acceptance e delivery all'inbox restano prove distinte.

Misura: nel probe B `empty200TreatedAsAccepted` è 1/1,
`providerAcceptanceRequiresExplicitAck` è `false` ed `externalRequests` è
`false`. Prova:

```bash
jq '.measures.provider, .actualPredicates.providerAcceptanceRequiresExplicitAck' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/B/aggregate/metrics.json
```

## CA-3. Un consenso o una soppressione ignoti si rinviano con motivo recuperabile

Documento assente, `pending`, errore di lookup e stato sconosciuto non possono
cadere nel ramo inviabile; il defer deve conservare motivo e percorso di
recupero, non soltanto emettere un warning.

Misura: quattro stati ignoti B su quattro sono stati inviati e zero differiti
(`numeratorSent=4`, `numeratorDeferred=0`); il verdetto D rileva inoltre il
catch fail-open del batch lookup. Prova:

```bash
jq '.measures.unknownConsent, .actualPredicates.unknownStatesDeferred' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/B/aggregate/metrics.json
```

## CA-4. Un cap deve lasciare un backlog osservabile e recuperabile

Un recipient oltre il cap non è recuperato per il solo fatto che una seconda
run esiste: il motivo del defer va persistito e il lavoro deve essere ripreso
anche quando davanti arriva lavoro fresco.

Misura: B seleziona 300/301 recipienti, differisce 1/301 e differisce ancora
1/301 nella seconda run con lavoro fresco. Prova:

```bash
jq '.measures.cap' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/B/aggregate/metrics.json
```

## CA-5. Il matching aziendale richiede un negativo X≠Y e la quarantena degli irrisolti

Alias e casing validi devono risolvere alla chiave canonica; un prefisso comune
non basta: se X=`Acme` e Y=`Acme Holdings`, X≠Y deve essere rifiutato, mentre un
record senza chiave canonica va quarantinato con motivo esplicito.

Misura: nel probe B il negativo X≠Y è rifiutato 0/1 e l'irrisolto è
quarantinato 0/1; la fixture positiva di alias non dimostra quindi da sola C1.
Prova:

```bash
jq '.measures.matching' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/B/aggregate/metrics.json
```

## CA-6. Un replay che fallisce non può eliminare l'intento senza esito persistito o coda retryable

Il replay deve conservare l'intento fino a un esito terminale oppure rendere
persistente un defer ritentabile; rimuovere tutti gli intent dell'email per
evitare un loop è perdita silenziosa.

Misura: nel percorso D il catch dell'errore è riproducibile 1/1 e la rimozione
della coda dell'email avviene 1/1 senza coda di retry. Prova:

```bash
git -C /Users/saggesel/Projects/frontaliere/frontaliere-si-o-no \
  show a7b409042e29baed63688e4bba92d9f45ca0feb0:services/companyFollowIntent.ts \
  | nl -ba | sed -n '126,182p'
```

## CA-7. La prova di consenso deve avere lo stesso purpose dell'azione abilitata

Un registro generico `communicationsOptIn` con preferenze newsletter attive non
prova il consenso a `companyFollow`; il purpose deve essere separato e
specifico, senza allargare il consenso ad altre comunicazioni.

Misura: D rileva 1/1 capture su `communicationsOptIn`, 0/1 su
`companyFollow` e tre preferenze newsletter impostate a `true`. Prova:

```bash
node /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/D/run-isolated.mjs
```

## CA-8. Una superficie SSG idratata si valida con transizioni DOM, non con markup statico soltanto

Il test minimo deve attraversare direct load, navigazione interna, back, forward,
refresh e cambio lingua usando selettori del DOM idratato; un HTML statico
corretto non prova che URL, H1, body e CTA restino coerenti dopo la transizione.

Misura: la prova C riproduce il failure forward con contenuto dell'azienda A
sotto URL B oltre 2.500 ms e il mismatch shell/CTA inglesi con body statico e
placeholder italiani. Prova:

```bash
rg -n 'forward|back|refresh|lingua|2\.500|mismatch' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/C/03-browser-flow.md \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/C/05-handoff-report.md
```

## CA-9. Ogni misura che confronta codice e live deve riportare insieme snapshot sorgente e deploy pubblico

Un verdetto di codice non dimostra la distribuzione: la riga di misura deve
identificare sia lo SHA sorgente sia lo SHA del deploy pubblico, e dichiarare la
divergenza invece di usarne uno come proxy dell'altro.

Misura: C osserva la divergenza fra codice `a7b409…` e Pages
`1199e4d6…`; A separa inoltre il runtime sender osservato `1744761…` dal Pages
deploy. Prova:

```bash
rg -n 'a7b409|1199e4d|1744761|deploy|SHA' \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/A/VERDICT.md \
  /Users/saggesel/Projects/frontaliere/company-alerts-audit-kit/artifacts/C/05-handoff-report.md
```

## 33. La quota API condivisa e' il tetto al parallelismo delle misure, prima del disco e della RAM

Il numero di deleghe che misurano contro la stessa API non e' limitato dalle
risorse della macchina ma dal **bucket di quota dell'utente**, che e' unico e
condiviso fra tutti gli agenti in volo. Il punto 5 di questo registro dice che
il disco cede a ~30 worktree e il punto 11 che la RAM cede molto prima; la
quota cede prima di entrambi, e cede **in modo asimmetrico**: non ferma tutti i
job, ferma quello che stava raccogliendo di piu'.

**Regola: prima di dispacciare un job di misura, conta quanti job in volo
interrogano la stessa API.** Se sono gia' due, il terzo va in coda. Il
parallelismo che paga e' fra lavori di natura diversa — uno che misura, uno che
implementa, uno che legge codice — non fra quattro raccolte simultanee sullo
stesso endpoint.

Misura, 2026-09-09: quattro job di misura lanciati insieme sul bucket `core` di
GitHub (5.000/ora) lo hanno esaurito. Il quinto ha ricevuto
`403 API rate limit exceeded` dopo aver persistito **283 righe su 1.567 attese**
per uno dei suoi quattro target, e ha dovuto consegnare
«non decidibile senza X» su una domanda che con la raccolta completa era
decidibile. Le altre tre raccolte del suo giro erano complete: la quota non
degrada in modo uniforme, taglia dove la raccolta e' piu' lunga.

**Corollario sul contatore.** `gh api rate_limit` riportava `core 0/5000` con un
`reset` gia' passato secondo l'orologio locale; la prova utile e' stata una
chiamata reale, che ha reso il `403` con request ID. Il contatore non e' un
oracolo di credito ne' in positivo (punto 25) ne' in negativo: la prova e'
sempre la chiamata.

**Cosa fare quando succede.** Il job che si ferma ha ragione a fermarsi: un
parziale dichiarato e' recuperabile, un parziale interpretato come zero non lo
e'. Chi orchestra rilancia **solo il join mancante**, non l'intera misura, e
solo dopo il reset — e lo rilancia da solo, non insieme ad altri.

## 40. Un produttore non fabbrica mai il dato che il consumatore usera' per giudicarlo

**Regola:** quando A produce un dato e B lo usa per giudicare A, il valore «non
disponibile» deve restare rappresentabile e propagarsi come terzo esito, mai
essere colmato da un default sintetico. Corollario vincolante: 2xx senza ID non
e' un fallimento e non va ritentato; e' un'accettazione senza prova. Sostituire
il default con un throw fa cadere la cascata sul provider successivo dopo che il
precedente ha gia' risposto 2xx, inviando due volte la stessa email.

**Misura:** 2026-09-09 — nello stesso incarico sono state osservate quattro
istanze. I sei adapter di `functions/src/emailCascade.js` fabbricano un
`messageId` sintetico col timestamp quando il provider non ne restituisce uno:
Mailjet `mj-${Date.now()}` (L922), Mailgun `mg-` (L992), Mailtrap `mailtrap-`
(L1030), Maileroo `maileroo-` (L1086), Resend `resend-` (L1138) e Cloudflare
`cf-` (L1238), impedendo al consumatore di distinguere «accettato con prova» da
«accettato senza prova». La stessa forma ricompare nel reviewer del ciclo che
riallinea il branch e cancella i propri finding precedenti, producendo l'LGTM
che il gate poi consuma come verdetto; nel flush anonimo che rimuove la coda
degli intenti dopo un errore, distruggendo la sola evidenza del fallimento; e
nel catch fail-open del lookup delle soppressioni, che trasforma «stato ignoto»
in «destinatario inviabile». In tutti e quattro i casi il produttore ha
fabbricato o cancellato la prova che il consumatore usava per giudicarlo.

## 41. Un vincolo di rilascio dichiarato senza meccanismo che lo imponga e' un'intenzione

**Regola:** un vincolo con una via d'uscita e' una via d'uscita. Se non si sa
quanto consuma un comando, quel comando deve passare dal semaforo; la categoria
«pesante» non si deduce dal nome del comando. La formulazione «se esiste ed e'
eseguibile, altrimenti procedi» non e' un controllo di rilascio, ma
l'autorizzazione a ignorarlo.

**Misura:** 2026-09-09 — la regola «passa dal semaforo
`growth7/heavy.sh`» e' stata scritta nel prompt di un worker come condizionale:
«se esiste e se e' eseguibile, altrimenti procedi». Il worker ha proceduto, il
suo typecheck ha consumato 3,5 GB, l'OOM ha ucciso quattro lane di una sessione
parallela e circa un'ora di lavoro non e' stata recuperabile.

## 42. In un checkout sparse, `ls` e i test di esistenza mentono su un path che in git esiste

**Regola:** in uno sparse checkout l'assenza di `public/` o `data/` non prova
che un file non esista nel repository, e un nome non qualificato non e' un
path. Il discriminante e' `readlink` applicato a tutti i path che corrispondono
al nome, oppure `git show` / `git ls-tree` sull'oggetto; `ls` e il test del
filesystem da soli non bastano.

**Misura:** 2026-09-09 — una diagnosi ha attribuito il fallimento del
typecheck a «moduli generati o dipendenze mancanti» — `siteShell`,
`blogImageCdnMirror`, `canonicalOverrideFiles.mjs` — ma tutti e tre esistevano
nel worktree. Il falso negativo nasceva dal trattare l'assenza o la presenza di
un nome nella vista sparse come prova dell'albero git.

**Comando probatorio:** risolvere tutti i candidati con `readlink` oppure
interrogare direttamente l'oggetto con `git show <ref>:<path>` o
`git ls-tree <ref> -- <path>` prima di dichiarare mancante un file.

## 43. Il typecheck globale del sito non e' utilizzabile come gate isolato

**Regola:** prima di attribuire un rosso di typecheck alla propria patch,
riprodurlo sulla base. Un fallimento che si riproduce su `origin/main` pulito e'
un fatto della baseline, non un effetto del diff, e va dichiarato come tale
invece di essere spiegato con una causa non misurata.

**Misura:** 2026-09-09 — `npm run typecheck` non produce alcuna diagnostica
TypeScript; `tsc --noEmit` muore con `exit 134` (JavaScript heap out of memory)
a circa 4,1 GB, identicamente su un `origin/main` pulito.

**Comando probatorio:** i due riscontri da confrontare sono
`npm run typecheck` e `tsc --noEmit`, eseguiti sia sulla patch sia sulla base
pulita.

## 44. Una suite verde prova soltanto cio' che i suoi test coprono

**Regola:** il numeratore di una suite scritta insieme alla patch non e' una
prova di copertura del contratto. Serve un oracolo che dichiari gli scenari
prima, a partire dalla specifica, e che venga eseguito almeno due volte per
verificare che i rossi siano stabili. Nel delta la domanda piu' importante non
e' quanti rossi si sono chiusi, ma se un verde e' diventato rosso: una
regressione introdotta dalle correzioni vale piu' di dieci difetti chiusi.

**Misura:** 2026-09-09 — la remediation di uno scope ha riportato 297/297,
108/108 e 41/41 verdi, mentre un oracolo indipendente, costruito senza guardare
l'implementazione, misurava 83 assert con 29 rossi sugli stessi contratti. La
suite dimostrava quindi solo la propria superficie di test, non la copertura
del contratto ne' l'assenza di regressioni.

## 45. «Dipendenza baseline» e' una risposta sulla responsabilita', mai sulla proprieta'

**Regola:** dichiarare un rosso «fuori scope» chiude la responsabilita' di chi
scrive, non il difetto. Chi lo incontra deve almeno aprire il segnale — un'issue
con la misura dentro — anche senza toccarlo. Un errore che ogni agente vede,
classifica correttamente come «non mio» e lascia dov'e' e' il modo in cui una
pipeline resta ferma senza che nessuno stia sbagliando.

**Misura:** 2026-09-09 — il report di remediation dello scope D di Company
Alerts riportava testualmente «`npm run build:fast` ha trasformato 3.632
moduli ma il gate locale fallisce su una dipendenza baseline:
`scripts/lib/job-url-host.mjs` importa `domainToASCII` da `node:url`,
externalizzato da Vite. Non e' stata modificata la dipendenza fuori scope per
mascherare il rosso». L'agente ha fatto la cosa formalmente corretta: non ha
mascherato un rosso non suo. L'orchestratore ha letto quella riga come rumore di
baseline. Nessuno dei due ha posto la domanda successiva: se e' baseline, chi la
possiede? Lo stesso errore ha poi bloccato ogni deploy del sito per 36 ore, e le
build recenti sono morte sul successivo import `node:`-only della stessa classe
(`createHash` da `node:crypto` in `functions/src/lib/jobEmailRanking.js`).

**Corollario:** gli import `node:`-only in moduli che finiscono nel bundle
browser sono una classe, non un caso. Chiuderne uno rende fatale il successivo.
Il docblock in cima a `scripts/lib/job-url-host.mjs` descriveva gia' la trappola
e la sua soluzione: la regressione e' ricomparsa in un modulo nuovo.

## 46. Il record di deployment non prova i byte serviti

**Regola:** per rispondere a «il commit X e' distribuito?» serve un oracolo
emesso dal build e servito dall'artefatto, non il record di deployment. Su questo
sito l'oracolo e' `/commit-hash.txt`, uno SHA completo emesso da
`buildIdPlugin.closeBundle()` (`build-plugins/buildIdPlugin.ts`, `COMMIT_HASH`
da `git rev-parse HEAD`). **Non** e' `/build-id.txt`, che restituisce un
timestamp numerico. Verificare poi con `git merge-base --is-ancestor
<merge_sha> <sha_live>`: exit 1 significa «non distribuito», non «comando
fallito».

**Misura:** 2026-09-09 — il deployment `github-pages` piu' recente con stato
`success` dichiarava
`1199e4d6b03b08e53179f90186508628eebe2cf3`, mentre il dominio canonico serviva
`/commit-hash.txt` = `4711c1b7d0a4d0fe006312b1ab8dc787f55519d0`, anche con
richiesta cache-busted. La prima spiegazione plausibile — cache CDN — e' falsa:
il log del publish prova che il run 34079769787 ha scaricato l'artifact del
build precedente 34071387366 (`deploy_ref=4711...`) e lo ha reimpacchettato come
artifact di un publish il cui `pages_build_version` era `1199...`. Metadata del
deployment e byte dell'artifact hanno quindi due provenienze diverse: e' un
cross-run artifact handoff, non un problema di cache.

**Comando probatorio:**

```bash
git merge-base --is-ancestor <merge_sha> <sha_live>
```

## 47. Un numero scritto in un commento non e' una misura, e sostituirlo puo' invertire la conclusione

**Regola:** un margine dichiarato di 2 minuti su 130 sta dentro il rumore di
qualunque deriva; prima di dedurne «per costruzione» va rimisurato. Un conteggio
aggregato di run `cancelled` non distingue «la coda non fa passare nessuno» da
«passa uno e quello muore»: i due casi hanno rimedi opposti. Il taglio che decide
e' l'ultima run che ha DAVVERO eseguito il job di build, non le pending sfrattate;
la stessa query rende anche la durata reale. La coda e' effetto, non causa, ed
`validate-dist-postbuild` e' anch'esso effetto, perche' senza build non c'e'
`dist` da validare.

**Misura:** 2026-09-09 — il fermo dei deploy e' stato prima attribuito alla
saturazione della coda, citando un commento dentro `deploy.yml` — «build mediano
130 min, divario fra due build che partono 128 min, la coda e' satura non
affamata» — e concludendo «margine chiuso per costruzione, non un guasto
comparso». Rimisurate, le run che partono davvero durano 98 e 118 minuti e,
soprattutto, le run non-`cancelled` dal 7 settembre sono TUTTE `failure`, la
prima del 2026-09-08T15:18:59Z. La finestra si spezza in due con cause diverse:
prima solo `cancelled` (la coda spiega), poi run che passano la coda, arrivano al
build e muoiono li'.

## 48. Import nominale contro namespace: il discriminante che tiene invisibile un difetto per mesi

Misurato il 2026-09-09 sui log di `deploy.yml`, mentre si cercava perche' il
sito non pubblicava piu'.

`__vite-browser-external` e' il modulo su cui Vite mappa i builtin Node in una
build browser, e non ha export nominati. Quindi la stessa violazione — un
modulo del grafo browser che importa un builtin Node — ha due esiti opposti a
seconda della **forma sintattica** dell'import:

- `import { createHash } from 'node:crypto'` → rollup deve risolvere il
  binding, non lo trova, **errore fatale**. La build muore al link, cioe' dopo
  ~80 minuti per locale.
- `import * as _fs from 'node:fs'` → nessun binding da risolvere, **warning**.
  La build passa.

Nello stesso log convivevano le due forme: rosso su
`functions/src/lib/jobEmailRanking.js`, giallo su tre moduli di
`build-plugins/` che importano `node:fs` in forma namespace e che erano li' da
mesi senza fermare niente.

**Non e' una questione di uso, ma di binding.** Nessuno chiamava `createHash`
dal browser: in quel percorso il contesto di ranking e' `null` e la funzione non
veniva mai eseguita. L'errore nasce dalla dichiarazione del nome, non dalla sua
chiamata — ed e' esattamente per questo che i tre namespace non sono «meno
gravi»: sono la stessa bomba con la spoletta non innescata. Il giorno in cui
qualcuno riscrive uno di quei tre import in forma nominale, il deploy si ferma
di nuovo senza che la classe del difetto sia cambiata.

**Il rimedio che NON si applica.** Convertire il nominale in namespace e' un
diff di tre righe e sblocca il deploy subito. E' vietato: e' alla lettera il
Non-Negotiable #2, «mai downgrade error → warning per sbloccare deploy», e
ricompone la trappola per il prossimo. Si taglia l'arco.

**E il verso del taglio conta.** Estrarre la parte pura in un modulo senza
dipendenze Node e farla ri-esportare dal modulo originale **non basta**: se il
consumatore nel grafo browser continua a importare dal modulo originale, quel
modulo resta nel grafo con il suo import Node e la foglia non sparisce. Il
passo che la rimuove e' spostare il consumatore sul modulo puro; il ri-export
serve solo ai consumatori Node, che nel grafo browser non ci sono. Verificato su
#8123: dopo la fix l'unico importatore nel grafo SPA e'
`services/newsletter-template.mjs`, e punta al modulo puro.

**Come si misura, invece di temerlo.** Non inseguire la cascata un fatale per
volta — rollup rende fatale il successivo appena chiudi il primo, e ogni giro
costa 80 minuti. Si cammina il grafo dei moduli dall'entry SPA (`App.tsx`,
`index.tsx`) seguendo import statici, dinamici e l'alias `@/`, e si contano le
foglie che importano un builtin. Numeri di quel giorno, da confrontare:
**546 moduli raggiunti, 4 foglie, 1 sola fatale**. Il criterio di accettazione
utile e' «0 foglie», non «0 foglie con import nominale»: il secondo e' piu'
debole e ricrea la spoletta.

Follow-up strutturale con la misura dentro: issue 8125.

## 49. Due superfici di distribuzione possono avere oracoli diversi (L-D)

**Regola:** prima di dichiarare che una modifica è o non è in produzione,
stabilire da quale superficie viene eseguita. Un workflow che fa `checkout` è
distribuito all'istante del merge; una SPA servita da un artefatto statico è
distribuita solo quando quell'artefatto cambia. Le due domande hanno oracoli
diversi e vanno risposte separatamente.

**Misura:** 2026-09-09 — il sito non distribuiva il frontend dal 7 settembre:
l'artefatto pubblico serviva ancora uno SHA che non conteneva nessuno dei
cinque merge della giornata. Nello stesso momento il workflow
`Send CompanyAlert Emails (immediate)` girava regolarmente e con successo,
perché si esegue da un checkout del repository, non dall'artefatto Pages. Le
correzioni della catena di invio erano quindi già in produzione dal merge,
mentre quelle del frontend non lo erano; l'orchestratore aveva dichiarato
«nulla di oggi è distribuito», falso per metà.

## 50. In una coda con `cancel-in-progress: false` viene sfrattato il pending, non l'in-progress (L-E)

**Regola:** quando la coda è in questo stato, trattenere i merge serve solo
finché nessun run è partito. Appena un run passa a `in_progress` è protetto e i
merge successivi non lo uccidono più; trattenere oltre quel momento è costo
senza beneficio. Un conteggio di run `cancelled` non distingue «la coda non fa
passare nessuno» da «passa uno e quello muore»: la distinzione si fa sull'ultima
run che ha davvero eseguito il job, e i due casi hanno rimedi opposti.

**Misura:** 2026-09-09 — `deploy.yml`, con
`concurrency: group: pages-build-run`, ha accumulato 18 run `cancelled` e zero
`success` in due ore, perché su `main` arrivavano 30 commit in due ore — 17 dai
bot `auto-translate`, `weather snapshot` e `tracking LinkedIn` — contro un build
da 98–118 minuti. Ogni push sfrattava il run pending del push precedente, quindi
nessuno raggiungeva mai l'esecuzione. Un dispatch manuale non aiutava: entrava
nello stesso gruppo e veniva sfrattato ugualmente.

## 51. Una finestra di sorveglianza fissa rende il silenzio ambiguo (L-F)

**Regola:** ciò che si sorveglia va interrogato per identità, non pescato da una
lista a finestra; ogni lista va inoltre ordinata esplicitamente prima di
leggerne la testa, perché l'ordine di ritorno dell'API non è garantito. La
domanda diagnostica generale è: «se la cosa che aspetto fallisse adesso, il mio
filtro emetterebbe qualcosa?». Se la risposta è no, il filtro copre solo il
percorso felice e il silenzio mente.

**Misura:** 2026-09-09 — un monitor osservava «le 12 PR più recenti» per seguire
una PR specifica. Quando altre PR sono state aperte, quella sorvegliata è uscita
dalla finestra e ha smesso di comparire: nessun evento, esattamente come se non
fosse cambiata. Nello stesso giro `gh run list` ha restituito righe di run di un
mese prima, non ordinate, che il monitor ha emesso come nuove; solo un
`sort_by(.createdAt)` esplicito ha smascherato il falso.

## 52. Un job che diagnostica puo' saturare la macchina piu' del lavoro che diagnostica.

Un job Codex incaricato di rimisurare 122 assert di un file di test ha lanciato
`git fsck --no-reflogs --unreachable` su un `.git` da 21 GB: otto minuti e mezzo
al 93% di CPU, per un'informazione che non gli serviva. Il load della macchina e'
salito 11 -> 16 -> 35 in circa 40 minuti con `github.com` e `api.github.com`
entrambi in timeout a 8s.

La regola: il costo di un comando diagnostico va valutato contro il repository
reale, non contro l'idea del comando; su questo clone (completo, non shallow)
`git fsck`, `git grep` senza pathspec e `git log --all -S` sono operazioni care.
Corollario sul brief: chiedere «censisci **tutti** i punti che...» senza dare un
perimetro produce un `git grep` nudo — il costo e' del prompt, non dell'agente.

## 53. Un semaforo che ognuno rispetta contando i propri job non e' un semaforo.

Il runtime Codex di questa macchina e' condiviso fra tutte le sessioni Claude: i
job girano sotto lo stesso `codex app-server` e si sommano, ma
`codex-companion.mjs status` mostra **solo i job della propria sessione**.
Nessuna sessione puo' misurare la saturazione dall'interno del proprio
strumento. Misurato: 12 job Codex simultanei fra due sessioni, ciascuna delle
quali ne vedeva rispettivamente 5 e 7.

La regola: il numero vero si legge solo da `uptime` e dalla tabella dei processi,
che sono condivisi; prima di lanciare, misura il totale, non il proprio.

## 54. Alla domanda «hai lavoro non salvato?» non si risponde con `git status --short` letto di fretta.

Una sessione ha dichiarato «nessun lavoro non committato» in tre worktree
destinati alla cancellazione. Uno conteneva
`tests/company-alerts-positive-chain.test.tsx`, 585 righe **non tracciate**,
scritte dalla sessione stessa poche ore prima. Il file non e' andato perso solo
perche' chi cancellava ha verificato l'identita' byte a byte con la copia su
`origin/main` invece di fidarsi della dichiarazione.

La regola: il predicato e' `git status --porcelain` **contato, untracked
inclusi**, eseguito nel worktree in questione e non ricordato. La classe che
sfugge e' esattamente quella che il comando mostra per ultima.

## 55. `gh` risolve silenziosamente contro il repository sbagliato quando la working directory scivola.

Due `gh pr view <numero>` di fila hanno risposto `Could not resolve to a
PullRequest with the number of N`. Non era un guasto di GitHub: la working
directory era finita dentro una sottocartella del repository **root**, e `gh`
risolveva contro `frontaliere-workspace` invece che contro il sito. Il messaggio
d'errore parla della PR, non del repository, quindi indirizza la diagnosi verso
la PR inesistente.

La regola: in un workspace multi-repo passa **sempre** `--repo <owner>/<name>`
esplicito, e leggi «risorsa non trovata» come «forse sto guardando nel posto
sbagliato» prima che come «la risorsa non esiste».

## 56. Una sonda di liveness sbagliata rende il fallimento indistinguibile dal successo.

Un monitor che verificava la vita di quattro job Codex con `pgrep -f "job-id <id>"`
ha emesso «TUTTI I JOB TERMINATI» mentre tutti e quattro erano `running`
e tredici worker erano attivi sulla macchina. La conseguenza non e' il rumore:
e' che l'evento **conclusivo** era falso, e senza una verifica indipendente
sarebbe stato riportato come esito. La regola: la liveness di un job si legge
dalla sua fonte autoritativa — il JSON di stato del job — non dalla tabella dei
processi; e ogni evento terminale emesso da un monitor va verificato prima di
essere riportato, perche' un monitor che sbaglia non sbaglia in modo rumoroso,
sbaglia in modo convincente.
