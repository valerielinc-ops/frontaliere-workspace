# Mappa wayfinder #2 — le tre condizioni di chiusura, con lo strumento che le misura

Stato al **2026-09-09 22:00Z**. Questo file esiste perche' i numeri della mappa scadono e i
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

**Stato al 2026-09-11 04:52Z**: catena **0 di 7**. 102 punti `after`, 100 punti MA3. Il 4 di 7 del
09-09 e' stato azzerato dal punto anomalo del 2026-09-10T00:16Z.

**Dove sta il dato**: `data/translation-stats-history.json` nel repo sito, voci con
`label === "after"`. Ne arriva una ogni ~2,2 ore.

### Cio' che tiene aperta la condizione non e' la traduzione: e' un punto di storico sbagliato

Cinque punti su 102 sono avvallamenti da 6 a 15 pp che si riprendono del tutto al punto dopo. In
**5 casi su 5** la voce `before` della stessa run e' identica alla `after` in `complete`,
`incomplete` e `total`: **quella run non ha tradotto nulla**, quindi il numero non e' uno stato
intermedio ma una sola lettura, e i due vicini la smentiscono.

| punto `after` | complete/incomplete | quota | prima | dopo |
|---|---|---|---|---|
| 2026-09-04T17:01:06Z | 15.863/13.115 | 54,74% | 60,58% | 62,32% |
| 2026-09-07T03:25:29Z | 17.321/11.243 | 60,64% | 69,02% | 68,39% |
| 2026-09-07T21:57:04Z | 17.590/11.118 | 61,27% | 69,83% | 67,94% |
| 2026-09-08T22:09:27Z | 20.998/11.156 | 65,30% | 80,88% | 76,85% |
| 2026-09-10T00:16:10Z | 22.954/9.554 | 70,61% | 79,66% | 79,68% |

Due ipotesi **gia' escluse**, per non ripagarle:

- **Non e' un checkout stale**: nessuno dei cinque valori compare prima nello storico; lo stato
  storico piu' vicino dista fra 223 e 3.558 job.
- **Non e' una slice mancante**: sul punto del 10-09 il `total` e' 32.508 contro i 32.499 dei
  vicini — nove job **in piu'**, non migliaia in meno. Il denominatore c'e' tutto; a cambiare e'
  la **classificazione** di circa 2.942 job.

Sulla MA3 ogni anomalia avvelena **tre** punti consecutivi. Con un punto ogni ~2,2 ore e
un'anomalia ogni ~20 punti, la finestra pulita necessaria (~15 ore) e' appena piu' corta
dell'intervallo medio fra due anomalie: la condizione e' raggiungibile ma fragile.

**Il produttore, identificato** — non ricercarlo:

- `.github/workflows/translate-pending.yml` **del sito** e' la copia morta: non gira dal
  **2026-08-25**.
- `.github/workflows/translate-pending-logic.yml` **del sito** e' la **sorgente** del workflow
  generato.
- Quello che gira e' `.github/workflows/translate-pending.yml` del **repo corpus**, «Translate
  Pending Jobs (sparse cross-repo execution)». Tutti e cinque i punti anomali sono portati da
  commit `🌐 Auto-translate pending jobs` prodotti da li'.

**Ipotesi esclusa a costo zero**: `titleLooksUntranslated` (`scripts/lib/job-locale-utils.mjs:661`)
e' deterministica e puramente lessicale — nessuna rete, nessun modello, `minConfidence` accettata e
**inerte**. A parita' di dati del job non cambia verdetto. L'anomalia viene dai dati che quella run
aveva in mano.

**Il correlato che distingue i punti anomali: la contesa sul passo di commit.** Ritardo fra il
timestamp del punto `after` e il commit che lo porta su `main`, su 52 punti confrontabili:

| gruppo | n | mediana | valori |
|---|---|---|---|
| normali | 47 | **0,61 h** | min 0,12 — max 2,56; solo 8 su 47 sopra 1 h |
| anomali | 5 | **2,20 h** | 1,30 · 1,84 · 2,20 · 2,59 · 2,62 |

