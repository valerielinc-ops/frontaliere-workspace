# Traduzioni job — piano esecutivo, stato e handoff

Ultimo aggiornamento autorevole: 2026-09-02 06:23 CEST

Goal backend: attivo, non completo, non bloccato

Prova finale corrente: **0/14 generazioni naturali consecutive**

Questo documento e' il trackpoint durevole del goal traduzioni. Va aggiornato
dopo ogni avanzamento materiale: nuova HEAD, finding P0-P2, nuovo test/failure
injection, push, PR, review, merge, misura live, reset del digest o cambio della
prossima azione. Gli aggiornamenti devono descrivere stato verificato, non
intenzione.

Il file storico locale precedente e'
`.agents/references/translation-goal-progress.md` nel checkout workspace
principale. Contiene la cronologia estesa fino al 2026-09-01, ma e' stale e non
versionato. Per riprendere il lavoro usare prima questo documento; consultare il
vecchio ledger soltanto per la storia dettagliata delle PR iniziali.

## Definizione di successo invariata

Il processo di traduzione dei job deve essere:

- autonomo, senza revisione umana delle traduzioni;
- a costo monetario aggiuntivo zero;
- completion-first, bounded e resistente a starvation/cancellazioni;
- content-addressed, capace di riusare una traduzione valida dopo delete/re-add;
- fail-closed su CAS, replay, target stale, artifact mancanti o conflittuali;
- dotato di gate automatici per lingua, completezza, numeri, URL, token, nomi
  propri, salario, localita' e campi strutturali;
- dotato di feedback loop automatico basato soltanto su esempi validati;
- live con recovery, rollback e rollout shadow -> canary -> production;
- verificato su almeno 14 generazioni naturali consecutive dello stesso runtime
  closure digest, senza run perse e con pending convergente;
- entro il budget GitHub Actions e senza nuovi servizi/API/modelli a pagamento.

Il goal non e' completo se il codice e' soltanto mergeato. Servono evidenze
produttive sul runtime finale, recovery e rollback testati, canary e production
attivi, qualita' sopra i gate, nessun costo aggiuntivo e cleanup finale.

## Prossima azione globale univoca

Acquisire e ispezionare il freeze exact-HEAD del core runtime quando il subagent
lo consegna, senza duplicarne file o modifiche. Nell'attesa T00 continua soltanto
il monitor read-only del run manuale #54, senza dispatch. Le colonne "Prossima
azione" della tabella Txx sono code locali dei rispettivi owner, non alternative
alla prossima azione globale.

## Vincoli operativi

- `/root` orchestra, misura, ratifica e revisiona. L'implementazione delegabile
  resta ai subagent in worktree/branch separati.
- Non modificare i checkout locali `main`. Fetch e lavoro avvengono in worktree
  basati su `origin/main`.
- Massimo quattro subagent simultanei, solo su ownership non sovrapposte.
- Modello minimo sufficiente: Luna/low per inventari e verifiche; Terra/medium o
  high per fix confinati; Sol/high per workflow, CAS/replay e invarianti; Sol
  xhigh solo per architettura o audit finale.
- Prima di modificare simboli esistenti: GitNexus impact analysis. Prima del
  commit finale: `detect_changes` completato con successo.
- Ogni modifica JavaScript/TypeScript richiede review generale e review JS/TS
  indipendenti sulla stessa exact HEAD.
- Ogni PR: test locali proporzionati, CI verde, review remota con `## LGTM`
  sull'exact HEAD, auto-merge. Mai merge manuale.
- Body PR con sezioni esatte `## Implementato` e
  `## Non implementato (ancora)`; ogni residuo deve avere uno stato ammesso.
- Il confine sito/corpus e' HTTP. Nessun import diretto tra repository.
- Prima di modificare un file portabile consultare
  `frontaliere-articles/scripts/ci/loop-sync-manifest.json`.
- Non abbassare gate, timeout, validazioni o test per ottenere verde.
- Non dispatchare/cancellare/rilanciare run naturali per accelerare la prova.

## Snapshot autorevole corrente

### Merge completati

