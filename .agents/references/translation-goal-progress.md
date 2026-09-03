# Translation goal — ledger di avanzamento e handoff

Ultimo aggiornamento: 2026-09-01 09:58 CEST (Europe/Zurich)

Questo file e' la fonte di continuita' del goal traduzioni. Va aggiornato dopo
ogni nuova misura, finding bloccante, nuova HEAD di PR, merge, cambio di fase o
decisione architetturale. Un agente che riprende il lavoro deve leggere prima
questo ledger, poi `AGENTS.md`, le istruzioni del repo interessato e `get_goal`.

## Goal e definizione di successo

Obiettivo invariato: riprogettare e implementare progressivamente il processo
di traduzione dei job affinche' sia autonomo, senza costi aggiuntivi, completo,
con qualita' elevata e capace di migliorare a ogni run tramite un feedback loop
misurabile.

Il goal e' stato ripreso esplicitamente dall'utente alle 08:10 CEST dopo un
precedente arresto per quota. Il backend al checkpoint 09:09 CEST conserva lo
stato storico `blocked` (`tokensUsed=6.026.250`, `remainingTokens` non esposto),
ma il blocco quota non esiste piu': weekly usage e' nuovamente al 100% e
l'esecuzione corrente e' attiva, con un nuovo audit di eventuali blocker.
Continuare con agenti in parallelo su task indipendenti; resta obbligatorio il
ciclo remoto PR/CI/review exact-HEAD/`## LGTM`/auto-merge.

### Checkpoint operativo immediato

- Reducer chiuso: site #6906 merged via auto-merge, final head
  `cfb5be2772348f38b0316ba0ce9719a033cfcec9`, merge
  `c291c8d87807f0cd2a6d217f29c5011a7a210419`; origin/main/ancestry verificati.
- Filone traduzioni attivo: PR3 store Git sharded + drainer CAS congelato sulla
  exact HEAD locale `ce3b561d3d1c304c2220bf02934ff3db7c9f03b0`, base hot-main
  `e7a29d3b67483d2a3bd68fd8815d8146a9a1e4bf`, worktree pulito e 6 file.
  Suite 114/114 verde, CAS p95 1.080,5 ms; doppia review exact-HEAD in corso,
  ancora nessun push/PR.
- PR4 scheduler completion-first avviata in parallelo su due soli file nuovi e
  indipendenti dallo store. Nessun wiring/runtime/workflow e nessun push/PR
  finche' PR3 non e' merged e l'integrazione store non e' stata aggiunta.
- Issue site #6876 chiusa: PR #6924 merged solo via auto-merge il
  2026-09-01T07:04:07Z, exact reviewed head `060daba589002ee6dd4f128190275f09eefabf9c`,
  merge `4d298d3363ad3af2956630910e1fab78aafc921f`; issue CLOSED e merge ancestor
  di origin/main verificati. Nessun run crawler manuale.
- Primo monitor live traduzioni ancora pendente: nessun true-final eleggibile;
  mantenere heartbeat/14 generazioni e non usare i due run baseline come prova.

Il goal non e' concluso finche' non sono contemporaneamente veri questi punti:

- tutti i job traducibili convergono verso la copertura completa IT/EN/DE/FR;
- una traduzione gia' valida non viene degradata o sovrascritta implicitamente;
- delete/re-add, rotazione URL/ID e crash non fanno perdere una traduzione valida;
- nessun record eliminato viene resuscitato e nessun campo crawler primario viene
  modificato dal writer traduzioni;
- il progresso sopravvive a contention, cancellazioni e runner interrotti;
- ogni successo dichiarato e' verificato semanticamente sul `main` corrente;
- nessuna API o infrastruttura a pagamento e nessuna revisione umana;
- il feedback loop misura outcome, errori, cache, qualita' e regressioni e cambia
  engine/gate/scheduler soltanto sulla base di evidenze;
- un eventuale LLM gira interamente dentro GitHub Actions, senza servizio
  esterno a pagamento, e viene adottato solo se una shadow evaluation dimostra
  un miglioramento netto e ripetibile sui job quarantinati.

## Vincoli operativi non negoziabili

- `/root` orchestra, decide la big picture e revisiona; i subagent implementano.
- Un altro agent e' owner dei crawler: non modificare crawler o sovrascrivere i
  suoi worktree/branch. Partire sempre dall'ultimissimo `origin/main`.
- Usare subagent in parallelo soltanto su ownership indipendenti e senza file
  sovrapposti; serializzare integrazioni dipendenti e freeze/rebase.
- Dimensionare il modello: Luna/low per ricognizioni e review meccaniche,
  Terra/medium per fix noti piccoli, Sol/high solo per invarianti persistenti,
  concorrenza, sicurezza o cambi multi-modulo.
- Test locali mirati e proporzionati; niente build completa duplicata. CI,
  review exact-HEAD e merge devono avvenire tramite la PR remota.
- Mai merge manuale. Abilitare auto-merge, attendere test verdi e review remota
  con `## LGTM` sulla stessa HEAD.
- Ogni code change richiede `code-reviewer`; ogni JS/TS richiede anche
  `typescript-reviewer`. Correggere P0-P2 sulla stessa PR e ripetere le review.
- PR body con sezioni esatte `## Implementato` e
  `## Non implementato (ancora)`; i deferred devono usare una forma ammessa.
- Prima degli edit: GitNexus impact quando disponibile; prima del commit:
  `detect_changes`. L'indice e' risultato stale sui nuovi simboli v2, quindi
  integrare sempre con call-site e diff diretti.
- Repo figli indipendenti. La SSOT dell'engine/workflow e' nel sito; il corpus e'
  wrapper/pubblicatore. Non creare import diretti sito-corpus.
- Non lanciare, cancellare o duplicare manualmente run di traduzione per
  accelerare le verifiche; osservare il primo run naturale eleggibile.

## Macro stato

| Macro | Stato | Evidenza / prossimo passo |
|---|---|---|
| Analisi dati storici e run live | completata per la baseline, raccolta continua | Due run profondamente auditati; attendere il primo true-final eleggibile e 14 generazioni |
| Final commit osservabile/affidabile | implementazione iniziale completata | site #6887 merged; la verifica end-to-end richiede un run post-corpus #695 e post-site #6887 |
| Identita', memory e journal v2 | completata | site #6894 e #6902 merged, 42 test locali sul freeze #6894 e canonical replay corretto |
| Reducer puro derived-only | completata | site #6906 merged `c291c8d...`; 73/73 locali, doppia review CLEAN, CI + LGTM exact-head |
| Store Git sharded + drainer | **in review locale** | PR3 exact `ce3b561d...`; 114/114, p95 1.080,5 ms; doppia review exact in corso, poi PR remota |
| Scheduler + negative cache | **implementazione pura in corso** | PR4: completion-first/fairness/cursor/negative-cache in 2 file nuovi; integrazione store solo post-PR3 |
| Shadow workflow e telemetria | pendente | nessuna scrittura main; misurare overlap, job-completi/minuto, qualita', CAS p95 |
| Canary/cutover | pendente | kill switch; poche company; espansione solo dopo gate live |
| Feedback loop autonomo | pendente | outcome memory, quality evidence, regressioni, engine/gate version e quarantena |
| Valutazione LLM locale GHA | pendente per scelta evidence-first | solo repair quarantene e solo se supera Argos/baseline senza costo |
| Rimisura finale / convergenza | pendente | 14 generazioni, backlog, qualita', zero resurrection/primary mutation e costi zero |
| Issue indipendente #6876 | completata | site #6924 merged via auto-merge; exact LGTM, CI verde, issue chiusa, nessun run crawler manuale |

## Filone parallelo indipendente — issue site #6876

Richiesta aggiunta dall'utente alle 06:55 CEST, senza sospendere il reducer.

- Issue: `Workflow Failure: Orchestrate Job Crawlers`, site #6876,
  <https://github.com/valerielinc-ops/frontaliere-si-o-no/issues/6876>.
- Run fallito: `33454436082`, schedule, head site
  `1c6e6b82ddbdb78b65a0c2ff2a44c65ed8a972b6`, 00:21-00:44Z.
- Evidenza preliminare: preflight shadow verde; `dispatch-groups` termina dopo
  ~22m36 con `{"mode":"shadow","failures":23}` e exit 1; sentinel successivo
  risponde `binding_mismatch`. Il dispatch cross-repo translate-pending riesce,
  quindi non e' la causa primaria del run rosso.
- Subagent indipendente: `/root/fix_issue_6876_crawler_orchestrator`, ruolo
  `bl-fixer` (Sol/high per workflow concorrente/cross-repo e causa non ancora
  provata). Deve partire dall'ultimissimo main, confrontare il run head con lo
  stato corrente e determinare se il difetto e' gia' stato corretto prima di
  editare.
