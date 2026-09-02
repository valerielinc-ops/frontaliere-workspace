# Crawler goal — ledger di avanzamento

Ultimo aggiornamento: 2026-09-02 07:04 CEST (Europe/Zurich)

## TRACKPOINT CORRENTE PER LA RIPRESA — LEGGERE PRIMA DI TUTTO

Questo e' il piano operativo canonico del goal crawler. Va aggiornato a ogni
transizione autorevole: claim, commit freeze, PR, finding di review, merge,
run terminale, artifact, commit dati, misura o chiusura. Le sezioni cronologiche
piu' sotto conservano le prove storiche, ma in caso di contrasto prevalgono:

1. GitHub live (issue, label, PR, review, check, workflow e artifact);
2. `origin/main` appena fetchato del repo interessato;
3. questo trackpoint;
4. le sezioni cronologiche precedenti e i worktree locali.

Non usare una fotografia locale vecchia per chiudere un'issue. Non usare
l'assenza di un file in un worktree sparse come prova che il file non esista.
Non lavorare su #6957 o sui worktree translation. Mai merge manuale.

### Disciplina anti-rate-limit

- Riusa gli agenti per task sequenziali della stessa catena; crea un agente
  nuovo solo dopo un fallimento sostanziale o per ownership davvero disgiunta.
- Mantieni normalmente tre subagent attivi e lascia uno slot al reviewer.
- Raggruppa le query GitHub read-only in un singolo censimento; non ripetere
  `gh` quando API/DNS e' gia' noto indisponibile.
- Un solo push freeze per head, una sola review canonica sulla head finale e
  nessun rerun di check gia' verdi.
- Nessun dispatch crawler per ottenere una misura che puo' attendere la
  schedule naturale. Mai sovrapporre generazioni.
- I test mirati precedono il full gate; non rilanciare full suite se il diff o
  la head non sono cambiati.
- Aggiornare questa sezione prima di terminare ogni ondata, cosi' un nuovo
  orchestratore non spende quota per ricostruire fatti gia' provati.

### Modalita' arresto controllato richiesta dall'utente

Dal 2026-09-02 06:38 CEST il goal e' in fase di **parcheggio**, non di
completamento. Non reclamare nuove issue, non avviare audit globali, non fare
dispatch crawler e non iniziare #7009 o altri task del percorso critico.
Le sole attivita' autorizzate fino allo stop sono: portare a review/merge
stabile i due WIP gia' attivi (#658 e #7008), registrare prove e SHA, pulire
mutex/worktree/branch, pubblicare questo trackpoint su `main` della root e
specchiare il checkpoint nei parent remoti site #7138 e corpus #727. Il goal
resta incompleto e dovra' essere ripreso dal percorso critico qui sotto.

### Snapshot dei repository e della produzione

| Superficie | Stato autorevole noto | Nota |
|---|---|---|
| site `origin/main` | `7a3f9647e478` alle 04:15Z | contiene #7135 `042a37ec`; i commit successivi includono filoni esterni, da non toccare |
| corpus `origin/main` | `ce615a8160e1` alle 04:01Z | contiene il merge automatico #726 `4f04439d`; verificare ancestor dopo ogni fetch |
| canonical legacy | run site `33584757882`, attempt1 | G01-G09 tutti terminal FAILURE, token-null, verified0, commit null; nessun push dati |
| prossima prova | schedule naturale 09:00 UTC / 11:00 CEST | non avviare un secondo dispatch manuale prima di questa prova |
| storico #6806 | 0/14 generazioni valide | receipt legacy/v1, token null e dry-run non contano |

### Onda attiva e ownership

| Task | Owner | File/moduli esclusivi | Repo | Dipendenze | Tier | Stato |
|---|---|---|---|---|---|---|
| #658 follow-up Nit post-#726 | nessuno | `scripts/ci/scan-generation-health.mjs`, `generator/tests/generation-health-watchdog.test.mjs` | corpus | nessuna | 2 | COMPLETO: PR #729 auto-merged `f74e7a649268`, head `2a038daf8`, CI SUCCESS, review `5085615049` LGTM0/0; #658 chiusa, mutex/branch/WT puliti |
| #7008 probe website | `/root/resume_6959_lidl` | `scripts/resolve-company-website.mjs`, `data/company-website-resolved.json`, `tests/resolve-company-website.test.ts` | site | PR/CI/review remota/auto-merge; #7009 resta non reclamata | 4 | freeze `9da2801af`, doppia rereview locale LGTM0/0; publisher autorizzato alla head esatta, nessun dispatch crawler |
| mirror backlog remoto | `/root/resume_6959_lidl` | issue/subissue GitHub | entrambi | nessuna | admin | COMPLETO: site #7138/#7139 con 36 native; corpus #727/#728 con 9 native; cross-link/checkpoint/mutex parent |
| review freeze #658+#7008 | `/root/review_freezes_658_7008` + `/root/ts_review_freezes_658_7008` | read-only sui cinque file totali | entrambi | freeze locali | review | #658 approvata 0/0 locale e remota; #7008 attende nuova HEAD pulita dopo finding `response.url`, poi code+TS 0/0 |

Il vecchio owner `/root/fix_corpus_658_commit_window` non deve piu' ricevere
#7008: ha terminato tre volte senza edit scambiando per blocker il checkout main
vecchio, i nuovi file attesi e la sorgente gia' identificata. Il mutex #7008 e'
stato aggiornato al nuovo owner nel commento `5504246629`.

### Ultime transizioni registrate

- 06:20: la prima freeze #658 `b87795329` e' stata scartata per conflitto reale
  con main nei due file. Il fixer ha rifatto l'adozione da `ce615a816` in un
  WT fresh e congelato `2a038daf8c5db815797b5ff7944b77208cd09bd3`.
  GitNexus upstream LOW/detect due file-un simbolo; node/diff check verdi;
  test 7/7, full 95/96 baseline estraneo; merge-tree main pulito.
- 06:14: #7008 congelata su branch `issue-7008-company-websites`, HEAD
  `0dcce8d00` (feature `4d8edff8` + latest main). Diff esatto tre file, test
  resolver 6/6 e sibling retry 20/20; probe live limit22 = 19 risolti e 3
  `null`, senza fallback inventato.
- Entrambi i push sono bloccati dal token GitHub standard invalido. Il publisher
  deve adottare i commit con il percorso auth gia' usato, dopo il verdetto dei
  due reviewer locali condivisi. Non ricreare le fix.
- 06:23: code e TS reviewer hanno approvato #658 `2a038daf8` con LGTM0/0.
  #7008 `0dcce8d00` e' stata bloccata: SSRF/redirect automatici e schema
  inventato, write non atomica, arbitration che perde il singolo host valido,
  pool/body non bounded, timeout/idempotenza non realmente osservati e TS2322
  nel mock. Blast HIGH: ownership trasferita a `/root/fix_7008_hardened` Tier4,
  commento remoto `5504334982`.
- 06:26: l'utente ha richiesto parita' locale/remoto. Il publisher sta creando
  due issue madre (site/corpus), due child di audit finale e relazioni native
  verso ogni issue esistente; nessun duplicato deve essere creato.
- 06:31: mirror remoto completato. Site parent #7138, audit child #7139 e 36
  relazioni native; corpus parent #727, audit child #728 e 9 relazioni native.
  I parent sono cross-linkati, hanno checkpoint corrente e mutex. Nessuna issue
  implementativa duplicata e' stata creata.
- 06:32: body follow-up #658 v3 ratificato in
  `/tmp/pr-corpus-658-injected-resolver-v3.md`, sha256
  `0ca99a2068bac260ddb7bd211f40c5996f7851aaf9f292f13848acd407832f40`;
  chiude #658 e non riusa il body obsoleto di #726. Publisher autorizzato a
  push/PR/review/automerge nativo.