| Repository | PR | Merge / evidenza | Risultato |
|---|---:|---|---|
| sito | #6887 | `2179bb5b6e90` | osservabilita' iniziale/final commit |
| sito | #6894 | `ba523543c90f` | identity, memory e journal v2 |
| sito | #6902 | `38f0ac23822b` | replay journal canonico |
| sito | #6906 | `c291c8d87807` | reducer derived-only |
| sito | #6960 | merge verificato | identita' stabile delete/re-add |
| sito | #6984 | `bd07936ad957` | state store/drainer v2 |
| sito | #6996 | `049f3d4b360a` | `queue: max`, limite noto 100 |
| sito | #7000 | `25b6f164bbe4` | scheduler completion-first/CAS |
| sito | #6924 | `4d298d3363ad` | fix issue #6876 |
| sito | #7109 | `3d8da8e08b9f` | shadow preflight v2 |
| corpus | #720 | `c6db3f22118c` | recovery fail-closed v0, `not_live` |
| sito | #7123 | `d437da21b0d7` | quality executor/provider protocol/scheduler retry |

Per #7123: pre-merge HEAD `c87937d34ea1ef5765c2662564bf658555322020`,
CI `vitest (unit + integration)` success e review remota `## LGTM` sulla stessa
HEAD. Auto-merge SQUASH. Worktree e branch locale rimossi; branch remoto 404.

### Misura live

Snapshot API e artifact autenticati: 2026-09-02T04:20:44Z.

- Workflow corpus: id `342441975`.
- Run #53 `33570724601`: `workflow_dispatch`, HEAD `ca61108fb526`, job
  `100087920945`, completato `success`; runtime 2h59m33s. Artifact unico
  `translation-observability-33570724601` (id `9831347479`, 2492 B): nessun
  artifact `translation-shadow-preflight-v2-*`.
- Nel #53 la popolazione e' 25.274 -> 25.275, incomplete 14.075 -> 13.842,
  verified translated 7.091 -> 11.428, flagged 4.108 -> 5, drain 4.336 e ingress
  0. Pending finale 12.915, tutti `needs_retranslation`; missing IT 4.396, EN
  4.076, DE 822, FR 3.942.
- Qualita' #53: descrizioni wrong-language 15/99.370 = 0,0151%; titoli sospetti
  29.186/74.612 = 39,12%. Transizioni: flagged->complete 4.104,
  incomplete->complete 232, incomplete->flagged 1.
- L'evidenza shadow del #53 e' insufficiente: `baseline.measured=false`,
  `stateTransition.advanced=false` (`same_run_population_changed`), continuity e
  perfect reuse tutti zero, delete/re-add non osservabile e nessun contatore
  N/14. Il run tecnico riuscito non abilita shadow -> canary.
- Run #54 `33585398593`: `workflow_dispatch`, HEAD `bafd37d8ed42`, ancora
  `in_progress` alle 2026-09-02T04:20:44Z e senza artifact a quel timestamp.
- Entrambi sono manuali: non contano e non spezzano la serie naturale.
- Ultimi 20 run misurati: 6 cancellati. Recovery e ledger restano critici.
- Il contatore finale resta 0/14 finche' runtime/workflow/schema finali non sono
  live. Ogni modifica alla closure dopo l'avvio azzera la serie.

### Decisione modello locale

Decisione corrente: **non introdurre un altro modello OSS/local**.

Evidenza: il collo di bottiglia osservato e' accettazione/ripetizione/coda, non
assenza di output grezzo. Argos ha budget 150m bulk + 150m mop-up; il cascade ha
90m; il workflow 350m. Non esistono ancora 20 run con metriche per fase, memoria,
OOM, cache e quality outcome che provino il vantaggio di un altro modello.

Rivalutare soltanto dopo almeno 20 run strumentati sul runtime finale. Prima
scelta: memory/retrieval, glossario, negative cache e provider Argos esistente.
Un nuovo modello e' ammissibile solo se migliora job completati/runner-hour e
quality gate senza superare 350m/run o 60s/sample shadow e senza costi.

## Stato dei worktree attivi

### Core runtime integrato

- Worktree:
  `frontaliere-si-o-no/.claude/worktrees/feat-translation-execution-ledger-v1`