- Ownership: solo workflow/script/test strettamente necessari a #6876; vietati
  file reducer #6906, crawler data e modifiche dell'altro agent crawler.
- Gate: niente run crawler manuali; se serve fix, test mirati, doppia review
  obbligatoria per JS/TS, PR exact-HEAD, CI + review remota `## LGTM`, auto-merge
  soltanto, mai merge manuale. Registrare qui causa, PR/head e risultato.

Checkpoint diagnostico #6876 alle 07:04 CEST:

- Worktree creato: `frontaliere-si-o-no/.claude/worktrees/issue-6876`; branch
  iniziale `issue-6876` da correggere in `codex/issue-6876` prima del push.
  Il base dichiarato `f36571c3` e' gia' stato superato dall'hot main: fetch e
  riallineamento obbligatori prima del commit.
- Tutti i 23 POST del run fallito **sono riusciti** e hanno creato esattamente
  group-01..23 (run `33454460732`..`33455982350`): non e' un problema di rate
  limit, discovery o capacity.
- Il run log classificava tutti i 23 come `binding_mismatch`, ma la prima
  spiegazione del campo `name` e' stata **rettificata** dopo verifica API live:
  sui run completati `33454460732`, `33455982350` e `33455984398`, `name` e
  `display_title` sono entrambi il run-name dinamico; il nome statico e' esposto
  dall'endpoint workflow/`workflowName`. Il group-01 completato passa quindi il
  validator storico. Il mismatch iniziale puo' essere un campo/path transitorio
  nel run appena creato; non va piu' dichiarato causa autonoma provata senza lo
  snapshot originale. La race del ref mobile sotto resta invece provata.
- Causa 2 provata: il preflight pinna corpus SHA `079cc61c`, ma i dispatch
  sequenziali ogni 60s usano il ref mobile `main`. Gruppi 01-06 partono da
  `079cc61c`, 07-13 da `ea34079f`, 14-23 da `e5b77d5a`; 17 fallirebbero comunque
  il guard `head_sha`. Anche il sentinel nasce su `e5b77d5a` e viene classificato
  mismatch; poi il job fallisce sul corpus commit divergente.
- Workflow e dispatcher sono byte-identici tra il run head e il current main
  ispezionato: issue non stale. GitNexus impact validator LOW, 3 caller diretti,
  10 simboli, 0 processi. Nessun edit funzionale/PR ancora.
- Fix richiesto da `/root`, poi corretto sui dati live: binding compatibile con
  entrambe le forme API documentata/osservata (`name` statico **oppure** run-name
  dinamico), mentre `display_title` deve essere il run-name esatto; continuano a
  essere obbligatori runId/repo/path/event/ref/head SHA/lifecycle e hash del
  workflow all'exact corpus SHA. Non rimuovere `head_sha`. Eliminare la race del
  ref mobile affinche' tutti i gruppi usino lo stesso workflow/corpus code;
  test esplicito con main che avanza durante la wave.
- Checkpoint implementazione #6876 07:20 CEST: proposta un ref corpus univoco
  per generation-token, usato da tutti i group e dal sentinel; input
  `site_code_commit` e checkout sito per SHA; binding su name statico,
  display-title dinamico, ref/path/SHA. Se il pin fallisce, fallback legacy ma
  `shadow_ready=false` per non dichiarare osservabilita' forte.
- Test intermedi dichiarati: nucleo 54/54 + generator/workflow 63/63;
  generator `--check` e actionlint dei due workflow diretti verdi. I 23 artifact
  generati mostrano solo il campo custom `background` preesistente. Diff dirty:
  36 file workflow/script/test/contract generati, nessun translation-derived o
  crawler data; full mirata prevista 124 test.
- `/root` ha bloccato commit/push fino a ratifica del lifecycle del ref pin:
  namespace, collision/replay, create/delete, cleanup su success/failure/cancel,
  retention/reaper e permessi cross-repo devono evitare ref leak/cancellazioni
  altrui; va anche provato che il fallback shadow-off sia fail-safe.
- Freeze #6876: **124/124** test mirati verdi, ancora nessun commit/push. Il
  diff iniziale non aveva alcun cleanup e avrebbe accumulato ref; correttamente
  dichiarato non pronto dal subagent.
- Lifecycle ratificato 07:23 CEST: ref
  `refs/heads/crawler-generation-shadow-<run_id>-<run_attempt>`; 404 -> create,
  same SHA -> idempotent, **existing different SHA -> fail closed senza PATCH**.
  Dopo sentinel realmente accepted, step `always()` cancella solo dopo GET che
  prova exact ref/SHA/type; mismatch/failure non cancella. Sentinel fallito o
  crash lascia il ref al reaper.
- Reaper richiesto prima delle wave: solo namespace dedicato, paginazione/cap
  bounded; token parsabile; owner run site con repo/workflow/id/attempt esatti,
  terminale e vecchio >=24h. Active/young/malformed/API incerta si preserva;
  current token mai cancellato; GET exact prima di DELETE. Test di collisione,
  cleanup idempotente/refusal, cancel/runner loss, owner/age/API e cap obbligatori.
  Fallback legacy con `shadow_ready=false` e observer dormiente ratificato.
- Dirty checkpoint 07:28 CEST: 36 file previsti/modificati, circa +822/-150,
  inclusi 23 workflow generati e test; HEAD base ancora `8d6970a2`, nessun
  commit/push. Il subagent sta implementando cleanup/reaper e deve ancora
  consegnare freeze/test/riallineamento hot-main.
- Nuovo freeze lifecycle dichiarato 130/130 test verdi, generator/check/node/
  actionlint/diff verdi, ancora senza commit. Review `/root` ha trovato P1 nel
  workflow cleanup: un env esplicito `${{ secrets.GITHUB_PAT_NANAKO }}` poteva
  sovrascrivere con vuoto il PAT caricato da Remote Config in `GITHUB_ENV`.
  Richiesto rimuovere override, ereditare il PAT della wave e aggiungere test;
  push resta bloccato fino al nuovo freeze.
- Freeze locale finale pre-review 07:36 CEST: P1 corretto e testato; GitNexus
  `detect_changes` LOW (0 processi affetti). Commit locale
  `5d2ea384f1c287d14e5952666fe68e259cfded63` (`fix(crawlers): pin generation
  dispatch workflow code`) su base hot-main esatta
  `1c7874179e024647db302e1f5b9dac13e9eaf877`, branch
  `codex/issue-6876`, ahead/behind 1/0 e worktree pulito. Dopo il rebase senza
  conflitti e' stata rigenerata byte-identica la matrice dei 23 workflow:
  130/130 test mirati verdi, generator `--check`, `node --check` sui 3 script,
  actionlint sui 2 workflow e diff check tutti verdi. Diff 36 file, +823/-150,
  nessun crawler data o file translation-derived. Due review read-only
  obbligatorie (`code-reviewer` e `typescript-reviewer`) sono in corso sulla
  stessa HEAD. **Nessun push, PR o run produzione ancora eseguito.**
- Review orchestrativa sul freeze `5d2ea384` ha trovato un nuovo P1 prima del
  push: `parseArguments()` contiene la configurazione `cleanup-ref` ma non lo
  include nell'allowlist iniziale dei mode; il workflow quindi invocherebbe un
  comando sempre rifiutato. Freeze e review della vecchia HEAD sono da
  considerare invalidati. Richiesti fix minimale, test CLI end-to-end del mode,
  nuovo commit/test freeze e doppia review sulla nuova HEAD; push resta vietato.
- Cleanup CLI corretto nel commit locale successivo e testato (131/131), ma la
  nuova HEAD non e' ancora review-clean. Verifica live di `/root` e subagent:
  group-01/23 e sentinel confermano `name=display_title=runName`; endpoint
  workflow separato conferma i nomi statici. Ratificata una dual-form esatta
  (`name` dinamico o statico, `display_title` sempre dinamico) senza 24 GET
  workflow aggiuntive, perche' path+ref+SHA+hash preflight vincolano gia' il file.
- Le due review hanno inoltre trovato due P2 nel reaper: `matching-refs` non
  documenta `page/per_page`, quindi le due pagine potevano duplicare la prima;
  inoltre 100 ref seriali con timeout 30s potevano consumare oltre il timeout
  del job prima della wave. Ratificato: una sola GET documentata senza query,
  body gia' limitato a 1 MiB, ref parsabili ordinate per runId/attempt piu'
  vecchi, massimo 4 candidate seriali per run e `truncated` esplicito. Worst case
  bounded 6 minuti; mantenere tutti i guard owner/age/exact-SHA. Richiesti test
  single-list, >4/oldest-first e preservazione fail-safe. Nessun push.