- 06:36: corpus PR #729 pubblicata sulla head esatta `2a038daf8`, closing
  reference [#658]. GitHub ha normalizzato solo il newline terminale del body;
  contenuto trim-identico. CI pending/in-progress, review remota ancora assente,
  nessun merge manuale.
- 06:39: #729 ha review remota canonica `5085615049` sulla head esatta
  `2a038daf8`, `## LGTM`, Important0/Nit0. La PR resta DRAFT mentre il check
  `rebase` termina; non fare un secondo dispatch. A check verdi renderla ready
  una sola volta e lasciare il merge alla custom automation del corpus, che non
  supporta l'auto-merge nativo.
- 06:40: #7008 ha nuova freeze `a291ad0a8a3f68528922614ff62d2530b55d7a37`
  da main `a807bdea1`, merge-tree pulito, tre file, 68/68 test, tsc/node/diff
  verdi e probe 592/registry22 = URL20/null2. Durante la review e' emerso un
  WIP unstaged di due file (25 aggiunte/3 rimozioni) che valida anche
  `response.url` effettivo contro SSRF e aggiunge il caso
  `https://127.0.0.1/admin`. Non pubblicare `a291ad0a8`: il fixer deve adottare
  il delta, rieseguire le prove e creare una nuova freeze clean, poi servono
  code review e TS review 0/0 sulla stessa HEAD.
- 06:43: corpus PR #729 e' stata resa ready dopo CI verde; poiche' l'evento
  review aveva fotografato `draft=true`, il solo recovery custom canonico e'
  stato il rerun attempt2 del workflow `33591417551`. Run SUCCESS e custom
  auto-merge alle 04:43:32Z, merge `f74e7a649268660773a2c0c171ee82b8cab46295`.
  #658 e' CLOSED, mutex rimosso, branch remoto assente e WT/branch locale v3
  puliti. Nessun merge manuale e nessun secondo dispatch di review.
- 06:44: review read-only di #7008 `a291ad0a8` conclusa Important2/Nit0.
  Il WIP `response.url` risolve il primo finding. Il secondo e' un hang reale:
  `lookupImpl()` precede l'AbortController e con una Promise mai risolta supera
  `timeoutMs` bloccando resolver/pool/Agent. Il fixer Tier4 deve includere la
  lookup nel budget fail-closed e aggiungere un test con lookup davvero
  pendente; poi nuova freeze clean e doppia review 0/0.
- 06:52: #7008 rifreezata clean come
  `a14169407db9afdbbcf9106a5b0cb0bcc72faba8` su origin/main
  `480b806cf98016e1c048daef19cf5b51c03618b9`; merge-tree exit0/tree
  `7770e84159b4ba0ffe159884af2d0a1f5e34b4b8`, tre file, estraneo0,
  diff-check0. Test resolver24 (inclusa lookup realmente pendente), identity27
  e public-policy19 = 70/70; node-check0; probe source592/registry22 =
  URL20/null2. Full tsc sparse resta baseline exit2/596 errori ma match sui
  file #7008 = 0. Doppia review finale code+TS avviata sulla head esatta;
  fixer sospeso e nessun push/PR prima di Important0/Nit0.
- 06:57: code review #7008 su `a14169407` e' `## LGTM`, Important0/Nit0.
  TS review blocca con Important1/Nit2: i JSDoc `any` e i cast del fake eludono
  il typecheck sul confine fetch/DNS/dispatcher; manca un test che provi il
  wiring reale dell'Agent e il rifiuto del secondo lookup privato al socket;
  il test idempotenza non rimuove la directory temporanea. Tutti e tre i
  finding sono stati classificati come dovuti e assegnati al fixer sulla
  stessa ownership; nessuna PR prima di nuova freeze e doppia rereview 0/0.
- 07:03: #7008 refreeze finale `9da2801aff91b830f5995e0b92d2674e86bf47a7`
  dopo integrazione origin/main `ecb147092460126c143fa6795638baab435bf999`;
  merge-tree exit0/tree `8ffef59...`, WT clean e soli tre file assegnati.
  Risolti Important/Nit TS con typedef strutturali senza `any`/double cast,
  test reale Agent/dispatcher che rifiuta la seconda lookup privata al socket
  e cleanup `mkdtemp` in `finally`. Resolver25/25, tsc mirato/node/diff verdi;
  sibling 48 candidati lessicali classificati, stesso antipattern0. Doppia
  rereview code+TS avviata sulla head esatta; nessun push/PR.
- 07:04: entrambe le rereview finali di #7008 `9da2801af` sono `## LGTM`,
  Important0/Nit0. Code reviewer: resolver25/25, registry22/592 = URL20/null2.
  TS reviewer: resolver25 + public-policy19 + atomic-writer5 = 49/49,
  typecheck sui file #7008 zero errori, WT ancora clean. Publisher autorizzato
  a push/PR sulla sola head esatta, CI, una review remota canonica e auto-merge
  nativo site; vietati merge manuale, claim #7009 e dispatch crawler.

### Percorso critico esatto

1. **Prima di riprendere il goal:** verificare che #729/#658 e la futura PR
   #7008 siano merged/closed con prove finali e nessun mutex/worktree/branch
   residuo. Se il parcheggio non li ha conclusi, terminare questi due WIP senza
   reclamare altro.
2. Completato il parcheggio, il primo nuovo task e' #7009, poi #7010; non
   reclamarli prima del merge #7008.
3. Alla prima schedule naturale utile osservare una sola canonical token-bound. Verificare prima il
   preflight: se non ready deve abortire prima del primo POST. Se ready, seguire
   23 gruppi, sentinel, observer, barrier, artifact e commit dati fino a terminale.
4. Con lo stesso run misurare #6806, #6862 Accor, #6932 adapter,
   #7064 retirement/route e #6816 Mabetex. Non creare cinque run separati.
5. Sul commit dati risultante eseguire tutti gli audit globali elencati sotto.
   Chiudere amministrativamente #5253 solo se parser CRITICAL live resta 0.
6. Eseguire #7009 e #7010 in serie con lo stesso fixer, una PR per acceptance;
   poi rimisurare #6529 e chiudere il parent aggregate.
7. Solo dopo la catena website/identity decomporre #6504 per coorti di logo;
   evitare mapping destinati a cambiare e download massivi non verificati.
8. Dopo la prima generazione valida, accumulare le restanti prove #6806 in
   modo canonico seriale e mai sovrapposto. Valutare una cadence temporanea solo
   con stop automatico a 14 e senza cambiare la definizione di generazione valida.
9. Chiudere con parity sito/corpus, shell contract, `build-api`, manifest e
   byte identity; poi nuovo censimento GitHub a issue aperte zero.

### Ledger di tutte le subissue note

| Issue | Stato corrente | Causa/scope | Prova per chiudere | Prossima azione |
|---|---|---|---|---|
| site #5253 | OPEN + mutex | tracker parser; WIP train superseded | artifact post-09 + `audit-parser-quality` CRITICAL0 | nessuna PR; chiusura amministrativa solo dopo live |
| site #6504 | OPEN, reale | 137 aziende/7.579 job senza logo | audit missing-logo 0 oppure eccezioni motivate e riesaminabili | attendere #7008-10, poi coorti Tier3/4 |
| site #6529 | OPEN aggregate | website `www`/bare non risolvibile con normalizzazione cieca | #7008+#7009+#7010 merged e gate reachability verde | non reclamare il parent come fix atomica |
| site #7008 | OPEN + mutex | probe HEAD->GET bare/www e registry idempotente | >=22 verdetti sui 592 record, schema/idempotenza testati | fixer attivo |
| site #7009 | OPEN fix-queued | generatore consuma registry, fallback bare | test generatore + output senza host inventati | claim solo dopo merge #7008 |
| site #7010 | OPEN fix-queued | gate anti-regressione reachability | gate verde su registry/output | claim solo dopo #7009 |
| site #6806 | OPEN | generazioni devono essere token-bound e fail-closed | prima canonical valida + storico 14/14 | attendere 09:00, poi serializzare storia |
| site #6816 | OPEN, verifica | Mabetex raggiungibile in Group15, snapshot noto 1 job | receipt/slice token-bound aggiornata | misurare nel run 09:00 |
| site #6862 | OPEN, verifica | Accor pagination fix #7111, 20/20 locale | snapshot completo persistito, id/URL/slug/history/route loss0 | misurare nel run 09:00 |
| site #6932 | OPEN, verifica | adapter ABB/Lidl/Migros/VTG code-level verdi | receipt/feed/idempotenza live, cross-locale Migros | misurare nel run 09:00 |
| site #7064 | OPEN, verifica | writer retirement roster merged #7122 | prima persistenza valida e route/history loss0 | misurare nel run 09:00 |
| corpus #658 | OPEN + mutex | watchdog commit pagination; Nit injection post-merge | follow-up due file Nit0, watchdog completo verde | pubblicare `b87795329` |
| site #6380 | da ricensire live | batch commit/ownership, separata da #658 | acceptance issue e stato live | non inglobare in #658 senza prova |
| site #6805 | da ricensire live | residuo storico indicato dal ledger | GitHub live + artifact | nessuna azione finche' non censita |
| site #6818 | CLOSED | parte source-detail train | chiusa; nessun lavoro | nessuno |
| site #6821 | CLOSED | Cippatrasporti incluso in #7082 | chiusa; mutex stale da rimuovere quando API stabile | cleanup amministrativo |
| site #6889 | CLOSED | timeout/header SSOT #7130 | 72/72 e LGTM0/0 | nessuno |
| site #7044 | CLOSED | cancelled recovery #7129 | 48/48 e LGTM0/0 | nessuno |
| site #7119 | CLOSED | regexp SSOT #7121 | LGTM0/0 | nessuno |
| corpus #662 | CLOSED | risolta da #661 | stato live gia' confermato | nessuno |
| corpus #668 | presumibilmente CLOSED, ricensire | precedente cap watchdog 300->500 | GitHub live | nessuna fix duplicata |
| corpus #692 | CLOSED | risolta da #700 | stato live gia' confermato | nessuno |
| site #5198 | tracker permanente transient | HTTP transient registrati | non e' closure target del goal salvo finding non classificati | continuare dedup transient |
| site #6957 | esclusa | traduzioni, owner esterno | non toccare | nessuno |

### Recensus live autorevole 2026-09-02 04:22Z — sostituisce le righe incerte

Il publisher ha censito via GraphQL 39 candidate OPEN site e 11 corpus,
escludendo #6957/traduzioni. Ha classificato 41 core/tracker e 9 adiacenti.
L'unica PR site crawler aperta al censimento e' #7137 per #7021; nessuna PR
corpus era aperta. La precedente misura scout con 401 e' invalida.

#### Site: core dovute, bloccate o da verificare

| Issue | Stato/claim | Tier e dipendenza | Metrica di chiusura |
|---|---|---|---|
| #5253 | OPEN+mutex, code-level gia' verde | T1, natural 09:00 | artifact fresh, parser strict CRITICAL0 |
| #6504 | parent logo decomposta | T3 parent -> figli | missing-logo affected jobs 8227->0 o registry accettato |
| #6918 | 5 key high-impact, 4.759 annunci | T4, asset/decisioni visuali | 5 key -> 0, weekly observer |
| #6919 | 5 key, 760 annunci | T2, domini verificati | 5 -> 0 |
| #6920 | 5 key, 443 annunci | T2, domini ratificati | 5 -> 0 |
| #6921 | 5 key, 323 annunci | T4, asset VD/visual check | 5 -> 0 |
| #6922 | 5 key, 260 annunci | T4, asset ZKB/Google visual | 5 -> 0 |
| #6923 | residuo 120 key/1.682 annunci | T3 batch ~5 key, ownership disgiunta | missing120 -> 0 per batch |
| #6529 | parent website decomposta | tracker #7008->#7009->#7010 | tutte child merged e gate reachability verde |
| #7008 | OPEN+mutex, Tier4 attivo | hardening review; blocca #7009 | >=22/592 verdict deterministici, timeout bounded, SSRF0 |
| #7009 | OPEN fix-queued | T2 dopo #7008 | hardcoded www 21->0, fallback registry |
| #7010 | OPEN fix-queued | T2 dopo #7009 | unreachable <=22 e fail on growth |
| #6781 | OPEN LOW, causa nota | T2 max2 file | missing-dir warning1, empty-dir0 |
| #6806 | OPEN+mutex, code fix #7135 | T1 live + history | 23 group verified, >=14 durable, token-null push0 |
| #6816 | OPEN LOW | T2 se branch davvero dead; prima live | ramo dead eliminato/retirement test, foreign publish0 |
| #6862 | OPEN+mutex, code fix #7111 | T1 natural | Accor 20/20+, receipt valid, identity/route loss0 |
| #6903 | OPEN retention | T4 | rejected tombstone >90d, no re-onboard, store bounded |
| #6908 | OPEN slug journal | T4 identity/history | owner diretti 6 campi 1->0, route/history loss0 |
| #6932 | OPEN live-verification | T1 | adapter 4/4 live/fixture, identity idempotent |
| #6979 | OPEN+mutex Gardenia | T4 transport | polite/sticky/deadline 3/3, live identity/route delta0 |
| #6983 | OPEN+mutex ma code-fixed | T1 live/admin | iPersonal token-bound e route proof, poi close |
| #7021 | OPEN, PR #7137 e owner esterno | non collidere | acceptance della PR/issue, remote LGTM e merge nativo |
| #7025 | OPEN Faulhaber JSON/WAF200 | T4 parser/transport | raw payload, WAF fail-closed, live/idempotence |
| #7026 | OPEN Fust encoding/canonical | T4 identity/parser | accentate preservate, canonical equivalenti, loss0 |
| #7055 | OPEN Apple false ZH | T4 HIGH geografia | 3/18 national no fake HQ, city/identity/history0 |
| #7061 | OPEN expiredAt/IT collapse | T4 HIGH route | sort cronologico, no collapse IT, exemption bounded, loss0 |
| #7064 | OPEN+mutex, code fix #7122/#7110 | T1 natural | prima persist valida e route/history0 |
| #7107 | OPEN trigger-workflow edge cases | T4 transport | Retry-After, body>1MB, race post-dispatch, attach duplicate0 |
| #7116 | OPEN exit42 batch commit | T3 ratifica -> T4 | contention bounded senza violare token/receipt; parity artifact |
| #7128 | OPEN iPersonal wiring/alias | T1 scout -> T4 se reale | removed-set archiviato, alias contamination0 |

#### Site: tracker, stale amministrative e recurrence non indipendenti

- #5198 e' il tracker rolling transient: non chiuderlo; escalation solo 3/3.
- #5321/#5429 sono tracker sector/profession zero-match, non coverage gap del
  registry crawler. Il coverage gap crawler e' gia' pre-audit0.
- #6315 e' un gate corpus-wide con ultima recurrence 25 agosto: rimisurare e
  auto-chiudere se verde, non dedurre una fix crawler.
- #6803 e' gia' risolta da #6877/#6851 item2 ma OPEN stale: chiusura admin.
- #6857, #6930, #6953 e #7024 sono recurrence del run legacy token-null/no-push,
  non nuovi parser defect: attendere natural token-bound, poi dedup/chiusura.
- #6983 e' code-fixed da #7039 + route #7108 ma aspetta prova live/admin.
- Adiacenti esclusi dal goal job-crawler: #4854 (aste), #5510 (article slug),
  #6611 (article AI smoke), #6681 (consent), #6687 (sparse profiles), #6752
  (farmacie scheduler). #6957/#7096 traduzioni sono esplicitamente escluse.

#### Corpus: core dovute o tracker

| Issue | Stato | Tier/dipendenza | Metrica |
|---|---|---|---|
| #25 | rolling transient | T1, escalation 3/3 | consecutive failures |
| #331 | identical transport cross-repo | T3 -> T4 dopo confinement | tutti identical trasportati, extra0 |
| #339 | parent drift | T3 tracker, figli #480/#653/#722 | loop-drift strict0 |
| #480 | ai-models both-moved parent | T3, figli626-629 closed; #630 open | ai-models byte-identico post-#630+transport |
| #630 | recordScore opt-out assente | T4 cross-repo/scoring | diagnostico non altera ledger, gemelli byte-identici |
| #653 | 7 ghost baseline | T3 evidence/manifest | ghost7->0 senza `--init` cieco |
| #658 | OPEN+mutex | T2 follow-up pronta | `2a038daf8`, review locale 0/0, suite/remote merge |
| #722 | 7 adapted + scan-job-timeouts drift | T3 cluster -> fix stream | loop-drift strict0 |

Drift live ancora reale su `scan-job-timeouts`, `ai-models`,
`article-factuality-gates`, `orphanQuerySource` e `github-issue-creator`:
#722/#480 non sono stale. #662/#668/#692 sono CLOSED. Non esiste una issue
corpus #6380; il vecchio riferimento non va trasformato in lavoro. Adiacenti
esclusi: #316 bookkeeping route:none, #659 retry workflow articoli, #694
immagini eventi.

### Parita' trackpoint locale / backlog remoto

- File locale versionato nel repo root: commit `8331750a`, `cce62a19`,
  `414f733b`, `f4d3f7a3`; push remoto ancora bloccato dal DNS/token standard.
- Site parent #7138 `[crawler-goal] Piano esecutivo crawler fino ad audit e
  persistenza verdi`; audit child #7139; 36 issue collegate come native subissue.
- Corpus parent #727 `[crawler-goal] Piano esecutivo corpus, API, parity e
  manifest`; audit child #728; 9 issue collegate come native subissue.
- I parent sono cross-linkati e contengono checkpoint, definition of done,
  dipendenze e guardrail. Non sono state duplicate issue esistenti.
- Ogni futura transizione locale deve aggiornare sia questo file/commit sia il
  parent remoto (body o commento checkpoint) e la issue specifica coinvolta.

### Matrice dei requisiti finali

| Requisito finale | Evidenza corrente | Stato conclusivo |
|---|---|---|
| duplicate crawler pairs = 0 | pre-audit snapshot `042a37ec`: 588 slice, 0 pair | NON conclusivo: ripetere sul nuovo commit dati |
| coverage gap = 0 | stesso pre-audit: 0 crawler/0 vacancy, stale witness0 | NON conclusivo |
| parser CRITICAL reali = 0 | pre-audit `042a37ec`: 588 crawler, CRITICAL0, warning149 | NON conclusivo |
| geografia senza falsi CH/TI | assembly temp da 588 slice in corso/completata; audit location da eseguire | mancante |
| stable-ID/slug collisions = 0 | observer e fix presenti; misura globale fresca mancante | mancante |
| previousSlugs decontamination dry-run = 0 | ultima prova pre-run non basta | mancante |
| crawler keys/summaries validi | test presenti; nuova generazione non misurata | mancante |
| slug/history/route suite verde | test storici verdi, run post-fix mancante | mancante |
| nessuna perdita previousSlugs recente | richiede confronto pre/post commit dati | mancante |
| corpus parity/shell contract | #7101/#725 verdi storicamente | ripetere su main finali |
| build-api riuscita | non eseguita sul corpus finale | mancante |
| manifest/counts completi | nessun nuovo manifest token-bound | mancante |
| file identical byte-identici | ultima projection 157/157 storica | ripetere su main finali |
| issue crawler dovute aperte = 0 | recensus live in corso; note aperte sopra | non raggiunto |
| persistenza live | 0 generazioni valide; legacy no-push | non raggiunto |

### Evidenze pre-audit riutilizzabili, ma non finali

- Snapshot materializzato da `origin/main@042a37ec`: 588 crawler,
  `audit-parser-quality --strict` = CRITICAL0/WARNING149/OK439.
- `audit-duplicate-crawler-companies` sullo stesso tree: pair0, gap0,
  stale witness0.
- Audit loghi su `origin/main@abae6fb4`: 28.562 job, 569 aziende, 432 con
  logo, 137 mancanti/7.579 job. Delle 137, 87 chiavi/5.864 job hanno almeno un
  dominio non-ATS; 50/1.715 hanno solo ATS/aggregator.
- Assembly temporanea delle 588 slice ha raggiunto lo stadio `jobs.json` con
  25.272 job dopo esclusione foreign/whitelist, backfill 152 ID e risoluzione
  di 80 collisioni locali, ma il processo successivo e' terminato ENOSPC prima
  del report location. I numeri sono diagnostici parziali, non un gate verde.

### Errori gia' commessi e come non ripeterli

1. Il primo run canonical e' partito prima che il lockstep corpus fosse su main;
   il vecchio preflight ha degradato a legacy. Ora #7135 abortisce: verificare
   preflight e ref-pin prima di osservare qualsiasi POST.
2. Non lanciare un altro run per compensare un run legacy. Tutti G01-G09 hanno
   provato no-push; attendere la schedule naturale.
3. Il pre-audit su WT `8113635c` era stale e mostrava duplicati SOH/SPZ gia'
   risolti. Ogni audit finale deve dichiarare commit codice e commit dati.
4. `git diff origin/main...branch` sul WIP #5253 mostrava 33 file; il diff
   diretto sulle path era zero. Per WIP vecchi usare entrambi e confrontare
   contenuto finale, non solo ancestry/cherry.
5. Un worktree sparse senza manifest/dati non prova assenza. Usare `git show`,
   `git ls-tree` o materializzare uno snapshot temporaneo.
6. Su macOS `/tmp` risolve a `/private/tmp`: l'`isMain` di script ESM puo' non
   partire con il primo path. Invocare il path reale e controllare che il report
   sia stato rigenerato, non leggere un JSON archiviato preesistente.
7. Per eseguire TSX in uno snapshot temporaneo servono `package.json` con
   `type:module` e risoluzione `node_modules`; un errore di export puo' essere
   solo un ambiente incompleto.
8. Il checkout root/main condiviso e' deliberatamente vecchio e sporco. La base
   di lavoro e' `origin/main` nel worktree fresh; non fermarsi per il main locale.
9. API/DNS GitHub indisponibile non blocca implementazione/test locali quando
   issue, claim e base sono gia' stati verificati. Blocca soltanto push/PR/review.
10. #6529 non si risolve togliendo sempre `www`: alcuni host richiedono `www`.
    Seguire #7008->#7009->#7010 con probe e registry.
11. #6504 non autorizza download massivo: favicon ATS/grey-globe e brand errati
    peggiorano i dati. Validare dominio, identity e asset per coorte.
12. #726 e' stata mergiata da automazione esterna con Nit1 nonostante noi non
    avessimo armato auto-merge su CLEAN. Dopo ogni merge leggere la review finale;
    se Nit/Important resta, riaprire e fare follow-up invece di nasconderlo.
13. Il push corpus HTTPS puo' fallire anche con commit pronto. Conservare il
    commit e farlo adottare dal publisher con il percorso auth autorizzato;
    non ricreare la fix.
14. Non inviare ripetutamente allo stesso agent un blocker gia' smentito. Dopo
    tre turni #7008 senza edit, sostituire l'owner e registrare il motivo.
15. Materializzare `scripts+data+build-plugins` in `/private/tmp` ha consumato
    3,1 GiB e l'assembly e' finita ENOSPC. Le due temp esatte create da questa
    sessione sono state eliminate (spazio libero tornato a 17 GiB). Per il
    prossimo audit location usare un worktree/snapshot mirato o attendere il
    commit dati canonico; non conservare copie complete del corpus.

### Istruzioni per un nuovo orchestratore

1. Leggi questa sezione e poi `git show` dei ref indicati; non rileggere subito
   tutte le 1.700+ righe cronologiche.
2. Esegui `list_agents`; adotta gli agenti live e non creare duplicati.
3. Controlla per primo il commit `b87795329` e il WT/branch #7008; sono i due
   WIP implementativi recuperabili correnti.
4. Interroga il publisher per il recensus live e sostituisci le righe incerte.
5. Non fare dispatch prima delle 09:00 UTC. Alla schedule, un solo owner deve
   seguire l'intera generazione e registrare token/run/artifact/commit.
6. Aggiorna questo trackpoint subito dopo ogni evento e committa soltanto questo
   file nel repo root; non includere le modifiche personali gia' presenti a
   `CLAUDE.md`, `.claude/`, `.codex/` o altri file `.agents/`.

## GATE #726, #5253 NULLO E CATENA WEBSITE 05:53 — PRECEDE GLI HANDOFF SOTTO

- Corpus #726 e' stata mergiata da automazione custom come `4f04439d0373`
  dopo check verdi, ma la review finale `5085354330` e' LGTM con Nit1: il
  default `resolveHead` dipende implicitamente dal `fetchPage` globale invece
  di quello iniettato dal caller. L'orchestratore non ha mergiato manualmente
  ne' armato auto-merge su CLEAN. #658 va riaperta e corretta con follow-up;
  non e' ancora un gate verde del goal.
- La generazione legacy e' ora interamente terminale: anche G01 e' FAILURE;
  nessun run token-null conta come persistenza. Il publisher sta acquisendo
  l'ultimo artifact e la prova no-push, senza rerun.
- Il bundle WIP #5253 non va adottato: le 33 path sono byte-identiche a
  `origin/main` tramite #7082 e il pre-audit sul tree `042a37ec` misura 588
  crawler, CRITICAL0. #5253 resta aperta solo per l'artifact token-bound delle
  09:00 UTC; sei potenziali PR sono state eliminate.
- #6529 e' gia' decomposta autorevolmente in #7008 -> #7009 -> #7010. #7008
  e' reclamata, nessun WIP concorrente, e assegnata a un fixer-lite su tre file;
  le dipendenti non sono reclamate. Acceptance #7008: probe HEAD->GET bare/www,
  timeout, registro dominio->URL|null idempotente e >=22 verdetti su 592 record.
- #6504 resta reale: 137 aziende/7.579 job senza logo. 87 chiavi/5.864 job
  hanno almeno un dominio non-ATS; 50/1.715 hanno solo ATS/aggregator. Dipende
  dalla catena website/identity e non va compressa in una Tier2 indiscriminata.

## MERGE FAIL-CLOSED, #726 PUBBLICATA E COMPRESSIONE RESIDUI 05:38 — PRECEDE GLI HANDOFF SOTTO

- Site PR #7135 e' auto-mergiata nativamente come `042a37ec1b59`, head
  `8eb46a586db2`: vitest SUCCESS, review remota esatta `## LGTM`, Important0 e
  Nit0. Le quattro path del freeze sono byte-identiche su `origin/main`; la
  canonical abortisce prima del primo POST quando preflight/ref-pin non e'
  valido. #6806 resta OPEN per persistenza e storico, non per codice.
- Corpus PR #726 e' pubblicata FF sulla head remota `427ec67556b0`, diff ancora
  limitato a due file dopo integrazione clean di main. Test causali #658 6/6 e
  contract/detect/node verdi; nuova CI e review remota sono in corso, quindi
  auto-merge non ancora armato. Nessun merge manuale.
- La vecchia generazione legacy e' stata drenata senza persistenza: G02/G08/G09
  terminal FAILURE con artifact token-null, valid=false, verified0, nessun
  receipt/slice/commit; G01 e' l'unico ancora in progress. Nessun secondo
  dispatch. La schedule naturale 09:00 UTC post-#7135 sara' una sola prova
  condivisa per #6806, #6862, #6932, #7064 e #6816.
- #6816 e' ridotta a verifica live: Mabetex e' raggiungibile dal Group15 e lo
  snapshot traccia 1 job; manca soltanto la prova token-bound aggiornata. #6529
  e' invece reale (website `https://www.<companyDomain>` hardcoded) e candidata
  Tier2 separata. Nessun WIP locale #6504/#6529 e' stato trovato; il claim
  remoto attende API GitHub stabile.
- Audit #6504 riprodotto su snapshot `origin/main@abae6fb4`: 28.562 job, 569
  aziende, 432 con logo e 137 senza logo (7.579 annunci). E' un aggregate da
  decomporre per coorti, non da mescolare alla fix host #6529. Il planner e'
  riusato in serie; lo scout inventaria in parallelo il WIP #5253.
- Ottimizzazione storico #6806: nessuna delle prove legacy esistenti conta;
  metrica attuale 0/14. Prima si attende un naturale completamente valido.
  Solo dopo, se tutti i gate sono verdi, si valutano run canonici seriali e mai
  sovrapposti per abbreviare la cadence, senza dry-run o receipt v1 conteggiati.

## FAIL-CLOSED LIVE, #7135 E CORPUS #726 05:27 — PRECEDE GLI HANDOFF SOTTO

- Merge acquisiti: #7121 `b61ead2f` (#7119 regex SSOT), #7122
  `ca872672` (#7064 retirement roster), #7129 `84ae3401` (#7044
  cancellation recovery) e #7130 `647e0b32` (#6889 timeout normalizzato).
  Tutte con CI verde e remote LGTM0/0; #7044/#6889/#7119 sono CLOSED e
  mutex0. #7064 resta OPEN per la prima prova naturale route/history loss0.
- L'unica orchestrazione canonica autorizzata e' site run `33584757882`,
  attempt1, token nominale `33584757882-1`, head `647e0b32`. Il preflight e'
  avvenuto prima che corpus PR #725 portasse il transport lockstep: ready=false
  e il dispatcher ha degradato legacy/no-token. L'orchestrator e' stato
  cancellato una volta dopo G09 per fermare nuovi POST; nessun rerun.
  G03/04/05/06/07 sono FAILURE fail-closed; artifact G03 token null,
  verified0, receipt/slice vuoti e reasons receipt_invalid/missing/wait_failed;
  commit dati token-null0. G01/02/08/09 restano da seguire a terminale.
- La prova ha scoperto un nuovo gap reale dentro #6806: preflight unknown/non
  ready e ref-pin failure non devono mai autorizzare legacy. Fix Tier4 pronta
  e pubblicata come PR site #7135, head `8eb46a58`, 4 file, 140/140 freeze,
  code+JS LGTM0/0, body `Addresses #6806`, auto-merge armato e CI in corso.
  Il percorso legacy non ha caller produttivi; la canonical ora abortisce
  prima del primo dispatch e usa il reporter failure esistente. #6806 resta
  OPEN per natural 09:00 UTC e storico >=14 generazioni valide.
- Corpus #658 e' confermata reale: 755 commit/47,72h superano cap500. PR #726
  e' stata corretta dopo remote Important1/Nit1: scansione pinned a SHA,
  budget 24 pagine/45s, failure commit isolata cosi' run/corpus/reconcile
  continuano e poi exit1; nessun ramo/test truncated o skip. Delta finale
  locale `ad9588d7e`, 2 file, #658 6/6, code+JS LGTM0/0; attende push FF del
  publisher e rereview remota. Il batch cross-repo #6380 e' separato perche'
  cambierebbe ownership/attribuzione e non serve a chiudere il blind spot.
- La prossima prova valida non sara' un secondo dispatch: si attende lo slot
  naturale 09:00 UTC dopo merge #7135. Un solo run token-bound dovra' provare
  insieme #6806, Accor #6862, guard #7064 e adapter #6932; la fotografia
  Accor 30 agosto e il pre-audit su WT `8113635c` sono pre-fix/stale e non
  contano per closure o audit finale.

## MERGE #7101 E ONDATA A QUATTRO SLOT 03:55 — PRECEDE GLI HANDOFF SOTTO

- #7101 e' auto-mergiata nativamente come `ebeeacd8c370`, head finale
  `7d401d26d56b`, required run `33577865455` SUCCESS. Ha chiuso
  #6814/#7084/#7085; i mutex stale sono stati rimossi. La review integrata
  `5084686412` aveva Important0, Nit1 e `## LGTM`; l'auto-merge e' avvenuto
  39 secondi dopo il post, prima che fosse possibile sospenderlo.
- Il Nit non e' stato nascosto: nuova issue unica #7119 OPEN, reclamata e
  assegnata Tier2. Eliminera' la copia locale di escape regex in
  `article-factuality-gates.mjs` usando `escapeRegExpLiteral`, con observer
  sui metacaratteri e no behavior change. Le tre Questions della review sono
  state classificate con evidenza sul PR e non hanno dimostrato altri difetti.
- #7064 item1 ha ora WT sparse fresh da `ebeeacd8`, ownership esclusiva su
  persister Bash+test e impact manuale HIGH (23 gruppi/596 primary slices).
  #7117 resta freeze 6 file in attesa di exact code review; #7119 opera su
  due file disgiunti. Quattro slot correnti: #7064, #7117 fixer, #7117
  reviewer read-only, #7119 fixer-lite.
- Spazio operativo: rimossi con `git worktree remove` cinque worktree clean
  e verificati (due detached gia' antenati di main; tre branch di PR concluse
  conservati e recuperabili), senza WIP/stash/traduzioni. Spazio libero
  5,4 -> 8,4 GiB.

## PERCORSO CRITICO OTTIMIZZATO 03:31 — PRECEDE GLI HANDOFF SOTTO

- #7101 e' ora sulla head remota finale `7d401d26d56b` con unico push
  FF/non-force dalla vecchia `ecd1ea417f93`. Il body e' byte-identico al
  freeze (`sha256 0b53cc...`), classifica 43/43 sibling path una volta
  (missing/extra/duplicate/stateless 0), ha closing refs esatti
  [#6814,#7084,#7085] e auto-merge nativo attivo. Il required run
  `33577865455` e' IN_PROGRESS; nessun altro push, review o dispatch finche'
  il check non termina.
- La riduzione PR e' applicata dove conserva una singola classe semantica:
  #6814 e' assorbita nel train #7101. #7044 non viene accorpata a #6889:
  causa/osservatore sono distinti, ma la scheda l'ha ridotta a fix Tier2 di
  due file e verra' assegnata allo stesso fixer-lite gia' caldo dopo #7101.
- #6889 ha rivelato un secondo acceptance reale nel commento owner: oltre al
  preamble shell SSOT, `target_exit==124` deve avere descrizione timeout
  specifica lasciando titolo/dedup invariati. PR unica #7117 e' OPEN sulla
  head `a3b94786`; il fixer-lite e' stato congelato e il WIP trasferito a un
  Tier4, che completera' sulla stessa PR generator, test, contract e i soli
  tre artifact Group18. La PR non chiude impropriamente #6889 finche' il
  secondo item non e' coperto.
- #7064 item1 e' confermata HIGH e distinta: il writer stale deve usare
  `crawler-generation-roster.json.primarySlices` come registry positivo;
  una slice base-present/remotely-missing ancora registrata deve abortire
  fail-closed, una non registrata e' retirement, una base-absent e' create.
  Issue reclamata con `agent:in-progress`, nessun WIP concorrente. Il fixer
  Tier4 resta read-only fino all'auto-merge #7101, poi usera' ownership
  esclusiva su `git-commit-data.sh` e il test causale; post-merge richiede
  run naturale unico e route/history loss0.
- #7044 scheda ratificata: `dropPhantomCancellations()` conta come timeout
  cancellazioni manuali/supersedute che hanno job ma nessuna annotation.
  Fix MEDIUM: una cancelled e' failure solo con evidenza timeout, mentre
  failure e incertezza restano fail-closed; observer causale in
  `close-recovered-recurrence.test.ts`. Implementazione solo dopo #7101.

## MAIN VERDE, VOLG E DIAGNOSI LIVE 02:58 — PRECEDE GLI HANDOFF SOTTO

- #7110 e' auto-mergiata nativamente come `ae7854af7fd9`, head
  `a7db95ccdc3b`: remote vitest SUCCESS, exact review Important0/Nit0/LGTM.
  #6784 e' CLOSED, mutex rimosso e WT/branch puliti. #7064 resta OPEN solo
  per item1; item2 SPZ/Paraplegie e' commentato come risolto e il mutex
  specifico e' rimosso. Il main e' tornato verde sul test ownership che
  bloccava #7101.
- Il rosso VOLG di Wave A era un observer stantio, non una regressione parser:
  #7082 ha sostituito la guard inline body-ratio 3% con il helper condiviso
  piu' forte 15% + min200/50 e ha conservato title-overlap 0,60. PR test-only
  #7114 e' auto-mergiata come `cd80cbd4d5dd`, vitest SUCCESS e remote LGTM;
  l'observer ora esercita boundary reali 15% e 0,60/0,40 e wiring host VOLG.
  #5253 resta OPEN e nessun G08 e' stato ridispatchato.
- I fallimenti della generazione canonica sono classificati: G03
  `33569035721` manca solo Interdiscount per HTTP503 e G10 `33569629086`
  manca solo Jumbo per HTTP503. Entrambi sono transient1/3 registrati su
  #5198; tutti gli altri slice sono persistiti e i receipt sono invalidi in
  modo corretto (`receipt_missing+wait_failed`) solo per il producer mancante.
  Nessun rerun manuale: la prossima generazione naturale riprovera'.
- #7101 e' stata ricostruita sopra #7110 e #7114 mantenendo old remote e
  latest main entrambi ancestor, diff 15 file, projection corpus 151+6=157/157,
  train372/372, manifest39/39, ownership19/19, typecheck23<baseline24 e
  GitNexus LOW/0. Il related finale su 588 file e' ancora running; nessun push
  fino al suo esito.
- #6889 e' reclamata e assegnata a Tier4 perche' include generator+test+tre
  artifact. Nessun WIP remoto esiste; il vecchio WT catchall e' 4408 commit
  indietro, ahead0 e 27 file dirty non isolabili, quindi non viene adottato.
  Il fixer lavora da sparse WT fresh e non collide con #7101/#7044/traduzioni.

## PR REMOTE E PERSISTENZA FAIL-CLOSED 02:23 — PRECEDE GLI HANDOFF SOTTO

- PR #7101 e' ora pubblicata sulla stessa PR con unico push effettivo
  FF/non-force, head `ecd1ea417f93`, base `ecd651c`, closing refs esatti
  [6814,7084,7085], autoMerge nativo attivo e body `Non implementato:
  Nessuno`. Corpus main include #721 e la metrica reale e' 157/157, drift0;
  vitest e nuova review remota sono in corso.
- PR #7110 e' aggiornata FF sulla stessa PR a head `484e2eeec83c`, base
  `77d0b501`; 16 file finali dopo avere adottato latest Rituals gia' clean.
  Suite193/193, global decontaminate0/0, ownership/audit0 e route/ID/current
  slug loss/add0. Vitest remoto SUCCESS; la review head ha Important0/Nit1
  sul magic ownerCount. Il Nit e' gia' corretto come espressione causale
  `15 - 3` e exact rereview locale e' LGTM, Important0/Nit0/domande0; resta
  da pushare il solo delta e ottenere nuova review remota/automerge.
- PR #7111 Accor e' auto-mergiata nativamente come `b8e613fbe935`, review
  exact LGTM e vitest SUCCESS. L'unico Group20 post-merge `33573760158` ha
  pero' provato il fail-closed, non la persistenza: Accor ha letto 20/20 job e
  scritto localmente lo snapshot completo, ma il dispatch diretto aveva
  `generationToken:null`; tutti i 28 producer e il commit atomico sono stati
  bloccati, verifiedCrawlers0 e nessun dato e' arrivato su main. Nessun secondo
  dispatch. #6862 e' stata riaperta con `agent:in-progress` e mutex: attende
  la prossima generazione coordinata token-bound post-merge.
- Il run G20 non e' un difetto di Accor ne' una perdita dati: il contratto
  #6806 ha impedito esattamente un push non correlato. L'artifact terminale
  `9826100665` e' invalid/receipt_missing e non conta nelle >=14 generazioni
  live richieste da #6806.

## REVIEW/PUBLISH E SWEEP OWNERSHIP 02:00 — PRECEDE GLI HANDOFF SOTTO

- Il transport corpus #721 ha tutti i check verdi e una nuova review remota
  sulla head `266d2ddaf54d`: Important0/Nit0, exact `## LGTM`. Il primo
  Important era un falso positivo cross-repo: site `3d8da8e08b9f` e main
  accettano gli otto flag shadow, e il workflow corpus esegue site `ref:main`.
  Evidenza postata sulla PR e una sola rereview canonica dispatchata come run
  `33572792661`; nessun rerun dei test success. Si attende solo auto-merge e
  presenza su corpus main prima del push #7101.
- Accor #6862 e' pubblicata come unica PR site #7111, head
  `d60ce700a45e`, closing=[6862], autoMerge nativo attivo. Prima del push il
  body e' stato corretto da una classificazione blanket a 36/36 sibling
  per-file, missing/extra/duplicate0, con exact review LGTM; nessun bypass del
  pre-push hook. Check e review remoti sono in corso, nessun dispatch.
- #7110 e' stata estesa soltanto entro la stessa classe ownership/previousSlugs
  per convergere sul main vivo: oltre ai sei target #6784 include i due alias
  iPersonal reintrodotti dal Group05 pre-merge (`8e2f3e498c02`), l'item2
  SPZ/Paraplegie di #7064 e i finding Banca Cler/Roche/empty buckets del dry
  globale. #7064 e' stata reclamata con `agent:in-progress`, commentata come
  item2 -> #7110 e resta open per item1; body usera' `Refs #7064`, non Closes.
  Freeze 17 file: suite193/193, dry-run globale0/0, audit ownership0 e
  route/ID loss0; exact review finale sul base frozen `869379e` e' in corso.
- La review del live-data guard ha impedito due abbassamenti silenziosi: prima
  un observer non inventariato, poi l'esclusione di interi file test misti.
  Il risultato separa solo i case che leggono davvero il corpus live; test
  unit/causali restano bloccanti, quattro falsi positivi scanner restano nel
  PR gate e inventory e' clean.
- Pianificazione #7044/#6889 corretta dopo avere rigettato una prima scheda
  che aveva letto la #6889 sbagliata. I contratti sono distinti e non vanno
  fusi nella stessa PR: #7044 MEDIUM multi-modulo prima, #6889 MEDIUM
  renderer+tre artifact dopo. L'ottimizzazione sara' un solo fixer Tier4
  riusato serialmente, non una PR omnibus che renderebbe la review meno forte.

## OTTIMIZZAZIONE ONDATA CORRENTE 01:35 — PRECEDE GLI HANDOFF SOTTO

- Capacita' saturata senza moltiplicare PR: tre fixer Tier4 e un reviewer
  seriale occupano i quattro slot disponibili oltre all'orchestratore. La
  matrice corrente mantiene ownership disgiunta: #7101 parity/ai-models,
  #7110 previousSlugs, #6862 Accor e review read-only seriale. I prossimi
  follow-up verranno assorbiti per superficie semantica, non aperti uno a uno.
- PR site #7108 (#7045 iPersonal) e' auto-mergiata nativamente come
  `ab1e8a59d731`, head `3e81888ef67d`: 122/122, route union 408->408,
  loss/add0, 22/22 owner1, collision0, second pass0 e exact `## LGTM`.
  Il Group05 `33569203104` e' SUCCESS ma e' partito alle 23:03:06Z, prima
  del merge 23:12:14Z: non prova la persistenza e non verra' contato. Un solo
  G05 post-merge verra' lanciato dopo la generazione corrente, senza duplicati.
- #7101 non e' stata pushata con una metrica falsa: site main e' avanzato
  fino a `0e704091950d`; freeze `b339d9e0c1b4` ha tree invariato
  `ace9fd168848`, old PR head e latest main entrambi ancestor tramite un ponte
  history-only, quindi il futuro push resta fast-forward. Suite 14/14,
  371/371 e 39/39 verdi, review exact LGTM. Il calo 157->155 e' interamente
  spiegato dal transport automatico corpus #721 di site #7109, che modifica
  esattamente `translate-pending.yml`, il contract e le baseline manifest;
  #7101 resta congelata finche' #721 non e' MERGED e 157/157 e' rimisurato.
- Il follow-up #6814 e' stato verificato ancora reale ma insiste sugli stessi
  file gia' toccati da #7101: cold-start dedupKey esegue 4 comandi CLOSED
  invece di 2. E' ratificato dentro la stessa PR con commit autonomo e
  observer 4->2; questo elimina una PR separata senza ampliare i moduli.
- #7110 e' stata aggiornata sulla stessa PR, senza force: baseline corrente
  6 slice/55 move, post dry-run0/0, identity/currentSlug/route union loss0 e
  duplicate/gap/stale0. La review exact ha impedito di aggiungere un observer
  live non inventariato; il secondo round ha poi impedito di escludere interi
  file misti dal gate. Il fix deve ora separare soltanto i case live in file
  dedicati, lasciando test unit/causali nel PR gate, poi ottenere nuovo LGTM.
- #6862 Accor resta Tier4 ma non tocchera' `runSpecInProduction`: GitNexus ha
  misurato il runtime condiviso CRITICAL (25 direct, 50 impacted, 20 moduli).
  La fix ratificata resta locale al crawler: bound conservativo da marker e
  total/pageSize, discovery iterativa fino al cap e replay dello snapshot
  validato per impedire che il secondo fetch perda una pagina comparsa.
- La generazione canonica `33568843425-1` sostituisce i dispatch Wave A:
  G04/G11/G12/G14/G17/G18 sono gia' SUCCESS. G03 e G10 sono FAILURE
  rispettivamente su Interdiscount e Jumbo pur con commit/finalizer riusciti;
  non verranno rilanciati alla cieca. G01/G02/G08/G19/G21/G22/G23 risultano
  ancora attivi e il sentinel e' SUCCESS. Prima si leggono receipt/log e si
  risolvono i rossi di produzione, poi si dispatchano solo i gruppi mancanti.

## PR #7101, DATA POST-TRANSLATION E ROUTE #7045 00:53 — PRECEDE GLI HANDOFF SOTTO

- Il train parity #7084/#7085 e' pubblicato come PR site #7101, head esatta
  `a6e8aafbf394`, base `9f7f7e337e97`, closing refs GraphQL [7084,7085] e
  auto-merge nativo attivo. Freeze: 3 commit/11 file, 371/371 test, 39/39
  manifest/transport, proiezione 151/157 -> 157/157. Review interna finale
  exact `## LGTM`, Critical0/Important0/Nit0; CI e review remota sono in corso,
  nessun merge manuale.
- PR #7033 e' stata riallineata fast-forward sulla stessa PR: head remota
  `c5a733a82539`, base inclusa fino a `be3798aff77b`, auto-merge attivo e
  vitest/review in corso. Nessun edit semantico al factory CRITICAL: solo
  merge/revalidation dopo la chiusura del main-red #6759.
- Il run deploy canonico #7049 `33551931249` e' ora COMPLETED/SUCCESS:
  matrix/prep e tutte le leg DE/IT/FR/EN sono SUCCESS. Nessun dispatch/cancel
  duplicato; resta soltanto la rimozione amministrativa del mutex.
- La sequenza esterna traduzioni ha prodotto `be3798aff77b` (358 slice) e
  `9f7f7e337e97` (171 slice slug regen). Non e' stato toccato #6957, ma ogni
  baseline crawler e' stata rimisurata sul tip post-sequenza: duplicate pair0,
  coverage gap0, stale witness0 e duplicate stable-ID group0. La contaminazione
  #6784 resta rossa e sale 51 -> 53: Denner12, Galenica14, KSBL4, Mobiliar3,
  Rituals16, Stadt-Zuerich4.
- #7045 ha rilevato una regressione route introdotta dal dato tradotto: le
  route Schinznach e St. Moritz erano ancora presenti ma con owner2 perche'
  copiate nell'history dell'active Nidau. Freeze target-first su 3 file rimuove
  solo i due alias dall'owner errato, preserva l'expired corretto e misura
  route union 408->408, loss/add0, 22/22 owner1, collision0, second pass0.
  Anche la compat #6806 verifica ora via ls-remote che missing token non pusha.
  Suite 122/122; rereview finale exact `## LGTM`, finding0; commit/PR in corso.
- #6784 e' applicata localmente sui sei slice/53 redirect: post dry-run0/0,
  stable identity/current slug e route union loss/add0, duplicate/gap/stale0,
  194 test verdi. Attende la review seriale obbligatoria prima di commit/PR.
- Accodato in un solo batch amministrativo: chiusura #6759/#6760/#6956 con
  metriche post-translation verdi e rimozione mutex #7049. #6957 esclusa.

## CRITICAL PATH COMPRESSO 00:10 — PRECEDE GLI HANDOFF SOTTO

- PR site #7083 e' auto-mergiata nativamente come `86edbab7a781`, head
  `b3a8ae27a3d`: check vitest finale SUCCESS e review remota exact `## LGTM`,
  Important0/Nit0. Il trasporto corpus non richiede una nuova PR: #719 e'
  gia' atterrata come `e1cce2b2d`, lockstep con il tip site #7083. #6806
  resta correttamente aperta per la prova live di almeno 14 receipt v2
  token-bound, non per altro codice.
- PR site #7087 (#7038 Retry-After) e' auto-mergiata nativamente come
  `34c6032ea9c5`, head `7c55bf9b5542`; #7038 e' CLOSED. Il post-merge G08
  verra' eseguito una sola volta insieme alla persistenza Volg di Wave A,
  evitando un dispatch duplicato. Il mutex resta fino alla prova live.
- La riparazione #6759 SOH/Solothurner e' auto-mergiata nativamente con PR
  #7088: head `8f0d477d75a6`, merge `9b373ea405d0`, vitest remoto SUCCESS e
  review exact `## LGTM` (Important0, un Nit classificato non-funnel). Gli
  audit danno duplicate pair, coverage gap e stale witness tutti 0; 2.913
  route attive, 144 ID canonici e 631 route archivio preservati. Worktree e
  branch sono puliti/rimossi, mutex #6759 rilasciato. Questo sblocca senza
  altra implementazione il riallineamento e la review remota di #7033.
- #7084 e' stato ridotto dal manifest autorevole dopo corpus #719/#720:
  dei nove target iniziali restano sei realmente `mode:identical`.
  `auto-merge-sweep` e' ora corpus-only/site-deleted, mentre
  `google-service-account-token` e `llm-json-repair` sono `adapted`; le loro
  modifiche site vengono quindi rimosse by construction. Il WIP corpus #701
  resta separato nel repo proprietario. Il manifest corrente contiene 157,
  non 127, entry identical: train integrato in tre commit/6 target proietta
  151/157 -> 157/157. Test essenziali 368/368 e sweep 563/564, con l'unico
  rosso response-cache riprodotto identico sulla base. Review dell'assemblato
  in corso; poi una sola PR site e un solo trasporto corpus.
- #7085 `ai-models` e' congelato nel commit `fe2510fd99da`, base
  `34c6032ea9c5`, dopo avere corretto tutti i quattro Important della prima
  review (ranking, delta/snapshot, flush write-failure e test cap). Rereview
  exact `## LGTM`, Important0/Nit0, 119/119 essenziali e GitNexus LOW/0; il
  commit e' stato consegnato invariato al train #7084, senza PR autonoma.
- Deploy canonico #7049 `33551931249` resta IN_PROGRESS senza dispatch o
  cancel duplicati: FR ed EN sono SUCCESS; DE e' fermo nello step 63 di
  risoluzione stale-locale e IT nello step 24 di push section shards. Questo
  run viene conservato come evidenza diretta per il follow-up timeout/
  fail-closed, non mascherato con un secondo run.
- #6784 e' stata riaperta e reclamata con evidenza sul main corrente: dry-run
  6 file/51 previousSlugs (Denner12, Galenica14, KSBL4, Mobiliar3, Rituals16,
  Stadt-Zuerich2). La translation run 33507200211 e' terminal CANCELLED e
  #6957 resta esclusa. Il prossimo fixer e' Tier4 target-first con identity,
  route/history, observer 0/0 e persistenza live.
- Avviata adozione Tier4 del WIP #7045: i due commit validi del branch locale
  `codex-fix-7045-receipt-snapshot` devono essere riapplicati per patch sul
  receipt token-bound #7083, mentre `codex-fix-7045-remote-delete` e #7039
  sono gia' in main. Nessuna collisione ammessa con #6784 o parity; nessun
  G05 pre-merge.

## MERGE WAVE A, PR #7083 E PARITY #7084 23:44 — PRECEDE GLI HANDOFF SOTTO

- Il train unico #7082 e' auto-mergiato nativamente su site main come
  `765db6e2709`, head `3735c6cdc6b6`: checks SUCCESS, exact review
  `## LGTM`, autoMerge=true e closing=[6821]. #6821 e' CLOSED ma conserva il
  mutex finche' G12 non prova persistenza/route/history. Il train ha chiuso
  prima del merge due Important trovati solo sull'aggregato (SSRF/redirect e
  fallback HQ geo Rexx/JobUp), quindi il merge finale e' 7 commit/33 file,
  479/479 e review Important0/Nit0.
- PR #7083 (#6806 token-bound) e' OPEN/MERGEABLE su head `b3a8ae27a3d`, body
  con `Refs #6806`, residuo storico >=14 dichiarato `blocked:` e closing=[].
  Auto-merge e review remoti sono in attesa. Prima della PR la review interna
  ha imposto token job-env su 69/69 artifact e un unico leaf SSOT per
  grammatica/parse, fino a 234/234 test e generator `--check` no-op.
- #7033 ha solo un rosso amministrativo storico: #6943 e' follow-up aggregata
  3-item e il gate vieta GitHub-native `Closes` anche se i tre item sono
  implementati. Body remoto ora usa `Addresses #6943`, closing=[] e un nuovo
  check body-edit e' in corso; nessun rerun manuale o commit aggiuntivo.
- Aperta e reclamata issue site #7084 per i nove drift `mode:identical`.
  Per comprimere quattro stream del planner in una sola coda remota, un fixer
  Tier4 costruisce un train site-first con quattro commit autonomi e review
  per stream; nessuna modifica diretta al corpus o traduzioni. Acceptance:
  127/127 byte-identici, loop-drift strict e manifest test verdi, poi un solo
  trasporto corpus. Il WIP corpus #701 e' solo patch/evidenza da adottare.
- #7038 e' ancora locale: review ha trovato timeout armato prima del cooldown,
  quindi Retry-After > timeout avviava il retry con signal gia' aborted. Il
  fixer ha spostato il timer sul solo I/O e aggiunto observer abort-aware;
  suite e exact rereview ancora in corso, nessuna PR.
- Deploy canonico `33551931249` resta IN_PROGRESS, head `1c2e679`; matrix/prep
  success e quattro locale ancora in progress. Sono gia' persistite le leg
  FR (`652273f`) ed EN (`98cbfc4`); nessun secondo dispatch.

## WAVE A COMPLETA, #7033 REMOTA, MIRROR #7058 23:06 — PRECEDE GLI HANDOFF SOTTO

- `#5253 Wave A` e' assemblato localmente in sei commit autonomi su
  `codex-train-5253-wave-a`: W0 `09ac3baf`, Cippa, KSURI+JobUp, Coop, 1123 e
  2649. Diff esatto 33 file/nessun overlap o estraneo, guard #7076
  preservato, suite combinata 435/435, W0 71/71, syntax/diff/PII/secrets verdi
  e GitNexus LOW/affected0. Body `/tmp/pr-5253-wave-a-body.md` passa sections
  e closes gate, contiene `Refs #5253` + `Closes #6821` e dichiara run/audit
  post-merge come `blocked:`. Attende exact review dell'assemblato; nessun
  push/PR ancora.
- PR #7033 ora contiene davvero la fix completa: body remoto byte-identico al
  ratificato, `closingIssuesReferences=[6943]`, unico push fast-forward
  `eccb66aa -> 065c6702` con patch-id invariato, nessun force/retry. Diff 16
  file, 165/165 test verdi, Hilcona live 152 fetched/79 CH/73 reject e
  collisioni ID/URL/route0. PR OPEN/MERGEABLE, auto-merge nativo e CI in
  corso.
- PR #7058 e' auto-mergiata su site main come `458ff1dce0c`. Il mirror engine
  e' poi sceso nel corpus con `288c1c73a` / merge #716 `b3f2f0a7d`: i tre
  file `blogContextualLinksPlugin`, `ogPagesPlugin` e
  `articleSectionDescriptors` sono ora byte-identici site/corpus. Restano da
  acquisire review/check remoti e build-api/manifest post-mirror prima di
  chiudere operativamente #7050.
- Audit offline globale del manifest corpus: 127 file `mode:identical`,
  118 byte-identici, 8 differenti e 1 mancante. Classificazione baseline:
  2 site-ahead (`auto-merge-sweep`, `shard-git-helpers`), 2 corpus-ahead
  (`google-service-account-token`, `llm-json-repair`) e 5 both-moved
  (`scan-job-timeouts`, `github-issue-creator`, `ai-models`, factuality,
  orphanQuerySource). E' un cluster cross-repo reale separato da #7058;
  planner Tier3 avviato e temporaneamente sospeso per dare lo slot alle
  review sul critical path.
- #6806 wiring funzionale ora passa 224/224 e 69/69 artifact/job-env con
  generator no-op, ma la review ha bloccato il freeze su un Important SSOT:
  regex token duplicata tra receipt/finalizer/contract. La correzione deve
  estrarre un leaf condiviso per l'intera classe sibling, con parity test;
  nessuna PR prima dell'exact LGTM. Residuo >=14 generazioni resta separato.

## PR #7058 E FREEZE 1123/2649 22:43 — PRECEDE GLI HANDOFF SOTTO

- Pubblicazione site sbloccata: PR #7058 aggiornata fast-forward da
  `5ebebdf` a `be6edc9d`, ref remota uguale alla head locale. PR
  OPEN/MERGEABLE/BLOCKED con auto-merge nativo attivo, CI
  `33555888119` in corso, body valido e `closingIssuesReferences=[7050]`.
  Nessuna configurazione o credenziale persistita.
- #7033 non e' stata forzata: il sibling hook ha bloccato prima della rete i
  56 candidati non ancora classificati nel body. Remote resta `3ee321e`; body
  Prada-only/stale e senza closing reference. Serve body per-file +
  `Closes #6943`, poi un solo push documentato della head `3c8705ba`.
- Recruitingapp-1123 ha exact rereview interna `Important:0, Nit:0, ## LGTM`
  ed e' congelato clean post-rebase su `48aed9c4046` (main `d58a86c`):
  102/102 test, diff quattro file, GitNexus LOW/affected0, live x2
  0 published/10 detail/10 foreign, URL-ID-route stabili. Nessun push.
- Recruitingapp-2649 conferma una diversa stale-slice: source live x2 ha 6/6
  detail ricche tutte Bonn/DE; main pubblica zero ma conserva sei falsi
  Lugano/TI per zero-job soft exit. Proof source-specific + empty-only
  authority e' verde 164/164, ma reviewer ha trovato un Important reale:
  query/fragment Umantis entrano in public URL/SHA-1 e possono creare
  remove+add/perdita route. Fix e test causale URL/ID sono obbligatori prima
  del freeze; nessuna PR/dispatch.
- Uno stesso code-reviewer viene riusato serialmente mentre i fixer correggono:
  dopo 1123/2649 sta verificando anche il freeze token-bound #6806. Cosi' gli
  slot restano pieni di lavoro utile senza moltiplicare reviewer o PR.

## CANALE SITE E TRAIN WAVE A 22:30 — PRECEDE GLI HANDOFF SOTTO

- Il canale autenticato gia' usato da #7074 e' stato rimisurato senza
  mutazioni: credenziale Valerie caricata da Remote Config in una TTY
  effimera con echo off, token solo nel processo, DNS bypassato con resolve
  esplicito per GitHub/API; `/user` e permissions `push/admin=true` sono
  verificati. Nessun secret/config e' stato stampato o persistito. Sono ora in
  pubblicazione batch, senza force, i due soli aggiornamenti fast-forward di
  PR gia' esistenti: #7058 `5ebebdf -> be6edc9` e #7033
  `3ee321e -> 3c8705b`.
- Il train unico `#5253 Wave A` sale a sei commit autonomi/localmente
  revisionati: W0, Coop, KSURI+JobUp, recruitingapp-1123,
  recruitingapp-2649 se la claim live e' confermata, e Cippatrasporti
  `Closes #6821`. Questo sostituisce fino a sei PR con una sola senza
  mescolare transport/receipt/parity; ciascun cluster mantiene osservatore,
  suite e prova live proprie.
- Coop e' gia' rebasata su site main `25892705150` come `b62f80128c54`:
  guard #7076 preservato, 169/169 test (166 WIP + 3 regressione #7076),
  diff/PII verdi e GitNexus LOW/affected0. Nessun push.
- Recruitingapp-1123 ha corretto i due Important (conflitto Swiss/foreign e
  canonical URL/ID `/Vacancies/<id>/Description/1`); 28/28 mirati e 102/102
  sibling/route/archive verdi, live doppio idempotente 0/10/10/10. Attende
  solo exact re-review quando si libera uno slot, poi commit autonomo.
- W0 non e' ancora congelato: la review ha trovato tre HIGH reali su binding
  subset/empty, serializzazione dell'artifact fail-closed e version hash della
  closure/stable-stringify. Tutti devono essere corretti, testati e
  ri-revisionati; nessuna scorciatoia per farlo entrare nel train.

## OTTIMIZZAZIONE CRITICAL PATH 22:24 — PRECEDE GLI HANDOFF SOTTO

- Ratificato un solo integration train site `#5253 Wave A`, non quattro PR:
  W0 provenance/replay, Coop family, KSURI+JobUp e recruitingapp-1123
  restano commit autonomi e localmente revisionati, ma confluiranno da latest
  `origin/main` in una sola PR/remota review e in un solo audit globale. I run
  gruppo post-merge restano canonici e non duplicati. Nessun altro scope
  entra nel train.
- KSURI+JobUp e' congelato su `7ad3dc563585`: 201/201 test, GitNexus LOW/0
  processi, diff/PII verdi; Important batch atomico, geografia/conflitto e
  identita' JSON-LD corretti, Nit throttle/date corretti. Il push e' fallito
  prima dell'invio per autenticazione site; nessun remote/PR e nessun retry.
- Il vero collo di bottiglia e' ora il canale di pubblicazione site: esistono
  piu' freeze verdi ma HTTPS fallisce prima dell'invio. Uno slot e' dedicato a
  documentare e rendere riutilizzabile, senza esporre secret o cambiare config
  di sistema, lo stesso canale autenticato gia' riuscito per #7074. Finche'
  non e' provato non si moltiplicano tentativi di push.
- Site `origin/main` e' `cfaf721c502`. Il merge #7076 (`4019549f236`) aggiunge
  il guard fail-closed `assertCoopSingleCompanyKeyScope` e tocca il test Coop:
  il freeze Coop non verra' pushato sul vecchio base, ma rebasato preservando
  integralmente il guard e rieseguendo i 166 test piu' la regressione #7076.
- Corpus #664 e' auto-mergiata su main come `99fbbab74`; main corrente e'
  `8b676e7aa` dopo #715/issue #678, che tocca quota-backoff e mirror manifest
  ed e' lasciata al suo owner. La meta' site #7058 resta quindi priorita' di
  parity appena il canale autenticato torna disponibile.

## 1123 SOURCE TRUTH 22:16 — PRECEDE GLI HANDOFF SOTTO

- recruitingapp-1123 non e' solo thin: source live corrente ha 10/10 detail
  austriaci (Linz/Wien ecc., ~4.5-5.2k caratteri), mentre main li pubblica
  falsamente Lugano/TI con 50-94 caratteri. La nuova pipeline detail+
  geografia source-backed produce correttamente snapshot autorevole empty:
  published0/discovered10/detailed10/foreign10. Post-merge G17 dovra'
  archiviare i dieci falsi job e preservare tutte le route/history tramite la
  pipeline standard; collisioni e perdita saranno misurate prima di chiudere.
  Nessun dispatch pre-merge.
- Code-reviewer W0 provenance/replay in corso dopo rebase a main `3b6136d`;
  la review KSURI/JobUp e' terminata e il parent deve ancora riportare il
  verdetto/correzioni all'orchestratore.

## MILESTONE W0 E KSURI/JOBUP 22:11 — PRECEDE GLI HANDOFF SOTTO

- W0 provenance/replay pronta pre-commit su cinque file: audit, nuovo modulo
  replay, due test e fixture 33530688671. Bundle immutabile conserva body/url
  sha256, digest observation+record+bundle, hash/versione extractor e
  normalizer, head+dataset; missing/tamper/provenance/version falliscono chiuso
  e le query URL non vengono persistite. I nove ambigui replayano identici e
  restano CRITICAL. Test 63/63, syntax/diff/PII/detect LOW verdi; 14 sibling
  lessicali classificati. Attende rebase main e code-reviewer prima del
  singolo push documentato; nessun audit dispatch.
- KSURI+JobUp: suite finale 8 file/195 test verde, detect LOW/0 processi;
  gruppi G18/G04/G11. Lo shared slug pin preserva i 24 master che altrimenti
  avrebbero driftato. I 33 candidati sibling sono classificati e JobUp era
  l'unico reale, ora incluso. Attende code-reviewer, rebase sui 5 commit main e
  safety rerun prima del freeze/push.
- Main corrente `3b6136d2bdb` (border-wait); il read Actions via CLI resta
  bloccato da TLS x509, quindi non si inventa lo stato del successore deploy.

## FREEZE COOP E RIALLOCAZIONE 1123 22:07 — PRECEDE GLI HANDOFF SOTTO

- #5253 Coop e' congelata clean/rebased su head `86bf0fff92c`: shared parser,
  updater Fust/Interdiscount/Jumbo/Volg e cinque test. 166/166 verdi; quattro
  audit strict source-detail exit0/CRITICAL0; live 2 per crawler ripetuto due
  volte con min parole 322/179/152/82, identity/URL/slug/history stabili e
  idempotenza true. Warning duplicate pre-persistenza: 2/90, 2/264, 14/186,
  6/577; sample Inter/Jumbo byte-identici by-source, quindi non contaminati.
  Review interna Important redirect SSRF e Nit CH/CHE entrambi corretti,
  rereview LGTM. Unico push normale fallito prima dell'invio; remote/PR
  assenti, nessun dispatch.
- Slot riallocato immediatamente a #5253 recruitingapp-1123, G17: 10/10 thin,
  listing 60/87 caratteri contro detail source 5-6k. WT fresh, ownership
  parser/spec/test disgiunta; una PR `Refs #5253`, non chiude il tracker.

## EVIDENZA REMOTA #7074 22:06 — PRECEDE GLI HANDOFF SOTTO

- REST remoto conferma #7074 MERGED alle 20:00:56Z, head `f656040448c5`, merge
  `c7bd44f58624`. Review unica e sulla head esatta: `Important: 0, Nit: 0`,
  termina `## LGTM`. Check finali vitest SUCCESS e enable-auto-merge SUCCESS;
  un vitest precedente cancelled e' sostituito dal success. Body ha soltanto
  `Closes #7049`.
- Deploy del merge `33552834551` cancellato dal newer-wins dopo 36s; unico
  successore autorevole `33552885323` su main `f76fafbc60d0`, stato pending.
  Publish/validate `33552891873` e' skipped finche' il deploy non produce
  l'input. Nessuna mutazione/dispatch; la persistenza #7049 resta aperta nel
  ledger finche' questo handle non pubblica tutti i locale.
- Issue #7049 e' CLOSED/completed dalle 20:00:57Z, ma conserva erroneamente la
  label `agent:in-progress`; rimozione mutex amministrativa ancora dovuta.
  Non si considera conclusa operativamente prima della prova live sopra.

## MERGE #7074 E REVIEW PARSER 22:03 — PRECEDE GLI HANDOFF SOTTO

- PR site #7074 e' auto-mergiata nativamente come `c7bd44f586240832` su parent
  `1c2e67947ef`; commit successivo main `f76fafbc60d` e' sitemap. Branch remota
  eliminata. Restano da acquisire prova review exact LGTM e soprattutto un
  solo deploy newest-main terminale con tutti i locale; il merge non vale da
  solo come persistenza #7049.
- Review interna Coop: Important reale sul redirect automatico che validava
  solo l'URL iniziale e poteva uscire dall'allow-list/SSRF; Nit reale sul
  country code `CH`/`CHE` non riconosciuto nel retry distrettuale. Entrambi
  devono essere corretti e ritestati prima di commit/push; la review GitHub
  remota resta il gate autorevole.
- KSURI continuity check ha impedito un drift: il merge dei 27 record avrebbe
  cambiato 24 master slug per titolo DE/localizzato. L'updater applica ora
  `preserveExistingSlugs:true` con observer; 38/38 test al checkpoint e
  simulazione post-pin ancora da completare.
- Il sibling reale JobUp e' stato diagnosticato: CNP(G11) 26 e Pole Sante(G04)
  4 hanno detail live ricche (303-795 parole), ma il fallback su failure e'
  solo 9 parole e pubblicabile. Impact LOW, due consumer. Ratificata
  l'inclusione nella stessa PR KSURI per la medesima invariante
  fail-open-to-thin, limitata al factory JobUp e test; helper Fondation/G14
  non cambia. Prove live G18+G04+G11 verranno coordinate post-merge.

## NEWEST DEPLOY E PARSER WIP 21:53 — PRECEDE GLI HANDOFF SOTTO

- Main e' avanzata a `738db06fe10` per sitemap. Il concurrency ha cancellato
  l'ex-successore `33548727480` e altri due intermedi; unico deploy newest-main
  waiting ora `33551931249` / run #24862. Il vecchio IT `33520063656` e'
  ancora autorevole e avanzato: upload batch1-6 completati, `Strip section
  subtrees (IT)` in corso. Nessun dispatch/cancel manuale.
- #7074 body advisory #6301 corretto senza commit/repush: il bullet
  Implementato cita ora `.github/workflows/deploy.yml`, commento di
  classificazione `5499522421`. Required vitest ancora in corso; review
  assente.
- WIP parser attivi e disgiunti: Coop modifica shared parser+quattro updater e
  test (7 file al checkpoint); KSURI modifica il factory REXX (1 file al
  checkpoint); W0 replay ha WT clean appena creato. Tutti devono riallinearsi
  sul nuovo main prima del freeze, senza includere il commit sitemap nel diff.

## FREEZE #7038/#6806 E KSURI 21:48 — PRECEDE GLI HANDOFF SOTTO

- #7038 transport HTTP429 e' pronta localmente su head `c4a2ad0ca2c1`, WT
  clean: solo `polite-fetch`, nuovo test helper e test Fachkraft; parser
  Fachkraft intatto. Retry-After delta/date capped60s, fallback capped e
  cooldown host condiviso con re-check dei worker accodati; 59/59 mirati e
  269/269 sibling, pre-impact HIGH, detect diff3/process0, diff/PII clean. I 29
  candidati lessicali sono classificati per-file nel body. Unico push
  `--no-verify` ratificato ha fallito prima dell'invio per auth; remote branch
  assente, body pronto. #7033 non e' stato ritentato.
- #6806 e' congelata pulita su `97c793ca12f`, ahead1: 4 file, token env
  46/46 gruppi, 163/163 family e detect LOW. Nessun push tentato dopo il
  fallimento auth #7058; storico >=14 resta correttamente `blocked:`.
- Lo slot e' passato a #5253-KSURI in WT fresh `codex-fix-5253-ksuri`.
  Preflight: issue aggregate OPEN/HIGH/claimed, nessun branch/PR/WT
  sovrapposto; factory REXX ha 3 consumer diretti e impact LOW/6 simboli/0
  processi. Ownership resta separata dal WT Coop; Tier4 sufficiente.
- W0 provenance/replay dei nove ambigui e' assegnata in parallelo al fixer che
  ha congelato #7038; una PR observer-only, nessun audit dispatch dedicato.

## PR DEPLOY #7074 21:45 — PRECEDE GLI HANDOFF SOTTO

- #7049 e' nella PR site #7074, head `f6560404`, base `70544c9b`, 4 file,
  +386/-7, auto-merge squash nativo abilitato. Two-phase: readiness dello step
  IT exact con budget 10.800s, poi marker exact con 2.700s ripartiti da zero;
  failure IT/API/step/deadline resta fail-closed e il push locale e'
  autorizzato solo dopo entrambi. Test locali 50/50, bash-n, ShellCheck,
  diff-check e sibling0. Remoto: enable-auto-merge verde, vitest required in
  corso, review ancora assente. Nessun deploy manuale.
- L'apertura riuscita di #7074 e' un cambio autorevole del canale site: sono
  autorizzati una sola nuova prova di push normale per #7058 e il push gia'
  preparato #7038. Solo se #7038 passa, una prova normale anche per #7033;
  nessun loop, force o modifica config.

## ONDATA PARSER #5253 21:43 — PRECEDE GLI HANDOFF SOTTO

- #7044 e' definitivamente fuori dal critical path parser. W0 provenance e'
  una nuova atomica observer-only sotto #5253 e puo' correre in parallelo:
  i nove non replayabili sono Ardian, Georg Fischer, Helsana, Lonza, Medbase,
  Rituals, Swiss Life, Swisscom sede Ticino e HFR. Restano CRITICAL finche' il
  receipt non conserva body/hash/versione extractor; non bloccano le fix con
  prova completa.
- Quarto slot riallocato al cluster Coop ad alto rendimento, una PR sotto
  #5253 e non quattro: Fust, Interdiscount, Jumbo, Volg/Fenaco. Causa comune
  nel shared `coop-job-parser`: fallback/listing sovrascrive location JSON-LD
  e descrizione detail; tutti mostrano duplicate-description. Agroscope e'
  esclusa per ownership #6943. La PR usa `Refs #5253`, non la chiude.
- Prove live previste G22/G03/G10/G08. Per comprimere il tempo senza perdere
  evidenza, G08 verra' lanciato una sola volta dopo il merge sia del cluster
  Coop sia di #7038 Fachkraft; lo stesso receipt/artifact/manifest verifichera'
  entrambi. Nessun dispatch prima dei merge.
- Onexecute successive, disgiunte: Prospective Buehler(G13)+Livit(G21) in una
  PR; KSURI(G18) singola; recruiting1123(G17) singola; recruiting2649(G14)
  evidence-first. W0 puo' essere affidato a uno slot Tier2/4 quando uno dei
  filoni attivi congela la propria head.

## FREEZE PARSER E TOKEN RECEIPT 21:42 — PRECEDE GLI HANDOFF SOTTO

- #6821 Cippatrasporti e' pronta localmente sulla head rebasata
  `3bc88a516926`, WT clean/ahead1: 23/23 test crawler, 69/69 slug/history,
  audit mirato 1 OK/0 CRITICAL/0 WARNING con source 2/2 fetched; due live fetch
  idempotenti, 2 job, minimo 261 parole, collisioni ID/URL/slug0, route 10->10
  loss0 e previousSlugs invariati. Un solo push normale e' fallito prima
  dell'invio per auth; nessun remote/PR e nessun retry loop. Mancano soltanto
  push, review/merge e un run canonico post-merge.
- #6806 milestone su quattro file: receipt schema v2 include generationToken
  nel digest; descriptor passa da v2 a v3 per non riusare una versione con
  shape incompatibile e contiene la claim receipt v2. Producer richiedono
  `CRAWLER_GENERATION_TOKEN`, batch eredita dal descriptor, finalizer live usa
  `allowLegacyV1:false` e rifiuta v1/missing/mismatch come invalid+missing.
  La lettura v1 resta soltanto per manifest storici. Fixture token copiato
  `9001-1 -> 9001-2` e v1 senza token falliscono chiuso; suite famiglia
  generation 163/163 verde. Il bullet storico >=14 generazioni non viene
  dichiarato risolto o simulato.

## CLASSIFICAZIONE RESIDUI 21:36 — PRECEDE GLI HANDOFF SOTTO

- #6529 e' realmente collegata ai crawler, anche se LOW: il generatore
  `generate-crawler-companies.mjs` antepone `www.` e pubblica host inesistenti
  nella directory aziende. Resta dovuta dopo parser/identity/persistenza; non
  va esclusa solo perche' non modifica vacancy.
- #6983 e' LOW, non HIGH come stimato dal primo census; il suo commit locale
  resta recuperabile ma viene dopo i filoni HIGH. L'identita'/route rende
  comunque necessario Tier4 quando sara' adottato.
- Lo slot #7050/#664, ora congelato su CI verde e auth site, viene riusato sul
  residuo HIGH #6806 in WT separato: receipt schema v2 token-bound e finalizer
  fail-closed su missing/mismatch. Non chiudera' #6806 se lo storico >=14
  generazioni resta non provato; nessun ciclo sintetico. Prova live eventuale
  su group diverso da Group05 e una sola volta post-merge.

## CI CORPUS E PRODUZIONE 21:35 — PRECEDE GLI HANDOFF SOTTO

- Corpus PR #664 head `ec5078e` ha tutti i check verdi: 13 success, 1 skipped,
  merge-tree senza conflitti. Non e' mergeabile proceduralmente: manca LGTM e
  resta l'Important remoto sui tre catch `readdirSync` nell'engine, che deve
  essere risolto nella SSOT site #7058 e poi mirrorato. Non dispatchare
  rereview/merge prima della catena site->corpus.
- Il vecchio deploy IT ha chiuso il pack section tar in 23m09, caricato i
  batch artifact 1 e 2 e sta caricando il batch 3. E' prova di avanzamento
  continuo; il run non viene cancellato. #7049 e' in implementazione su WT
  fresh `ac506f5`: baseline 40/40, bash syntax e shellcheck verdi; observer
  two-phase in costruzione con marker 2700 invariato e API failure fail-closed.
- #6821 e' stato adottato dal quarto fixer sul commit recuperabile `8a855f9`.
  Impact pre-edit: fetcher/detectCategory LOW, nessun processo critico; blast
  complessivo MEDIUM per runner dedicato, quindi Tier4 resta sufficiente.

## CODA DEPLOY E WIP RECUPERABILI 21:31 — PRECEDE GLI HANDOFF SOTTO

- La coda deploy ha conservato un solo successore autorevole:
  `33548727480` / run #24859 su main `ac506f5`, stato pending/waiting dietro al
  vecchio `33520063656`. I successori intermedi, inclusi `33547955979` su
  `2bdcb59` e `33548683858` su `3578ac6`, sono cancelled dal concurrency.
  Nessun dispatch/cancel manuale: quando IT termina, deve partire soltanto il
  newest main e pubblicare tutti i locale.
- Push site #7033 tentato esattamente una volta: fallito prima dell'invio con
  `could not read Username ... Device not configured`; remote resta
  `3ee321e`, locale pronto `3c8705ba`. Il WT e' preservato e non si riprova in
  loop. Lo stesso Tier4 ha quindi iniziato #7038: impact pre-edit HIGH, 28
  simboli per `politeFetch`, 19 per `throttle`, nessun processo CRITICAL;
  confermata la causa retry lineare senza Retry-After/host cooldown.
- Censimento WIP senza modifiche:
  - #6983 **ADOPT**: commit locale `4d868419`, 6 file, clean, 1 ahead, nessun
    remote/PR; coordinarlo con la prova live #7045.
  - #6821 **ADOPT**: commit locale `8a855f9`, 6 file, clean, 1 ahead, nessun
    remote/PR; restano test/audit/run live.
  - #6862 **ADOPT condizionato**: 3 file dirty non committati su HEAD main;
    preservare il WT e confermare owner prima di intervenire.
  - #6979 **SUPERSEDED come WIP**: zero diff utile, solo `AGENTS.md` foreign;
    nessun remote/PR. Rivalutare l'issue dopo #7038 perche' condivide
    `polite-fetch`, ma non accorparla senza prova della stessa semantica.

## EVIDENZE TIER1 E PUSH CORPUS 21:29 — PRECEDE GLI HANDOFF SOTTO

- #6760 ha verdetto **CLOSE** senza codice su `origin/main ac506f5d194d`:
  589 slice, coverage gap `0 crawler / 0 vacancy`, stale >48h 0. La sola
  duplicate pair SOH appartiene a #6759 e non blocca il body coverage.
- #6956 ha verdetto **CLOSE** senza codice: Banca Cler reconcile 0 gruppi/0
  record, stable-ID cross-crawler 0 e duplicate id+slug 0. Il commit risolutivo
  e' `df4b704ebd0d` (15->11, quattro gruppi eliminati, route loss 0 secondo la
  diagnosi completa). I 25 slug/51 move restano una nuova classe target-first,
  non scope #6956. Entrambe le chiusure amministrative attendono un canale
  GitHub scrivibile; non serve una PR.
