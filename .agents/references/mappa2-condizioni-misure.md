# Mappa wayfinder #2 — le tre condizioni di chiusura, con lo strumento che le misura

Stato al **2026-09-11 06:00Z**. Questo file esiste perche' i numeri della mappa scadono e i
comandi che li producono si perdono fra le sessioni. Chi riprende parte da qui.

Mappa: https://github.com/valerielinc-ops/frontaliere-workspace/issues/2

---

## Condizione 1 — la quota di completezza sale

**Formulazione ratificata (2026-09-09)**: la quota `complete / (complete + incomplete)`, su
**media mobile a 3 punti**, sale per **7 punti consecutivi**.

La formulazione grezza — 7 rialzi della quota puntuale — era **insatisfacibile**: su 99
transizioni storiche la catena massima mai raggiunta era **5**. Su media mobile a 3 il massimo
storico e' **22**, quindi la condizione riformulata e' raggiungibile. Questo e' il motivo della
riformulazione, non una comodita'.

**Stato al 2026-09-11 06:30Z**: catena **0 di 7**. 102 punti `after`, 100 punti MA3.

**La misura e' stata riparata il 2026-09-11 alle 06:45:55Z** dalla PR sito **#8290**
(`6ee26149d9d`): lo step `Log translation stats (after)` sta ora alla riga **434** di
`translate-pending-logic.yml`, dopo `Commit translations` (395) e dopo la Fase 2d (405), e misura il
**candidate tree** via `scripts/lib/git-commit-data.sh:1483-1524` e `:1750-1755`, senza avanzare il
checkout (`:1777-1783`).

**Conseguenze da tenere presenti leggendo la serie:**

- **I 102 punti precedenti non sono confrontabili con i futuri**, e nessuno e' stato retrocorretto.
  La condizione 1 **riparte da zero**: servono almeno nove punti nuovi, cioe' **21-38 ore** alla
  cadenza reale.
- **Il livello scendera' di circa nove punti percentuali**, verso il **70,6%** invece del 79,8%.
  **Non e' una regressione**: e' la fine di una sovrastima.
- **Limite dichiarato e non risolto**: una kill brutale al cap dei 350 minuti resta non
  intercettabile. La deadline a 300 minuti (`translate-pending-logic.yml:408-411`) lascia 50 minuti
  al cap, quindi il percorso previsto per budget non perde il punto; un SIGKILL si'.

**Dove sta il dato**: `data/translation-stats-history.json` nel repo sito, voci con
`label === "after"`.

### Il blocco: il residuo e' piatto, e due terzi ha piu' di una settimana

Escludendo dalla serie i sei punti con la firma dell'artefatto, **la catena corrente resta 0**.

| ora | complete | incomplete | totale | quota |
|---|---|---|---|---|
| 2026-09-08T10:51 | 22.814 | **6.013** | 28.827 | 79,14% |
| 2026-09-09T10:39 | 25.601 | **6.671** | 32.272 | 79,33% |
| 2026-09-10T11:58 | 26.003 | **6.494** | 32.497 | 80,02% |
| 2026-09-11T01:26 | 26.031 | **6.571** | 32.602 | 79,84% |

In tre giorni `incomplete` non scende. La quota sale di 0,7 pp quasi tutta dal denominatore
(`complete` +3.217 contro `total` +3.775): **sale per diluizione**.

**Quadro reale, col predicato canonico** su `origin/main` (`25c93c9a686`, 2026-09-11T05:09Z),
eta' da `jobQueuedAtMs`:

| fascia | job | incomplete | complete |
|---|---|---|---|
| sotto 24h | 1.253 | 1.067 | 14,8% |
| **24-48h** | 979 | 193 | **80,3%** |
| 2-7 giorni | 6.062 | 1.989 | 67,2% |
| 7-30 giorni | 11.237 | 3.441 | 69,4% |
| oltre 30 giorni | 13.457 | 3.023 | 77,5% |
| **totale** | **32.988** | **9.713** | **70,6%** |