- Nuovo freeze locale #6876 post-fix e post-hot-main rebase 07:49 CEST: exact
  HEAD `35e9345fd0d56d92edac948d4c387f2c18aabb0e`, base/origin-main
  `dba6f4c5915eff4de561c82c564fc99f7c024c15`, ahead/behind 3/0 e worktree
  pulito. Suite ampliata **135/135** verde; generator `--check`, `node --check`
  x3, actionlint x2, diff/status tutti verdi; artifact rigenerati byte-identici
  e nessun conflitto. Nessun push. Le due nuove review exact-HEAD sono pendenti
  solo per slot temporaneamente occupati dalle review PR3; il subagent resta in
  freeze e le riavvia appena si libera capacita'.
- Poiche' hot main e' avanzato ancora, freeze #6876 riallineato nuovamente senza
  conflitti alle 07:54 CEST: exact clean HEAD
  `0dc1dfcfe3cf39a5c4b6ac57be629984a4bd6671`, base/origin-main
  `0dc4edb5f7716481d768efba3cbce3533bb21008`, ahead/behind 3/0. Generator ancora
  byte-identico e 135/135 + generator/node/actionlint/diff/status verdi.
  `code-reviewer` v2 e' partito su questa HEAD; `typescript-reviewer` v2 partira'
  appena si libera uno slot. HEAD congelata, nessun push.
- `code-reviewer` v2 ha bloccato anche la HEAD `0dc1dfcf` con un nuovo P1 nel
  runtime observer non incluso nel primo diff: `loadEventSentinel()` eseguiva il
  pre-check senza corpus SHA, quindi costruiva un binding legacy `main` e
  rifiutava ogni sentinel sul nuovo ref pinned prima di leggere l'artifact. Fix
  ratificato: pre-check contro `run.head_sha` per vincolare subito ref/path/run,
  poi secondo check invariato contro `sentinel.corpusCodeCommit` dopo download e
  validazione del sentinel. Richiesto test observe-event end-to-end. Attendere
  anche il verdict TS, combinare i fix, riallineare hot main, 135+ test e due
  nuove review CLEAN. Nessun push.
- Chiusura verificata 09:09 CEST: fix finale su exact HEAD
  `060daba589002ee6dd4f128190275f09eefabf9c`, 139/139 test locali, generator
  `--check`, `node --check`, actionlint e GitNexus verdi; review locali general
  e JS/TS CLEAN. La PR site #6924 ha ottenuto CI SUCCESS e review automatica
  exact-HEAD con `## LGTM` (Important 0); l'auto-merge gia' predisposto ha creato
  il merge `4d298d3363ad3af2956630910e1fab78aafc921f` alle 07:04:07Z. Issue #6876
  CLOSED alle 07:04:08Z, ancestry su origin/main verificata. Worktree e branch
  locale rimossi solo dopo il merge; branch remoto lasciato intatto. Nessun run
  crawler o traduzione e' stato lanciato manualmente.

## Diagnosi basata sui dati

### Run `33430387921` — baseline storica, non eleggibile

- Evento schedule, corpus precedente a #695; job circa 4h44, wall time circa 6h12.
- Phase 2a Argos: 100m26; 6.000 job, 10.087 campi, 10.077 ok,
  10 fail; 1.457 flag `needsRetranslation` chiusi.
- Phase 2b: 52m07; 207 invocazioni effettive, tutte arrivate con budget
  `0min`; 3 pending in meno ma **0 flag realmente chiusi**.
- Phase 2c Argos: 64m39; 10.234 campi, 10.224 ok, 10 fail; 296 flag chiusi.
- I due pass Argos hanno prodotto 20.301 output riusciti ma soltanto 1.753
  completamenti. Entrambi selezionavano deterministicamente
  `order.slice(0, 6000)` senza cursore o negative cache.
- Il commit traduzioni ha perso 14/14 CAS in 42m38 e ha restituito soft-success.
  Il successivo commit slug ha inglobato 556 file sporchi e ha pushato
  `3c6caf19f7ba8cb4fbd880c9efacbafee833bef4`.
- Audit semantico di quel commit: 14.335 job cambiati, 0 primary crawler field
  change osservati e 14.334 cambi derived. Nessuna resurrection osservata, ma
  questo non prova la qualita' linguistica.
- Durante la finestra CAS: 459 commit in 42 minuti, circa 10,8/min. Un singolo
  commit monolitico non converge in modo affidabile.

### Run `33455986103` — seconda baseline, non eleggibile

- Evento manuale, head corpus `e5b77d5...`, creato prima di #695/#6887;
  2026-09-01 01:36:18Z -> 04:04:31Z, successo tecnico ma non prova il nuovo
  true-final.
- Phase 2a: 62m17; 15.471 candidati, 6.000 job, 10.465 richieste;
  10.452 output ok, 13 fail, ma solo 730 campi accettati e 141 flag chiusi.
- Phase 2b: 23m38; 10.322 pending prima, 10.292 dopo, 33 flag chiusi.
  Ha usato la cascade attuale, inclusi provider esterni; non e' il target
  zero-costo. 168/174 chiamate di campo riuscite, ma solo 33 job completati.
- Phase 2c: 33m57; 15.269 candidati, di nuovo 6.000 job, 10.136 richieste;
  10.123 output ok, 13 fail, ma solo 50 campi accettati e 16 flag chiusi.
- Totale Argos: **20.575 output riusciti -> 780 campi accettati -> 157 flag
  chiusi**. Con Phase 2b: 190 completamenti. Il collo di bottiglia e' gate,
  ripetizione e scheduling, non throughput di inferenza.
- Commit traduzioni riuscito in `a856e739e9f54dee49f85352385f25be3c1db10b`
  su 197 file; il vecchio finalizer ha comunque atteso uguaglianza esatta con
  `main` e ha visto un altro SHA per 20/20 tentativi. Anche i commit successivi
  hanno mostrato lo stesso difetto di attesa.

### Conclusioni quantitative correnti

- Ottimizzare "campi generati/secondo" peggiora il problema se il gate rifiuta
  gli stessi output. La metrica primaria deve essere `job completati/runner-hour`.
- Phase 2b non puo' restare nel critical path: prima baseline 52m/0 flag,
  seconda 23m38/33 flag e dipendenze esterne. Va rimossa solo dopo shadow/canary,
  non per intuizione.
- Phase 2c deve diventare resume da cursore/outcome persistito; oggi ricalcola
  migliaia di output gia' bocciati.
- La finestra CAS deve essere nell'ordine di secondi e applicare micro-batch,
  non minuti su centinaia di file.

## Delete/re-add e cache — verifica eseguita

Il meccanismo corrente e' parziale, quindi non va considerato risolto dal legacy:

- `dedicated-crawler-common.mjs` usa cache per-company in
  `data/translation-cache/<company>.json`, chiave `slug || id || index`, hash
  `title|description`, TTL 30 giorni e bypass con `needsRetranslation`.
- La chiave non garantisce reuse quando cambiano sia URL/ID/slug; non esiste un
  pruning/invalidation contract uniforme.
- `jobs-localization-memory.json` e' content/context-addressed ma LRU 30k;
  Argos bulk non usa uniformemente lo stesso path.
- Coop ha un riuso URL/content specifico, non un invariante generale.

La v2 merged risolve il fondamento:

- identity indipendente da URL, job ID, slug e timestamp;
- chiave su tipo/campo, direzione locale, source hash e context hash;
- engine/gate version nell'attempt key;
- candidati validated/rejected, conflitti espliciti, invalidazione auditabile;
- negative-cache esatta sul lookup, ma merge degli outcome commutativo;
- journal fail-closed con sequenza per attempt, retry idempotente e replay
  canonico indipendente dall'interleaving;
- test delete->re-add con URL/ID nuovi, source/context change, engine/gate
  bypass, invalidazione, conflitti e cicli ripetuti.

Il reducer deve completare la garanzia: una patch vecchia non si applica a un
target nuovo solo perche' il contenuto coincide. Il job riaggiunto viene
riscansionato, ottiene un hit nella memory content-addressed e genera una nuova
patch legata al target corrente.

## Architettura ratificata

```text
scan main@baseline
  -> lookup memoria content/context-addressed
  -> negative-cache / candidato valido / generazione locale su miss
  -> quality gate versionato
  -> checkpoint su ref Git translation-state-v2
  -> reducer rilegge main fresco
  -> micro-commit esclusivamente derived-only
  -> verifica semantica sul nuovo HEAD
  -> ack del journal e feedback loop
```

Decisioni:

- State store su ref Git dedicato `translation-state-v2`: non contende con i
  crawler che scrivono `main` e non costa nulla oltre GitHub Actions/Git.