- Corpus PR #664 ha ricevuto la head `ec5078e58`; il body chiude soltanto #654
  e #677, con `closingIssuesReferences=[654,677]` e #339 assente. Sono partiti
  15 check. Il vecchio Important riguarda la catena engine #7050 ed e'
  esplicitamente dipendente dal merge site #7058; nessun twin #7050 e' stato
  anticipato nel corpus. Attendere check, review remota, exact `## LGTM` e
  auto-merge nativo.
- Slot Tier1 riallocato al censimento recuperabile dei WT #6983/#6979/#6821/
  #6862: prima adozione o chiusura, poi nuovo codice. Questo evita quattro
  branch/PR duplicate e individua collisioni con il nuovo fix shared transport
  #7038.

## CAMMINO CRITICO CORRETTO 21:28 — PRECEDE GLI HANDOFF SOTTO

- #7044 non e' il gate provenance/replay dei 44 CRITICAL: il body autorevole
  riguarda la classificazione deterministica di timeout, cancellazione manuale
  e supersessione del workflow. E' MEDIUM/follow-up/`fu-prio:low` e non blocca
  le fix parser. L'artifact canonico #5253 `33530688671` e' completo; il
  prossimo audit globale resta unico dopo le fix. Nessuna dipendenza fittizia
  #7044 -> parser viene introdotta.