Tutti e cinque nella coda lunga. Il ritardo e' posteriore al calcolo, quindi non ne e' la causa:
e' l'indicatore di quanto la run resta appesa fra calcolo e push. Nel corpus le run di
`translate-pending.yml` durano **5-13 ore** e si **sovrappongono**: nella finestra del 10-09 la run
`34360370563` (13:56Z → 02:39Z, ~12,7 h) finisce mentre `34380507868` e `34416243224` sono in corso.

Ipotesi da verificare: una run lunga calcola le statistiche dal proprio albero, vecchio di ore, e
le scrive dopo che altre run hanno gia' committato traduzioni piu' recenti. La verifica e' diretta:
**il passo delle statistiche legge i job prima o dopo il rebase del passo di commit?** Da guardare
nello stesso giro `translate-queue-recovery.yml` e `translate-queue-recovery-watchdog.yml` del
corpus. Scheda: `.scratch/codex-c1art.txt`.

**Cadenza reale**, contro il «~2,2 ore» scritto prima: mediana **4,21 h** su 101 intervalli,
**2,31 h** sugli ultimi 20, massimo 9,19 h. Sette rialzi MA3 richiedono almeno nove punti, cioe'
**21-38 ore** di serie pulita.

**Comando**:

```bash
cd frontaliere-si-o-no && git fetch origin main -q
git show origin/main:data/translation-stats-history.json > /tmp/hist.json
node -e '
const h=require("/tmp/hist.json");
const a=(Array.isArray(h)?h:h.entries||[]).filter(e=>e.label==="after");
const s=a.map(e=>e.complete/(e.complete+e.incomplete));
const ma=[]; for(let i=2;i<s.length;i++) ma.push((s[i]+s[i-1]+s[i-2])/3);
let chain=0,best=0; for(let i=1;i<ma.length;i++){ if(ma[i]>ma[i-1]){chain++; if(chain>best)best=chain;} else chain=0; }
console.log(JSON.stringify({punti:ma.length,catena_corrente:chain,catena_max:best,ultimi6:ma.slice(-6).map(x=>+(x*100).toFixed(2))}));
'
```

**Trappola**: un punto dati puo' **mancare** invece di essere negativo. Il tetto di 350 minuti
uccideva una run su sei sempre dopo `Commit translations` e prima di
`Commit translation observability history`, cioe' cancellava esattamente il punto di questa
condizione. Riparato dalla PR sito **#8075** (issue #42). Se la catena si spezza senza una ragione
visibile nei dati, la prima cosa da guardare e' se il punto e' stato scritto.

---

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

**Scheda pronta**: `.scratch/codex-m2b.txt`.

---

## Condizione 3 — meno del 10% dei `complete` mal tradotti, su due misure consecutive

**Predicato**: fra i job `complete` il cui titolo sorgente tedesco porta una forma di genere,
quanti hanno **almeno una traduzione non tedesca** (it/en/fr) che la porta ancora. Test:
`masculineGermanTitle(title) !== title` sul **titolo tradotto**.

**Stato**: **catena 0**. Regressione misurata.

| commit | ora | denominatore | numeratore | quota |
|---|---|---|---|---|
| `3790bb5399a` | 2026-09-09 04:09Z | 13.730 | 850 | **6,19%** |
| `4262cc889ee` | 2026-09-09 21:34Z | 13.788 | 1.777 | **12,89%** |

Denominatore piatto (+0,4%), numeratore **+109%** in ~17 ore. Non e' crescita del corpus.

**Strumento — ROTTO, verificato il 2026-09-11.** `cond3b.mjs` e `cond3c.mjs` importano i predicati
da `.scratch/extracted-functions.mjs`, e li' `isIncomplete` e' **la versione riscritta a mano con
le sole soglie di lunghezza** (`minTitleChars = 3`, `minDescChars = 120`): esattamente il predicato
che in questo lavoro ha gia' reso 99,5% dove la verita' era 81,3%.