- Journal/memory sharded per prefisso hash; niente JSON monolitico.
- Nessun TTL di correttezza: testo+contesto identici non diventano falsi col
  tempo. TTL/LRU possono solo governare retention/priorita'.
- Invalidazione esplicita conserva il candidato per audit ma lo rende non
  applicabile finche' un nuovo candidato non passa la policy corrente.
- Bundle atomico per job; micro-batch iniziale 1-4 slice o <=250 bundle, da
  adattare per mantenere fetch->push CAS p95 <2s.
- Writer allowlist iniziale: soltanto `titleByLocale.<locale>` e
  `descriptionByLocale.<locale>`. `needsRetranslation` si aggiorna solo come
  conseguenza successiva di una completezza verificata.
- Vietati al reducer: primary title/description, URL, id, slug/slugByLocale,
  sourceLang, date, liveness, active/expired membership, company/location,
  history e cache legacy.
- Record assente -> `target_absent`, mai crearlo. Source/context/URL cambiato ->
  stale, mai applicare. Traduzione buona esistente -> `already_valid`, mai
  sovrascrivere senza invalidazione esplicita.
- Gli expired non sono target di scrittura del reducer: spesso non contengono
  sourceLang, URL o descrizione master. Servono come possibile corpus di
  training/seed verificato, non come record da mutare.
- Il finalizer verifica ancestry dell'ultimo commit applicato e presenza
  semantica dei patch acknowledged sul nuovo HEAD; non richiede uguaglianza
  dell'HEAD. Stati: `complete`, `partial_persisted`,
  `no_progress_contention`, `failed`.

## Implementato e merged

### Corpus #695 — state-advance artifact

- Merge `f9332b14...` il 2026-09-01 01:16:43Z.
- Trasporta il contratto di avanzamento stato necessario al true-final.
- Il primo run valido deve partire da una revisione corpus che lo contenga.

### Site #6887 — output `final_commit`

- PR: https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6887
- Head approvata `e541eb68c0b09e7a6e8d12a03fec40f988bd57ce`.
- Merge `2179bb5b6e90ea26de310b58831dd6b090cbc568`, 2026-09-01 01:59:27Z.
- Il grouped-isolated helper emette `final_commit` in `GITHUB_OUTPUT` solo dopo
  push riuscito; no-op e contention non emettono SHA.
- Test locali/reviewer verdi; CI e review remota exact-HEAD `## LGTM`; auto-merge.

### Site #6894 — memory/identity/journal v2 puri

- PR: https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6894
- Head `43ac7e22f5bb5ffb61633d3ddaf5a61df3742c78`.
- Merge `ba523543c90f094994e158b3a666dc71af533a7f`, 2026-09-01 03:35:15Z.
- Nuovi moduli:
  `translation-unit-identity-v2.mjs`,
  `content-addressed-translation-memory-v2.mjs`,
  `translation-journal-v2.mjs` e due suite.
- Due finding corretti prima del merge:
  1. eventId collidente su cicli delete/re-add ripetuti -> sequence contigua;
  2. merge validated/rejected order-dependent -> merge commutativo e conflitto
     esplicito.
- 42/42 test mirati v2+regressioni v1; CI verde; remote LGTM; auto-merge.

### Site #6902 — replay journal canonico

- PR: https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6902
- Head `2b11da311d20b35f48fb692467a9aa6d345b5ad8`.
- Merge `38f0ac23822b27d3d9b540395508543ea6c2eb4a`, 2026-09-01 04:15:08Z.
- Corretto P1 post-#6894: lo stesso event set interleavato diversamente produceva
  byte diversi e non accettava eventi dello stesso attempt fuori ordine.
- Ora shape validation, dedup e occurrence conflict precedono sort canonico
  `(attemptKey, sequence, eventId)` e replay causale.
- 16/16 test fixer, 5/5 reviewer; doppia review locale P0-P2 pulita; CI e review
  remota exact-HEAD Important 0 + `## LGTM`; auto-merge.

## Attivita' completata — reducer derived-only v2

Owner subagent: `/root/implement_derived_translation_reducer_v2` (`bl-fixer`,
Sol/high per gli invarianti anti-corruzione).

- Worktree:
  `frontaliere-si-o-no/.claude/worktrees/codex/translation-derived-reducer-v2`
- Branch: `codex/translation-derived-reducer-v2`
- Base al checkpoint: site `09f7696af1665bb7760add0718073458426a351c`.
- Stato alle 06:30 CEST: freeze locale pulito e riallineato all'ultimo
  `origin/main`; HEAD `98494833c2344b5a1db405556ac4bbd2eab5b0f8`
  (commit feature `b76dd0241741` + merge main). Quattro file nuovi soltanto:
  `translation-derived-{patch,reducer}-v2.mjs` e due suite omonime.
- Test mirati v2+v1 64/64 verdi; `node --check` e `git diff --check` verdi;
  GitNexus `detect_changes`: 4 file, risk LOW, 0 processi.
- Nessun push/PR ancora: il primo push e' stato fermato dal sibling gate per 75
  candidati lessicali. Il subagent li sta classificando per-file e usera'
  `--no-verify` solo dopo aver documentato i falsi positivi nel body, come
  previsto dalle istruzioni del repo.
- Finding orchestratore P1 prima del push: il reducer richiedeva envelope con
  chiavi esatte `{crawlerKey,jobs}`, mentre i real active slice includono almeno
  `assembledAt` e possono avere metadata. In produzione avrebbe lanciato prima
  di restituire un outcome. Fix richiesto sullo stesso branch: validare solo i
  campi necessari, preservare tutte le chiavi envelope e aggiungere fixture
  realistica. Richiesto anche source-copy check coerente con CRLF/NFC e
  whitespace per impedire che la sorgente con soli spazi diversi venga applicata
  come traduzione. Push sospeso fino a nuovo freeze/test.
- Race documentata: PR site #6906 e auto-merge sono stati aperti sulla vecchia
  HEAD `98494833c2344b5a1db405556ac4bbd2eab5b0f8` pochi secondi prima che lo STOP
  raggiungesse il subagent. La CI iniziale e' da considerare obsoleta. Il
  subagent sta correggendo entrambi i finding sulla stessa branch/PR; non
  approvare o valutare #6906 finche' non comunica una nuova exact HEAD e i test
  post-fix.
- P1 risolto e pushato sulla stessa PR #6906. Nuova exact HEAD
  `5268858ad65155e5cf5c14647b7fd0b774c91568`: envelope esteso accettato ma
  richiede `crawlerKey/jobs`, metadata `assembledAt/generation/checksum`
  preservati in apply e no-op; confronto source-copy uniforme NFC/CRLF +
  trim/collasso whitespace per slot e candidate.
- Verifica post-fix: suite v1+v2 66/66 (23 reducer/patch), `node --check` e
  diff check verdi, GitNexus LOW/0. PR mergeable, CI GitHub in corso; review
  locali completate sulla HEAD `5268858...`; la review remota/CI non puo' ancora
  essere considerata conclusiva. Auto-merge armato, mai merge manuale.
- Review generale sulla HEAD `5268858...`: warning bloccante di efficienza. Il
  reducer clona e congela l'intera slice per ogni patch/no-op, producendo costo
  `O(numero patch * dimensione slice)`. Correzione richiesta prima del merge:
  API batch bounded (target iniziale <=250 job bundle/patch), una sola clone e
  un solo deep-freeze per slice, outcome deterministico per ogni patch; il futuro
  drainer deve usare questa API batch.
- Review JS/TS sulla stessa HEAD: P1 riprodotto. Una mappa locale ereditata dal
  prototype passa la validazione e la scrittura puo' mutare `Object.prototype`.
  Correzione obbligatoria con lettura own-property e test di prototype pollution.
  P2: envelope estesi con `Map`/`Date` restano mutabili nonostante `Object.freeze`;
  il confine del reducer deve essere esplicitamente JSON-only e validato prima
  del clone/apply, con regressioni per valori non JSON/ciclici.
- Il warning review su delete -> re-add identico e' una decisione di contratto,
  non una resurrection: stesso URL/key/source/context identifica lo stesso target
  logico e puo' riusare a costo zero la traduzione valida. Il reducer non crea mai
  record: target assente -> `target_absent`; re-add con URL/ID o contesto cambiato
  richiede una nuova patch. La distinzione deve essere resa eseguibile con test e
  documentata nella PR prima della nuova review.
- Stato merge: **bloccato sulla HEAD `5268858...`** finche' il subagent non
  consegna i tre fix/test sopra, un nuovo exact HEAD e i controlli mirati verdi.
  Dopo ogni push vanno ripetute entrambe le review obbligatorie e il ciclo remoto
  exact-HEAD; nessun finding P0-P2 puo' essere differito. Alle 06:38 CEST
  l'auto-merge e' stato esplicitamente disarmato per impedire che la CI della
  HEAD difettosa la unisse; va riarmato solo dopo il nuovo freeze pulito.