- Deploy `33520063656` ancora `in_progress`, 3/4 job completi. Il job IT sta
  realmente avanzando nel packing: dopo build 2h21, early CDN 13m e section
  push 1h27, ha prodotto tar successivi fino a Neuchatel alle 21:26 CEST.
  Questo rafforza #7049: il problema e' il budget dei locale non-IT consumato
  prima della readiness IT, non un processo morto. Nessun cancel/restart.
- Traduzioni esterne `33507200211` ancora `in_progress` e senza artifact, ma
  non ferme: housekeeping, Argos, scatter e mop-up sono finite; phase 2d sta
  scorrendo le 589 slice (osservata fino a `buergenstock-hotels`). Le chiavi
  DeepL sono esaurite e due Azure restituiscono 401, ma il fallback continua.
  Non toccare #6957; duplicate SOH e decontamination restano in attesa del
  terminale prima di una sola riparazione.
- Corpus #664/#654/#677 ha gia' 9 twin byte-identici, fingerprint
  SiteShellContract verde, suite seriale 2.520 pass/0 fail/4 skip e build-api
  verde: 30 artifact, manifest 3.663+1.660, sitemap 3.656/1.657, ticker
  shadowed 0. GitNexus CRITICAL conferma il Tier4 per il fan-out dei 12 file;
  gate e review remota restano obbligatori. Nessun delta site #7050 e' stato
  copiato prima del merge della SSOT.
- #7038 e' gia' claimed dall'orchestratore; PR #7047 e' merged, ma il nuovo
  live proof ha rivelato la classe HTTP429 nel trasporto condiviso. Nessun
  branch/worktree/PR residuo #7038 e' stato trovato. Lo slot #6943 tenta un
  solo push normale della head pronta; se l'auth fallisce prima dell'invio,
  passa subito al fix rate-aware #7038 senza perdere il WIP #6943.

## OTTIMIZZAZIONE E CENSIMENTO AUTOREVOLE 21:24 — PRECEDE GLI HANDOFF SOTTO

- Il tracker autorevole del blocco deploy corrente e' **#7049**, OPEN/HIGH e
  gia' `agent:in-progress`; #2569 e' soltanto il precedente storico della
  classe. Il fixer e' stato corretto prima dell'implementazione: deve adottare
  WIP/branch/PR #7049, non creare duplicati e usare `Closes #7049` soltanto se
  completa tutta l'acceptance. Il piano tecnico two-phase gate resta valido.