- Branch: `feat/translation-execution-ledger-v1`
- HEAD del branch prima degli edit:
  `69304b16b29185b8c63b3b3537f634c61569d8a3`.
- Base dell'attuale branch: site
  `d437da21b0d79940e20797dab6773295d3fb419f`. Non e' il main remoto corrente.
- Site `origin/main`/`ls-remote` al 2026-09-02 06:19 CEST:
  `7a3f9647e47842165aff0b870f4134ccd97213d8`; branch ahead 3/behind 10.
- Tre commit preesistenti: ledger, store CAS e successor guard con sei file.
- GitNexus full index completato sulla exact HEAD: 70.627 nodi, 153.709 edge,
  300 flow; status up-to-date.
- Baseline suite prima degli edit: 66 test, 64 pass. Un test ledger ha misurato
  3,475s contro gate 2s; un test state-store e' fallito `ENOSPC`, altri 26 sono
  passati. `ENOSPC` non e' un difetto funzionale: dopo cleanup mirato sono
  disponibili 15 GiB; entrambi i test devono essere ripetuti, e il gate ledger
  deve comunque tornare <2s senza abbassare la soglia.
- Subagent: `/root/implement_integrated_translation_runtime`, Sol/high.
- Stato: implementazione in corso, non frozen. Dirty ownership verificata:
  modificati ledger e state-store; nuovi runtime, policy e runtime test. Nessun
  commit/push/PR per questi edit. Riallineare hot main soltanto al freeze, dopo
  test e verifica semantica del merge-tree.

Ownership core consentita:

- `.github/workflows/translate-pending-logic.yml`
- `.github/workflows/deploy.yml`
- `.github/corpus-workflows/translate-pending.yml` solo rigenerato
- `.github/corpus-workflows/contract.json` solo rigenerato
- `scripts/ci/translation-execution-{ledger,store}.mjs`
- `scripts/ci/translation-successor-guard.mjs`
- `scripts/ci/translation-runtime-v2.mjs`
- `scripts/ci/translation-runtime-v2-policy.json`
- `scripts/lib/translation-state-store-v2.mjs`
- test ledger/store/guard/state-store/runtime/workflow corrispondenti.

Vietati al core: file candidate #7123, generator, provider Argos e test, crawler,
corpus repo, checkout main. Se il generator emette file aggiuntivi o serve una
permission/secret nuova, il worker deve fermarsi.

### Provider Argos v2

- Worktree:
  `frontaliere-si-o-no/.claude/worktrees/feat-translation-argos-provider-v2`
- Branch: `feat-translation-argos-provider-v2`
- Commit frozen finale:
  `50c1497bc7d8e40f835b44a200e1bb042db66623`
- File esclusivi:
  `scripts/lib/translation-argos-provider-v2.mjs`,
  `tests/translation-argos-provider-v2.test.ts`.
- API: `createTranslationArgosProviderV2`, `translateWithArgosV2`, adapter
  testabile `runArgosJsonlRequestV2`.
- Descriptor V3 frozen, `costClass=zero`, `executionClass=isolated_callback`.
- Nessun download/install: preflight offline sui modelli esistenti; child
  `python3` a parametri fissi/no shell; JSONL 1:1; stdout 512KiB e stderr 64KiB;
  timeout/abort `SIGKILL`; errori/protocollo/source-copy fail-closed.
- `node --check` e 26/26 test provider+executor verdi.
- GitNexus `detect_changes` eseguito prima dell'amend finale: 2 file,
  36 simboli, 0 processi, rischio low. PII/diff clean. Worktree clean.
- Nessun push/PR. Il core non deve riscrivere questi file: integrare il commit
  con cherry-pick soltanto dopo il freeze del core o in un punto coordinato.

### Trackpoint

- Repository root `frontaliere-workspace`, non i due repo applicativi.
- Worktree:
  `/Users/saggesel/Projects/frontaliere/.claude/worktrees/translation-goal-trackpoint`
- Branch: `codex/translation-goal-trackpoint`, base `origin/main` `b59d3983`.
- Il checkout root `main` contiene modifiche/untracked dell'utente e non deve
  essere modificato, ripulito o usato per commit.