- Ack subagent 06:40 CEST: tutti i cinque punti sono stati recepiti; CI/review
  della HEAD `5268858...` sono dichiarate obsolete. Refactor in corso con batch
  `<=250`, una clone/deep-freeze, JSON-only pre-clone, own-properties e test
  prototype/batch/delete-readd. Nessun push previsto prima di suite e
  `detect_changes` verdi.
- Nuovo freeze **solo locale**, non ancora pushato, 06:45 CEST: HEAD
  `51b90e1897c09e2aaa7c7abe3eba744e7bc3d857`, che include il commit feature
  `6ee67e506bf` e un merge dell'hot main `f36571c36317`. Il PR diff contro quel
  main resta esattamente di quattro file nuovi (patch, reducer e due test), 898
  righe; nessun data/crawler/runtime nel diff della PR. Il grande `git show` del
  merge contiene solo gli aggiornamenti crawler gia' presenti su main e non e'
  scope della feature.
- Risultati dichiarati sul freeze locale: v1+v2 69/69 (26 dedicati),
  `node --check`, `git diff --check` verdi, GitNexus LOW/0. `typecheck:gate`
  locale non eseguibile nel worktree sparse per il noto file data non
  materializzato; dovra' essere provato dalla CI completa.
- Implementazione nel freeze: own-only per chiavi/URL/source/context/mappe,
  boundary JSON-only prima del clone, batch bounded `<=250` con una clone e un
  freeze per slice, single delegato, outcome sequenziali; stesso logical re-add
  riusa, URL/ID ruotato richiede fresh patch. `/root` ha fermato il push per
  effettuare l'ispezione orchestratore dell'exact diff; auto-merge resta off.
- Verifica orchestratore sul freeze: scope 4 file e node/diff check confermati;
  ripetuti 64 test core verdi. Il comando del subagent aggiunge i 5 test shadow
  planner e produce 69/69; comando exact ora registrato nel suo messaggio.
- Nuovi finding pre-push 06:47 CEST: (A) nonostante una sola clone, la ricerca
  target scandiva ancora tutti i job per ogni patch, quindi restava
  `O(patch * slice)`; richiesto indice jobKey costruito una volta per batch.
  (B) il check di densita' usava `Array.from({length})`, con rischio di enorme
  allocazione su sparse array ostile; richiesto confronto own-index-count prima
  dell'iterazione e test `length=0xffffffff`. (C) batch vuoti devono essere
  rifiutati (contratto 1..250) per evitare clone/freeze inutile. (D) titolo test
  delete/re-add da rendere coerente con reuse identico e fresh dopo rotazione.
  Questi punti sono stati assegnati; il freeze `51b90e1...` resta locale e non
  approvato al push.
- Secondo freeze locale 06:49 CEST, ancora non pushato: HEAD
  `5eadb27666ffe795c5702df358a481f4ffb1258a`. A-D implementati: indice
  jobKey una volta/batch, densita' senza allocazione da length, batch 1..250 e
  semantica delete/re-add nominata correttamente. Suite exact ora 71/71 (23
  reducer), node/diff verdi, GitNexus LOW/0. L'ispezione `/root` ha confermato
  il cambio ma ha trovato un ultimo own-boundary: la costruzione indice leggeva
  `mutableSlice.jobs` senza verificare che fosse own, quindi una slice malformata
  poteva far scandire un array ereditato da `Object.prototype`. Own-check e
  regressione richiesti prima di autorizzare il push; auto-merge sempre off.
- Freeze locale approvato al push 06:51 CEST: HEAD
  `1e33b512c7460c3bacb2f5ae4180c149c90051d2`. L'ultimo own-check e' coperto da
  una regressione con `Object.prototype.jobs` Proxy non leggibile e crawlerKey
  ereditato; il reducer restituisce `malformed_target` senza acquisirli.
  `/root` ha ripetuto il comando exact completo: 7 file, **72/72** test verdi
  (inclusi 24 reducer), oltre a node/diff check. Push/body #6906 autorizzati;
  auto-merge resta vietato finche' doppia review e CI/review remota sulla nuova
  exact HEAD non sono pulite.
- Push completato: PR #6906 remote exact HEAD
  `1e33b512c7460c3bacb2f5ae4180c149c90051d2`, OPEN/BLOCKED, CI current-head
  IN_PROGRESS, auto-merge off. Body aggiornato con fix, false-positive del
  sibling gate e typecheck sparse delegato alla CI. Un `## LGTM` visibile su
  `5268858...` e' **obsoleto** e non vale per questa HEAD.
- Doppia review obbligatoria rilanciata sull'exact HEAD: agenti
  `review_derived_reducer_v2_general` e `review_derived_reducer_v2_js`. Devono
  restituire CLEAN sui P0-P2; qualsiasi push successivo invalida review e CI e
  richiede un nuovo ciclo.
- Review generale exact `1e33b5...`: **CLEAN P0-P2**, 29/29 test mirati; ha
  ratificato cache reuse su logical re-add identico e fresh patch su rotazione.
- Review JS exact `1e33b5...`: precedenti P1/P2 risolti, ma nuovo **P2
  bloccante** riprodotto. Un envelope JSON aciclico annidato ~12.000 livelli fa
  esplodere la ricorsione di `assertJsonData` (e poi del deep-freeze) con
  `RangeError`, anziche' fallire controllatamente. Richiesto depth cap
  esplicito prima del clone, test deep acyclic e TypeError deterministico.
  Subagent riattivato; la CI e la review generale sulla HEAD corrente diventano
  obsolete al prossimo push. Auto-merge resta off.
- Fix depth pushato: nuovo remote exact HEAD PR #6906
  `cfb5be2772348f38b0316ba0ce9719a033cfcec9`. Boundary JSON depth massima 128,
  rifiuto TypeError prima del clone e regressione aciclica 12.000 livelli;
  auto-merge off, CI current-head in corso. `/root` ha ispezionato il commit e
  ripetuto **73/73** test exact verdi + node/diff check. Entrambe le review
  obbligatorie sono state rilanciate sulla nuova HEAD; ogni LGTM precedente e'
  obsoleto.
- Doppia review exact `cfb5be...` conclusa **CLEAN P0-P2**. General: 30/30;
  JS: boundary manuale depth 128 accettata/129 TypeError, zero clone sul reject,
  30/30. Nessun finding residuo locale.
- Gate remoto: run CI iniziale `33471777595` cancellato dal ciclo di sync/body;
  run sostitutivo `33471852534` IN_PROGRESS sulla medesima exact HEAD. Review
  automation visibile resta solo il vecchio LGTM su `5268858...`; attendere il
  nuovo `## LGTM` exact prima di riarmare auto-merge. Origin/main e' avanzato a
  `871becbeaf89`; PR risulta MERGEABLE ma BLOCKED.
- Chiusura finale: CI sostitutiva `33471852534` SUCCESS (tsc, assemble+migrate,
  related vitest); review automation exact `cfb5be...` con Important 0/Nit 0 e
  `## LGTM`. Auto-merge squash riarmato soltanto dopo questi gate.
- PR #6906 merged 2026-09-01 05:06:41Z; final head
  `cfb5be2772348f38b0316ba0ce9719a033cfcec9`, merge commit
  `c291c8d87807f0cd2a6d217f29c5011a7a210419`. Fetch e
  `merge-base --is-ancestor` verdi; al checkpoint `origin/main` e' esattamente
  il merge commit. Diff finale: quattro file nuovi, 1.034 righe; nessun file
  crawler/data/runtime/writer.
- Cleanup conservativo completato: worktree era clean e i quattro file erano
  byte-identici al merge squash su origin/main; rimossi soltanto worktree
  `.claude/worktrees/codex/translation-derived-reducer-v2` e branch locale
  `codex/translation-derived-reducer-v2`. Branch remoto e altri worktree non
  toccati. La prossima implementazione del filone e' PR3.
- Ownership prevista: massimo 4-5 file, nuovi moduli patch/reducer e test.
- Vietati: runtime, workflow, crawler, data, writer Git, expired mutations.

Contratto assegnato:

- patch strict/immutable/canonica e hashata;
- target `crawlerKey + resolveJobDiffKey` con guard URL;
- candidate/attempt verificabili da identity v2, engine/gate version e output hash;
- reducer puro su active slice `{crawlerKey,jobs}`;
- exact target, collisioni multiple fail-closed, nessuna mutation input;
- recompute identity dalla sorgente corrente (`title`/`description`, sourceLang,
  company/location) e confronto source/context/locale;