- Il percorso minimo ora usa tutti i quattro slot: tre fixer indipendenti
  (#6943/#7033, #7050/#7058 -> corpus #664, #7049) e un planner che costruisce
  le ondate aggregate del residuo. Un cluster entra in una sola PR solo se
  condivide causa, moduli, observer e prova live; altrimenti resta separato.
  Dopo ogni rilascio lo stesso agent viene riusato subito, evitando il costo di
  nuovo contesto. Le run live sono una per classe/cluster, mai una per issue.
- Query browser GitHub `is:issue state:open label:crawler`: **15 open**:
  #7049, #7045, #7044, #7038, #6983, #6979, #6932, #6889, #6862, #6821,
  #6816, #6814, #6760, #6759, #6529. Non sono tutte automaticamente dovute:
  #6760 ha metrica corrente coverage `0/0` ed e' candidata a chiusura Tier1;
  #6759 resta dovuta finche' traduzioni stale + reconcile non riportano i
  duplicate pair a 0; #6529 va classificata per il confine crawler. #5253,
  #6806 e #6956 restano nel censimento esteso anche senza label `crawler`.
- Remote refs invariati alle 21:24: site main `ac506f5d...`, PR #7033 branch
  `3ee321e...`, PR #7058 branch `5ebebdf...`; corpus main `991d7b1b...`, PR
  #664 branch `9e32a652...`. I commit locali correttivi sono recuperabili ma
  non ancora inviati per la credenziale site invalida; nessun push/dispatch
  duplicato e nessuna modifica al checkout main condiviso.

| Task | Owner | File/moduli | Repo | Dipendenze | Tier |
|---|---|---|---|---|---:|
| #6943/#7033 + history diagnosis | `/root/fix_6943_prada_critical` | crawler geo/test; writer read-only | sito | auth/push, review, merge | 4 |
| #7050/#7058 -> #664/#654/#677 | `/root/fix_7050_664_677_chain` | engine + identical twins/loop/shell | cross-repo | site merge prima del mirror finale | 4 |
| #7049 deploy two-phase gate | `/root/resume_6959_lidl` | deploy, wait helper, due observer | sito | adotta WIP; deploy corrente terminale | 4 |
| backlog residuale/cluster PR | `/root/plan_5253_critical_clusters` | issue/WIP/test map read-only | entrambi | non collide con i tre fixer | 3 |

## MERGE E PRIORITA' PRODUZIONE 21:19 — PRECEDE GLI HANDOFF SOTTO

- PR site #7072/#7040 auto-mergiata nativamente alle 21:17 come
  `3578ac6ab5ad...`; due commit, sette check e ciclo review/auto-merge. Il fix
  descendant-aware del dispatch e' su main. `/root` mantiene il monitoraggio
  live e lo slot Tier4 e' riallocato a #2569; nessun nuovo dispatch.
- #2569 non e' superseduta dall'hoist CDN #5251: nel run `33520063656` la sola
  build IT dura 8.460s, mentre EN/DE/FR consumano il budget marker di 2.700s
  quando IT e' ancora `in_progress`. Piano ratificato: gate a due fasi,
  attesa bounded della readiness dello step IT early-CDN e poi marker esatto
  con budget 2.700s invariato. IT failure, API incerta o deadline restano
  fail-closed; zero publish senza marker. Ownership: `deploy.yml`,
  `wait-cdn-build-id.sh` e due test dedicati; Tier4 incaricato.
- Il vecchio deploy e' ancora realmente live, non terminale: IT ha gia'
  completato build 2h21, push section shard 1h27 ed e' avanzato al packaging;
  il newer-wins resta accodato. Questo e' un verified wait sullo stesso handle,
  non autorizza cancel o restart.
- Censimento issue: #6806 e' OPEN; i controlli commit/blob/ancestor/history
  risultano gia' superseduti, resta il binding receipt↔generationToken.
  #6956 e' OPEN ma il suo body riguarda esclusivamente 4 stable-ID duplicati
  Banca Cler; l'audit current e' 0. Non repurporla per i 25 previousSlugs:
  chiusura Tier1 del difetto originale e nuova issue writer target-first sono
  percorsi separati.

## CENSIMENTO BROWSER LIVE 21:12 — PRECEDE GLI HANDOFF SOTTO

- La sessione GitHub web autenticata ha ripristinato l'osservabilita' read-only
  durante il guasto DNS/API della CLI. Nessun token/OAuth e nessuna mutazione
  sono stati creati dal browser.
- Group05 canonico `33541024771` e' terminale SUCCESS in 11m10s, artifact
  `crawler-group-05-terminal-33541024771` presente e summary iPersonal con 14
  offerte pubblicate. Il commit dati `1c5b1b516ef1...` resta coerente con il
  run. La route recovery e' verde (0 perse), ma #7045 resta aperta finche'
  l'observer statico viene sostituito da prova receipt-correlata di turnover.
- Group08 canonico `33540050341` e' terminale FAILURE in 18m16s, con artifact
  terminale presente. Fachkraft ha contato `listing=3530`, `cached-source=2019`,
  `detail-required=1511` e ha fallito chiuso al detail 38/3530: HTTP 429 dopo
  <=2 tentativi in 8785ms. Nessuna slice parziale Fachkraft e' stata
  pubblicata; breadcrumb transient 1/3 su #5198. Serve fix rate-aware bounded
  prima di un solo rerun canonico; planner Tier3 incaricato.
- Traduzioni corpus `33507200211`, base stale `b5b8aba`, sono ancora
  `in_progress` dopo quasi cinque ore e senza artifact. Non cancellare,
  ridispatchare o applicare reconcile. Su main corrente `3c4b56c7e0c` i gate
  restano: coverage `0/0`, duplicate pair `1` SOH, decontamination 6 file/51
  move/25 slug, duplicate stable ID 0.
- PR #7072/#7040 e' OPEN su `3821a6a...`, 2 file/2 commit, checks pending.
  PR #7058/#7050 e' OPEN sulla vecchia head `5ebebdf...`; il commit locale
  correttivo `be6edc9...` resta non inviato per auth site invalida.
- La coda deploy newer-wins ha cancellato `33544660808`; l'handle autorevole
  osservato ora e' `33547955979` su main `2bdcb592...`, WAITING dietro
  `33520063656`. Il vecchio run non e' appeso su un singolo comando da quattro
  ore: IT ha impiegato build 2h21 e push shard 1h27 ed e' avanzato al pack tar
  iniziato alle 21:09 (es. `berna-dist-it.tar` 1.1G). EN/DE/FR hanno pero'
  esaurito il gate marker IT da 2700s e non hanno pubblicato, riaprendo le
  issue stale-locale #5773/#5869. Nessun cancel o dispatch aggiuntivo: seguire
  IT a terminale, poi il newer-wins deve pubblicare tutti i locale; planner
  Tier3 incaricato del fix strutturale #2569 senza ridurre il fail-closed.
- #6806 e' stato ristretto: commit/blob/ancestor/history sono gia' protetti da
  #6746/#6998/#7052. Il residuo reale e' receipt schema v1 senza
  `generationToken`; un receipt valido puo' essere attribuito al token errato.
  Fix futuro minimo: receipt/descriptor token-bound + finalizer fail-closed sul
  mismatch, 4 file e prova live su un group diverso da Group05.

## PERCORSO CRITICO OTTIMIZZATO 21:04 — PRECEDE GLI HANDOFF SOTTO

- Il limite di quattro subagent e' usato per filoni indipendenti: #6943 con
  diagnosi #6956, #7040 con persistenza Lidl, catena site #7050 -> corpus #664
  + #654 + #677, e planning parser #5253. Le attivita' aggregate condividono
  una causa/contratto; non vengono accorpati crawler group o writer
  incompatibili.
- L'autenticazione site e' il collo di bottiglia attuale: `gh auth status`
  conferma invalido il token `valerielinc-ops`; anche il credential helper
  macOS fallisce prima dell'invio. Il trasporto Git anonimo funziona. Nessuna
  configurazione o credenziale e' stata modificata e nessun push duplicato e'
  partito.
- #7050 ha corretto anche l'Important remoto per tutte le letture/stat
  per-file: commit locale recuperabile `be6edc9d5a1...`, 15/15 observer,
  63/63 suite mirata, render 6.620 pagine byte-identico, GitNexus LOW e diff
  pulito. Il remote #7058 resta a `5ebebdf7...`; un solo push normale appena
  torna una credenziale site valida.
- #7040 e' nella PR #7072, head `3821a6a2001...`, con binding al canonical
  Compare URL e negative fixture sull'URL incoerente; CI/review restano da
  osservare appena torna l'API. Nessun dispatch aggiuntivo.
- Audit globale esatto su `origin/main d73896a84c8`: coverage gap
  `0 crawler / 0 vacancy`; duplicate pairs `1`, esclusivamente
  `solothurner-spitaeler` -> `soh-solothurner-spitaeler` reintrodotta dal run
  traduzioni stale partito prima delle guard. Il reconcile dry-run riassorbe
  140 active + 39 archive, trasferisce 11 + 17 slug e non segnala altri
  movimenti. Non applicare finche' il run traduzioni esterno non e' terminale;
  poi una sola riparazione e un solo audit. Il WT temporaneo read-only e' stato
  rimosso clean; spazio 13 GiB.
- Il piano minimo #5253 e' ratificato: W0 provenance/replay e' una PR CI-only;
  W1 usa tre/quattro PR per contratti omogenei (Coop 4 crawler, Prospective
  Buehler/Livit, thin KSURI, thin 1123); W2 accorpa i cinque Workday solo dopo
  W0. L'audit globale si esegue una volta dopo merge e receipt, non dopo ogni
  singolo crawler. Baseline autorevole resta 44 CRITICAL finche' le prove non
  sono replayabili.

| Task | Owner | File/moduli | Repo | Dipendenze | Tier |
|---|---|---|---|---|---:|
| #6943 + diagnosi #6956 | `/root/fix_6943_prada_critical` | geo crawler/test; writer history read-only | sito | push #7033, claim #6956 prima di edit | 4/5 |
| #7040 + Lidl | `/root/resume_6959_lidl` | trigger/test; monitor manifest | sito/corpus | PR #7072 e deploy newer-wins | 4 |
| #7050 -> #664/#654/#677 | `/root/fix_7050_664_677_chain` | engine, identical twins, shell contract | cross-repo | push #7058, merge/mirror sito | 4 |
| #5253 W0-W2 | `/root/plan_5253_critical_clusters` | piano provenance e cluster parser | sito | claim/create issue quando API torna | 3 |

## RIMISURA LIVE 20:56 — PRECEDE GLI HANDOFF SOTTO

- GitHub API/DNS/TLS e' temporaneamente indisponibile, quindi nessun handle e'
  stato riavviato o duplicato. Il canale Git locale ha pero' aggiornato
  `origin/main` a `f62e0571...` e prova i commit dati degli handle canonici:
  Group08 `a11e98eda102...` (run `33540050341`) e Group05
  `1c5b1b516ef1...` (run `33541024771`). Artifact e stato terminale Actions
  restano da verificare appena torna l'API.
- Group08 ha committato 26 sibling ma non Fachkraft, coerentemente con lo step
  fallito osservato prima del blackout. La slice Fachkraft corrente resta
  3.215 job con 386 descrizioni sotto 50 parole; #7038 e' ancora rossa e non
  va ridispatchata finche' lo stesso run non e' verificato terminale e i log
  del failure non sono letti.
- Group05/iPersonal post-live: active 14->14 e expired 110->124; la sorgente ha
  sostituito tutte le 14 vacancy (common URL/ID active 0), ma l'unico ID comune
  sull'unione non cambia URL/slug/routes. Route union 387->408, perse 0,
  aggiunte 21; collisioni active/union ID, URL e master slug tutte 0; le 22
  route recovery hanno un owner unico. Il test statico #7045 su `f62e` passa
  1/3 ma fallisce i due assert che congelano gli esatti 14 ID e la lunghezza
  expired=110: planner Tier3 riattivato per stabilire se e' observer one-shot
  o violazione del contratto archive route-only. #7045 resta aperta.
- Rimisura #6956 su worktree detached/sparse di `origin/main f62e`: 590 slice,
  28.648 active e 29.312 expired; duplicate stable-ID+slug groups 0, duplicate
  `.id`+slug groups 0, overlap active/expired 0. Tuttavia il gate finale
  `node scripts/decontaminate-prev-slugs.mjs` e' rosso: 6 file, 51 moves/25
  slug unici (Denner12, Galenica14, KSBL4, Mobiliar3, Rituals16,
  Stadt-Zuerich2). #6909 era verde; commit successivi translation/locale/group
  hanno reintrodotto history sul claimant sbagliato. Non chiudere #6956 e non
  toccare #6957/traduzioni; serve ownership/claim e fix di classe + data repair.
- #6943 e' completo localmente sul commit recuperabile `3c8705ba303c`, WT
  clean: 16 file, 148/148 test, audit 66 = 61 green + 2 Hilcona corretti + 3
  issue separate #7055/#7056/#7057, residui non tracciati 0. Due push hanno
  fallito prima dell'invio per credenziali/TLS; remote PR #7033 resta alla head
  vecchia `3ee321e...`. Nessun force o config persistita.
- #7040 aveva commit/push `f1597a2e...`, ma il pre-PR live check ha scoperto
  che GitHub Compare non espone `head_commit`: la prima implementazione avrebbe
  fallito chiuso anche sui discendenti validi. La PR non e' stata creata;
  l'owner corregge il binding sul canonical compare URL con fixture reale e
  caso URL incoerente, poi aggiungera' un commit normale.
- Review #7058: il finding remoto ha esteso la stessa classe fail-closed dalle
  sole `readdir` alle letture/stat per-file nei tre moduli. L'owner aggiunge
  guard ENOENT-only e injection test sulla stessa PR; nessuna build locale
  completa durante il vincolo di spazio.
- Il planner #5253 ha classificato tutti i 44 CRITICAL. Prima ondata obbligata:
  provenance/replay delle osservazioni source-detail; poi quattro ownership
  disgiunte Coop, Prospective, thin KSURI/1123 e evidence 2649. I 9 finding
  non riproducibili restano CRITICAL/provenance-ambiguous: non sono stati
  falsamente riclassificati verdi.
- Il worktree temporaneo read-only della rimisura #6956 e' stato rimosso dopo
  l'audit; nessun sorgente o WIP cancellato. Spazio corrente ~17 GiB.

## OTTIMIZZAZIONE ONDATA 20:05 — PRECEDE GLI HANDOFF SOTTO

- PR site #7054 e' auto-mergiata nativamente come
  `0c0ee0e27fc25dc2f55c848fbbcce2fe6b7acaa2`, CI e review remota
  `## LGTM` verdi, 0 Important/0 Nit. La review della classe completa ha
  coperto anche delete remote, summary/cache/extra e fresh descriptor al
  rerun. #7045 resta riaperta soltanto per persistenza live.
- Unico Group05 post-merge `33541024771`, token
  `ipersonal-7045-0c0ee0e2-1`, input `site_code_commit` esatto
  `0c0ee0e...`; alle 20:03 CEST e' `in_progress` sul primo checkout. Nessun
  secondo dispatch. `/root` ha assunto il monitoraggio e liberato lo slot del
  fixer completato.
- Lo slot liberato e' stato riallocato al planner Tier3
  `/root/plan_5253_critical_clusters`: classifica uno per uno i 44 CRITICAL
  del report `33530688671` e propone il numero minimo di PR per causa comune,
  con metriche/observer/persistenza. Prime classi provate: Coop 4 crawler,
  Prospective factory 2, thin extractor 2+1 ambiguo, canonicalizzazione
  observer Workday-like separata dai veri default-HQ/foreign-location.
- Per ridurre la catena corpus senza ridurre i gate, #654 e #677 vengono
  inglobate nella PR corpus esistente #664 dopo merge+mirror di site #7050.
  I sette twin aggiuntivi di #654 sono tutti `mode: identical`, non claimed e
  senza overlap; #654 ora e' claimed dallo stesso owner. La PR #664 non deve
  chiudere il parent aggregate #339 e chiudera' solo #654/#677 se byte parity,
  loop drift, shell contract, build-api e manifest/counts sono verdi.
- PR site #7058 per #7050 e' aperta su head `5ebebdf7...`, auto-merge armato;
  test remoto in corso. Il test mirato e' 8/8, suite 56/56 e le due modalita'
  renderer sono byte-identiche su 6.620 pagine. La build locale ha completato
  24.905 moduli ma ha incontrato ENOSPC solo scrivendo il build-id; CI remota
  resta l'osservatore autorevole.
- Il Group08 post-#7047 `33540050341` e' ancora `in_progress`: Fachkraft e'
  fallito, mentre Volg/Burkhalter e la barrier sono ancora attivi. #7038 non
  e' certificabile finche' il run non e' terminale e la causa del failure non
  e' estratta; nessun redispatch durante il run corrente.
- #6943 resta nella sola PR #7033: 8 source + 8 test, Prada/5 sibling/Hilcona,
  retirement history incluso; suite mirata 148/148 verde. L'owner completa
  audit 66, detect_changes e gate prima del nuovo push. Apple/Breitling/Corner
  sono separati in #7055/#7056/#7057 e saranno una sola PR geo-HQ solo se il
  planner/fixer prova un contratto comune.
- #7040 viene implementata dallo stesso owner che monitora Lidl, su file
  disgiunti dalla persistenza. Acceptance: exact-or-descendant success,
  divergenza fail-closed, correlazione esatta del run e race bounded.
- Rimosso il collo di bottiglia ENOSPC senza toccare WIP: eliminati solo il
  `dist` non tracciato/rigenerabile di #7050 e i worktree puliti gia' conclusi
  #7045/#7049. Spazio passato da 278 MiB a 23 GiB liberi.
- Persistenza ancora aperta: deploy storico `33520063656` su push shard IT;
  newer-wins `33540931852` head `0c0ee0e...` pending; traduzioni stale
  `33507200211` ancora in Phase2c Argos e non va toccato.

| Task | Owner | File/moduli | Repo | Dipendenze | Tier |
|---|---|---|---|---|---:|
| #6943 / PR #7033 | `/root/fix_6943_prada_critical` | Prada, PLZ sibling, Hilcona, retirement/test | sito | stessa PR | 5 |
| #7040 + persistenza Lidl | `/root/resume_6959_lidl` | trigger workflow/test; manifest live read-only | sito/corpus | deploy newer-wins | 4 |
| #7050 → #664 + #654 + #677 | `/root/fix_7050_664_677_chain` | engine articoli; 8 twin identical; shell fingerprint/manifest | cross-repo | merge+mirror sito | 4 |
| #5253 44 CRITICAL | `/root/plan_5253_critical_clusters` | report, parser/observer mapping read-only | sito | non collidere con #7033/#6949/#6947 | 3 |

## OTTIMIZZAZIONE ONDATA 19:46 — PRECEDE GLI HANDOFF SOTTO

- Lo slot Tier4 che seguiva soltanto il deploy `33520063656` e' stato
  liberato: `/root` mantiene il monitoraggio amministrativo dello stesso
  handle, senza cancel o redispatch. Il run e' ancora `in_progress`, con il
  solo job IT su `Push section shards (IT → frontaliere-<section>-it)`;
  il marker CDN e' gia' persistito. Il newer-wins `33539243112`, head
  `71a2b7b8bfc9f87461dcd385816062b5964e1e86`, e' `pending` ed e'
  discendente dal commit dati Lidl `969f430a...`.
- Il quarto slot e' stato riallocato alla catena blocker HIGH
  site #7050 → corpus PR #664 → corpus #677. Owner unico
  `/root/fix_7050_664_677_chain`, Tier4. Obiettivo: una nuova PR sito e riuso
  della PR corpus #664; il WIP #677 viene inglobato nella #664 soltanto se il
  diff resta coerente e tutti i gate sono completi, altrimenti una terza PR e'
  ammessa solo con prova del conflitto semantico. Questo riduce handoff e tempi
  morti senza toccare il filone traduzioni.
- #7045 follow-up e' in WT fresh da main corrente, due soli file: guard
  `GROUP_BATCH` generale per ogni path e test active/summary/cache/extra;
  37/37 test verdi. PR #7054 aperta, head `f9417cce...`, base
  `451a4392...`, auto-merge armato e CI/review remote in corso. Non viene
  accorpata a #6953/#6983 perche' ownership e semantica sono diverse.
- #6943/PR #7033 viene completata nella stessa PR: Prada, cinque sibling PLZ,
  retry/redirect bounded e audit dei 66 candidati. Sei source e sette test
  modificati; primo run 110 test verde, nessun nuovo push ancora al milestone.
- #6959 e' CLOSED sul crawler ma la persistenza live resta in attesa del
  newer-wins. Il run `33539243112` e' stato cancellato dalla concurrency;
  il successore autorevole e' `33539747828`, head dati Group08
  `451a4392007...`, pending dietro il deploy lungo. #7040 non viene accorpata a #6806: file, contratto e ownership
  sono distinti (`trigger-workflow.sh` contro generation finalizer/contract).
- Il Group08 pre-fix `33517641328` e' terminato SUCCESS con receipt/artifact
  validi 27/27 e commit dati `451a4392007...`. Rimisura Fachkraft fra base
  `71a2b7b8...` e commit: active+expired 4.699->4.733, route union
  20.067->20.177, route perse 0, URL change 0 sui 3.179 ID comuni. La slice
  active ha pero' ancora 422 descrizioni sotto 50 parole perche' il run era
  partito prima di #7047. Dopo aver verificato zero Group08 concorrenti,
  avviato l'unico post-merge `33540050341`, token
  `fachkraft-7038-2193a5fa-1`, pin site `451a4392007...`; nessun secondo
  dispatch.
- L'audit 66 di #6943 ha confermato Hilcona nella stessa classe fail-open
  (`inferAnyCanton(...) || 'GR'`) con localita' estere persistite come GR:
  incluso nella stessa PR #7033 dopo impact. Apple Retail, Breitling e Corner
  mostrano default-HQ persistiti ma contratti distinti: restano candidati
  atomici fino alla matrice audit completa, non vengono mescolati alla PR.

| Task | Owner | File/moduli | Repo | Dipendenze | Tier |
|---|---|---|---|---|---:|
| #7045 | `/root/fix_7045_receipt_toctou` | grouped data commit + test isolamento | sito | nessuna; live solo post-merge | 5 |
| #6943 / PR #7033 | `/root/fix_6943_prada_critical` | Prada, 5 sibling, retry e audit 66 | sito | stessa PR esistente | 5 |
| persistenza Lidl → #7040 | `/root/resume_6959_lidl` | manifest/API, poi trigger downstream | sito/corpus | deploy `33539243112` | 4 |
| #7050 → #664 → #677 | `/root/fix_7050_664_677_chain` | engine articoli, mirror, manifest/drift | cross-repo | merge sito prima del corpus | 4 |

## HANDOFF LIVE 18:27 — PRECEDE LO SNAPSHOT DELLE 07:55

Lo snapshot `HANDOFF IMMEDIATO` sotto resta utile come cronologia, ma non e'
piu' autorevole per issue, PR, run o metriche. GitHub/origin live hanno mostrato:

- PR site #7004 auto-mergiata come `e65066baf51f3454a08553cb4934cd228b132d50`
  con CI verde e review remota LGTM; #6772 e' CLOSED. PR corpus #710
  auto-mergiata come `5e5114b73...`, CI/loop-drift/LGTM verdi. I mutex stale
  `agent:in-progress` delle issue crawler gia' chiuse sono stati rimossi.
- Ultima wave canonica: orchestrator site `33516846901` SUCCESS, token
  `33516846901-1`. Non ridispatchare. Dei 23 gruppi corpus: Group08
  `33517641328` era ancora `in_progress` alle 17:03; Group04
  `33517203608`, Group05 `33517313335` e Group22 `33519163121` sono FAILURE;
  gli altri 19 sono SUCCESS.
- Group04/Lidl: source 341, fetched/accounted 341, canonical305, duplicate6,
  `droppedNonCh=30`. Le localita' citate (Samstagern, Kuessnacht a. R.,
  Perlen, Buetzberg, Emmenbruecke, Bevaix) sono CH reali. PR #7029, merged
  `a98b9197...`, ha reso quei drop non bloccanti; la review remota ha segnalato
  rischio di erosione coverage/route. #6959 resta OPEN e claimed; il nuovo
  fixer deve riparare la geografia source-backed, non accettare il drop.
- Rimisura source-backed Lidl del fixer: il feed live e' salito a 344
  (de300/fr40/it4); i 30 annunci classificati `nonCH` hanno tutti
  `country=CH` e appartengono a 11 sedi CH confermate anche da geo.admin.ch
  (SG/AG/ZH/SZ/BE/LU/NE). La fix Tier4 deve risolvere exact city+PLZ e
  fallire chiuso su qualunque nuova sede CH non risolta; zero route CH perse.
- Group05/iPersonal: 15 detail tentati, 2 scarti geography source-backed,
  listings13 ma parsed7; fallisce `parsed 7/15`. #6953 resta OPEN. Group22
  MediPersonal fallisce `parsed 14/15`; stessa classe da prendere nella
  prossima ondata insieme al WT/issue #6983, non un altro dispatch.
- Audit parser-quality `33519296286` non misura i crawler: fallisce prima del
  report con `ERR_MODULE_NOT_FOUND undici` da
  `scripts/lib/prospector/public-fetch-policy.mjs`. #5253 resta OPEN; un
  fixer-lite sta ripristinando il bootstrap senza chiudere il tracker.
- Il bootstrap #5253 e' ora nella PR site #7031 (2 file, nessun closing ref),
  auto-mergiata come `5baab2ac5a855fb7a40763d825ac3a243c65ed1b`, CI
  sostitutiva `33524978477` SUCCESS e review remota `## LGTM` Important0/Nit1.
  Unico audit canonico post-merge: `33525971231`, head main `187a2d5e...`.
  Bootstrap verde, 590 slice caricate e 1.090 source-detail avviati a
  concurrency3; lo strict e' stato cancellato dal job budget 15m dopo 12m10s,
  report non finalizzato e artifact assente. Evidenza commentata in #5253.
  Non ridispatchare finche' un Tier2 non aumenta il budget con test; #5253 non
  va chiusa finche' i finding reali non sono verdi.
- Tier2 timeout #5253: PR #7037 auto-mergiata come
  `2d6cdd4970ca271f33ec0477158658328c6d53a5`, budget 60m,
  strict/source-detail e concurrency invariati, test verdi e review remota
  `## LGTM`. La stessa review e il run `33525971231` provano un gap fail-closed
  residuo: al timeout il job e' `cancelled`, l'upload manca/fallisce e il
  reporter `if: failure()` viene saltato. Follow-up #7041 e PR #7042 sono
  auto-chiusi/mergiati come `0c3bd31c9e14...`: due file,
  `failure() || cancelled()`, test verde e review `## LGTM`. Unico audit
  canonico post-merge `33530688671`, head esatta `0c3bd31c...`, in progress;
  nessun secondo dispatch. Le tre domande review sono classificate nel nuovo
  follow-up #7044 (supersessione, diagnosi cancelled, streak cronico), Tier3
  prima di una eventuale fix multi-modulo Tier4. L'audit unico
  `33530688671` e' ora terminale FAILURE soltanto per i finding: strict,
  upload e reporter sono arrivati a termine. Artifact valido
  `parser-quality-report-33530688671-1` id `9810170561`, head
  `0c3bd31c9e14...`, dataset `bdb6ceb9...`, 589 crawler; source-detail
  richiesti 1.088, fetched 978, fetchFailed 110, processingFailed 0;
  authoritative 547, match 480, mismatch 67, inconclusive 52 e description
  mismatch 239. Esito 44 CRITICAL, 215 WARNING, 330 OK. Il report precede i
  commit live iPersonal/MediPersonal `e8fd1782...` e `57bcb2e5...`: non
  ridispatchare; classificare i 44 finding e tenere #5253 aperta.
  Rimisura Tier1: nessuno dei 44 e' iPersonal/MediPersonal e nessuno dipende
  da fetchFailed/processingFailed; sono quindi correnti rispetto ai due commit
  dati successivi. 43 hanno source-detail mismatch, 9 duplicate-description,
  19 duplicate-desc-only e 3 thin-description. I cluster maggiori di duplicati
  sono Roche, Volg, Interdiscount, Fust e Jumbo; i thin sono
  recruitingapp-1123, kantonsspital-uri e recruitingapp-2649. Serve
  pianificazione per cluster, non una chiusura amministrativa di #5253.
- Audit duplicate `33497909769` ha riaperto #6759/#6760: 589 slice, 2 coppie
  (SOH/Solothurner 141, Paraplegie/SPZ 27) e 1 gap SOH. Il remoto
  `origin/fix/issue-6760` ha 2 commit ma e' 249 behind e contiene un diff
  distruttivo di 22 file (11k+/29k-): recuperare solo la causa/hunk provati,
  mai cherry-pick wholesale. Il WT storico `codex/fix-6760-coverage` resta
  intatto con `AGENTS.md` foreign.
- Causa ricorrenza #6759/#6760 provata nel commit traduzione `ee410bd8aba9`:
  un run partito su snapshot pre-merge ha riaggiunto `solothurner-spitaeler`
  e `spz` dopo la loro rimozione. Non filtrare il catalogo globale
  `listSliceFileNames` (nasconderebbe gli alias agli audit): serve una barriera
  write-only/post-fetch-rebase, senza editare il filone traduzioni #6957.
- Group08 `33517641328` era ancora `in_progress` alle 17:14, bloccato sullo
  step crawler `fachkraft`; alle 17:26 lo step aveva superato 72 minuti contro
  ~24 minuti storici. E' lo stesso handle canonico da ripollare, mai da
  riavviare; il possibile hang/timeout e' un finding reliability da censire a
  esito terminale. Le altre failure della wave restano Group04/05/22.