**La copertura reale e' 70,6%, non 79,8%**: la differenza e' il difetto della misura (il punto
`after` scritto a meta' run, vedi sotto). E **6.464 job oltre i sette giorni**, non ~3.300 come
stimato per differenza in una prima lettura: due terzi del backlog.

La curva ha la forma di una coda servita fresca e poi abbandonata: massimo a **24-48h** (80,3%),
minimo a **2-7 giorni** (67,2%), risalita parziale oltre i 30 giorni.

**«La completezza si perde» e' SMENTITA.** Confronto job per job fra `0019af8e376`
(2026-09-06T05:08Z) e `25c93c9a686`, con `isIncomplete` importata dal sorgente **di ciascun ref**,
sui 1.989 incomplete della fascia 2-7 giorni:

| gruppo | conteggio |
|---|---|
| gia' `incomplete` nel ref vecchio | 209 / 1.989 (10,5%) |
| **completi allora, incompleti oggi** | **4 / 1.989 (0,2%)** |
| non esistenti nel ref vecchio | 1.776 / 1.989 (89,3%) |

Quattro job, non un fenomeno: il lavoro e' **capacita' e ripasso**, non conservazione.
**Attenzione pero' al 89,3%**: il ref vecchio ha cinque giorni e la fascia ne copre da due a sette,
quindi i job visti per la prima volta il 07-09 settembre non potevano esistere nel ref del 06. Quel
numero misura la finestra di confronto, non il backlog.

I quattro casi hanno comunque un nome: `mergeLocaleTextMap`
(`scripts/lib/dedicated-crawler-common.mjs:6461-6513`) rimuove le traduzioni non-source quando
rileva drift della sorgente, e `hardenJobLocaleFields` (`:1516-1520`) riempie le slot con la
sorgente impostando `needsRetranslation`. **I test pinnano di proposito** questo comportamento
(`tests/dedicated-crawler-common.test.ts:618-692` la rimozione, `:1698-1740` la conservazione): non
e' un bug da togliere, e distinguere un vero cambio di posting da un aggiornamento della stessa
vacancy e' il lavoro vero.

Scheda per la domanda che resta: `.scratch/codex-c0drain.txt` — il residuo oltre i sette giorni
entra mai nei primi `effectiveMax` (default 100) job che una run seleziona? Denominatore **6.464**.

Comando: `.scratch/agebands.mjs` (`SRC=<dir> REF=<ref> node .scratch/agebands.mjs`).

### La causa, chiusa: il punto misura il worktree transitorio, non l'albero pubblicato

In `.github/workflows/translate-pending-logic.yml` l'ordine degli step e':

| # | step |
|---|---|
| 1 | **`Log translation stats (after)`** |
| 2 | `Scatter changes back to per-crawler slices` |
| 3 | `Phase 2c mop-up: local MT (Argos)` |
| 4 | `Re-assemble dataset after Phase 2c mop-up` |
| 5 | `Commit translations` |
| 6 | `Phase 2d: Fix untranslated titles (free cascade)` |

Il punto chiamato `after` e' scritto **prima** di scatter, mop-up, re-assemble, commit e Fase 2d.
E' una misura di **meta' run**. In piu' `scripts/lib/git-commit-data.sh` aggiorna il riferimento
remoto solo dopo (fetch verso 1512-1521, merge 3-way verso 1657-1686, push verso 1715-1727) **senza
avanzare il checkout locale**.

Ricostruzione aritmetica sul punto `2026-09-11T01:26:57.017Z`:

| albero | total | incomplete |
|---|---|---|
| base della run (`e6a743d`) | 32.602 | 7.424 |
| **worktree misurato dalla run** | 32.602 | **6.571** |
| parent del commit finale (`9fc88ab`) | 33.000 | 10.572 |
| **`c5286d0f01e` pubblicato** | 33.000 | **9.720** |

`e6a743d → 9fc88ab`: +398 elementi e +3.148 incomplete da **19 commit concorrenti** di crawler e
publisher durante la run. `9fc88ab → c5286d0f01e`: −852, il lavoro della run applicato dal merge
3-way. E torna: **9.720 − 6.571 = 3.148 − 852 + 853 = 3.149**.

**Non e' `isIncomplete` a divergere: e' lo snapshot.** Escluso con prova anche il sospetto di una
copia degli script: il corpus **non contiene copie**, e gli hash di `log-translation-stats.mjs` e
`relocalize-pending-jobs.mjs` coincidono fra `c5286d0f01e` e `origin/main`.

I **398 job** sono reali: 593 slice valide, **0 `id` duplicati**, 177 elementi senza `id`, 0 senza
`url`; +1.032 URL entrati e −634 usciti su **148 slice cambiate su 593**.

**Conseguenza**: l'errore della serie non e' costante — dipende da quanti commit concorrenti
atterrano durante ogni run, e le run durano 5-13 ore. **Una catena di rialzi su quella serie non
prova convergenza.**

**Il numero corretto**: 9.720 su 33.000 sul tree pubblicato; 9.713 su 32.988 su `origin/main` di
adesso. Il 6.571 vale **solo** per il worktree transitorio della run.

### Le cinque letture «anomale» non erano artefatti

Hanno la firma `before == after` — 37 punti su 102 ce l'hanno, quindi da sola non discrimina — ma
quella firma **non significa «run inerte»**: significa che entrambe le letture vengono dalla stessa
snapshot. La run `34360370563` ha `before == after` e registra **1.229** transizioni
`incomplete → complete`; il bulk ha girato `8.735.193/9.000.000 ms`, il mop-up
`7.081.500/7.329.929 ms`, ed e' la **cascade** a essere rimasta a `0/228` con `starved = true` e
stop reason `cascade deadline`.

La scomposizione del punto del 10-09: `9.554/32.508` incomplete, di cui **9.354** con **tutte le
slot presenti** (falliscono i rami semantici) e solo **200** con una slot corta o assente. Non e'
una locale non caricata.

**Argomento da non riusare**: «nessuno dei cinque valori compare prima nello storico, quindi non e'
un albero vecchio». E' debole — la serie e' campionata ogni poche ore. L'argomento che regge e' il
**totale**, che al punto anomalo e' sempre maggiore o uguale al precedente.

**Ipotesi escluse a costo zero, non ripagarle**: `titleLooksUntranslated`
(`scripts/lib/job-locale-utils.mjs:661`) e' deterministica e lessicale, `minConfidence` **inerte**;
`LOCALES` e `MIN_DESC_CHARS` (`relocalize-pending-jobs.mjs:91-92`) sono letterali; `classifyJob`
(`log-translation-stats.mjs:137`) non applica esenzioni a `incomplete`; `isSliceFile` esclude solo
`.gitkeep` e `coop-ticino-locale-cache.json`, entrambi con zero job.

**La fix**: spostare la misura sulla stessa tree pubblicata — dopo mop-up e re-assemble, dopo il
refresh/merge remoto. Lato **SITE** (`bin/where-to-fix`: `mode: assente`); il workflow del corpus e'
**generato**, non si tocca. Due vincoli: il punto **non deve sparire** quando la run finisce per
budget (era il regresso riparato da #8075 / issue #42), e non rimuovere l'invariante per cui il
checkout locale non viene avanzato (`git-commit-data.sh:1715-1727`). **Se la fix passa, i 102 punti
esistenti non sono confrontabili con i futuri e la condizione 1 riparte da zero.**
Scheda: `.scratch/codex-afterfix.txt`.

### La causa prima, misurata il 2026-09-11: la coda vecchia **e' servita**, ma dalla corsia sbagliata

Misurato da me sui log di tre run riuscite del corpus (`34416243224`, `34443590913`, `34541569329`)
e sul codice di `origin/main`. Smentisce la premessa della scheda `codex-c0drain.txt`.

**Il cap non e' 100, e' 900.** `RELOCALIZE_DEFAULT_MAX_JOBS = 900`
(`scripts/relocalize-pending-jobs.mjs:141`) e il workflow passa `--max-jobs 900`
(`translate-pending.yml:262`). Il commento alla riga 687 che dice «(default 100)» e' **stale**.
`effectiveMax = Math.min(MAX_JOBS, pending.length)` sta alla riga 1598.

**Una riserva per i job vecchi esiste gia'**: `RESERVE_FOR_OLDEST = 0.2`
(`scripts/lib/job-traffic-priority.mjs:62`), pescata oldest-first con passo di uno slot ogni cinque
(`strideForReserve`, :113). Quindi la risposta alla domanda della scheda e' **si', li raggiunge**:
la coda che la run ordina ha `oldest 150,6d · p50 24,6d`, e le sue fasce sono
`7-30d=1323 30-90d=1639 90-180d=273` su 4.350 datati — **il 74,4% della coda ha piu' di sette
giorni**. Il residuo non e' irraggiungibile: e' in cima.

**La run lo dice gia' da sola**, e nessuno lo stava leggendo:

```
⚠️  QUEUE AGE ALERT — oldest job in queue 150.6d, oltre il ratchet di 150d.
    drain is clearing the head and leaving the tail. Raise RESERVE_FOR_OLDEST or the cap.
```

**Dove si rompe davvero: la resa della Fase 2b.** Timeline degli step, dall'API:

| run | Fase 2a (Argos bulk) | Fase 2b (cascade) | job liberati dalla cascade |
|---|---|---|---|
| `34416243224` | 14,8 min | **69,2 min** | **42** |
| `34443590913` | 11,0 min | **75,4 min** | **26** |
| `34541569329` | **106,5 min** | **2,0 min** | **0** |

Due modi di fallire, entrambi reali. Quando la cascade **ha** la sua finestra rende **0,34-0,61
job/min**; il commento che dimensiona il cap a 900 assume **11,1 job/min**
(`relocalize-pending-jobs.mjs:124`), cioe' **18-32 volte** di piu'. E non e' una regressione: la
ricerca del 09-07 su dieci run aveva gia' misurato `resa=0,783 job/min`
(`cascade-short-row-fixed-cost-research.md:57`). La cascade ha **sempre** reso ~19-42 job per run.
Quando invece la Fase 2a esplode — 106,5 minuti contro gli 11-15 abituali — consuma l'intera
finestra run-wide e alla cascade restano 2 minuti e **zero** job: `JOBS_CASCADE_DEADLINE_MS` vale
`5400000` (90 min) ed e' misurato **da `RUN_START_MS`**, non dall'inizio della fase
(`relocalize-pending-jobs.mjs:254,264,599`).

**Perche' il residuo non si drena, in una riga.** Argos macina 8.928 traduzioni per run ma ne
scrive **2.396 (26,8%)**: il guard di lingua ne respinge **4.258 (47,7%)** perche' *anche il
candidato* e' nella lingua sbagliata, e altre 2.232 (25,0%) come `source-copy`. La composizione dei
respinti dice quale lavoro e':

| motivo | slot |
|---|---|
| `binnen-i` | 1.956 |
| `compound-residue` | 1.018 |
| `source-function-word` | 494 |
| `source-overlap` | 346 |
| `source-orthography` | 238 |
| `source-copy` | 206 |

Sono forme di genere e composti tedeschi: **esattamente cio' che Argos non sa fare** e che solo la
cascade HTTP/Haiku puo' fare. Quindi il residuo duro arriva a 4.258 slot per run davanti all'unica
corsia capace di risolverlo, e quella corsia ne libera **26-42**.

**Conseguenza per le condizioni 1 e 2.** Non e' un difetto da riparare: e' un **rapporto di
capacita'**. Finche' la cascade rende ~0,8 job/min in una finestra di 90 minuti, il suo tetto
strutturale e' ~70 job/run, contro una coda dura che si ripresenta a migliaia. Le leve gia'
studiate — #24 regola di salto, #25 tetto per azienda, #27 costo fisso per invocazione — valgono
insieme un fattore vicino a 2, non a 30. **La condizione 1 non puo' chiudersi spostando la riserva
o alzando il cap**: entrambi ridistribuiscono slot di una corsia che non ha throughput.

### La leva trovata il 2026-09-11: la Fase 2d non gira **mai**

Su **45 run riuscite** consecutive di `translate-pending.yml` del corpus, lo step
`Phase 2d: Fix untranslated titles (free cascade)` ha conclusione **`skipped` in tutte e 45**.

```bash
ids=$(gh api "repos/nanakokyobashi-rgb/frontaliere-articles/actions/workflows/translate-pending.yml/runs?per_page=60" \
  -q '.workflow_runs[] | select(.conclusion=="success") | .id')
for id in ${=ids}; do
  gh api "repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/$id/jobs" \
    -q '[.jobs[].steps[] | select(.name|test("Phase 2d")) | .conclusion] | join(",")'
done
```

(`${=ids}`, non `$ids`: il tool Bash gira **zsh**, che non fa word splitting. Con `$ids` il ciclo
esamina **una** run e sembra confermare qualunque cosa si stia cercando.)

**Il gate.** `if: steps.hk.outputs.run == 'true' && inputs.dry_run != true`, e lo step `hk` mette
`run=true` **solo** se `github.event.schedule == '0 7 * * *'` (`translate-pending.yml:166-178`).
Ogni run osservata stampa `⏭️  Housekeeping skipped (not daily cron)` — comprese quelle schedulate
che atterrano fra le 07:00Z e le 09:59Z. La Fase 2d e' quindi legata a una condizione di
**housekeeping** che non ha niente a che vedere col riparare titoli.

**Perche' e' la leva.** `scripts/fix-untranslated-titles.mjs` usa **`titleLooksUntranslated`** — lo
stesso predicato canonico che sta dentro `isIncomplete` — e ripara i titoli con la cascade HTTP
gratuita (DeepL → MyMemory), **senza AI e senza crawler**. E' l'unica corsia veloce che attacca il
ramo titolo di `incomplete`, contro una Fase 2b che paga un'invocazione di crawler per azienda e
rende 0,34-0,61 job/min.

**Il meccanismo completo, misurato su 100 run.** Il gate non e' solo mal puntato: punta sull'unica
run che **non sopravvive mai**.

| run | creata | durata del job | esito | housekeeping / Fase 2d |
|---|---|---|---|---|
| `34349391734` | 09-09 12:09Z | 5h55m | cancelled | success / skipped |
| `34223496560` | 09-08 11:58Z | 5h55m | cancelled | success / **cancelled** |
| `34126519779` | 09-07 13:16Z | 5h55m | cancelled | success / **cancelled** |
| `34030460785` | 09-06 11:30Z | 5h55m | cancelled | success / **cancelled** |
| `33962494837` | 09-05 11:07Z | 5h55m | cancelled | success / **cancelled** |
| `33404957452` | 08-31 14:50Z | 5h55m | cancelled | success / **cancelled** |

Su **100 run** esaminate, quelle col gate di housekeeping soddisfatto sono **sei**, e sono
**cancellate tutte e sei**. Il job dura ogni volta **5h55m**, cioe' il `timeout-minutes: 350`
(`translate-pending.yml:52`) piu' il grace della cancellazione. In cinque casi su sei la Fase 2d
risulta `cancelled`, non `skipped`: era **in esecuzione** quando e' caduta la scure.

La catena e' quindi doppia e si chiude da sola: la Fase 2d gira solo sulla run giornaliera di
housekeeping; quella run e' la piu' lunga di tutte perche' passa 593 slice di pulizia in piu'; e
per questo e' l'unica che arriva al tetto dei 350 minuti e viene uccisa proprio nel tratto finale
dove la Fase 2d vive. **Zero esecuzioni complete in undici giorni.**

E' anche, esattamente, il limite dichiarato dalla #8290 — «una kill brutale al cap dei 350 minuti
resta non intercettabile» — che quindi **si verifica ogni giorno**, non in teoria: la run di
housekeeping perde anche il punto della condizione 1.

**Il vincolo che governa la fix.** `UNTRANSLATED_TITLE_FIX_DEADLINE_MS` vale `18000000`, cioe' 300
minuti run-wide, contro un tetto di 350. La fix deve dichiarare **quando** gira e **con quale
budget**.

**PR sito #8296 aperta** (`phase-2d-reopen`): sposta il gate a
`github.event_name == 'schedule' && github.event.schedule != '0 7 * * *'` — cioe' su ogni run
schedulata **tranne** quella di housekeeping — e abbassa il budget a `14400000`, 240 minuti. Le run
non-housekeeping chiudono oggi fra ~125 e ~155 minuti, quindi il margine al tetto resta ampio.
Tocca sorgente (`translate-pending-logic.yml`), artefatto generato e `contract.json`. Scheda:
`.scratch/codex-p2d.txt`.

### Difetto separato: la corsia Haiku muore in 4 run su 7 dal 10-09

Nelle ultime 100 run di `translate-pending.yml` del corpus le `failure` sono **sei**: due a fine
agosto e **quattro tutte il 2026-09-10** (`34458198473` 09:00Z, `34474527640` 12:02Z,
`34482419809` 13:24Z, `34504919618` 16:54Z). Sette run quel giorno: **43%** di riuscita, contro
**nessun fallimento** fra il 31-08 e il 09-09.

Tutte e quattro sugli stessi step — `14 Run ./.github/actions/setup-claude-haiku-fallback` e
`26 Capture translation observability baseline` — con lo stesso errore:

```
##[error]Trusted Node/npm runtime must resolve outside writable runner trees.
```

L'action del corpus e' cambiata il 2026-09-10 alle **12:44:55Z** (`7f684bba610`), ma la prima run a
fallire e' quella delle **09:00Z**: il commit non e' il fattore scatenante. Quattro fallimenti
intermittenti con un controllo d'ambiente puntano a una **variazione del runner**. **Non spiega lo
stallo del residuo**, che comincia l'08-09. Le due copie dell'action differiscono (sito
`ae2dcc04b8bb`, corpus `a4e2bdde0347`), nessun vincolo di mirror, e quella che gira e' del
**corpus**. Scheda: `.scratch/codex-haikufix.txt`.

**RETTIFICA del 2026-09-11 08:00Z: la copia che gira e' quella del SITO, non quella del corpus.**

Il workflow del corpus fa `actions/checkout` di `valerielinc-ops/frontaliere-si-o-no` **senza
`path:`** (`translate-pending.yml:54-62`), quindi il sito viene scritto nella radice di
`$GITHUB_WORKSPACE`. Lo step successivo `uses: ./.github/actions/setup-claude-haiku-fallback`
(riga 163) legge dalla stessa radice: esegue la copia del **sito**. La variabile
`CODEX_ACTION_PATH` continua a mostrare
`/home/runner/work/frontaliere-articles/frontaliere-articles/./.github/actions/...` perche' quella
directory **si chiama** come il corpus, ma il suo contenuto e' il sito.

**La prova e' nel log, non nel ragionamento.** La run `34541569329` stampa
`trusted-runtime candidate=... mode=... owner=...` — tre campi. Al commit di quella run
(`745f2765e`) la copia del **corpus non conteneva affatto** `report_runtime_candidates`; quella del
**sito** lo contiene con esattamente quel `printf` a tre campi.

**Chi ha davvero riparato la corsia: PR sito #8224**, mergiata il 2026-09-10 alle **17:35:51Z** —
prima di qualunque lavoro di questa sessione. I quattro fallimenti sono tutti fra le 09:00Z e le
16:54Z, la prima riuscita e' alle 23:18Z. La #8224 **non allenta** il predicato: mantiene
`(( (8#$mode & 022) == 0 ))` e aggiunge un fallback fail-closed che scarica un Node
`v24.21.0` a checksum fisso in una directory privata sotto `RUNNER_TEMP`, con il commento che lo
dichiara: «Ubuntu's setup-node toolcache is runner-managed. It is intentionally rejected by
`path_components_trusted()`».

**Conseguenza sulle due PR del corpus.** #1352 (mergiata 06:46:51Z) e #1354 (mergiata 07:52:40Z)
correggono la copia del corpus, che **questo workflow non esegue**. Non erano la causa del guasto
alla corsia di traduzione.

**Ma quella copia non e' inerte** — misurato, non dedotto. I workflow del corpus che usano
`uses: ./.github/actions/setup-claude-haiku-fallback` sono **25**:

| workflow | checkout del sito prima dello `uses:` | copia eseguita |
|---|---|---|
| `crawler-group-01..23` | si', senza `path:` | **sito** |
| `translate-pending` | si', senza `path:` | **sito** |
| `generate-article` | **no** — `actions/checkout` senza `repository:` alla riga 598 | **corpus** |

Quindi #1352 e #1354 proteggono la generazione degli articoli, non la traduzione: il degrado
invece del fallimento e la maschera ottale valgono per `generate-article.yml`. La domanda aperta
si chiude cosi': **la copia del corpus serve a un workflow solo**, e le due copie restano
disallineate senza vincolo di mirror (`bin/where-to-fix`: `mode: assente`). Chi tocca una delle due
deve decidere esplicitamente se l'altra la segue.

**Ritirata la mia riserva.** Avevo scritto che l'affermazione dell'agente — «la riuscita usa una
versione dell'action del sito che scarica Node in `RUNNER_TEMP`, quindi non dimostra un runtime
trusted» — fosse una lettura del predicato e non una misura. **Era giusta**: e' esattamente cio'
che fa la #8224.

### Cadenza reale

Mediana **4,21 h** su 101 intervalli, **2,31 h** sugli ultimi 20, massimo 9,19 h. Sette rialzi MA3
richiedono almeno nove punti, cioe' **21-38 ore** di serie pulita.

**Trappola di metodo pagata su questo dato** (§45): la produttivita' oraria per giorno civile dava
«279 → 80 → 9 job/ora» e sembrava un crollo causato dalle PR del 09-09. Su finestre mobili di 24 h
compare una finestra morta di 28 ore **gia' fra il 06-09 e l'08-09**, e valori fra −0,4 e 215
job/ora. Le run durano 5-13 ore e si sovrappongono: la serie misura **atterraggi**, non lavoro.
**L'attribuzione a #8077 / #8078 e' ritirata.**

## Condizione 2 — un annuncio nuovo e' tradotto entro 24 ore

**Operativizzazione**: quota di `complete` nella **coorte 24-48h** (job messi in coda fra 24 e 48
ore fa). Sotto le 24h il ritardo e' legittimo, quindi la fascia parte da 24.

**Stato al 2026-09-11T05:06:37Z**, su `origin/main` `acf31d247f5b0af182a52b0a84800cc759c716fc`,
565 slice non vuote e 30 vuote: **786 / 979 = 80,3%**. Bersaglio ~100%.

Rispetto all'81,3% precedente e' **sceso di ~1,0 pp**: la PR **#8080** (ponte near-miss con limite
superiore d'eta') **non ha mosso questa coorte**.

Campo dell'eta' usato: `queuedAt` da `jobQueuedAtMs` in
`scripts/lib/job-traffic-priority.mjs:260-268`, catena `firstSeenAt` → `postedDate` → `crawledAt` →
`datePosted`. In questa lettura **32.988 job su 32.988 risolvono a `firstSeenAt`**: nessun
fallback, `crawledAt` mai usato.

### Le fasce adiacenti: la completezza **scende** con l'eta'

| fascia | complete / denominatore | quota |
|---|---|---|
| sotto 24h | 186 / 1.253 | 14,8% |
| **24-48h** | **786 / 979** | **80,3%** |
| 2-7 giorni | 4.073 / 6.062 | **67,2%** |

La fascia 2-7 giorni sta **13 punti sotto** la 24-48h. Se l'unico fenomeno fosse il ritardo di
lavorazione la completezza sarebbe monotona crescente con l'eta'. Due letture, lavori opposti:

1. **La completezza si perde** — job gia' `complete` tornano `incomplete`. Allora il problema e' la
   **conservazione** e nessun aumento di capacita' chiude le condizioni 1 e 2.
2. **Effetto coorte** — le coorti fresche hanno priorita' per costruzione e le vecchie non vengono
   piu' ripassate. Allora il residuo e' debito fermo e le condizioni si chiudono lasciandolo li'.

I cinque punti anomali della condizione 1 hanno **la firma della lettura 1**, ma transitoria.
Discriminante e scheda: `.scratch/codex-c0loss.txt`. **Questa misura sta sotto tutte e tre le
condizioni.**

**Predicato**: `isIncomplete` **importata** da `scripts/relocalize-pending-jobs.mjs` di
`origin/main`. Non reimplementarla: una versione riscritta a mano con soglie di lunghezza ha reso
**99,5%** dove la verita' era 81,3% — un numero che sembrava un successo e avrebbe chiuso la
condizione.

**Data di messa in coda**: il campo della coda (`queuedAt` nel modulo delle priorita'), **non**
`job.crawledAt`. Usare `crawledAt` e' l'altra meta' dell'errore che ha prodotto il 99,5%.

**Cautela d'esecuzione**: non importare lo script dal repo di lavoro — in questo workspace un
`import()` di uno script senza guard su `main` ha gia' scritto dati veri. Materializzalo altrove
(worktree sparse via `frontaliere-si-o-no/scripts/dev/fast-worktree.sh`, oppure sotto `.scratch/`
verificando che gli import relativi si risolvano) cosi' che la sua `ROOT` non punti al repo vero.

**Scheda gia' consumata**: `.scratch/codex-m2b.txt` — rientrata il 2026-09-11, il numero sopra e' il suo.

---

## Perche' i job restano `incomplete`: attribuzione al ramo, 2026-09-11

Misurato da me su `origin/main` del sito (`6a4441ee59c`) applicando `isIncomplete` **importata** e
poi ricalcando i suoi rami **nell'ordine del sorgente** per attribuire ogni job al **primo** che
scatta. Strumento: `.scratch/why2448.mjs`.

```bash
W=<dir>; git archive origin/main scripts | tar -x -C $W
for f in $(git ls-tree -r origin/main --name-only | grep -E '^data/[^/]+\.json$'); do
  git show origin/main:$f > $W/$f; done      # le lib caricano dati a import-time
SRC=$W REF=origin/main RELOCALIZE_ALLOW_NO_TRAFFIC=1 \
  BAND_LO_H=24 BAND_HI_H=48 node .scratch/why2448.mjs
```

**Coorte 24-48h — la condizione 2.** 978 job, **193 incomplete**, 80,3% complete (riproduce la
misura precedente: 979/193).

| causa | job | quota |
|---|---:|---:|
| **`titolo-non-tradotto`** | **174** | **90,2%** |
| `desc-troppo-magra` | 9 | 4,7% |
| `slot-desc-corta` | 5 | 2,6% |
| `desc-copia-sorgente` | 4 | 2,1% |
| `slot-titolo-assente` | 1 | 0,5% |

Per locale: `it` 77, `en` 49, `de` 29, `fr` 19.

**Residuo oltre i sette giorni — la condizione 1.** 24.694 job, **6.465 incomplete** (conferma i
6.464 misurati prima), 73,8% complete.

| causa | job | quota |
|---|---:|---:|
| **`titolo-non-tradotto`** | **4.122** | **63,8%** |
| `desc-uguale-normalizzata` | 1.476 | 22,8% |
| `desc-copia-sorgente` | 344 | 5,3% |
| `desc-troppo-magra` | 268 | 4,1% |
| `desc-lingua-sbagliata` | 171 | 2,6% |
| `slot-desc-corta` | 46 | 0,7% |
| `slot-titolo-assente` | 38 | 0,6% |

### Cosa ne segue

`titolo-non-tradotto` e' il ramo `titleLooksUntranslated` di `isIncomplete`, ed e'
**esattamente** il predicato che `scripts/fix-untranslated-titles.mjs` usa per selezionare cosa
riparare. Quindi la Fase 2d — quella che non gira mai — attacca:

- il **90,2%** del divario della **condizione 2**;
- il **64,2%** del residuo della **condizione 1**.

Il resto della condizione 1 e' un problema **diverso**: 1.820 job (28,1%) hanno la descrizione
uguale alla sorgente, normalizzata o letterale. La Fase 2d **non li tocca** — non modifica le
descrizioni, lo dichiara il suo stesso docstring. Serve una corsia per le descrizioni, e oggi
quella corsia e' la Fase 2b, che rende 26-42 job per run.

**Attribuzione chiusa al 100%**: nessun job resta non attribuito in nessuna delle due coorti. Il
buco del 6,3% della prima passata era mio, non del predicato: mancavano **due rami** di
`isIncomplete`, la rilevazione di lingua sulla descrizione
(`detectLanguageWithConfidence`, confidenza ≥ 0,65) e il controllo di descrizione **troppo magra**
rispetto alla sorgente (soglia 0,45 per `it`, 0,50 per `fr`/`de`, 0,55 altrove, solo su sorgenti
≥ 500 caratteri). Chiuso il buco, 30 job passano da `titolo-non-tradotto` al ramo corretto: la
quota titoli scende da 64,2% a **63,8%**, cioe' la conclusione non cambia ma il numero ora regge.

**Il blocco descrizioni, dopo la #8296.** Sommando i quattro rami che riguardano la descrizione —
`desc-uguale-normalizzata` 1.476, `desc-copia-sorgente` 344, `desc-troppo-magra` 268,
`desc-lingua-sbagliata` 171 — restano **2.259 job, il 34,9%** del residuo oltre i sette giorni.
Nessuno di questi lo tocca la Fase 2d. Ed e' plausibile che il mop-up Argos li **veda e li salti**:
il suo write-guard riporta `skip:source-copy 2.232` per run, un ordine di grandezza compatibile con
questa popolazione. Verificarlo e' la prossima domanda, non una conclusione.

## Condizione 3 — CHIUSA il 2026-09-11

**Formulazione**: fra i job `complete` il cui titolo sorgente tedesco porta una forma di genere,
quanti hanno almeno una traduzione non tedesca (it/en/fr) che la porta ancora. Predicato del
numeratore: `masculineGermanTitle(title) !== title` sul **titolo tradotto**. Chiude sotto il **10%**
su due misure consecutive.

**Stato: chiusa.** Con `isIncomplete` importata da `origin/main` e lo **stesso** predicato su tutti
e tre i ref:

| ref | ora | numeratore / denominatore | quota |
|---|---|---|---|
| `3790bb5399a` | 2026-09-09 04:09Z | 262 / 10.903 | **2,40%** |
| `4262cc889ee` | 2026-09-09 19:34Z | 251 / 10.189 | **2,46%** |
| `origin/main` (`acf31d247f5`) | 2026-09-11 | 252 / 10.265 | **2,45%** |

Tre letture consecutive a un quarto della soglia. Il numeratore **scende** (262 → 251), non
raddoppia.

**La «regressione» era il filtro rotto, per intero.** I job che lo stub ammetteva nel denominatore e
la funzione vera esclude contribuivano al numeratore dello stub con **588** job a `3790bb5399a` e
**1.526** a `4262cc889ee`: **+938**, contro il **+927** che era il salto inspiegato. La scheda
`m3reg` era costruita su un difetto inesistente ed e' stata **ritirata**.

**Righe verificate su `origin/main`** (non sul rapporto dell'agente):

| funzione | posizione |
|---|---|
| `isIncomplete` | `scripts/relocalize-pending-jobs.mjs:637` |
| `titleLooksUntranslated` | `scripts/lib/job-locale-utils.mjs:661` |
| `normalizeForLengthComparison` | `scripts/lib/dedicated-crawler-common.mjs:5231` |
| `masculineGermanTitle` | `scripts/local-mt-mopup.mjs:228` |
| `genderFormOffence` | `scripts/mark-mistranslated-jobs.mjs:175` |

**Strumento sbagliato, gia' pagato**: `genderFormOffence` legge solo il titolo sorgente, che non
cambia mai, quindi il numero non puo' scendere. Va bene **solo** come filtro del denominatore, mai
come numeratore. Ha reso 42,72% e non e' una misura di qualita'.

**Strada gia' scartata**: la riparazione euristica dei titoli a valle. Un detector al 33% di falsi
positivi distruggeva titoli buoni.

---

## L'unico work item aperto: #24

`https://github.com/valerielinc-ops/frontaliere-workspace/issues/24` — salto per azienda.

La macchina e' **gia' in produzione** (`COMPANY_SKIP_STATE_PATH`, `COMPANY_STERILE_RUNS` /
`COMPANY_SKIP_RUNS`, ledger scritto e riletto, salto applicato sia nel ciclo principale sia nel
ritentativo). Non c'e' niente da implementare: manca solo di **poterlo misurare**.

Il campo `companyServed` e' stato aggiunto all'artifact `translation-thinking-ab` dalla PR sito
**#8083** (emesso in `scripts/relocalize-pending-jobs.mjs` verso le righe 1968 e 2127). La issue
si chiude con **10 punti dati non vuoti**; alla chiusura della PR ce n'erano **5**.

**Trappola che decide il risultato**: contare le righe **senza filtrare su `companyServed`**
riproduce il **37,6%**, che e' il numero sbagliato. Sulla run `34207161385`, 197 righe su 200
erano aziende mai servite; escluderle porta a **17,1%**. Lo stesso insieme di run, due verdetti
che differiscono del doppio.

### Misurato il 2026-09-11: #24 e' **non chiudibile**, e non e' la leva

Scheda `.scratch/codex-m24b.txt`, rientrata. **7 punti validi** sui 10 che servono: `34291200957`,
`34315383960`, `34317459305`, `34332308235`, `34416243224`, `34441079032`, `34443590913`.

| run | righe | servite | servite e sterili | sterile / servita (min) | % |
|---|---:|---:|---:|---:|---:|
| `34291200957` | 200 | 8 | 4 | 26,9 / 48,4 | 55,5% |
| `34315383960` | 202 | 6 | 2 | 16,3 / 52,9 | 30,8% |
| `34317459305` | 201 | 5 | 0 | 0,0 / 48,6 | 0,0% |
| `34332308235` | 205 | 5 | 1 | 8,7 / 49,6 | 17,4% |
| `34416243224` | 201 | 7 | 0 | 0,0 / 48,2 | 0,0% |
| `34441079032` | 202 | 5 | 2 | 7,6 / 47,4 | 16,1% |
| `34443590913` | 205 | 8 | 5 | 42,8 / 55,4 | 77,2% |

Mediana **17,45%**, range **0,00-77,23%**, SD **26,75 pp**, IQR di Tukey **0,00-55,48%**. Con n=7 e
una dispersione cosi' la mediana non e' un numero su cui decidere: e' un ordine di grandezza.

**Ma la colonna che conta non e' quella che la issue chiedeva.** Delle ~200 righe per run —
una per azienda del lotto — le aziende **effettivamente servite** sono **5-8**, e consumano
47-55 minuti. Tutto il resto della finestra della cascade non e' sterile: e' **mai arrivato**.
Combacia con il `252 companies remaining (deferred to next run)` stampato dalle run.

**Aritmetica della leva.** La finestra sterile mediana vale ~17,45% di ~50 minuti serviti, cioe'
~8,7 minuti per run. A `0,783 job/min` (`cascade-short-row-fixed-cost-research.md:57`) recuperarla
per intero vale **~7 job per run**, contro i 26-42 che la cascade gia' libera e contro un residuo
duro di **6.464** job oltre i sette giorni.

**Verdetto**: #24 va fatto — e' tempo gia' pagato che torna gratis — ma **non chiude ne' la
condizione 1 ne' la 2**. Chiamarlo «l'unico work item aperto» era corretto come inventario e
fuorviante come piano.

**Nota sullo strumento, verificata**: l'artifact `translation-thinking-ab` **viene ancora
prodotto** — l'ultimo e' della run `34541569329` (2026-09-11T01:51Z), e ce ne sono per
`34443590913`, `34441079032`, `34380507868`, `34360370563`. I punti «mancanti» non sono un guasto
della strumentazione: sono run in cui le **aziende servite sono zero**, e quindi il denominatore
della misura e' nullo. La run `34541569329` ne e' l'esempio: `0 jobs translated so far; 252
companies remaining`, perche' la Fase 2a aveva gia' consumato la finestra.

Cioe': i tre punti che mancano a #24 mancano **per lo stesso motivo per cui #24 non basta**. Non e'
un'attesa che si risolve aspettando — si risolve alzando la resa della Fase 2b.

---

## Cosa e' gia' chiuso

Sei issue chiuse, cinque PR sito mergiate:

| PR | Chiude | Cosa |
|---|---|---|
| #8075 | #42 | Tetto di 350 minuti: uccideva una run su sei, sempre dopo `Commit translations`, cioe' cancellava il punto dati della condizione 1. |
| #8077 | — | Rimozione dell'handle one-shot `reflag_gender_forms` dopo l'uso. **Sospettato nella regressione della condizione 3.** |
| #8078 | #29 | Quarto vettore di soppressione, mai documentato, sotto `SKIP_AI_TRANSLATION`. |
| #8080 | #40 | Buco 24-48h: ponte near-miss con limite superiore d'eta' (`NEAR_MISS_WINDOW_MS = 2 * FRESH_WINDOW_MS`). |
| #8083 | — | Campo `companyServed` nell'artifact, per #24. |

Chiuse senza codice nuovo perche' il lavoro era gia' in main: **#38** (#7927+#7930), **#31**
(#7936), **#34** (risparmio gia' preso in `fc36df0`, il resto gia' provato e ritirato in
`47eaf068`).

---

## Regole di misura che questo lavoro ha pagato per imparare

Stanno per esteso in `.agents/references/codex-agent-lessons.md`, §30-§39. Le tre che qui hanno
morso davvero:

1. **Un predicato di destinazione deve poter arrivare a zero.** Un predicato di accodamento non e'
   una metrica di qualita'. (§34)
2. **Numeratore e denominatore insieme, sempre, e in entrambe le misure di una coppia.** Uno zero
   senza denominatore chiude una issue per sbaglio. (§31, §39)
3. **Una condizione «su due misure consecutive» nasce con il ref parametrizzato.** Se lo script ha
   `origin/main` hardcodato, la seconda misura non sara' confrontabile con la prima. (§39)

---

## Runbook: come terminare le tre misure rimaste

Le schede sono gia' scritte. **Non riscriverle**: rilanciarle. Ogni scheda contiene i predicati
corretti, le trappole gia' pagate e la forma della consegna.

### Prima di lanciare: la RAM decide quante ne puoi tenere

```bash
vm_stat | sed -n '2p'
sysctl -n vm.swapusage
```

Sotto **~10.000 pagine libere non dispacciare**. Sopra le 20.000 puoi tenerne tre in parallelo;
in mezzo, una alla volta. La macchina e' condivisa con le altre sessioni: `ListAgents` dice
quante sono attive in questo momento.

### La forma di invocazione, obbligatoria

```bash
cd /Users/saggesel/Projects/frontaliere
P=~/.claude/plugins/cache/openai-codex/codex/1.0.6
CODEX_COMPANION_SANDBOX=danger-full-access node "$P/scripts/codex-companion.mjs" \
  task --write --fresh --model gpt-5.6-luna --effort max "$(cat .scratch/codex-<nome>.txt)" \
  > .scratch/out-<nome>.txt 2>&1
```

Sempre in background, sempre con output su file. `CODEX_COMPANION_SANDBOX=danger-full-access` non
e' opzionale: senza, il companion ricade su `workspace-write`, la rete e' chiusa e i comandi
falliscono con `Could not resolve host`.

### Le schede: quali sono vive, al 2026-09-11 06:30Z

| scheda | stato |
|---|---|
| `codex-m3reg.txt` | **RITIRATA** — cercava la causa di una regressione che non esiste (vedi condizione 3) |
| `codex-m2b.txt` | **consumata** — ha reso 786/979 = 80,3% sulla coorte 24-48h |
| `codex-c3pred.txt` | **consumata** — ha chiuso la condizione 3 |
| `codex-c1art.txt` | **consumata** — ha trovato l'ordine degli step |
| `codex-c0loss.txt` | **consumata** — ha smentito «la completezza si perde» (4 job su 1.989) |
| `codex-c1pred.txt` | **consumata** — ha chiuso l'aritmetica del divario 6.571/9.720 |
| `codex-afterfix.txt` | **viva, implementazione** — sposta la misura sulla tree pubblicata (sito) |
| `codex-haikufix.txt` | **consumata** — PR corpus #1352 mergiata 11-09 06:46Z; follow-up #1354 aperta |
| `codex-c0drain.txt` | **ritirata** — premessa smentita: il cap e' 900 non 100, la riserva oldest-first esiste e la coda vecchia e' in cima. Risposta misurata direttamente, vedi «La causa prima» |
| `codex-m24b.txt` | **viva, non lanciata** — punti dati di #24, non bloccante |

L'ordine, se ne lanci una sola: **`afterfix`**. Finche' la misura e' rotta, ogni altro numero sulla
condizione 1 e' una lettura di un albero di passaggio.

### Terminarle: **per ID, mai per firma**

Al lancio in background il tool restituisce un `task_id`. Fermale cosi', una per una:

```
TaskStop con task_id = <l'id restituito al lancio>
```

**Mai `pkill -f codex-companion`.** Su questa macchina girano piu' sessioni Claude e tutte
lanciano Codex con la stessa riga di comando: il pattern non distingue i tuoi job da quelli di un
peer. E' gia' costato il job di una sessione vicina il 2026-09-09. Vale per qualunque comando che
selezioni processi per pattern: `pkill`, `killall`, `kill` su output di `ps | grep`.

Se lo fai comunque, **avvisa i peer**: `ListAgents` li elenca, e un messaggio con l'ora e la firma
usata permette a chi ha perso un job di riconoscerlo invece di inseguire un guasto inesistente.

### Prima di fermare: guarda se ha gia' finito

Un job che sembra fermo di solito ha gia' consegnato. Prima di terminarlo:

```bash
tail -c 2000 .scratch/out-<nome>.txt
```

Se ha aperto una PR, cercala prima di rilanciare: un rilancio su lavoro gia' fatto ne produce una
seconda.

### Quando rientrano: verificare il codice, non il rapporto

Il rapporto di un agente non e' la prova. Per ogni affermazione che tocca il codice:

```bash
git -C /Users/saggesel/Projects/frontaliere/frontaliere-si-o-no show origin/<branch>:<file> | grep '<la riga>'
```

Due trappole in questo comando:

- `git show origin/<branch>:<file>` su un ref **non risolto** non fallisce: rende un commit, con
  exit 0 e nessun errore. Se l'output non ha la forma del file atteso, risolvi prima il ref con
  `git fetch origin <branch>:refs/tmp/x` e leggi da `refs/tmp/x`.
- Un `cwd` alla deriva fa dire a git «il file non esiste» invece di «sei nel repo sbagliato».
  Usa sempre `git -C <path assoluto>`.

### Cosa accettare come risultato

Per ognuna delle tre, il risultato e' valido solo se porta **numeratore e denominatore insieme**.
Un numeratore solo — soprattutto uno zero — non e' una misura: ha gia' quasi chiuso una issue per
errore. E per la condizione 3, la seconda misura vale solo se presa **rieseguendo lo script anche
sul commit precedente** (`REF=<commit> node .scratch/cond3c.mjs`), non confrontandola con un
numero citato.

Ogni scheda autorizza esplicitamente a **smentire la premessa**. Una premessa smentita con la
misura che la smentisce e' un risultato corretto, non un fallimento: tre delle sei issue chiuse
finora si sono chiuse cosi'.