- Questo file deve essere committato e poi aggiornato con commit incrementali o
  amend controllati. Pubblicazione remota solo con il ciclo PR previsto.

## Architettura finale ratificata

### Binding e ledger

Il caller corpus e' standalone. Prima di mutazioni:

1. risolvere il vero Git blob del caller per repository/workflow id/path/run;
2. creare o leggere locator immutable by-run;
3. fissare `sourceHeadSha`, caller blob ed `executionKey`;
4. creare locator e ledger iniziale nello stesso CAS sul ref
   `translation-execution-v1`;
5. in replay fare checkout dell'esatto `sourceHeadSha`, mai del `main` mobile.

Ogni fase conserva intent, input digest, `mainHeadBefore/After`, path posseduti
con blob before/after e terminal. Bounds ratificati: massimo 2.048 path e
512KiB di manifest; ledger 16KiB; generation record 1MiB. Locator senza ledger,
ledger senza locator, diff fuori allowlist, terminal diverso o CAS ambiguo non
riconciliabile falliscono chiusi.

Fasi sequenziali:

1. `housekeeping`
2. `translation`
3. `title_fixes`
4. `observability`
5. `slug_regeneration`
6. `complete`

### Shadow, canary e production

- Bootstrap sempre `shadow`, counter 0.
- Shadow valuta al massimo 12 unita'/60s e scrive solo ref di controllo; legacy
  resta l'unico writer main.
- Dopo 14 naturali consecutive sullo stesso digest e recovery live:
  `canary_one_job`.
- Il primo canary valido applica esattamente un job con provider zero-cost e
  almeno una unita' realmente `applied`; altrimenti resta pending/fail-closed.
- Production aumenta automaticamente i cap `4 -> 16 -> 64 -> 250`, tre
  generazioni naturali verdi per cap.
- Violazione pre-write: fallback legacy nello stesso run e reset a shadow.
- Violazione post-write: inverse patch solo se il blob corrente e' ancora
  l'after-blob atteso; altrimenti `rollback_required`, nessun overwrite.
- Phase 2b legacy viene saltata solo dopo runtime v2 riuscito in production;
  resta fallback sul residuo e sulle regressioni di backlog/velocity.

### Successor e dispatch

`complete` e successor intent sono atomici prima di qualsiasi POST.

- `no_dispatch`: receipt locale deterministica.
- `deploy`: intent correlabile nel `run-name` del workflow deploy.
- Receipt immediata solo se risposta e run id/head/repo/path sono verificati.
- Timeout, eccezione, 204, 5xx o 2xx privo di receipt: ambiguous.
- 4xx: rejected.
- Intent senza receipt: soltanto GET reconciliation; `pending` non ripete POST;
  `found` salva receipt CAS.
- Massimo un POST per intent.

### Feedback loop e quality

Generation record canonico, senza testo candidato o PII, con:

- binding e digest closure/policy/schema/plan/settlement/ledger/data;
- mode before/executed/next e cap;
- eligibility naturale e reason code;
- scheduler incl. pivot missing, fairness deferred e near-empty;
- outcome quality/retry/reject con shape completa, inclusi zeri;
- exact memory hit/miss/conflict e state commit before/after;
- main writes, owned digest e rollback;
- dispatch intent/receipt;
- durata Argos/cascade/runtime, queue in/out, oldest age;
- stato recovery/caller blob/capability/probe receipt.

Una traduzione shadow non passa implicitamente in production: ref distinti e
revalidazione obbligatoria. Gli esempi incrementali entrano nella memory solo
dopo validazione automatica completa.

## Piano esecutivo atomico