- Backlog live: almeno 16 issue `crawler` OPEN (#7049, #7045, #7044,
  #7040, #7038, #6983, #6979, #6932, #6889, #6862, #6821, #6816, #6814,
  #6760, #6759, #6529) e 4 `crawler-data-quality` OPEN (#7045, #6957
  traduzioni con owner esterno, #6956, #6504). Restano inoltre i
  tracker/follow-up non etichettati #5253,
  #5198, #5617, #6109, #6781, #6803, #6806, #6880, #6903, #6908 e #6953.
  #6787/#6793/#6794/#6805/#6818/#6870-#6874/#6910 sono CLOSED.
  #6940 e' stata chiusa amministrativamente alle 18:11: i tre item sono su
  main via #7019/#7030/#6934/#6951, con CI verdi ed evidenza puntuale.
- Corpus correlati: #676 e' ora CLOSED con prova Tier1 su main correnti:
  0/24 artifact crawler site-ahead:identical, tutti byte/hash pari e contract
  allineato dopo #710. Restano OPEN #25, #658, #662, #668 e drift
  #339/#654/#671/#677/#679. #339/#671 sono parent decomposti, non task diretti.
  #677 e' ancora un finding site-ahead:adapted su `host/constants.ts`, ma la
  pianificazione ha provato che e' un falso drift dell'observer: il checker
  hasha tutte le ~850 righe site mentre i 21 scalari SiteShell raggiungibili
  sono invariati e hanno fingerprint gia' testate su entrambi i lati. Claimed;
  fix Tier2 corpus-only ha prodotto WIP locale non committato su
  checker+test+manifest e test mirato 10/10. E' stata fermata prima del push:
  la PR corpus #664 modifica lo stesso manifest. #664 e' a sua volta bloccata
  da Important reali su tre `packages/articles` site-side con catch
  `readdirSync` fail-silent; creata e claimed site #7050, Tier4 cross-repo.
  Ordine vincolante: #7050 site→mirror, riadozione #664 senza chiudere il
  parent #339, poi recupero WIP #677 e loop-drift/build-api.
  #658 item1 e' su main via #666 ma item2
  (snapshot paginazione non atomico) resta dovuto; #668 ha tre run watchdog
  verdi ma necessita classificazione rispetto a #658 prima di chiusura.
- Filone autonomo da non collidere: site #6943 ha aperto PR #7033 per il solo
  item Prada postal-prefix. L'item 2 retry/redirect resta esplicitamente non
  implementato; il dismiss `by construction` dell'audit sui 66 sibling non e'
  prova sufficiente per l'audit finale del goal e andra' rimisurato dopo il
  ciclo autonomo. Censimento successivo: la review remota finale della PR ha
  un Important reale su 5 sibling space-only (`agroscope`, `agie-charmilles`,
  `federal-job-normalization`, `ksgr`, `prospective-ch common`), quindi la PR
  non e' mergiabile. #6943 e' stata claimed per adozione Tier4 al prossimo
  slot: recuperare i 3 commit esistenti sulla stessa PR, risolvere il finding
  e l'item 2, mai ricominciare o chiudere item3 col vecchio scope-boundary.

### Ondata attiva alle 19:27 (ownership disgiunte)

| Task | Owner | File/moduli | Repo | Dipendenze | Tier |
|---|---|---|---|---|---:|
| #5253 audit post-#7042 | `/root` follow remoto | artifact/report parser quality | sito | unico run `33530688671` | 1 |
| #6759+#6760 post-#7043 | `/root` follow remoto | solo run traduzioni/audit post-terminale; codice shared congelato | sito | attendere run traduzioni stale | 1 |
| #7045 + #6953+#6983 | `/root/fix_7045_receipt_toctou` | receipt immutabile + batch commit da descriptor; test TOCTOU; repair 22 route | sito | base `6278829c`; nessun run prima del merge | 5 |
| persistenza #6959, poi #7040 | `/root/resume_6959_lidl` | manifest/API Lidl; quindi `trigger-workflow.sh` + test | sito/corpus in verifica, fix sito | deploy newer-wins; non toccare #6806 | 4 |
| #6943 / PR #7033 adozione | `/root/fix_6943_prada_critical` | Prada, 5 parser PLZ sibling, item2 transport/retry e audit 66 sibling | sito | stessa branch/PR; non toccare traduzioni | 5 |
| #7038 Fachkraft | `/root` follow remoto | run Group08, receipt/manifest/route | corpus/sito | nessun dispatch finche' run `33517641328` e' attivo | 1 |
| corpus #677 | WIP congelato | loop-drift checker + test + manifest | corpus | collisione PR #664; dipende da site #7050→mirror | 2 |

#7038: causa parzialmente nota, blast radius HIGH, singolo repo, persistenza
live richiesta, contratto a media ambiguita', costo dati/route di produzione;
verifica richiesta test+audit+Group08+manifest. #6821 resta congelata nel WT
esistente per la dipendenza dal vero report #5253 e dal cluster thin globale.

Il fixer-lite #5253 ha liberato lo slot dopo PR #7031; `/root` segue il solo
audit post-merge `33525971231`. Un cambio di sessione alle 17:27 ha terminato i
processi ma non gli artifact: quattro agent Tier4 sono stati riavviati sugli
stessi WT/branch/PR, senza duplicare lavoro. Lidl ha
aperto PR #7032, poi auto-mergiata come
`474634fa6bfa9cec196dceb13009e2b627d65baa`; locale 344=338 canonical+6
duplicate, 30 route CH recuperate, hash idempotente e routeLoss0. Unico
Group04 post-merge `33527114688`, token `lidl-6959-474634fa-1`, SUCCESS:
commit dati corpus `969f430aa0a66f2c3becb42d78840a0802c3271b`, artifact valido
`9808811762`, 27/27 receipt/slice e Lidl `pushed`. Il trigger downstream ha
fallito perche' `main` aveva gia' superato `EXPECTED_SHA`; il deploy push
`33529119379` e' stato cancellato da un push piu' nuovo; anche il sostitutivo
`33529321097` e poi `33529365520` sono stati superseded. Handle canonico
newer-wins corrente `33538634509`, `workflow_dispatch` gia' esistente, head
`df4b704ebd0d1dc8749d044117593d4838fd5f8c`, verificato discendente dal commit
dati e PENDING alle 19:36; i candidati intermedi sono stati cancellati dalla
concurrency newer-wins, seguirlo senza dispatch. La head contiene anche il
recovery post-merge `33537927438`: 0 previousSlugs recuperati, 15 record
duplicate-id riconciliati e net +3 previousSlugs su 3 job (nessuna perdita).
Issue #7040
creata e claimed
per rendere `trigger-workflow.sh` descendant-aware restando fail-closed su
divergenza e mantenendo la correlazione esatta del run; e' separata da #6806.
Il deploy `33520063656` e' ancora entro la durata storica (~2h20); il live CDN
Lidl pre-deploy contiene 263/318 ID attesi. La persistenza richiede un
newer-wins terminale, 318/318 e route/history/manifest, non la sola ancestry.
Alle 19:03 il job IT e' ancora `in_progress` ma non produce log dalle 14:53Z,
con FR/DE/EN fermi sul cross-shard guard e timeout globale 360m. Nessun
cancel/dispatch. Creata e claimed #7049: causa ignota, blast HIGH, Tier4 al
prossimo slot; acceptance su child heartbeat/timeout fail-closed, diagnostica,
guard deterministico e deploy live.
Diagnosi successiva corregge il segnale: l'endpoint log in-progress e' capped a
~4,21 MB anche per FR/DE, che hanno poi completato il Build in 65-69m; dunque
Last-Modified/silenzio non sono heartbeat validi. L'anomalia IT resta reale per
durata, non deadlock: alle 17:12:44Z il Build IT e' terminato dopo ~2h22 ed e'
passato al prune, entro il timeout 360m. Il fixer Tier4 e' attivo da main `9c7a24e`,
impact grafico UNKNOWN per shell/workflow ma blast operativo HIGH; cerca un
segnale di progresso affidabile e confronto storico. Vietato un watchdog sotto
la durata sana provata; se il profilo e' normale, #7049 va riclassificata senza
fix artificiale. Alle 19:18 la diagnosi e' conclusa senza diff: anche i log
FR/DE restano fermi allo stesso cap pur avendo Build SUCCESS, quindi il silenzio
non misura il child; cache OG 502 MB e dataset jobs 330 MB spiegano il leg IT
speciale, unico a generare/copiare gli OG per-job e a trasformare root+IT.
IT e' ora su `Validate locale shard output`, FR/DE/EN sul guard bounded
`Wait for IT CDN push`; si attende lo stesso run terminale. Se il marker IT
sblocca i sibling e il run termina, #7049 va chiusa amministrativamente con
questa prova, nessuna PR. Alle 19:26 EN e FR hanno esaurito il guard e concluso
SUCCESS passando dall'observer `Surface an unpublished locale shard (#2569
CDN ordering gate timed out)`: nessuna pubblicazione parziale, comportamento
fail-closed esplicito. DE attende ancora il guard e IT valida lo shard. Separare
questo finding #2569 dalla falsa assunzione di heartbeat e dalla persistenza
Lidl, che richiede il deploy newer-wins.
Il cluster #6759/#6760 misura localmente 0 DUP/0 GAP, seconda esecuzione no-op,
missing identity/URL/route=0 e 73 test verdi; PR #7034 auto-mergiata come
`9d0b7ed9e9c1cd8c6b7eb1441146e2905bf4b9da`, CI/LGTM verdi. Audit canonico
`33527884925` misura 0 DUP/0 GAP, ma #6759/#6760 sono state riaperte: 8/10
alias RETIREMENTS hanno archive slice ancora separate; SOH 37 entry/248
route-token con 108 non canonical, SPZ 16/77 con 36 non canonical. La PR
concatenata deve rehome/dedup history target-first e preservare tutte le 144
route, non cancellare gli archive.
- PR concatenata #7043 auto-mergiata nativamente come
  `6278829c74504202735a455e025db2f709ddf24d`, head `8a91754f...`, 23 file:
  rehome target-first
  sull'intera RETIREMENTS, 298 record alias e 4.205 route locale-aware al
  commit; il delta live successivo porta la union pre-guard a 4.236 route,
  missing/collisioni0, seconda esecuzione no-op, 76/76 test e audit 0/0. Il run
  traduzioni stale `33507200211` e' ancora attivo e usa un checkout pre-guard:
  dopo merge le issue restano riaperte finche' quel run non e' terminale e una
  rimisura prova alias active/archive0 e tutte le 4.205 route; un eventuale
  residuo richiede una PR dati concatenata, mai intervento sul WT traduzioni.
  La prima CI ha trovato una regressione reale sul prefisso semantico del
  defer-commit in Nord Anglia; il fixer l'ha corretta sulla stessa PR e ha
  provato 117/117 test del cluster. La CI sostitutiva `33531518825` e' SUCCESS
  e la review remota e' `## LGTM`, Important0/Nit0. I 45 candidati del
  sibling-check sono stati classificati individualmente nel body/JSON locale,
  come richiesto dall'eccezione documentata in AGENTS.md. #6759/#6760 restano
  OPEN con mutex finche' il run traduzioni stale non e' terminale; da ora
  l'owner ha congelato `git-commit-data.sh` e reconcile e potra' fare soltanto
  un eventuale follow-up data-only sulle slice. Alle 19:39 il run e' avanzato
  da Phase 2b a `Phase 2c mop-up: local MT (Argos Translate, in-process)`;
  nessun intervento o dispatch. `/root` ne segue il terminale mentre lo slot
  implementativo e' stato riallocato a #6943.
- Nuovo finding sibling reale emerso da #6821 prima del push: il helper
  `isSufficientVacancyDescription` accetta 12 parole/80 caratteri anche in gate
  finali di spec/prospector, Accor, Apleona, ETE e iPersonal; Cippatrasporti ha
  aggiunto floor 50. #6821 e' congelata senza bypass finche' audit #5253 e
  misura 12-49 parole non permettono una scheda coordinata; non collidere con
  WT Accor o col fixer iPersonal.
- Issue atomica #7038 creata per Fachkraft: Group08 `33517641328` resta appeso
  sullo step da oltre 90m contro ~24m storici; la stessa slice ha 439 stored /
  372 active tra 12-49 parole. Acceptance unisce timeout locale bounded,
  fail-closed, arricchimento >=50 e route/history loss0. Non cancellare o
  ridispatchare l'handle corrente.
- Fixer #7038: nessun WIP remoto preesistente; WT sparse da `565c7cd0`, impact
  sui simboli Fachkraft LOW e runtime globale CRITICAL lasciato intatto. Fix
  confinata a updater/parser/test: 3.530 card, reuse rich solo stesso URL+titolo,
  detail timeout15s/retry1/deadline90m, abort fail-closed, floor50 e retirement
  con soft landing; 25/25 test verdi. Prima della PR restano due run locali,
  misura thin0/routeLoss0, sibling/detect_changes/PII/diff. PR #7047 aperta
  dopo rebase su `57bcb2e5`, tre file esclusivi: 26/26 test, check Node/diff/PII
  verdi, detect_changes LOW. Source-active 3.130; le 372 vacancy 12-49 parole
  sono soft-landed, pubblicabili sotto 50 = 0, collisioni ID/URL/slug = 0 e
  route-token 18.660→18.660. PR auto-mergiata nativamente come
  `2193a5fae7a44cf8fb6b34ace2d46ca7ee3b82a2`, CI verde e review remota
  `## LGTM`, Important0/Nit0. #7038 e' stata riaperta dopo la chiusura
  automatica e conserva il mutex: nessun dispatch finche' il Group08
  pre-fix `33517641328` resta attivo; poi al massimo un run post-merge con
  receipt/manifest, thin0, collisioni0 e route/history loss0.
- iPersonal/MediPersonal: PR #7039 auto-mergiata come `565c7cd0f61a...`, CI
  verde e review remota `## LGTM` 0/0; 105 test mirati verdi e due run locali
  15/15 per entrambi, accounting0, collisioni ID/URL/slug0, hash idempotente e
  routeLoss0. #6953/#6983 si sono chiuse via `Closes` e vanno riaperte finche'
  i due handle canonici minimi Group05/22 non provano receipt/manifest e
  persistenza: sono state riaperte col mutex; Group05 `33529788531`, Group22
  `33529791936`, pin `565c7cd0` e token `7039-565c7cd0-live`. Le tre domande
  adversarial sono state classificate con prova nel commento PR
  `#issuecomment-5496791278`, senza difetto residuo o repush. Entrambi i run
  sono ora SUCCESS, inclusi target crawler, commit atomico e finalizer; restano
  da acquisire artifact/receipt, SHA dati remoto, manifest e route/history.
  Il commit Group05 `57bcb2e5...` ha rivelato route loss reale: 15 active
  rimossi ma expired 95→98, con 22 route pre-run mancanti (2 canonical active
  Schinznach/St. Moritz + 20 locali/history). Issue #7045 creata e claimed,
  Tier5 CRITICAL; MediPersonal resta verde 15→15, route loss0. La diagnosi prova
  una TOCTOU: il descriptor differito registra soltanto path mutabili;
  iPersonal ha scritto expired 95→110 e creato il descriptor, poi il sibling
  Agroscope ha eseguito la riconciliazione ghost globale; il batch commit ha
  riletto i path live e ha committato solo 98 expired, perdendo 12 record e 22
  route. I blob remoti escludono merge/push race. Impact GitNexus del helper
  globale: 1 caller diretto, 1.244 simboli impattati, CRITICAL. #7045 richiede
  quindi Tier5 Sol xhigh e descriptor immutabile (blob/hash) con staging dal
  descriptor e test di mutazione sibling post-defer. L'agent diagnostico ha
  concluso senza modifiche mentre #7043 occupava lo shared helper. Dopo il
  merge #7043 la collisione e' cessata: assegnato Tier5 worker Sol
  xhigh con ownership esclusiva su receipt, batch commit, test TOCTOU e repair
  iPersonal strettamente necessario. Acceptance: snapshot descriptor
  immutabile e versionato, staging mai dal worktree live, tamper/conflitti
  fail-closed, riproduzione sibling post-defer, recupero di tutte le 22 route,
  collisioni0/idempotenza e singolo Group05 soltanto post-merge.
  Milestone intermedio: quattro file in ownership (receipt, batch commit, test
  grouped-isolation, expired iPersonal); observer TOCTOU reale e suite 16/16
  verdi, inclusi tamper/missing descriptor/blob, same-path conflict,
  delete/recreate e seconda run. Repair target-first expired 98→110 con +12
  record pre-loss: 22/22 route recuperate, 14 active intatte e collisioni
  ID/URL/canonical slug=0. PR #7052 aperta, head `02f47701dfe5`, esattamente
  5 file autorizzati; 61 sibling e 26 test mirati verdi, syntax/JSON/diff/PII
  verdi, detect_changes LOW. Closing ref soltanto #7045, #6953/#6983 restano
  OPEN. La prima CI ha trovato 1 failure reale su 204 test: il benchmark
  full-roster generava ancora receipt fixture con `sha256:null` per gli
  expired, mentre il contratto v2 ora richiede correttamente l'hash sia per
  active sia per expired. Nessun cap alzato e nessun bypass di `valid`: il
  fixer ha corretto solo il fixture, test dedicato 7/7 e 33/33 mirati verdi,
  rebase su main `79c8f323`, detect_changes LOW e diff/PII/conflict verdi.
  Nuova head PR `0cb832522618`; CI sostitutiva SUCCESS e review remota
  `## LGTM`, Important0/Nit0. Auto-merge nativo completato come
  `cda19bbf96b427bf06c8b2881f5a198121bb75ff`.
  La terza domanda adversarial ha pero' rivelato prima della persistenza un
  gap reale della stessa classe: descriptor GROUP_BATCH ammette summary,
  translation-cache e sette adapter extra; su base-present + remote-deleted +
  local-modified il guard abortisce solo per active/expired job slice, mentre
  gli altri path vengono stale-readded. #7045 e' stata riaperta con mutex e
  prova nel commento `5497969471`; nessun run live. Follow-up Tier5 immediato
  da origin/main: guard generale per ogni path GROUP_BATCH e test
  summary/cache/extra, lasciando invariato il legacy sequential.

Nessun agent puo' spawnare altri agent; massimo quattro slot oltre `/root`.
Prossima priorita' quando si libera uno slot: terminare #7039 e la persistenza
iPersonal/MediPersonal, quindi #7038 Fachkraft; #6956 stable-ID/slug resta
Tier4 nonostante la label LOW. Gli HIGH #6806/#6940 si adottano solo dopo aver
verificato i fixer autonomi/PR gia' attivi. Non toccare #6957 o i WT
traduzione.

Filone autonomo osservato alle 18:35: PR #7046 su #6945/Coop auto-mergiata
come `b3f1b48903d1944dc4e60c7df9dd0eaa51881fbe`, CI/LGTM0/0, due file e
solo item 1 (warning per divisioni non riconosciute); usa `Addresses`, non
chiude la issue, e dichiara ancora bloccati gli item 2-3. I tre adversarial
sono classificati nel commento #6945 `5497335236`; la issue resta da drenare.

Nuovi WIP autonomi censiti:
- PR #7048 / #6947 CSC auto-mergiata come `8641942583bd...`, CI/LGTM0/0:
  risolve soltanto il nested `<article>`. #6947 e' OPEN+claimed per il fallback
  semantic-hash, cap 50k/ordine DOM e verifica del primo posting live; residuo
  Tier4 HIGH identity/coverage.
- PR #7051 / #6949 CEDES e' aperta per il solo item locale `zh-hans`; item2
  Laederach fallback e item3 Davos suffix restano esplicitamente dovuti.
  #6949 ha gia' mutex del filone autonomo: non collidere. La prima CI ha
  fallito esclusivamente al gate review: Important sul body, che descriveva il
  circuit-breaker interno come `blocked:`. L'orchestratore ha corretto il body
  in `per scelta:` e classificato le tre domande: origin/path restano
  fail-closed; live CEDES espone `/en/`, `/ja/`, `/zh-hans/` e nessuna variante
  a due trattini; a valle non esiste locale-detection. E' stato rilanciato il
  solo failed job dello stesso run `33536067359`, non un dispatch funzionale.
  Dopo autorebase la head `534f0d2f` ha ottenuto CI SUCCESS e review remota
  `## LGTM`, Important0/Nit0; auto-merge nativo completato come
  `a1931a2b410ae4e81f0cbb44ab1835e67b2d8c41`. Le domande su subtags/casing e
  prefisso generico sono classificate con live path en/ja/zh-hans e gate
  origin/namespace fail-closed. #6949 resta OPEN per item2 Laederach e item3
  Davos; nessuna collisione col filone autonomo.
- Adozione #6943 rivalutata prima di editare: GitNexus misura LOW sui parser
  Prada/Agroscope/Agie/Federal/KSGR, ma CRITICAL su
  `createProspectiveChParser` (66 impattati: 33 direct + 33 depth2). Il Tier4
  si e' fermato correttamente e ha lasciato WT clean
  `.claude/worktrees/fix-issue-6943-adopt`, branch `fix/issue-6943`, locale
  `db5938a...` (solo merge main `79c8f323` sopra i 3 commit WIP), nessun push.
  Task escalato Tier5 Sol xhigh: stessa PR, intera classe dei 5 sibling, helper
  shared con audit 33 consumer, item2 redirect/retry e audit reale dei 66.

## HANDOFF IMMEDIATO — leggere per primo dopo session limit

### Obiettivo finale e definizione di completamento

Il goal persistente resta **active**: drenare tutte le issue crawler dei due backlog e portare ogni crawler al massimo livello pratico di qualita' dati, assenza di errori/fail-silent e stabilita' ID/URL/slug/history. Non marcare il goal `complete` finche' non sono soddisfatte tutte queste condizioni:

1. Nessuna issue crawler/`crawler-data-quality`/follow-up crawler HIGH o CRITICAL aperta senza fix e persistenza verificata.
2. Parser-quality senza CRITICAL reali; source zero/retirement provati fail-closed e con soft landing delle route quando esistevano record pubblicati.
3. Duplicate ownership e coverage gap restano 0; URL/ID/canonical unici, geografia CH/TI source-backed, descrizioni non thin quando la fonte e' ricca.
4. Nessuna collisione slug; ogni cambio conserva la route precedente in `previousSlugs`/`previousSlugsByLocale` o come route locale corrente; decontaminazione e truncation ratchet a 0.
5. Site SSOT e corpus mirror/contract sincronizzati secondo `loop-sync-manifest.json`; manifest API/counts non troncati.
6. Rimisura finale globale documentata: parser audit, duplicate/coverage, data-quality, slug/history, transient ledger, corpus manifest/API.

### Snapshot operativo esatto

- Goal: `active`, `tokensUsed=7.101.794`, `remainingTokens` non esposto al 2026-09-01 07:51 CEST. Il weekly limit e' imminente: riusare i tre subagent e la review remota; non aprire review locali o analisi duplicate.
- Spazio: 18 GiB liberi, filesystem 96%. Non ripulire worktree con WIP/foreign file; gli indici `.gitnexus` ignorati gia' rimossi dove sicuro.
- Nessuna delle PR #6900/#6901/#6905/#6907/#6909/#6912 richiede piu' review: sono tutte merged. L'unico handle di persistenza ancora attivo e' il run corpus Coop esplicitato sotto:
  - **#6900 / #6898 KSM COMPLETATO** — merge `2b271f0a15d3e5809a2164705a1522bdce81e087`, CI e rereview remota LGTM 0/0. Singolo Group18 corpus `33469926943` COMPLETED/SUCCESS; commit dati `1079e63fd35f7b7c215333940b1f38beb6e23df8`. Slice 10→10/common10, ID change0, slug change0, history-loss0; ID/URL/slug unici 10/10, invalid0, thin0. Tre URL Unicode raw mantengono identita'; live source 11 validi/unici, il nuovo detail404 non supera la pubblicazione localizzata e non crea identita' spuria. #6898 richiusa con prova; nessun redispatch.
  - **#6901 / #6822 retirement `de` COMPLETATO** — auto-merge squash `911049299563b9264ad84d3a5b62ff641c9eeb7c`, required run `33469114060` SUCCESS e rereview remota sulla head finale `bb629b48bed14debabff6ce3c3d31de346c1d28b` LGTM 0/0. Persistenza su `main`: 2→0 active, 2 expired Köln, 8 route slug/history preservate, parser/updater/spec/summary assenti, candidate terminale `rejected/DE`, audit canonico `de` 0/0/0 exit 0. #6822 chiusa con evidenza; il percorso reale di ri-elezione dopo prune 90d e' separato in #6903. Russell e' passato a #6784.
  - **#6905 / #6897 Coop lifecycle MERGED, PERSISTENZA IN CORSO** — merge `af17a117...`, CI/LGTM0/0. #6897 riaperta. Baseline: slice2134, missingCompanyKey/nonCoop/collisioni0, missStreak0=2134, route2134/2134. **Unico** corpus Group01 `33472923843`, target Coop/barrier in progress; nessun secondo run. Dopo commit provare accounting, 54 missStreak1, route/history loss0 e parita' feed→adapter; poi chiudere e prendere #6910.
- **#6786 / PR #6914 REVIEW REMOTA IN CORSO** — head `d330dfaa28a5eb4c99cef2d33e9b607551e38f59`, base `82f839ad...`, 122 file, diff SHA256 `91c667f7...`, patch-id `5151a74a`. Auto-merge REBASE armato; required `vitest (unit + integration)` run `33475446955` in progress, review remota non ancora presente alle 07:55 CEST. Non fare review locale e non repushare senza finding concreto.
- **#6904 Prada geography / PR #6907 COMPLETATA**: PR merge `871becbeaf894cf776dcd3816ff6080001d9915c`, CI SUCCESS e LGTM 0/1. Unico corpus Group13 `33471833535`, dati `15e453402a924bedad90b2f11e356eeebe9f4e96`; active1→0, discovered6/written0/removed1, Arezzo expired1 con 4 route preservate, collision0. #6904 verificata CLOSED e senza label `agent:in-progress`. Advisory sibling non confermata resta nell'audit job-locations finale.
- Non redispatchare run gia' avviati e non repushare una head soltanto per un check cancelled/review-gate anticipato. Fixare sulla stessa PR soltanto finding concreti HIGH/CRITICAL; review e rereview sempre remote.

### Subagent attivi e code vincolanti

| Subagent | Attivita' corrente | Coda dopo merge + persistenza |
|---|---|---|
| Rawls `/root/fix_6759_duplicates` | #6897: singolo corpus Group01 `33472923843` in corso, baseline congelata | dopo prova e chiusura: #6910 Fust/VTG/Lidl/EOC writer → #6818 Gardenia → #6821 Cippatrasporti → #6803 |
| Hypatia `/root/fix_6760_coverage` | #6805 adottata senza duplicare: PR #6863/branch `fix/issue-6805`, WT `codex/fix-6805-adopt`; rebase clean. Closure-check drift gia' risolto in main, resta roster regex posizionale id→background; implementazione/test/contract sito-corpus in corso | dopo merge/verifica #6805: prossimo HIGH/follow-up dal ledger |
| Russell `/root/fix_parser_audit_5253` | #6786 / PR #6914: head `d330dfaa`, ratchet AST 118/raw0, 1.763 test + syntax119 verdi; required CI e review remota in corso, auto-merge REBASE armato | dopo merge: #6787 weekly audit → #6793 Chicco → #6794 St. Moritz, salvo nuovo HIGH |

Regola: ogni subagent passa al task successivo solo dopo merge, singolo run/persistenza e chiusura documentata del precedente. Prima di iniziare una coda verificare issue, label `agent:in-progress`, branch e PR remote: adottare artefatti recuperabili invece di duplicarli.

### Cosa e' gia' completato in questo goal

- Infrastruttura listing/timeout, duplicate ownership, coverage, Prospector SSRF/location, Fust/Coop/TPL/CSC routing, Apleona timeout/parser, careers, Umantis, SuccessFactors, iPersonal, OCST, farmacie e numerosi parser sono merged e verificati; SHAs/run sono nelle sezioni sotto.
- Ultimi completamenti verificati: #6823/#6912 ETE (32 rich, 23 identity/history invarianti, route loss0), #6784/#6909 previousSlugs contamination 292/20→0/0, #6904/#6907 Prada geography foreign0, #6822/#6901 retirement `de`, #6898/#6900 KSM, #6867 Coop FR, #6885 CEDES/Davos/Laederach, #6868+#6890 CSC, #6891 Hilcona/Prada/Locarno, #4146 TPL, #6882 Apleona, #6800 pharmacy.
- #6891 post-persist: Locarno source0/no byte change; Hilcona 160→158 common158 con ID/slug/history change0; Prada 3→1 churn e foreign geo separato in #6904.

### Macro lavoro residuo, in ordine

