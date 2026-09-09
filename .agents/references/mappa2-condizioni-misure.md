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

**Stato**: catena **4 di 7**. 98 punti MA3 disponibili.

Ultimi sei punti della media mobile:

| # | MA3 |
|---|---|
| -6 | 74,34% |
| -5 | 73,69% |
| -4 | 78,32% |
| -3 | 79,15% |
| -2 | 79,33% |
| -1 | 79,49% |

**Dove sta il dato**: `data/translation-stats-history.json` nel repo sito, voci con
`label === "after"`. Ne arriva una ogni ~2,2 ore. Servono 3 rialzi ancora, cioe' ~7 ore se
tengono.

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

**Stato**: ultima misura nota **81,3%**, bersaglio ~100%. Una rilettura col nuovo ordinamento
della PR **#8080** e' stata dispacciata ma **non e' rientrata**: il numero 81,3% e' precedente a
quel cambiamento.

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

**Strumento**: `cond3b.mjs` nello scratchpad, con `extracted-functions.mjs` accanto. La variante
`cond3c.mjs` ha il ref parametrizzato (`REF=<commit> node cond3c.mjs`) ed e' quella da usare:
una condizione «su due misure consecutive» va verificata **rieseguendo lo script sul commit
precedente**, mai confrontando con un numero citato. E' quel controllo che qui ha separato una
regressione vera da una crescita di popolazione.

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