| ID | Subissue | Repository/ownership | Stato | Successo verificabile | Prossima azione |
|---|---|---|---|---|---|
| T00 | Snapshot, follow-up e metriche live | read-only | #53 auditato; #54 in monitor | ID/SHA/date/denominatori | poll #54 senza dispatch |
| T01 | Quality executor/memory/provider protocol | sito #7123 | merged | CI+LGTM+auto-merge exact | nessuna |
| T02 | Provider Argos offline zero-cost | 2 file provider/test | frozen locale | 26/26, detect low, no download | integrare nel core |
| T03 | Ledger/store/successor primitive | 6 file core | in modifica, non frozen | CAS/replay test | estendere bounds/wiring e rifare freeze |
| T04 | Runtime closure, policy e state machine | runtime/policy/test | in corso | failure matrix e digest reset | implementare |
| T05 | State lineage immutabile | state-store/test | in corso | single+double deletion/history fail | implementare/testare |
| T06 | Scheduler follow-up #7097 pivot | runtime metrics/test | aperto | pivot missing osservabile | includere T04 |
| T07 | Scheduler follow-up #7098 fairness | runtime/state test | aperto | CAS cross-generation, rollback near-empty | includere T04 |
| T08 | Scheduler follow-up #7099 replay gap | state-store/test | aperto | replay dopo >=3 generation idempotente | includere T05 |
| T09 | Runtime wiring #7096 | workflow/runtime | aperto | shadow stesso snapshot, main byte-identico | includere T04/T10 |
| T10 | Workflow translate/deploy | 2 source + generated | in corso | permissions invarianti, parity generated | implementare |
| T11 | Shadow metrics e feedback loop | runtime/state refs | aperto | record canonici, candidate main writes=0 | includere site PR |
| T12 | Canary/production/rollback automatici | runtime policy | aperto | transizioni deterministicamente testate | includere site PR |
| T13 | Doppia review locale integrated HEAD | read-only reviewer | pendente | general CLEAN + JS CLEAN exact | dopo freeze |
| T14 | PR sito integrata | sito | pendente | CI verde, remote exact LGTM, auto-merge | dopo T13 |
| T15 | Trasporto caller corpus PR A | corpus sync | pendente | caller/contract byte-identici, blob nuovo | dopo T14 |
| T16 | Prova target sul nuovo caller | produzione dry-run/naturale | pendente | locator+resume+guard manuale e scheduled | dopo T15 |
| T17 | Recovery capability v1 PR B | corpus recovery | pendente | blob pin, dedupe/guard v1, CI/LGTM | dopo T16 |
| T18 | Probe recovery post-merge | produzione | pendente | target cancellato/dry-run recuperato una volta | dopo T17 |
| T19 | 14 naturali shadow consecutive | produzione | 0/14 | stesso digest, nessun gap/cancel/fail | dopo T17 |
| T20 | Canary one-job | produzione | pendente | exact 1 job, >=1 applied, zero costo | dopo T19 |
| T21 | Ramp production | produzione | pendente | cap 4/16/64/250, 3 verdi/cap | dopo T20 |
| T22 | Audit finale requisito-per-requisito | cross-repo/read-only | pendente | tutte le prove forti presenti | dopo T21 |
| T23 | Cleanup finale | entrambi i repo | pendente | PR/worktree/branch puliti | dopo T22 |

La PR sito unica puo' contenere T03-T12. Non e' sicuro ridurre il totale a una
sola PR cross-repo: il corpus recovery e' hardcoded `not_live` e deve osservare
il nuovo caller sul default branch prima di promuovere capability. Sequenza
minima sicura: **site PR -> corpus PR A -> prova live -> corpus PR B**.

## Matrice test/failure injection obbligatoria

| Area | Prove minime |
|---|---|
| Locator/CAS | locator+ledger stesso CAS; half-state; binding mismatch; due claimant; CAS ambiguo applicato/non applicato; exhaustion |
| Phase replay | crash pre-commit, post-main-push/pre-terminal, post-terminal; trailer recovery; unowned path; bounds; terminal conflict |
| State immutability | delete memory, journal, entrambi, patch/ack/intent/plan/settlement; history rewrite; tutti fail-closed |
| Scheduler | pivot missing metric; fairness bundle deferred; credit persistito; due near-empty rollback; plan <=1MiB |
| Settlement | replay esatto dopo almeno tre generation; outcome diverso e cursor regression rifiutati |
| Quality/provider | timeout, abort, busy child, malformed/duplicate/oversized output, source copy, URL/token/numero/language gate |
| Dispatch | receipt valida; 204/timeout/5xx/exception; 4xx; crash after intent; found/pending; POST <=1 |
| Rollout | manual escluso; 13->14->canary; canary zero/multi-job reject; caps; digest reset; legacy fallback same-run |
| Rollback | exact current blob revert; foreign change freeze; ambiguous reconcile, mai retry cieco |
| Recovery | blob mismatch, v0 capability, locator replay, attempt diverso, receipt manuale+scheduled |
| Workflow | source->portable parity; contract aggiornato; permission invarianti; generated drift zero |
| Performance | ledger/store gate <2s; shadow sample <=60s; main candidate writes shadow=0; workflow <=350m |