- outcome distinti: `target_absent`, `ambiguous_target`, `stale_target`,
  `stale_source`, `already_valid`, `rejected_candidate`, `malformed_target`,
  `applied` (nomi razionalizzabili senza perdere informazione);
- `applied` solo su slot target mancante/vuoto/source-copy; output vuoto o
  source-copy rifiutato; traduzione differente esistente preservata;
- idempotenza: seconda applicazione -> `already_valid`;
- test anti-resurrection, URL rotation, duplicate key, malformed maps, source/
  locale/context stale, tamper, canonicalita', immutabilita' e preservazione
  deep di tutti i primary/altre locale.

Passi di chiusura quando il subagent risponde:

1. Verificare implementazione batch a una clone/slice, own-property/JSON-only e
   casi delete/re-add espliciti; nessun wiring/runtime/data.
2. Verificare worktree pulito, diff e numero file; poi test mirati,
   `node --check`, `git diff --check`, PII e
   GitNexus/detect_changes (o documentare indice stale).
3. Aprire/controllare PR e exact HEAD.
4. Lanciare `code-reviewer` e `typescript-reviewer` proporzionati; correggere
   P0-P2 sulla stessa PR.
5. Attendere CI e review remota exact-HEAD con `## LGTM`; solo auto-merge.
6. Verificare merge commit/ancestry, worktree clean, poi rimuovere worktree e
   branch locale in modo esplicito.
7. Aggiornare questo ledger con PR/head/merge/test/finding.

## Roadmap micro dopo il reducer

### PR3 — store Git sharded e drainer

Stato 07:08 CEST: incarico avviato sullo stesso subagent Sol/high che ha chiuso
#6906; nessun worktree/design/edit/PR ancora comunicato. Branch richiesto
`codex/translation-state-drainer-v2` da latest hot main. Ownership limitata a
nuovi moduli store/drainer, test bare-remote e CLI soltanto se indispensabile;
workflow, crawler, data e legacy engine vietati. Il subagent deve presentare il
design basato sui contratti reali prima degli edit e fermarsi se repo/ref/writer
scope richiede una scelta architetturale diversa.

Design pre-edit ricevuto e ratificato alle 07:18 CEST:

- Worktree `frontaliere-si-o-no/.claude/worktrees/codex/translation-state-drainer-v2`,
  branch omonima, base iniziale `ea224a1c8605`; pulito e senza edit al design
  freeze. GitNexus sui nuovi simboli resta stale, direct analysis LOW.
- Ownership ora massimo 6 file: nuovi store/drainer + due test e l'estensione
  backward-compatible di `translation-journal-v2.mjs` + test. Nessuna CLI finche'
  non indispensabile, nessun workflow/data/crawler/legacy.
- Ref default solo `refs/heads/translation-state-v2`, state-only/orphan,
  main/tags rifiutati. Layout content-addressed bounded per patch, candidate,
  evento journal, queue, publish-intent e ack; max artifact 1 MiB e batch 1..250.
  Checkpoint bulk patch+memory+journal+queue in un unico CAS state commit.
- Main writer: private index dal fresh remote main, hash/update-index/write-tree/
  commit-tree, push non-force; su reject fetch e rebuild. Intent durable prima
  del push; semantic verify e latest-main recheck prima dell'ack. Crash recovery
  deve riconoscere un proposed commit gia' ancestor senza duplicarlo.
- Decisione `/root`: ack exact-outcome, evento lifecycle e queue removal devono
  essere atomici nello stesso state-ref CAS. Non lasciare lifecycle `queued`.
  Journal v2 esteso con `already_valid`, `stale_target`, `ambiguous_target`,
  `rejected_candidate`, `malformed_target`; `queued` transisce in ogni outcome.
  Retry ammesso con stesso candidate per stale-target/ambiguous/malformed e per
  applied/already-valid se il derivato sparisce; stale-source e rejected-candidate
  terminali, target-absent -> missing resta per re-add.
- `slicePath` esplicito ratificato, allowlist solo
  `data/jobs/by-crawler/<safe>.json`, no traversal/expired e lettura dal Git
  object fresh main, non dal working tree. Tutte le patch batch devono riferirsi
  alla stessa slice/crawler; path persiste in queue/intent/ack.
- Se main avanza dopo il publish, il recovery rivaluta il latest main: non puo'
  ackare falsamente `applied` se il target e' diventato stale/absent. Test
  bare-remote con due writer, crash stages e p95 reale <2s restano obbligatori.
- Dirty checkpoint 07:28 CEST: journal+test modificati; nuovi
  `translation-state-store-v2.mjs` e relativo test presenti ma untracked;
  drainer/test non ancora creati. HEAD base `ea224a1c8605`, nessun commit/push.
- Dirty checkpoint 07:35 CEST, ownership ancora esattamente 6 file: implementati
  outcome/retry journal, store state sharded con queue/memory/patch/intent e ACK
  immutabili content-addressed multipli, binding/hash/path fail-closed e CAS
  atomico ACK+evento+queue removal. Il drainer rivalida su fresh main e rimette
  in queue quando il derived precedentemente valido sparisce. Aggiunte
  regressioni su doppio ACK immutabile e derived-disappearance. `node --check`
  store/drainer verde; journal+store 25/25 verdi. Resta da rilanciare il test
  bare-remote drainer (~70s), poi audit/detect/review. Nessun blocker, commit o
  push.
- Freeze staged pre-review 07:47 CEST: base riallineata fast-forward a hot main
  `de9a876bdecd3d502d5f5ec7ebdcb1ea02fe8eed`; esattamente i 6 file ownership
  staged, nessun commit/push. Suite integrata identity/memory/journal/reducer/
  store/drainer 108/108 verde (drainer 15 test); benchmark bare-remote 20 sample
  p95 fetch->push **599,4 ms**, ampiamente sotto il gate 2s. `node --check` sui 3
  moduli, diff check e PII scan sui 6 file verdi. GitNexus detect staged vede 6
  file ma 0 simboli/processi per indice stale; call-site direct `rg` verificati.
  Review JS ha trovato un solo problema di compatibilita' ES2022 (`toSorted`),
  gia' corretto in `[...samples].sort`; review JS e general sono ripartite sulla
  versione corretta. Serve rerun exact post-fix e doppio CLEAN prima del commit.
- Review general PR3 ha poi bloccato il freeze con **2 P1 + 1 P2**, tutti
  confermati e nessuno spinto: (P1) un batch ACK misto terminale/recoverable
  rimetteva in queue anche il subset terminale; (P1) retry invariati
  stale/ambiguous/malformed consumavano eventi journal fino al cap; (P2) intent
  completo duplicato N volte e lettura ACK fino a 250 snapshot/fetch. Fix
  ratificato: requeue solo recoverable realmente cambiati, no nuovo ciclo
  journal/ACK per outcome invariato, intent canonico unico `by-hash` con pointer
  piccoli `by-patch`, lettura ACK batch da un solo state tip. Richiesti test
  mixed-batch, replay ripetuto, layout/costo lineare e crash tra ack/requeue o
  recovery equivalente. Lo staging deve essere riallineato (status corrente
  `AM` per fix post-stage), poi rerun exact e doppia review CLEAN. Nessun commit/
  push.
- JS review del vecchio freeze PR3: REQUEST CHANGES con 4 high + 2 medium,
  anch'essa invalidata e nessun codice spinto. High: intent non ancora pubblicato
  interpretato come assente da un clone fresco; ref state preesistente non
  provato state-only; ACK letti da snapshot diversi; re-add dopo `target_absent`
  con outcome mutato non aggiornato. Medium: subprocess Git senza timeout e race
  CAS nel test non deterministica. Correzioni dichiarate nel working state:
  `cat-file` distingue intent unpushed, test clone fresco; marker/tree/root
  orphan + catena single-parent validano il ref; ACK batch da un tip; requeue su
  outcome cambiato con test stale re-add; timeout Git 30s e barrier CAS
  deterministica. Include anche fix general (subset, replay invariato, intent
  unico/pointer). Rerun exact ora 111 test in corso; obbligatorie due nuove review
  CLEAN sul freeze finale. Nessun commit/push.
- Nuovo freeze PR3 staged (non commit) 08:08 CEST: tutti i fix sopra inclusi;
  **111/111** test verdi, p95 bare-remote **751,5 ms**, node/diff/PII/GitNexus
  detect verdi. Base/HEAD resta `de9a876bdecd` ed e' ormai dietro hot main: non
  aprire PR da questo stato. Le due rereview non sono ancora partite solo per i
  due slot occupati dalle review #6876; nessun blocker funzionale comunicato e
  nessun commit/push.