La `isIncomplete` vera e' `scripts/relocalize-pending-jobs.mjs:637` e ha **due controlli che lo
stub non ha**: la guardia sulla locale sorgente (`normSrc.length / normBase.length < 0.55`) e
`titleLooksUntranslated` **per slot**. Quindi il `complete` dello stub e' un **soprainsieme** di
quello vero, e i job in eccesso sono in buona parte quelli **col titolo ancora in tedesco** —
cioe' proprio quelli che finiscono nel numeratore. Lo strumento ammetteva nel denominatore i job
che poi trovava nel numeratore.

`masculineGermanTitle` invece e' **fedele al byte** a `scripts/local-mt-mopup.mjs:228`: il
predicato del numeratore non e' in discussione.

Conseguenza: **il livello non regge** — ne' 6,19% ne' 12,89% sono la quota della condizione 3 come
la mappa la definisce. **Il raddoppio regge come segnale**, perche' le due misure usano lo stesso
filtro sbagliato, ma acquista una causa alternativa precisa: se in quella finestra sono cresciuti i
job con titolo non tradotto, lo stub li ha promossi a `complete` e li ha trovati nel numeratore
senza che nessun percorso di scrittura abbia prodotto una traduzione nuova sbagliata.

Rimisura con il predicato importato: scheda `.scratch/codex-c3pred.txt`, su tre ref
(`3790bb5399a`, `4262cc889ee`, `origin/main` di oggi).

**La regola che resta valida**: il ref va parametrizzato (`REF=<commit> node ...`). Una condizione
«su due misure consecutive» va verificata **rieseguendo lo strumento sul commit precedente**, mai
confrontando con un numero citato.

**Strumento sbagliato, gia' pagato**: `genderFormOffence` legge **solo il titolo sorgente**, che
non cambia mai, quindi il numero non puo' scendere. Ha reso 42,72% e non e' una misura di
qualita'. Non tornarci.

**Causa da trovare**: `scripts/local-mt-mopup.mjs` normalizza (`masculineGermanTitle` verso la
riga 228, `normalizeArgosText()` verso 236-240, `buildMopupRequest()` verso 247 invocata verso
627). Qualche **altro** percorso di scrittura del titolo tradotto evidentemente no. La diagnosi e'
stata dispacciata ma **non e' rientrata**. Scheda: `.scratch/codex-m3reg.txt`.

Ipotesi da verificare per prima, gia' scritta nella scheda: la PR sito **#8077** ha rimosso
l'handle one-shot `reflag_gender_forms` e il suo step; va stabilito se quello step facesse
**anche** normalizzazione, o solo rimarcatura per la ricoda.

Ipotesi alternativa, altrettanto legittima: i 927 job non sono nuovi errori ma job **gia'
sbagliati diventati `complete`** in quella finestra, entrati nel numeratore da un'altra porta. In
quel caso e' una regressione di contabilita', non di qualita'. Il conteggio che discrimina e'
quanti dei 927 esistevano gia' sbagliati e non `complete`.

**Strada gia' scartata**: la riparazione **euristica** dei titoli a valle. Un detector al 33% di
falsi positivi distruggeva titoli buoni. Non riproporla senza un detector di qualita' diversa.

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

Il conteggio aggiornato dei punti dati e' stato dispacciato ma **non e' rientrato**. Scheda:
`.scratch/codex-m24b.txt`.

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

I tre `<nome>` da usare: `m3reg`, `m2b`, `m24b`.

### L'ordine, e perche' e' questo

1. **`m3reg`** — la causa della regressione della condizione 3. Va per prima perche' e' l'unica
   che va nella direzione sbagliata: finche' la causa e' aperta, le due misure consecutive non
   possono nemmeno partire.
2. **`m2b`** — coorte 24-48h. E' una lettura sola e dice se la PR #8080 ha funzionato.
3. **`m24b`** — punti dati di #24. Non e' bloccante: la issue si chiude da se' quando i punti
   arrivano a 10.

Se ne lanci una sola, lancia `m3reg`.

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