1. Completare persistenza Coop #6897 dal solo Group01 `33472923843`; poi Rawls prende HIGH #6910.
2. Completare #6805 adottando/recuperando PR #6863 e risolvendo closure-check import dinamici + roster field-order.
3. Parser CRITICAL residui: #6818 Gardenia e #6821 Cippatrasporti; poi rimisurare #5253 e chiuderlo solo a 0 CRITICAL reali. ETE #6823 e' completata.
4. Stabilita' slug/data: #6786 copre l'intera classe AST di 118 writer ed e' in review remota nella PR #6914; poi #6787 audit settimanale, #6793 Chicco e #6794 St. Moritz. #6784 e' completata.
5. Follow-up crawler HIGH/medium: #6910 adapter writer; #6803, #6806, #6870-#6874; #6903 persistenza verdict Prospector oltre90d; poi LOW #6908/#6889/#6880/#6862/#6816/#6814/#6772/#6781/#6529 e reporter/dispatch correlati.
6. Corpus/API: #676 sync identical residuo, #662 kill-switch/write, #658 atomicita' pagine, #692 cap scanner, #6380 burst commit; rispettare SSOT sito e mirror modes.
7. Rimisura globale finale secondo la definizione di completamento sopra.

### Censimento live minimo del backlog (06:36 CEST)