- Evoluzione PR3 09:09 CEST: dopo riallineamento a hot main e correzione della
  race finale, exact clean HEAD
  `ce3b561d3d1c304c2220bf02934ff3db7c9f03b0`, base
  `e7a29d3b67483d2a3bd68fd8815d8146a9a1e4bf`, esattamente 6 file e nessun
  push/PR. Ogni tentativo usa un unico fresh state tip; il recovery restituisce
  uno stato discriminato `recovered`/`needs_apply`/`absent`; un ACK recovered o
  no-write e' ammesso solo dopo aver provato che il remote tip e' ancora quello
  stesso. Se cambia, il loop bounded riparte e conserva `publishedCommit` e
  intent del proposal gia' pubblicato. Il post-push riusa lo stesso helper.
  Regressione deterministica sulla corsa presente. Suite completa **114/114**,
  benchmark bare-remote p95 **1.080,5 ms**, node/diff/PII clean. Review
  generalista e JS/TS indipendenti sono in corso sulla stessa exact HEAD; push
  e PR restano vietati fino a doppio CLEAN.
- TS review sulla stessa HEAD ha trovato un nuovo **P1**: in un checkout shallow
  fresco, `fetchTip()` non scarica la history se il tip e' gia' presente;
  l'oggetto di un `proposedCommit` pubblicato ma piu' vecchio della shallow
  boundary puo' quindi mancare e venire scambiato per intent non pubblicato,
  perdendo `publishedCommit`/`intentHash` nell'ACK. General CLEAN e freeze
  `ce3b561d` sono invalidati. Fix ratificato: fetch exact SHA; se il server non
  lo consente, fallback raro a unshallow blobless del main; errore di espansione
  fail-closed, mentre solo una history completa che non contiene il commit prova
  l'intent unpushed. Richiesti test depth=1 `file://`, fallback SHA rifiutato e
  failure fail-closed; poi nuova suite/benchmark e doppia review exact.
- Freeze post-P1 e hot-main 09:33 CEST: exact clean HEAD
  `63beec083da4482e3d9cded0197ee027078daaff`, base/origin-main
  `9f88f35611cc9721e627dc707d820eb89aa6caf9`, 6 file. Tre regressioni shallow
  provano: provenance pubblicata recuperata via unshallow; intent davvero
  unpushed da depth=1 ripubblicato con nuova provenance; errore unshallow
  fail-closed senza ACK. Suite **117/117**, bare-remote p95 **1.192,5 ms**,
  node/diff/PII e GitNexus LOW verdi. General e JS/TS review exact riavviate;
  ancora nessun push/PR.
- Le review su `63beec08` hanno trovato altri due casi concorrenti reali e hanno
  invalidato il freeze: **P2** recovery intent ordinato per hash, che in un
  secondo ciclo requeue poteva attribuire l'ACK al vecchio publish invece che al
  piu' recente; **P1** outcome retained classificato una sola volta, che dopo un
  advance di main durante il drain del sibling poteva lasciare fuori coda una
  patch nuovamente applicabile. Fix ratificati: scegliere l'unico publish
  massimale per ancestry (`merge-base --independent`, incomparabili fail-closed)
  e, dopo l'ACK di ogni active subset, auditare l'intero requested batch su un
  tip fresco/stabile, requeueando solo i nuovi stale in round successivi entro
  un unico budget bounded. Richieste regressioni two-publish/requeue e mixed
  retained+sibling con main advance. Nessun push.

- Ref dedicato `translation-state-v2`; memory/journal shardati.
- Checkpoint periodico per non perdere 30-100 minuti di inferenza.
- Writer main separato dal generatore; micro-batch derived-only.
- Re-fetch main prima di ogni apply; rivalutare target/source/URL.
- Retry su non-fast-forward ricostruendo il commit dal main fresco.
- Ack journal solo dopo verifica semantica del commit pubblicato.
- Test con bare remote e writer concorrente:
  rejection ref, retry, crash prima/dopo push e prima ack, HEAD che avanza,
  zero patch perse, nessuna resurrection, CAS p95 locale <2s.
- Evitare append singolo O(n^2) su journal grande: introdurre bulk append o shard
  sufficientemente piccoli e misurare, non ottimizzare alla cieca.

### PR4 — scheduler completion-first e negative cache

- Design read-only completato e ratificato. Ownership finale massima prevista:
  scheduler puro/test piu' estensione store/test dopo il merge PR3; workflow,
  generatori legacy, crawler, dati e Phase 2b restano invariati.
- Implementazione pura avviata in parallelo su latest main nel branch
  `codex/translation-completion-scheduler-v2`, con ownership esclusiva dei due
  nuovi file `scripts/lib/translation-completion-scheduler-v2.mjs` e
  `tests/translation-completion-scheduler-v2.test.ts`. Nessun push/PR prima del
  merge PR3 e della successiva integrazione store.
- API pure pianificate: create/validate cursor, plan e settle. Piano attivo
  riproducibile byte-identico dopo crash; job bundle atomici, massimo 250 unita';
  cursor/pivot separati per completion lane e fairness cumulativa 1/5.
- Identita' occurrence del target separata dall'attempt memory. Exact validated
  hit -> reuse; miss -> generate; exact rejected/negative cache e candidati in
  conflitto -> quarantena fail-closed. Delete/re-add non ricrea target assenti,
  ma puo' riusare una memory valida identica con nuova patch legata al target.
- Completion order: minore generation distance, minori unita' residue, eta' e
  rotazione deterministica. Metriche del planner sono predittive; `jobsCompleted`
  aumenta soltanto dopo ACK semantico di tutte le unita' del job sul main fresco.
- Freeze puro locale 09:32 CEST: exact clean HEAD
  `855bdac4eba205fe83e70ee2fc94e3c498aee4b6`, base `e7a29d3...`, soltanto i
  due file nuovi, +1.299 righe; 31/31 suite translation-v2 (13 scheduler),
  `node --check`, tsc mirato, diff check e GitNexus LOW verdi. Root review ha
  corretto prima delle review formali due mismatch: URL exact-target non viene
  piu' riscritto da `URL.href` (root-vs-slash resta occurrence diversa) e
  `slicePath` usa la stessa allowlist esatta dello store. Commit riclassificato
  `chore(translations)` per non generare una WhatsNew entry user-facing estranea.
  Nessun push/PR/rebase; restano code-reviewer e JS/TS review exact, poi rebase e
  integrazione store soltanto dopo il merge PR3.
- TS review sul freeze `855bdac4` ha trovato un **P2**: la deserializzazione del
  settlement ricalcolava tutti i metrici salvo `queueJobsOut`/`queueUnitsOut`,
  permettendo a un artifact re-hashato di dichiarare falsamente backlog zero.
  Freeze e review general concorrente invalidati. Fix ratificato: persistere
  anche queue input nel settlement e provare `out = in - completed` dai singoli
  outcome, con test di tampering; amend sui soli due file, poi doppia review.
- Nuovo freeze post-P2: exact clean HEAD
  `8a988dd42b8afa4b837d32802723ed3ce1909bf4`, ancora due soli file. Settlement
  include `queueJobsIn`/`queueUnitsIn`; il validator ricalcola completed job/unit
  dagli outcome e prova `out = in - completed`. Quattro artifact rihashati con
  tampering su input/output vengono respinti. 31/31 test, node/tsc/diff/GitNexus
  verdi; rereview JS/TS avviata, general da riavviare dopo il reviewer PR3.
- JS/TS review di `8a988dd4` e' CLEAN, ma la review general ha riprodotto due
  ulteriori problemi e invalida comunque il freeze. **P1 fairness:** con
  capacita' 5, quattro bundle completion da 1 lasciavano un solo slot e la lane
  fairness saltava per sempre il job piu' vecchio da 2 scegliendo un giovane da
  1, poi azzerava il credito. **P2 settlement:** input/output backlog potevano
  essere falsificati insieme e rihashati perche' il validator non aveva il piano
  originario. Fix ratificati: quando fairness e' dovuta non saltare il suo head;
  se non entra, chiudere il piano conservando credito 4, e fallire chiaramente
  sui bundle feasible piu' grandi di `maxUnits`. Validazione/serializzazione del
  settlement deve essere plan-aware e legare queue input al plan hash/metrics.
  Richiesti test stream continuo, oversized e tamper coordinato. Nessun push.
- Nuovo freeze post-fix 09:58 CEST: exact clean HEAD
  `ace5365eecf9d74f98cce097e7e5abed356998ea`, ancora 2 file. Fairness head
  non viene saltato: se non entra, il piano termina conservando credito 4; un
  bundle feasible oltre `maxUnits` fallisce esplicitamente. Settlement validator
  e serializer sono plan-aware e legano planHash/scope/cursor/outcome/queue input
  al piano originale. 32/32 test (14 scheduler), node/tsc/diff/GitNexus verdi;
  doppia rereview exact avviata, nessun push/PR/rebase.