## Errori e lezioni da non ripetere

1. **Non confondere output con progresso.** Due baseline hanno generato oltre
   20.000 output Argos ma pochi job completi. La metrica primaria e' job
   completati/runner-hour, non campi/secondo.
2. **Non contare run manuali.** #53/#54 sono `workflow_dispatch`. La serie parte
   soltanto dal runtime closure digest finale e solo su schedule canonica.
3. **`queue: max` non basta.** Il backlog e' limitato a 100 e le run cancellate
   prima del job non hanno stato target; recovery v1 resta necessaria.
4. **Testare il contratto, non dettagli runtime.** Node 22/Linux chiamava
   `MessagePort.close` anche per endpoint interni: il test globale vedeva 16
   anziche' 8. Il fix corretto conta gli 8 parent receiver, una close esplicita
   ciascuno, zero leak e zero `Worker.terminate` nel percorso error->exit.
5. **Usare mutation proof.** Il vecchio ordering d935 passava il primo test
   corretto sulle porte ma chiamava terminate 8 volte. L'asserzione zero
   terminate rende la regressione realmente rossa.
6. **Node locale non equivale al CI.** macOS/Node 26 e macOS/Node 22 possono
   ordinare `error`/`exit` diversamente da Linux/Node 22. La CI exact-head resta
   autoritativa.
7. **GitNexus puo' superare 120s.** Un timeout SIGTERM non prova corruzione.
   Usare sessione persistente e poll; verificare `status` sull'exact commit.
8. **GitNexus modifica documentazione e disco.** `analyze` puo' aggiungere un
   blocco ad `AGENTS.md`; rimuovere soltanto quel blocco con apply_patch e
   provare checksum/clean. Ogni indice pesa 1-4GiB: eliminare solo cache
   `.gitnexus` ignorate, vecchie e non attive.
9. **ENOSPC e' ambiente, ma il test va ripetuto.** Sono stati rimossi soltanto
   sette indici rigenerabili di worktree senza PR aperte; spazio 3,6->15GiB.
   Nessun worktree/branch/file tracciato e' stato eliminato.
10. **Il caller corpus e' standalone.** Cambia perche' il generator incorpora
    byte per byte la logic del sito, non per un ref reusable. Portable artifact
    e contract vanno rigenerati; il corpus deve trasportarli.
11. **Recovery non puo' essere promossa nello stesso istante del caller.** Il
    nuovo blob deve essere default-branch e provato live manuale+scheduled prima
    di cambiare `TARGET_EXECUTION_CAPABILITY` da v0 a v1.
12. **Dispatch ambiguo non si ripete.** Intent durevole prima del POST; poi solo
    GET reconciliation. Un secondo POST puo' duplicare deploy/recovery.
13. **Non riusare memory shadow in production implicitamente.** Ref distinti e
    revalidazione evitano che un candidato ipotetico diventi live senza gate.
14. **Bash per Remote Config.** `bin/rc-env.sh` va sourced con `/bin/bash`, non
    zsh. Per API GitHub usare token senza stamparlo e, quando DNS e' instabile,
    `--cacert /etc/ssl/cert.pem --resolve api.github.com:443:140.82.121.5`.
15. **Il checkout main puo' essere sporco.** Non usare reset/checkout/clean sul
    main. Ogni branch/task nasce da `origin/main` in worktree isolato.
16. **Success non equivale a evidenza shadow.** #53 ha drenato 4.336 elementi,
    ma non ha baseline, artifact shadow, state advance, continuity/replay o
    contatore N/14. Il gate resta chiuso anche con outcome tecnico verde.