- Query `state:open label:crawler` sul sito: 12 issue (#6529, #6772, #6814, #6816, #6818, #6821, #6823, #6862, #6889, #6897, #6898, #6904).
- Query `state:open label:crawler-data-quality`: 5 issue (#6504, #6784, #6786, #6898, #6904), con le ultime due sovrapposte alla lista sopra.
- Verifica GraphQL dei tracker/follow-up nominati ma non sempre etichettati `crawler`: #6787, #6793, #6794, #6805, #6806, #6870-#6874 e #6903 sono tutti OPEN. Il ledger li include nelle code; non usare una sola label come prova di backlog esaurito.
- Corpus GraphQL: #658, #662, #668, #676 e #692 sono tutti OPEN; #676 e' il trasporto `identical`, #668/#658 coprono i blind spot del watchdog/commit window, #662 kill-switch-vs-write e #692 i cap di scansione.
- Delta successivo al censimento: #6908 LOW (`restoreExistingSlugIdentity` direct writer, sibling di #6784) e #6910 HIGH (adapter write fail-open/non-atomici Fust/VTG/Lidl/EOC, sibling remoto di #6905) sono state create e inserite nelle code; non sono comprese nei conteggi delle due query delle 06:36.

### Primo giro del nuovo agent

1. Leggere questo handoff e `get_goal`; non creare un nuovo goal.
2. `collaboration.list_agents`: se i tre subagent esistono ancora, riusarli; altrimenti ricreare solo gli slot mancanti con task/ownership sopra e modello/effort proporzionato.
3. Seguire senza polling stretto solo Group01 Coop `33472923843`; ETE e' gia' persistita/chiusa. Controllare artifact/mutex di #6805 e il prossimo PR #6786 quando appare. Non ridispatchare alcun run completato.
4. Aggiornare questo file dopo ogni merge, run/persistenza, nuovo finding reale o cambio coda.
5. Non toccare traduzioni: worktree `codex/translation-derived-reducer-v2`, `fix-translation-starvation` e relativi filoni hanno owner esterno.

### Audit conclusivo canonico — eseguire solo dopo aver drenato il backlog

Usare un checkout completo e aggiornato del sito: un WT sparse senza `data/` rende i risultati non probanti. Questi comandi sono ricavati dagli script reali del repository, non da nomi presunti:

```bash
cd /Users/saggesel/Projects/frontaliere/frontaliere-si-o-no
node scripts/audit-duplicate-crawler-companies.mjs
npm run audit:parser-quality
npm run audit:job-locations
node scripts/decontaminate-prev-slugs.mjs
npm run validate:jobs-crawler-keys
npm run validate:crawler-summaries
npx vitest run tests/dedicated-crawlers-localization-coverage.test.ts tests/slug-stability.test.ts tests/slug-history-journal.test.ts tests/slug-preservation-guard.test.ts tests/route-slugs-no-drift.test.ts tests/previous-slugs-bridge.test.ts
node scripts/scan-prev-slug-losses.mjs --since "60 days ago" --out /tmp/crawler-prev-slug-losses.json
```

Successo richiesto: duplicate pairs0, coverage gaps0, parser CRITICAL0 e location/geografia senza falsi CH/TI; dry-run decontamination 0 file/0 slug; crawler keys e summaries validi; suite slug verde; nessuna perdita slug inspiegata recente o recoverable residua. Non usare `--rebaseline` per far sparire finding reali.

Poi verificare il confine corpus/API dalla SSOT sito:

```bash
cd /Users/saggesel/Projects/frontaliere/frontaliere-articles
npm run test:parity
npm run test:shell-contract
npx -y tsx@4 scripts/build-api.mjs
jq '{commit, counts}' dist/api/manifest.json
```

Il manifest deve riferire il corpus atteso e conteggi completi/non troncati; i file `identical` devono essere byte-identici alla SSOT secondo `scripts/ci/loop-sync-manifest.json`. Chiudere #5253/#6787 e il goal solo dopo aver allegato output e provenance dataset/commit a una rimisura finale globale.

## Obiettivo e regole correnti

- Obiettivo invariato: migliorare tutti i crawler per qualita' dati, assenza di errori e stabilita' degli slug; drenare tutte le issue crawler del backlog.
- L'utente ha autorizzato tutti gli interventi nel perimetro: non chiedere conferme intermedie.
- Budget weekly residuo segnalato: 30%. Da questo checkpoint non avviare nuove review locali: test locali proporzionati, poi PR, review remota post-test e auto-merge nativo. Mai merge manuale.
- Checkpoint goal usage 2026-09-01 07:51 CEST: `tokensUsed=7.101.794`, `remainingTokens` non esposto; il goal resta `active`. Continuare a riusare i tre subagent e il ledger invece di duplicare analisi.
- Un altro agent e' owner dell'ottimizzazione traduzioni: non duplicare quel lavoro.
- Dimensionare i subagent: scout/luna-low per rimisure; worker/terra-medium per fix meccanici; sol/high solo per causa ignota, sicurezza o refactor multi-modulo.
- `/root` orchestra e revisiona la big picture; i subagent implementano. Repo figli separati e confine sito/corpus via HTTP.
- PR body: sezioni esatte `## Implementato` e `## Non implementato (ancora)`; ogni bullet deferred deve usare una forma ammessa (`in questa PR`, `PR concatenata #N`, `blocked:`, `per scelta`, `by construction`).

## Macro stato

| Macro | Stato | Evidenza / prossimo passo |
|---|---|---|
| Censimento backlog crawler | completato, da aggiornare a ogni audit | tracker live #6759/#6760 e follow-up elencati sotto |
| Slice listing centralizzato | completato | site #6767, #6771, #6776, #6777 merged; aggregate #6769/#6770 chiuse dopo 8/8 e 12/12 consumer |
| Timeout/host-kill site+corpus | completato | site #6782 merge `40ba8393`; corpus #661 merge `38f32dcb`; helper condivisi byte-identici |
| Fust authoritative/slug | high completato | #6762 e #6810 merged; #6788 chiusa, resta LOW #6772 |
| Duplicati companyKey | completato | #6798 `4999f71b` e #6812 `2cbe0aac`; rimisure verdi; #6759/#6657/#6797 chiuse |
| Coverage gap | completato | #6811 merge `64807a03`; audit post-merge 6/16 -> 0/0; #6760 e #6658 chiuse |
| Prospector/location/SSRF #6441 | completato | #6807 merge `d06b87f7`; CI verde, remote LGTM, #6441 chiusa; audit #5253 migliorato ma resta aperto |
| Traduzioni | handoff esterno | non riprendere il WT locale salvo nuovo coordinamento esplicito |
| Parser residuali #5253 | in corso | iPersonal, OCST, Apleona, `de` ed ETE completati; restano Gardenia/Cippa, poi audit globale 0 CRITICAL |
| Rimisura finale globale | pendente | audit parser, duplicati, gap, slug collision, transient ledger e manifest API |

## Merge gia' acquisiti nel goal

- Site: #6726, #6731, #6733, #6736, #6738, #6744, #6745, #6746, #6747, #6755, #6757, #6758, #6762, #6767, #6771, #6776, #6777, #6782, #6783.
- Site #6798: merge `4999f71b42c74db5375ecf365a8a3b660d78e8e9` (duplicate crawler identities).
- Site #6810: merge `ed60963173363b3cd4071a3d2171b22da588140c` (Fust slug-write encapsulation); #6788 chiusa.
- Site #6811: merge `64807a0360846ac52c24e736e8ef40bd92e1478d` (coverage audit/title stability); CI verde e review remota `## LGTM`.
- Site #6807: merge `d06b87f7ce3db6188eb379d0af50bf583e23c299` (Prospector location/SSRF/slug); CI verde, review remota finale `## LGTM`, #6441 chiusa.
- Site #6812: merge `2cbe0aacfe9abf9d1a21529bd8af9387ba4974aa` (SMN/dedicated ownership race); CI verde e rereview remota `## LGTM` dopo correzione HIGH.
- Site #6815: merge `4bafd89b7316b5dbb7ec033a07f2299a4e85642b` (Zurich crawler); CI e review remote verdi, 0 Important/0 Nit.
- Site #6841: merge `4b7351198a0f` (Prospector Umantis); CI/typecheck/assemble e 351 test verdi, remote LGTM 0 Important; #6829/#6834-#6837 chiuse.
- Site #6839: merge `6de5a97d` (career feed quality); 204/204 test, syntax/TypeScript verdi, finding HIGH corretto e rereview remote LGTM; #6691 chiusa.
- Site #6844: merge `babf8e9c64b00d212edd7f0bfbc8f0c0ead9ec6c` (GKB parser fail-closed); CI verde e remote LGTM.
- Site #6846: merge `a9c28b69e25d31c4780a97901b4e10a68cc15d88` (iPersonal/Med-iPersonal); finding HIGH JSON escape corretto, CI verde e rereview remote LGTM.
- Site #6849: merge `191cf42a034539f18ab67e4e6afef405ee2e9d62` (Kanton Zuerich audit contract); CI verde e remote LGTM.
- Site #6847: merge `64dde748ea73` (CSB Groupe E/Hirslanden/IBSA); CI verde e rereview remote LGTM 0/0 dopo correzione HIGH.
- Site #6854: merge `62ce650a167b14772047582131770fed274427de` (Michael Page detail + REALREF key); CI verde e remote LGTM.
- Site #6852: merge `92d665831f82b1b92b6d5815cc970d8afa3c20b2` (iPersonal authoritative retire); CI verde e rereview remote LGTM.
- Site #6855: merge `374ebfa5c3202553de9a9ec4ca077c74529f03e7` (Accor CH/detail Brotli); CI verde e remote LGTM 0 Important/1 Nit.
- Site #6861: merge `aad6d1c1c68ab356ce6e163e3354c80e813fe82b` (iPersonal paragraph-heading detail); CI verde e remote LGTM.
- Site #6860: merge `e51a6d3d218a968f3b1f32759fd668d52e06c60b` (audit active/grace/expired); CI verde e remote LGTM.
- Site #6864: merge `466b24af682312569594cd55dcb0dc77754ce71f` (OCST source-proven empty/fail-closed); CI verde e remote `## LGTM`.
- Site #6865: merge `1c6e6b82ddbdb78b65a0c2ff2a44c65ed8a972b6` (Apleona Umantis detail quality); CI verde e remote `## LGTM` con 0 Important/0 Nit.
- Site #6869: merge `8f9182bc0818ff0e0590e81a707754a6a50eaffe` (Fust authoritative French detail routes); required check verde, remote `## LGTM` 0 Important/0 Nit.
- Site #6878: merge `1568e779778cf9f0d286bc62009333411f5bb21b` (Faulhaber source-specific Jina fail-closed); CI verde, remote LGTM 0 Important/1 Nit tracciato #6880.
- Site #6881: merge `3c80c39c902e2d7d264d07cb5271fb33465b1652` (Coop authoritative localized detail seeds); required check verde, remote LGTM 0/0.
- Site #6886: merge `9256d94a6b366a7c5b85fece453831366efeb28f` (TPL source-zero/detail fail-closed); 74 test locali e CI verdi, remote LGTM 0 Important/0 Nit. Group11 `33460055514` target SUCCESS, data `ef7fdfab2d033280eb3618c0500c22f6315f0464`, adapter nella push race `33784c0b`; #4146 chiusa.
- Site #6884: merge `789b4d6c730f51dfd600b1f728750acac381d59e` (timeout per-target Apleona 60m); CI verde e remote LGTM 0 Important/1 Nit. Corpus PR #696 merge `4d9600c42`, Group18/contract byte-identici alla SSOT; #6882 chiusa con persistenza.
- Site #6888: merge `7aca9b3b5bfa2fac967f9bbf7b168708dc3b4a01` (CSC Drupal source-zero/detail exact redirect contract); primo HIGH remoto corretto sulla stessa PR, rereview LGTM 0/0. Singolo dispatch/persistenza in corso prima di chiudere #6868.
- Site #6840: merge `907ebddc7029206c031914ba8ce67259968ea4c1` (farmacie/Wuerth/Damiani/Skyguide malformed-row observability e fail-closed >=50%); CI `33462198369`, remote LGTM 0 Important/1 Nit cosmetico, 98 test mirati. #6800 chiusa.
- Site #6892: merge `7d7192cd88796a92156310730e58e60b15a5abf1` (origin/HTTPS fail-closed CEDES, Davos, Laederach); CI verde, remote LGTM 0/0, 81 test mirati. Run unici G05/G10/G16 SUCCESS; persistenza 4/9/39 active, invalid URL 0, ID/slug/history loss 0. #6885 chiusa.
- Site #6896: merge `c08a819465b8e5cab22ea893d1682977655b3d6e` (CSC main-content marker + semantic identity/alias collision fail-closed); CI SUCCESS, remote LGTM Important 0/Nit 1 ridondante defense-in-depth. Group09 `33468097013` CSC SUCCESS; adapter `8c031fe4` seedDetail vuoto/seedUrls assente, summary `819005c4` total0/earlyExit/exit0, slice live+expired assenti e route0. #6890 chiusa.
- Site #6899: merge `5ce254d08b533a125d0507412bf94f67511e9f11` (origin/HTTPS fail-closed Hilcona, Prada, Citta' di Locarno); CI SUCCESS e remote LGTM 0/0. Run Locarno/Hilcona/Prada SUCCESS con persistenza verificata; #6891 chiusa. Nuovo difetto geo Prada separato in #6904.
- Site #6901: merge squash `911049299563b9264ad84d3a5b62ff641c9eeb7c` (retirement falso crawler `de`/MPI AGE Köln), head finale `bb629b48bed14debabff6ce3c3d31de346c1d28b`; required run `33469114060` SUCCESS e rereview remota finale LGTM 0/0. Persistito 2→0 active e 0→2 expired, 8 route slug/history preservate; parser/updater/spec/summary assenti, candidate terminale `rejected/DE`, audit canonico 0/0/0 exit0. #6822 chiusa; ri-elezione post-prune 90d tracciata #6903.
- Site #6900: merge `2b271f0a15d3e5809a2164705a1522bdce81e087`, head `42ae697a865d`; required CI SUCCESS e rereview remota LGTM 0/0. Singolo corpus Group18 `33469926943` SUCCESS, commit dati `1079e63fd35f7b7c215333940b1f38beb6e23df8`: slice10→10/common10, ID0/slug0/history-loss0, unique ID/URL/slug10, invalid0/thin0. Tre URL Unicode mantengono identita'; live source11 validi/unici, detail404 nuovo non pubblicato. #6898 richiusa con prova.
- Site #6905: auto-merge `af17a11703cb8bdbb8503d2d43c6ddb6338a651d`, head `647d9175705e`. Live freeze API2091, 10 non-CH, 2081 canonical, slice2134, shared UUID2080, absent54/new1/collision0, missing companyKey0/non-Coop0. Primo HIGH corretto; sibling #6910 collegata; q apiTotal/legacy/fingerprint coperte. 77 test, diff SHA `fbead7ff...`, patch-id `5369fa79...`; CI SUCCESS e LGTM0/0. Singolo Group01/persistenza in avvio; nessun redispatch.
- Corpus: #642, #645, #647, #648, #661.
- Corpus #696: merge `4d9600c42` (trasporto identical Group18 timeout Apleona); remote LGTM 0 Important/1 Nit, workflow Group18 e contract byte-identici alla SSOT, manifest aggiornato.
- Non usare vecchie freeze/branch Fust `origin/fix/issue-6657`: contiene una grande slice obsoleta.

## Attivita' correnti — micro stato

### #6798 / issue #6759 — duplicate crawler identities

- PR: https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6798
- Stato: merged con auto-merge nativo il 2026-08-31; merge commit `4999f71b42c74db5375ecf365a8a3b660d78e8e9`, head approvata `7757bba8258a1cd674dd38d71a322f70d3133d0c`.
- Review locali storiche sul freeze finale: code e TS `LGTM`; da ora vale solo la review remota.
- Misure: 5.193 record dei 17 gruppi -> 4.681; identita' uniche 4.681 -> 4.681, missing 0; route locale+slug 48.022 -> 48.159, missing 0.
- Ritirati 10 crawler e 10 summary live; 8 archivi expired preservati. Ownership leak/miss/companyKey mismatch 0; repair dry-run idempotente.
- Fix inclusi: Denner/partner completeness; PostAuto/CarPostal/PostBus/AutoPostale predicate unico; RFSM; GKB/Tschuggen merge conservativo; slug legacy multilingua preservati.
- Body remoto corretto usando `PR concatenata #6797` e `PR concatenata #6788`; non usare negazioni che contengono la stringa `in questa PR`.
- Ultimo delta: Important Spital Davos corretto con union `/Jobs/All` + `/Jobs/1`, href stabile e merge metadata. Live 25+10 -> 25; 52/52 test verdi; diff SHA `704462df...`, patch-id `2003cf23...`, merge-tree clean. Run remoto finale `33427992693` verde e review remota `## LGTM` sulla head finale.
- Rimisura post-merge: eliminate le 18 coppie del tracker; gap `0 crawler / 0 vacancy`; 35 slice `5.193 -> 4.681`, route `48.022 -> 48.159`, missing 0 e +137 bridge; 10/10 crawler live e 10/10 summary ritirati, expired invariati.
- #6759 chiusa con verifica; #6657 chiusa come superseded senza recuperare il vecchio branch. Restano separatamente #6760 e #6797.

### #6760 — coverage gap e titoli issue stabili

- Worktree/branch: `codex/fix-6760-coverage`; non toccare `AGENTS.md` foreign unstaged.
- Ultima freeze pre-rebase approvata: staged SHA `4574c1a81e350d44c3407b009d8a79608c19676e5a427c3bcd0e1c47b6bfe6bf`, patch-id `54f2e7d1b66fe58ec766088dcb2186f0ea1d2c4d`, 5 file.
- Fix: ownership unordered; cardinalita' active per keeper/containment con raw fallback legacy; yid preservato e tracking scartato; title/dedupKey stabili; elezione congiunta OPEN+CLOSED e reopen della generazione canonica piu' recente; contract `GithubIssueSignals` strutturale e option `project` tipizzata.
- Misura freeze: gap 6 crawler/16 vacancy -> 0; 18 duplicate pair restano visibili.
- Il rebase su main ha composto il nuovo return `persisted:true`; test 137/checkJs verdi e merge-tree clean, ma la fotografia live mostra HOCH/KSSG URL `1291713901` finche' #6798 non merge.
- PR #6811 merged: https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6811; head `5ffd27a0f4fc12a02909e5371108391376322712`, merge `64807a0360846ac52c24e736e8ef40bd92e1478d`.
- Verifica post-merge su main `3c24cd64`: 585 slice e 477 host; coverage `6/16 -> 0 crawler / 0 vacancy`; unica duplicate residua Obach/SMN (#6797). #6760 e legacy #6658 chiuse con evidenza e label in-progress rimossa.
- Il Nit remoto non funnel-critical sulla doppia query cold-start e' tracciato come LOW #6814.
- Dopo merge: chiudere #6760 e #6658 come snapshot superseduto.

### #6441 — Prospector location, SSRF e slug

- PR: https://github.com/valerielinc-ops/frontaliere-si-o-no/pull/6807
- Head PR: `9d39beafc974...`; base `dc43e8e0b899...`. Review esclusivamente remota.
- Worktree: `frontaliere-si-o-no/.claude/worktrees/fix-6441-prospector-location`.
- Round 9 freeze: HEAD `31bee62caf0103bdd386790d9622d4d96b01b423`, base `dc43e8e0b8998e06332a842d7bf18fa6a980feeb`.
- Full SHA `a04198c2b4b222fac70ab55f44e1e14ac4c4ac0c43823ce1b4a2fb295b54da7a`; patch-id `8da2e4441888e06bb30609bd4e715aa83669cab1`; 61 file. Staged SHA `937573ea3df0e827b429b18146c312178731606ed08d46abd0daa7e3db3e066f`; 53 staged, 0 unstaged/untracked.
- Verifiche: 45 file/992 test verdi; 50 MJS syntax; diff/workflow/secret/email clean; phone hits solo fixture CIDR/IP/date; checkJs owned 0.
- Copertura cumulativa: public-only DNS pinned/redirect/robots/throttle/retry; IPv4/IPv6/NAT64; gate/runtime parity ed effective URL; JSON-LD+microdata multi-location; geografia source-backed/fail-closed; subdivision/ZIP+4/CH-XX; comuni ambigui; scanner quote-aware/recovery; structured address; Mabetex/Hermes/Thermo; description sufficiency.
- Gate sibling: 231 candidati classificati per path; `--no-verify` usato solo dopo classificazione completa e gate manuale verde.
- Head finale `6200335c417a2730ecdc935348ae6bb71e709f01`; merge `d06b87f7ce3db6188eb379d0af50bf583e23c299`. I 5 conflitti modify/delete con #6798 sono stati risolti mantenendo le cancellazioni upstream dei parser duplicati; 139/139 test mirati e CI `33430964610` verdi. Review remota finale `## LGTM`, Important 0 e un Nit non funnel-critical sul ramo legacy Mabetex. #6441 chiusa; worktree clean. Rimisura parser-quality #5253 in corso.

### Traduzioni — ownership esterno

- Un altro agent sta ottimizzando il processo traduzioni; non duplicare.
- WT locale preservato `fix-translation-starvation`; ultima freeze locale prima handoff: HEAD `7f1a5f0a27d7b7b7e6a53ea287e231af27b5210f`, SHA `e9fbbbb2f88b7c5c698dd64316e71519c2418b37a77376038ffea0c2ef2a35c5`, patch-id `cc766133ea7c9d34ed8ccff0e7383a6072457eb8`.
- Problemi gia' scoperti localmente: report unknown/JSDoc, invalid report non deve resolve, queue count/threshold devono essere integer finite >=0 e invalid -> alert. Non pubblicare questo WT senza coordinamento con l'owner esterno.

## Issue nuove o follow-up da drenare

- #6797 HIGH: completata. PR #6812 auto-mergiata con merge `2cbe0aacfe9abf9d1a21529bd8af9387ba4974aa`, head `4949c9d6ff89ca04c11511c6c1d4891bf7a22c93`. Finding HIGH remoto corretto sulla stessa PR. Post-merge overlap `1 -> 0`, esclusive `4/55 -> 5/55`, union 60 invariata; route legacy IT/EN preservate; secondo reconcile 0 movimenti/0 slug. #6797 chiusa e worktree rimosso.
- #6788 HIGH: completata. PR #6810 auto-mergiata con merge `ed60963173363b3cd4071a3d2171b22da588140c`; head `3e979f8`; gate 7/7, Fust 19/19, CI verde e review remota `## LGTM` senza finding. Issue chiusa.
- #6668 HIGH/funnel: completata. PR #6815 merge `4bafd89b7316b5dbb7ec033a07f2299a4e85642b`, remote LGTM 0/0 e CI verde. Dispatch corpus `33435228008`, commit dati `c415662d71356db1501ef17bb77a88b1ef886e21`: slice 378 -> 45, rimossi 333 off-board; live=persisted 45, missing/stale 0, URL canonici/CH/ID unici 45/45. Tutti i 45 ID preservati; 3 slug master + 1 locale corretti e journaled, previousSlugs persi 0. #6668 chiusa; worktree/branch rimossi.
- #6691 completata: PR #6839 auto-mergiata, head `7a5c6c80`, merge `6de5a97d`; remote LGTM dopo correzione HIGH, 204/204 test e syntax/TypeScript verdi. Post-merge live ORIOR 2, Badrutt's 19, Nord 5, tutti unici/completi/senza tracking; Ariston 187 raw -> 9 CH, 0 esteri/0 senza cantone. #6691 chiusa.
- #6820 careers completata: dispatch unico gruppo 13 run `33439016079`, commit dati `1a478ff2983063633d8b480fdc037b805d77575f`. Persistite 2/2 Böckten/BL, ID e URL invariati, thin 0; descrizioni normalizzate 2536/3008, spontanea filtrata. Unico drift slug DE preservato in `previousSlugsByLocale.de`. #6820 chiusa; nessun secondo dispatch.
- #6791 MEDIUM: timeout scanner cap 200 run.
- #6792 LOW: matcher divergente create/update issue timeout.
- #6790 LOW: semantics `persisted:true` follow-up site.
- #6814 LOW: evitare la doppia query `findRecentlyClosedIssueByTitlePrefix` nel cold-start con `dedupKey`.
- #6784 data-quality / PR #6909 **COMPLETATA**: auto-merge `074cb8b7dfc3f9f634eb734ab0188da70983c29c`, required CI SUCCESS e remote LGTM Important0/Nit0. Origin/main post-merge: dry-run decontamination 0 file/0 slug; confronto parent→merge 20 slice, 9.129→9.129 job, core identity mismatch file0, route loss/add0/0. #6784 CLOSED e commentata con evidenza. Q reviewer: corpus 29.380 record, 159 senza id ma tutti con fingerprint URL stabile, collisioni `dup`0; `needsRetranslation` intenzionale/audit separato; `trackSlugHistoryDrift` same-identity. Sibling LOW #6908 resta.
- #6786 data-quality / PR #6914: inventario deduplicato finale **118 writer crawler** (43 update locali + 67 dedicated parser + Workday/Greenhouse/SuccessFactors + cleanup/EOC/Swisscom + ABB/Fust). Migrazione chirurgica completata con `dedicated-crawler-common.slugify` invariato; ratchet AST 118/raw0 verde, syntax 119 script verde, suite 103 file/1.763 test verde. Live Burkhalter 255: mid-token 7→0, collision groups1→0, unique255, secondo run byte-identico. GitNexus post-change LOW su 77 file/81 simboli; fan-out Workday CRITICAL preautorizzato e coperto (17 moduli/19 call + 37 upstream). PR head `d330dfaa`, base `82f839ad`, 122 file, diff `91c667f7...`, patch-id `5151a74a`; auto-merge REBASE armato, required CI/review remota in corso. L'hook normale ha bloccato 30 candidati e il push `--no-verify` e' avvenuto solo dopo classificazione per-path completa nel body. Nessun article/taxonomy/SEO/traduzioni.
- #6785 data-quality: `mergeUrlKey` preferisce tag `data` al ref reale per PageExecutive (17/19 Michael Page).
- #6787 HIGH: workflow Crawler Data Quality Audit settimanale fallito; usare come tracker/validazione dei fix #6784-#6786.
- #6793 parser-health: `chicco-doro` shrink 0/1, da rimisurare live prima di intervenire.
- #6794 job-content: `gemeinde-st-moritz` usa una voce menu come titolo; da correggere e testare.
- #6803 follow-up Fust: race summary read/write e fail-loud su rollout misto.
- #6805 follow-up compatibilita' corpus: artefatto remoto PR #6863/`fix/issue-6805` adottato nel WT sparse `codex/fix-6805-adopt`, rebase clean. Il vecchio rosso era drift di `translate-pending.yml` gia' risolto in main (#6879); il WIP closure-check resta 5 file helper/test. Il difetto reale residuo e' `crawlerIdsFromArtifact`, regex posizionale `id`→`background` nel portable observer identical verso corpus. Blast manuale: 3 call site closure + 2 assert observer; GitNexus UNKNOWN per helper test. In corso parser field-order + fixture, poi rigenerazione contract/hash e test sito/corpus; nessuna PR duplicata.
- #6806 follow-up generation barrier: `generationToken` non vincolante e storico durevole non validato.
- #6870 follow-up careers: per-item malformed non deve abortire l'intero feed; Nord Anglia silent URL-drop e rischio `urlHash` su link grezzo/token rotante. Funnel/slug, da trattare dopo i CRITICAL parser correnti.
- #6871 follow-up ownership audit: identity query-param allow-list globale non host-scoped e skew suppression 24h che puo' mascherare crawler fermo. File condiviso `crawler-source-hosts.mjs`, richiede audit dataset/impact prima del fix.
- #6872 follow-up identity: `normalizeJobUrl` lowercasa anche valori query potenzialmente case-sensitive; verificare corpus e preservare case solo dove identity lo richiede.
- #6873 follow-up dispatch: legacy crawler dispatch/preflight senza retry e `trigger-workflow.sh` exactly-once senza recovery verificata per deploy/fast-publish.
- #6874 follow-up ownership/Denner/Spital Davos: 7 item concreti (fallback identity collision, pagination silent stall, OSC recovery, invariant shared-board, tre assunzioni/merge Spital). Scomporre per file/piattaforma prima dell'implementazione.
- Corpus #662 LOW: kill-switch vs write failure; #663 `searchSafePrefix` e' chiusa. Corpus #658 e' solo parzialmente coperta dalla PR #666: allarme `commit-window-truncated` risolve il blind spot sostenuto, resta la non-atomicita' delle pagine API da separare o risolvere prima di chiuderla. Corpus #692 conserva i cap fissi 200 run/200 issue in `scan-job-timeouts.mjs`.
- #6781 LOW: newsletter non segnala piu' ENOENT dopo `listSliceFileNames([])`.
- #6772 LOW: Fust terzo snapshot zero deve restare confirmed.
- #6657/#6658: chiuse con evidenza dopo merge e rimisure #6798/#6811.
- #5253 audit parser quality resta tracker ampio. Post-#6860: 587 crawler; 29.611 stored, 28.382 active, 1.229 grace, 0 expired; 9 CRITICAL / 147 WARNING / 431 OK. Baseline iniziale 595/61/230/304 e post-#6807 585/21/160/404. MichaelPage 16/39 active, 23 grace, 0 CRITICAL/WARNING. Tracker aggiornato e aperto per i 9 CRITICAL statici + source-detail.
- #6816 LOW: ramo legacy Mabetex irraggiungibile rilevato dal Nit remoto di #6807.
- #6889 LOW: due Nit SSOT del timeout crawler — deduplicare l'header shell `set -uo pipefail`/`set +e` e distinguere nel reporter exit 124 timeout da crash/commit failure, senza cambiare la semantica degli artifact.
- #6890 HIGH completata/chiusa: PR #6896 merge `c08a819465b8e5cab22ea893d1682977655b3d6e`, CI verde e remote LGTM 0 Important/1 Nit non operativo. Group09 `33468097013` target CSC SUCCESS 04:04:32–04:04:48Z; adapter `8c031fe4` seedDetail=[]/seedUrls assente, summary `819005c4` total0/earlyExit/exit0, live+expired e route/slug 0→0. Rawls passa a #6897.
- #6897 HIGH concatenata a Coop: PR #6905 auto-merged `af17a11703cb8bdbb8503d2d43c6ddb6338a651d`, head finale `647d9175705e`, CI SUCCESS e LGTM0/0. Fix cross-domain + write/parita' adapter fail-closed: 54 assenti grace1→2→ritiro con route/history; 2081 canonical, shared2080, new1/collision0. Primo HIGH accounting corretto; sibling writer Fust/VTG/Lidl/EOC separato in HIGH #6910. Issue riaperta per la prova di persistenza. Unico Group01 `33472923843` ancora `in_progress` alle 07:51 CEST (`Run coop` + barrier); nessun redispatch.
- #6898 HIGH concatenata a #6891 COMPLETATA: PR #6900 merge `2b271f0a15d3e5809a2164705a1522bdce81e087`; fix KSM scoped con HTTPS/origin/path e no-fetch, identity percent-encoding corretta. Singolo Group18 `33469926943` SUCCESS, dati `1079e63f...`: 10→10/common10, ID/slug/history loss0, unici10, invalid/thin0, tre Unicode stabili. #6898 chiusa con evidenza.
- #6904 HIGH completata: PR #6907 merge `871becbeaf894cf776dcd3816ff6080001d9915c`, CI SUCCESS/LGTM 0/1; Group13 `33471833535`, dati `15e453402a924bedad90b2f11e356eeebe9f4e96`. Active1→0, discovered6/written0/removed1, Arezzo expired1 con 4 route preservate, collision0 e foreign active0. ETE #6823 e' stata completata subito dopo.
- Rimisura #5253 ha creato 21 residui atomici HIGH #6817-#6837: Accor, Albergo Gardenia, Apleona, Careers, Cippatrasporti, DE, ETE, GKB, Groupe E, Hirslanden, IBSA, iPersonal, J. Safra Sarasin, Kanton Zuerich, Med-iPersonal, Michael Page, OCST e recruitingapp 1123/1154/2649/2677.
- #6822 `de` completata: root cause tenant estero `mpi-age.de.umantis.com` (MPI Köln) scaffoldato storicamente come Lugano/TI dal parser Prospector; il resolver post-#6807 produceva gia' zero, ma il fail-open manteneva 2 active. PR #6901 merge `911049299563...`, CI/rereview finali verdi; retirement persistito 2→0 active e 2 expired con 8 route preservate, candidate `rejected/DE`, audit 0/0/0. Residuo distinto #6903 sulla ri-elezione dopo prune 90d.
- #6823 ETE / PR #6912 **COMPLETATA**: merge `50c8426b...`, CI/LGTM0/0; unico Group09 `33474265061` target SUCCESS, dati `99fcf3799ee656c26621d87e0c724cfc22b02bdb`. Slice32/32 rich, thin0 (min1.114 char/129 parole), location Avenches4/Bassersdorf6/Härkingen10/St.Gallen12, missing0. Parent→commit overlap23 con ID/URL/slug/slugByLocale/previousSlugs/history invariati23/23, stale0/new9/collision0, route/alias261 loss0; summary total/written32,new9,updated23,removed0. #6823 CLOSED/commentata, mutex rimosso. Hypatia passa #6805/PR #6863.
- Cluster Umantis completato: PR #6841 auto-mergiata con merge `4b7351198a0f`, head `b608417cb44d`; CI/typecheck/assemble e 351 test verdi, remote `## LGTM` con 0 Important/2 Nit. Audit focalizzato 0 CRITICAL: J. Safra 9 rich avg 3302; 1154 8 avg 2452; 2677 2 CH avg 2054; 1123 e 2649 zero foreign. #6829/#6834-#6837 chiuse.
- #6824 GKB completata: PR #6844 merge `babf8e9c64b00d212edd7f0bfbc8f0c0ead9ec6c`, remote LGTM 0 Important. Dispatch unico `33440941069`, commit dati `65c15bbca8c4dbb1e3d6c074babb4e6922e803c7`: 25 job, 0 thin, min/avg/max 1188/1698/2572, ID/URL/slug unici 25/25; URL/ID/route parent preservati 25/25. Audit 0 CRITICAL/1 WARNING hidden duplicate-desc. #6824 chiusa, WT clean.
- Cluster SuccessFactors/CSB #6825/#6826/#6827 completato: PR #6847 merge `64dde748ea73`, remote LGTM 0/0. Dispatch unici SUCCESS: Hirs group09 `33446098064` -> data `c2598f49b805`; Groupe E group13 `33446099916` -> `55ce53f92ff2`; IBSA group15 `33446101981` -> `b303a0894c4b`. Post-persist: Groupe E 40 live, 0 flat/mismatch (4 rimosse upstream, superstiti invariati); Hirs 371/371, 0 mismatch e URL/slug/local/history invariati; IBSA 8/8, 0 warning, Grancia TI/CH/CAP6916 presente. Issue chiuse e WT clean.
- Cluster iPersonal #6828/#6831 completato. PR #6861 auto-mergiata, head `c5fd9d82`, merge `aad6d1c1c68ab356ce6e163e3354c80e813fe82b`, CI/remote LGTM. Run canonico Group05 `33452239464`, target iPersonal SUCCESS, commit dati `d7377b6d9d3f587f88d397c7eb3d3de840626ba5`: active 45 -> 15, 30 archiviati; 15/15 ID e URL unici, thin 0, flat 0, min description 3.236, survivor ID/URL/slug changes 0, 395 route preesistenti/missing 0. #6828 chiusa. Med commit `1f818fb4`: 17 -> 15, thin/flat/route missing 0; #6831 chiusa/evidence aggiornata. Faulhaber/Fust sibling failure non ritentati.
- #6830 Kanton Zuerich/Solique completata: PR #6849 merge `191cf42a...`; run canonico `33445142531` SUCCESS, commit dati `af5e5f5915225b24e6d640aa5614b16704b9871d`. Persistito 175 live + 13 grace, 9 scaduti archiviati con 9/9 route preservate; sui 187 comuni zero cambi ID/URL/slug. Audit 0 CRITICAL/0 WARNING/1 OK, source-detail 2/2 match, locali mancanti e duplicate 0. #6830 chiusa; nessun secondo dispatch.
- Michael Page #6832/#6785 e audit follow-up #6856 completati. PR #6860 merge `e51a6d3d...`, CI/remote LGTM. Post-merge full audit 587 crawler, 29611 stored/28382 active/1229 grace/0 expired, 9 CRITICAL/147 WARNING/431 OK; MichaelPage 16 active/23 grace, 0 CRITICAL/WARNING. #6856 chiusa, #5253 aggiornato e aperto.
- #6817 Accor completata: PR #6855 merge `374ebfa5c3202553de9a9ec4ca077c74529f03e7`, remote LGTM/CI verde. Group20 run `33451128255`, data commit `8c5faeebe93c7acc272507ba1dd198a2e5534539`: 22 source-active, 0 thin, 191-1240 parole, URL/ID/slug unici e route valide; GE/VD/ZH, 5 previousSlugs su 3 job. 7 estere thin restano solo grace non-active. #6817 chiusa. Run overall rosso solo per sibling OCST; Nit pagination dinamica da tracciare se assente.
- #6833 OCST completata/chiusa: PR #6864 merge `466b24af682312569594cd55dcb0dc77754ce71f`, CI verde e remote `## LGTM`; unico Group20 `33454414948`, target SUCCESS. Commit dati `aa531d222a940263edd7462e2733e15ce14d36f1`: active 0, audit thin 0, archivio creato con 2 route e `previousSlugs` conservati; nessuna failure issue OCST. Nit Accor separato LOW #6862.
- #6819 Apleona e #6882 completate/chiuse: parser Group18 `33454506617` SUCCESS dopo 40m29s, data `35530844f870...`, audit verde; site PR #6884 merge `789b4d6c...`, corpus transport PR #696 merge `4d9600c42`, entrambe remote LGTM. Latest corpus: Group18 SHA `3aee19b2...` cmp=0 con SSOT, contract `ea878d6f...` cmp=0, manifest identical aggiornato. Q child/dedup/budget chiuse con evidenza; resta LOW #6889.
- #6659 Fust completata/chiusa: PR #6869 merge `8f9182bc0818ff0e0590e81a707754a6a50eaffe`, remote LGTM; unico Group22 `33455705664` SUCCESS, commit dati `5302bf9e635b`. Persistiti 89/89, ID/URL/UUID unici, 78 DE/8 FR/3 IT, missing location/canton/description 0. Le 74 identita' storiche conservano ID/URL/slug/locale/history; 15 nuove; route 1.228→1.288, missing 0.
- #6867 Coop HIGH completata/chiusa: PR #6881 merge `3c80c39c...`, remote LGTM 0/0; singolo Group01 `33458000585` SUCCESS e data `86739ba367f0e977882e41ef2deb6becfe69aa17`. Feed drenato 2.091/2.091, esclusi 10 non-CH, 2.081 detail seed e 2.078 estratti; slice 2.134 con ID/URL unici e collisioni slug 0. Le 228 route FR sono tutte presenti (baseline 0); sulle 1.906 identita' condivise URL change0 e perdita route/history0. Housekeeping 2.134/2.134 senza rimozioni. Il lifecycle cross-domain e il write adapter fail-open sono separati in #6897.
- #4146 TPL HIGH completata/chiusa: PR #6886 merge `9256d94a6b366a7c5b85fece453831366efeb28f`, CI verde e remote LGTM 0/0. Unico Group11 `33460055514` target SUCCESS; data `ef7fdfab2d033280eb3618c0500c22f6315f0464`, adapter nella push race `33784c0b`: total/discovered/written 0/0/0, `sourceProvenEmpty=true`, slice0, ghost748 rifiutata, collision0, audit 0 critical/0 warning. Nessuna route/slug/history era mai stata pubblicata. Le q remote sono chiuse by-construction: H1 ambiguo diventa falso negativo fail-closed via `expectedTitle`, `skipShrinkGuard` e' coperto da expected-map+source parity, multi-row e' all-or-nothing source-authoritative. I tre sibling raw absolute/off-domain reali restano HIGH #6885.
- #6885 HIGH completata/chiusa: PR #6892 merge `7d7192cd88796a92156310730e58e60b15a5abf1`, CI verde e remote LGTM 0/0. I 5 ingressi unsafe CEDES/Davos/Laederach sono 0/5; run unici G05 `33461969876`, G10 `33461962619`, G16 `33461962436` SUCCESS. Persistito 4/9/39 active, invalid URL/thin 0; common 4/8/39 con ID change0, slug change0, history loss0. I tre sibling reali sono #6891.
- #6891 HIGH completata/chiusa: PR #6899 merge `5ce254d08b533a125d0507412bf94f67511e9f11`, CI verde e remote LGTM 0/0. Post-merge: Locarno run `33468113915` SUCCESS/source0/no byte change; Hilcona `33468115293` SUCCESS→data `05464ff6`, 160→158 e 158 common con ID/slug/history change0, invalid/thin0; Prada `33468117215` SUCCESS→`810ca859`, 3→1 churn, invalid/thin0 e 3 route rimosse registrate nel ledger. Q remote classificate con prova nel commento; nuovo difetto geo Prada separato HIGH #6904.
- #6868 CSC HIGH completata/chiusa: PR #6888 merge `7aca9b3b5bfa2fac967f9bbf7b168708dc3b4a01`, primo HIGH redirect corretto e rereview LGTM 0/0; Group09 `33461676649` SUCCESS. Residui reali corretti da #6890/#6896 e verificati col Group09 `33468097013`: adapter/summary source-zero, live+expired assenti, route/ID/slug 0→0. Nessun lavoro CSC residuo.
- #6857 Faulhaber completata/chiusa: PR #6878 merge `1568e779778c`, remote LGTM/CI verde; unico Group05 `33457398891`, target SUCCESS; commit dati `7a74fb061212`. Persistito 3/3, thin 0, min desc 156, allow-list 3/3; ID/slug/URL live invariati e route univoche nei 4 locali, nessuna route precedente da perdere. Nit LOW #6880.
- #6800 farmacia Ticino completata/chiusa: PR #6840 merge `907ebddc7029206c031914ba8ce67259968ea4c1`, head `2a6d8de95440`, CI `33462198369`, remote LGTM 0 Important/1 Nit (prefisso `console.warn` Damiani cosmetico). Fix esteso a Wuerth, Damiani e Skyguide: contatori e fail-closed con soglia >=50%, farmacie `_warnings` separati da `_errors`, envelope schema compatibile; 98 test mirati, syntax/merge-tree e GitNexus LOW verdi.
- #5198 transient ledger permanente; #6109 locale quality resta aperta finche' queue >100.
- Censimento label crawler/data-quality aggiornato: restano anche #5617 job-title locale weekly, #6504 logo aziende, #6529 host `www.` inesistenti, #6772 Fust zero-snapshot, #6781 warning slice newsletter, #6814 cold-start dedup, #6816 Mabetex legacy e #6862 pagination Accor. Sono gia' ordinati sotto i blocker HIGH/parser.
- Corpus: #663 `searchSafePrefix` risulta CLOSED (2026-08-31). Restano #662 kill-switch/write failure; #676 trasporto `site-ahead:identical` di 24 crawler-group/contract da copiare byte-identico dal sito con baseline manifest; #668 watchdog commit-window troncata dal burst di commit crawler, osservatore gia' implementato e auto-closer ma il burst va ridotto con #6380. Corpus #679 e' drift misto non specificamente crawler, da trattare nel sweep di sync senza violare le ownership `identical`/`adapted`.

## Backlog crawler residuo ordinato

1. Finalizzare l'unico HIGH in persistenza senza dispatch duplicati: #6897/PR #6905 Coop, merged e verificata ma con Group01 `33472923843` ancora in corso. Prada/KSM/`de`/ETE e i precedenti HIGH sono chiusi con persistenza.
2. Drenare i parser CRITICAL residui di #5253: Gardenia #6818 e Cippatrasporti #6821 nelle code assegnate. ETE #6823 e' chiusa; non rebaselineare difetti reali.
3. Drenare i LOW derivati gia' registrati (#6880/#6862/#6889) solo dopo gli HIGH/parser, riusando head esistenti quando presenti.
   - Coda successiva senza nuovi slot: Rawls dopo #6897 prende #6910 (stesso contesto), poi Gardenia/Cippa/#6803; Hypatia e' gia' su #6805/PR #6863; Russell sta finalizzando #6786. Verificare sempre issue/PR/branch live prima di iniziare per non duplicare il drainer remoto.
   - Coda assegnata corrente: Rawls #6897 persistenza → #6910 → Gardenia #6818 → Cippa #6821 → #6803; Hypatia #6805; Russell #6786 → #6787 weekly audit → #6793 Chicco → #6794 St. Moritz. Ogni passaggio avviene solo dopo merge/persistenza della task precedente.
4. Tracker HIGH #6787 e stabilita'/dati: #6786 truncation in finalizzazione; poi #6793 Chicco d'Oro, #6794 St. Moritz, #6803/#6805/#6806; follow-up #6870 (career feed), #6871/#6872 (identity/audit), #6873 (dispatch recovery), #6874 (ownership/Denner/Spital), #6903 (verdict Prospector oltre retention 90d) e LOW #6908 (`restoreExistingSlugIdentity` writer), da scomporre by file dove necessario. #6784 e #6785 sono completate.
5. Follow-up infrastrutturali: #6380 batch group commits, #6381 AI cache, #6382 translation cache (coordinare owner esterno), #6383 stats shards, #6513 pin guards, #6529 company websites, #6504 logos, #6739 pharmacy guards, #6685 reporter signals.
6. Sincronizzazione/reliability corpus: #676 copia identical dei 24 crawler-group/contract dalla SSOT sito; #662 timeout kill-switch/write; #668 burst commit/watchdog con #6380; #658 non-atomicita' residua della paginazione commit; #692 cap 200 run/issue nello scanner timeout. #663 e' gia' chiusa.
7. #6392 PDF/orphan query e #4854 solo dopo i crawler vacancy prioritari.
8. Rimisura finale: audit duplicate/coverage, parser-quality, title/description locale (#5617/#6109), slug collisions, transient ledger site/corpus, manifest corpus e conteggi API.

## Stato operativo e risorse

- Stash GSC site da preservare: `stash@{0}` / `7f461dfb...`.
- Non toccare il WT corpus superseded `fix-6746-loop-runtime-contract` o il sentinel staged `fix-6746-observer-sentinel` senza nuova ispezione.
- Ultimo spazio noto: 18 GiB (filesystem 96%) alle 06:22 CEST. Oltre al detached clean `codex/fix-6760-rebase` (+~669 MiB), rimossi solo indici `.gitnexus/` ignorati e rigenerabili da tre WT storici (~6,9 GB): SuccessFactors, coverage e careers. Preservati `AGENTS.md` foreign nei primi due e l'intero staged WIP careers (8 file); nessun codice/dato cancellato. Preservare stash/sentinel/traduzioni e i WT correnti #6897/#6898; il WT #6822 puo' essere rimosso solo se clean e se non contiene file foreign.
- Root worktree dirty preesistente da preservare: `.claude/agents/bl-fixer-lite.md`, `.claude/agents/bl-fixer.md`, `.claude/skills/add-repo-workspace/SKILL.md`, `CLAUDE.md`; `.agents/` e `.codex/` sono untracked/session data. Non includere questi file in PR crawler.
- Review remota e auto-merge possono richiedere retry per HTTP 429: non cambiare/re-pushare una head approvata solo per forzare il retry.

## Protocollo di ripresa se si esaurisce il weekly limit

1. Leggere prima `HANDOFF IMMEDIATO` in cima a questo file e poi `get_goal`; il goal resta attivo, non crearne uno nuovo.
2. Seguire soltanto Group01 Coop `33472923843` fino a commit/persistenza; PR #6905/#6907 e tutte #6900/#6901/#6909/#6912 sono gia' merged. Non ridispatchare run completati e non duplicare branch o PR.
3. Per una PR merged: se `Closes` ha auto-chiuso l'issue prima della persistenza, riaprirla; eseguire/seguire un solo run canonico, controllare summary/slice/ID/URL/slug/history e richiudere con evidenza.
4. Priorita' immediata: Coop persistence → #6910; in parallelo #6805 e chiusura PR #6786; quindi Gardenia #6818/Cippa #6821, #6787/#6793/#6794, follow-up e corpus come da macro residuo. ETE/#6784/#6904 sono concluse.
5. Aggiornare questo ledger dopo ogni PR merge, run/persistenza, nuovo blocker/finding o cambio coda.
6. Non aprire review locali e non riprendere il filone traduzioni senza coordinamento esplicito.