- Priorita' ai job a cui mancano meno unita' per diventare completi.
- Aging/fairness per evitare starvation dei job difficili.
- Cursor e outcome persistiti: Phase 2c riparte dal punto raggiunto.
- Un rejected per la stessa tupla source/context/engine/gate non viene
  rigenerato identico; retry solo con source, engine o gate version differenti.
- Metriche: queue in/out, exact hit/miss/conflict/negative-hit, generated,
  validated/rejected/quarantined, job completati, non solo field output.

### PR5 — shadow workflow

- Integrare scanner/planner/store senza scrivere `main`.
- Mantenere le cache legacy durante shadow; nessuna cancellazione iniziale.
- Confrontare patch v2 col diff prodotto dal legacy.
- Gate: 0 primary change, 0 resurrection, overlap pass circa 0, source-stale e
  target-absent spiegati, metriche job-completi/minuto e CAS window pubblicate.
- Aggiornare il mirror corpus solo secondo `loop-sync-manifest.json`.

### PR6 — canary, cutover e feedback loop

- Kill switch `TRANSLATION_V2_APPLY=0`.
- Canary su poche company/slice; micro-batch e verifica semantica.
- Espandere solo con nessuna regressione e throughput di job completi migliore.
- Rimuovere Phase 2b dal critical path soltanto dopo evidenza shadow/canary.
- Disattivare il commit monolitico legacy soltanto quando tutti gli outcome v2
  sono durevoli, osservabili e riarmabili.
- Rollback con inverse patch condizionata sull'hash del derivato corrente; mai
  revert Git largo che possa cancellare update crawler successivi.

## Feedback loop e qualita'

Ogni run v2 deve registrare sul ref di stato:

- `baselineMainSha`, `stateGeneration`, engine/gate version;
- pending iniziali/finali e job completati;
- exact cache hit, miss, conflict, negative-cache hit;
- generated, validated, rejected, quarantined;
- patch queued, applied, already-valid, stale-source, target-absent/ambiguous;
- CAS attempts e fetch->push p50/p95;
- `lastAppliedCommit`, ancestry e semantic verification;
- campioni/hash di evidence bounded, senza PII e senza corpus monolitico.

La qualita' non e' "output prodotto". Gate minimi da versionare e misurare:

- lingua target corretta e non copia della sorgente;
- placeholder, URL, email, numeri, unita', HTML/Markdown e nomi propri preservati;
- terminologia job/company/location coerente;
- completezza semantica e assenza di hallucination/contamination;
- confronto con traduzioni gia' validate e regressioni storiche;
- conflitti mai risolti implicitamente: quarantena o engine/gate successivo.

Il loop migliora cambiando una sola dimensione versionata alla volta e
confrontando shadow/canary contro baseline. Nessuna auto-promozione di un engine
senza soglie deterministiche e rollback.

## LLM locale in GitHub Actions — decisione ancora aperta

Non installare subito un LLM per intuizione. La seconda baseline dimostra che
il problema dominante e' l'accettazione/ripetizione, non la velocita' Argos.

Se la shadow analysis mostra quarantene linguistiche che Argos non risolve:

- provare un modello open-weight piccolo e quantizzato, scaricato/cacheato nel
  runner GHA e inferito localmente (CPU), senza endpoint/API esterni;
- usarlo solo come repair tier delle quarantene, non sul corpus intero;
- retrieval locale da esempi di annunci perfettamente tradotti tramite memory
  content-addressed, senza training persistente non deterministico sul runner;
- feedback tra run tramite dataset/evidence versionati sul ref Git, non tramite
  stato effimero del runner;
- valutare shadow: incremento job completi, quality gates, tempo, memoria,
  stabilita', licenza e dimensione cache;
- adottare solo se il beneficio e' netto, ripetibile e a costo monetario zero.

Alternative da confrontare prima del fine-tuning:

1. Argos + glossario/domain memory + negative cache;
2. translation memory exact/content-context + retrieval di esempi validi;
3. quality repair deterministico per placeholder/markup/terminologia;
4. LLM locale quantizzato per soli rejected/quarantined;
5. fine-tuning/adapter persistito soltanto se GHA lo sostiene entro tempi e
   artifact Git ragionevoli. Non assumere che training a ogni run sia efficiente.

## Monitor true-final e raccolta temporale

Automation heartbeat esistente: `traduzioni-verifica-true-final`, ogni giorno
alle 18:30 Europe/Zurich, notifiche solo sui run falliti.

Regole:

- ignorare `33430387921` e `33455986103` (entrambi non eleggibili);
- non triggerare/cancellare run;
- primo run valido: corpus checkout contenente #695 e site checkout contenente
  #6887;
- verificare artifact privacy, trueFinal, state transition, `finalCommit`
  non-null e ancestor del nuovo HEAD, generation/history e outcome semantico;
- seguire 14 generazioni naturali e raccogliere tempi, backlog, completamenti,
  cache/negative-cache, delete/re-add e qualita';
- non decidere sull'LLM prima della baseline/shadow sufficiente.

Checkpoint live 09:09 CEST: il primo candidato naturale post-correzioni e'
`33475284123`, schedule, corpus head
`5dfe85b325bdc239ceb1405387a7c5bfe3833e85`; ancestry locale prova che contiene
il merge corpus #695. Il checkout sito e' riuscito alle 05:57Z, quindi dopo il
merge #6887, ma l'exact site SHA andra' estratto dal log/artifact finale. Il job
e' ancora `in_progress` in Phase 2a; non e' ancora possibile validare trueFinal,
state transition o finalCommit. Il run naturale successivo `33476945660` e'
`pending`. Nessuno dei due va cancellato o duplicato.

## Stato repository e risorse

- Site `origin/main` al checkpoint: `e7a29d3b67483d2a3bd68fd8815d8146a9a1e4bf`.
- Corpus `origin/main` locale al checkpoint:
  `4d9600c42d656179788d0212ad4ad086a950549c`.
- Main e' molto caldo per il lavoro crawler: fetch/re-align e merge-tree prima
  del push di ogni PR traduzioni.
- Il clone sito non e' shallow. Usare sparse worktree via
  `scripts/dev/fast-worktree.sh`; non fare `npm install` nei worktree.
- Dopo cleanup conservativo di worktree merged erano disponibili circa 7,8 GB.
  Non rimuovere worktree dirty/ahead o appartenenti al crawler agent.
- La root contiene modifiche/untracked di altri lavori (`.agents`, `.codex`,
  CLAUDE/agent/skill docs): non committare o ripristinare in blocco. Questo file
  e' intenzionalmente nella root condivisa e puo' restare non committato finche'
  l'owner della root decide come pubblicarlo.

## Protocollo di ripresa se la sessione viene interrotta

1. Leggere integralmente questo file, `AGENTS.md`, le istruzioni site/corpus e
   chiamare `get_goal`. Non creare un nuovo goal: questo resta `active`.
2. Controllare subito gli agenti/subtask PR3
   `/root/resume_translation_pr3_to_pr` e PR4
   `/root/resume_issue_6876_to_pr`, insieme ai worktree indicati. PR3 e' il gate
   per integrare lo store di PR4; non sovrapporre i rispettivi file.
3. Verificare dal remoto che #6887, #6894, #6902, #6906 e #6924 siano merged;
   non rifare quei cambi e non ricreare i relativi worktree.
4. Non considerare `33430387921` o `33455986103` come true-final validi. Cercare
   il primo run naturale successivo con corpus #695 e site #6887.
5. Proseguire in ordine: reducer -> store/drainer -> scheduler -> shadow ->
   canary/cutover -> feedback loop/LLM evidence gate -> rimisura 14 generazioni.
6. Parallelizzare soltanto task con ownership indipendente. Delegare ai subagent;
   `/root` revisiona diff, invarianti, risultati e big picture e serializza le
   integrazioni dipendenti.
7. Per ogni PR: test mirati, doppia review richiesta, CI/review remota sulla
   stessa HEAD, `## LGTM`, auto-merge; mai merge manuale.
8. Aggiornare questo ledger immediatamente con PR, HEAD, merge, test, finding,
   blocker, nuova misura e prossimo passo eseguibile.
9. Non marcare il goal complete finche' la definizione di successo in apertura
   non e' provata su run live. Un'interruzione di sessione non e' un blocker: il
   ledger e l'automation consentono la ripresa.

## Template minimo per i prossimi aggiornamenti

```text
Timestamp CEST:
Macro fase:
Subagent/worktree/branch:
PR / exact HEAD / base:
File e invariant ownership:
Test locali:
Review locali P0-P2:
CI remoto:
Review remota exact-HEAD:
Auto-merge / merge commit:
Misura prima -> dopo:
Finding o blocker:
Prossimo passo unico:
```