## Direzione esatta per un nuovo agente

1. Leggere integralmente questo file, poi root/site/corpus `AGENTS.md` e
   `CLAUDE.md`; chiamare `get_goal`. Non creare un nuovo goal.
2. Eseguire `list_agents`. Se il core worker e' ancora running, non duplicarne
   file o test. Chiedere checkpoint e continuare su misura/trackpoint.
3. Verificare:

   ```bash
   git -C frontaliere-si-o-no/.claude/worktrees/feat-translation-execution-ledger-v1 rev-parse HEAD
   git -C frontaliere-si-o-no/.claude/worktrees/feat-translation-execution-ledger-v1 status --short --branch
   git -C frontaliere-si-o-no/.claude/worktrees/feat-translation-argos-provider-v2 rev-parse HEAD
   git -C frontaliere-si-o-no/.claude/worktrees/feat-translation-argos-provider-v2 status --short --branch
   ```

4. Prossimo passo unico corrente: attendere la consegna del core e ispezionarne
   exact HEAD, diff e test senza duplicare T04-T12. Nell'attesa fare soltanto il
   poll read-only del #54. Poi integrare con cherry-pick del solo commit provider
   `50c1497...`, eseguire suite combinata e freeze.
5. Sul freeze combinato: GitNexus `detect_changes`, sibling audit per-file, PII,
   general reviewer Sol/high e JS reviewer Terra/high. Finding P0-P2 torna al
   worker; il reviewer non corregge.
6. Soltanto doppio CLEAN: push non-force, PR site con body esatto, CI, remote
   `## LGTM` exact, auto-merge. Verificare merge/patch/file/ancestry e cleanup.
7. Continuare T15-T23 senza fermarsi dopo la PR sito.
8. Aggiornare questo file dopo ogni evento materiale usando il template sotto e
   committare il trackpoint sul branch root dedicato. Non modificare il root
   checkout main sporco.

## Protocollo di aggiornamento del trackpoint

Ogni update aggiunge una voce in testa al journal e aggiorna le righe Txx
interessate. Non riscrivere la storia per far sembrare lineare il lavoro.

Template:

```text
Timestamp CEST:
Evento materiale:
Subissue Txx:
Repo / worktree / branch:
Base / exact HEAD / PR:
Diff ownership:
Test e metriche:
Review locali:
CI / review remota / auto-merge:
Misura live prima -> dopo:
Finding, errore o lezione:
Prossima azione unica:
```

## Journal corrente

### 2026-09-02 06:23 CEST — audit artifact #53 completato

- Artifact unico di #53 verificato: observability, nessun shadow preflight.
- Drain 4.336 e verified 7.091 -> 11.428, ma pending finale 12.915.
- Baseline assente, state non avanzato, delete/re-add e continuity non
  osservabili, N/14 mancante: shadow -> canary resta fail-closed.
- #54 era ancora manuale/in progress senza artifact. Prossima azione globale:
  acquisire e revisionare il freeze core; T00 continua il solo poll read-only.

### 2026-09-02 06:20 CEST — drift audit e run #53 concluso

- Audit indipendente del trackpoint ha rilevato main remoto avanzato e core gia'
  dirty; corrette le claim prima del commit.
- Site main remoto `7a3f9647...`; core branch ahead 3/behind 10, ancora senza
  commit dei nuovi edit.
- Run manuale #53 concluso success; #54 ora in progress. Nessuno conta per le
  14 naturali. Prossima misura: audit artifact/shadow #53 senza dispatch.

### 2026-09-02 06:14 CEST — trackpoint versionato avviato

- Creato worktree root separato, branch `codex/translation-goal-trackpoint` da
  `origin/main` `b59d3983`; checkout root main sporco intatto.
- Provider Argos compliance completata su `50c1497...`.
- GitNexus core reindex completato su `69304b1`.
- Liberati 11+GiB rimuovendo solo sette cache `.gitnexus` rigenerabili e
  inattive; spazio disponibile 15GiB.
- Core autorizzato a impact/edit/test. Prossima azione: attendere freeze core,
  aggiornare T04-T12 e integrare provider.
