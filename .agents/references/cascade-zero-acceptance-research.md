# Le aziende ad accettazione zero nella finestra del cascade — nota di ricerca

Ricerca del **2026-09-07**, in risposta a
[frontaliere-workspace#23](https://github.com/valerielinc-ops/frontaliere-workspace/issues/23)
(collegate: #22 accettazione bimodale, #20 finestra residua, parent #2).

Sola lettura: nessun file di codice, nessun workflow e nessun dato di produzione
sono stati modificati.

## Cosa e' misurato dal vivo e cosa viene dalla issue

**Misurato ora, sui dati vivi:**

- I **10 artifact** `translation-thinking-ab-<id>-1` non ancora scaduti sul repo
  del corpus (`gh api repos/nanakokyobashi-rgb/frontaliere-articles/actions/artifacts`,
  tutti con `expired=false` al 2026-09-07). La issue ne cita nove; nel frattempo
  ne e' arrivato un altro (`34044040517`, generato 2026-09-06T23:33Z).
- I **9 artifact** `translation-observability-<id>` corrispondenti, per la
  finestra effettiva della fase `cascade` e il suo `stopReason`.
- Lo **stato reale dei job** delle sette aziende nominate, estratto da
  `origin/main` del sito (`git show origin/main:data/jobs/by-crawler/<key>.json`)
  sia allo stato corrente sia a sei commit consecutivi fra il 2026-09-04 e il
  2026-09-06, per vedere come lo stesso job si muove da una run all'altra.
- Il **verdetto del gate** su ognuno di quei job, ottenuto importando la
  `isIncomplete` vera (`scripts/relocalize-pending-jobs.mjs:421`) e
  riproducendone l'ordine dei rami con le stesse funzioni importate
  (`titleLooksUntranslated`, `detectLanguageWithConfidence`). La riproduzione e'
  stata validata: **507 stati-job, zero disaccordi** con `isIncomplete`.

**Preso dalla issue e non rimisurato:** nulla di quantitativo. I numeri della
issue (308 tentativi, 225,8 min, 82/26,6%, 70,7 min/31,3%) sono stati sostituiti
dalla rimisura. Restano validi come ordine di grandezza — la rimisura li conferma
quasi esattamente, vedi sotto.

**Rimisura della claim (10 run, 2026-09-05T06:46Z → 2026-09-06T23:33Z):**

```
run=10 righe=72 finestra=237.5min liberati=186
resa=0.78 job/min   finestra sterile (cleared==0)=57.7min (24.3%) su 37 righe
```

Gruppo ad accettazione ≤ 0,20 (aziende con `attempted > 0`):
**7 aziende, 85 tentativi su 324 (26,2%), 74,1 min su 237,5 (31,2%), 4 job
liberati.** La claim della issue **regge** sui dati vivi, praticamente invariata.
Alla lista della issue si aggiunge `delvitech-sa` (0/3).

| azienda | att | cle | acc | min |
|---|---|---|---|---|
| `burkhalter-group` | 56 | 24 | 0,43 | 53,2 |
| `vf-international-the-north-face-timberland` | 16 | 1 | **0,06** | **37,9** |
| `pemsa` | 35 | 31 | 0,89 | 32,9 |
| `mcdonald-s-switzerland` | 48 | 48 | 1,00 | 27,6 |
| `marriott` | 14 | 2 | **0,14** | 14,6 |
| `arxada` | 12 | 0 | **0,00** | 10,2 |
| `galenica` | 34 | 26 | 0,76 | 9,3 |
| … | | | | |
| `weisse-arena` | 6 | 1 | **0,17** | 3,9 |
| `delvitech-sa` | 3 | 0 | **0,00** | 3,4 |
| `banca-sempione` | 6 | 0 | **0,00** | 3,2 |
| `usi-universita-della-svizzera-italiana` | 28 | 0 | **0,00** | 1,0 |

Due correzioni alla lettura della issue, entrambe rilevanti per le conclusioni:

1. **`usi` non e' il caso da riparare, e' il caso da capire.** I suoi 28
   «tentativi» costano in tutto **1,0 minuti su 237,5** (0,4%). E' il caso
   diagnostico perfetto — determinismo assoluto — ma sul consumo di finestra e'
   irrilevante.
2. **Il piu' grande singolo pozzo di finestra della serie non e' nel gruppo ad
   accettazione bassa.** La riga `burkhalter-group` della run `34022638117` ha
   speso **1716,7 s (28,6 min, il 12% dell'intera serie) per 1 solo job
   liberato**, ma l'accettazione complessiva di burkhalter e' 0,43 e nessuna
   regola basata sull'accettazione per azienda la tocca.

La metrica piu' onesta non e' «accettazione ≤ 0,20» ma **finestra sterile**:
le 37 righe su 72 (51%) che hanno prodotto `cleared == 0` costano
**57,7 min su 237,5, cioe' il 24,3%**.

**Il vincolo di finestra e' reale e sempre attivo.** Su tutte e 8 le run con
`runPhases` negli artifact di osservabilita', la fase cascade ha
`stopReason: "cascade deadline"`. Nessuna run e' finita per `queue exhausted`.
Quindi ogni minuto liberato e' un minuto che il cascade spende davvero su
un'altra azienda: la conversione minuti → job non e' ipotetica.

| run | fase cascade | somma righe A/B | job liberati | copertura | stopReason |
|---|---|---|---|---|---|
| `33955176620` | 19,6 min | 18,3 | 22 | 93% | cascade deadline |
| `33975963053` | 44,4 | 42,3 | 42 | 95% | cascade deadline |
| `33997493400` | 6,6 | 5,5 | 8 | 83% | cascade deadline |
| `34013657674` | 2,2 | 1,5 | 0 | 68% | cascade deadline |
| `34015450260` | 25,7 | 24,2 | 14 | 94% | cascade deadline |
| `34022638117` | 39,9 | 38,3 | 12 | 96% | cascade deadline |
| `34033876142` | 38,1 | 36,0 | 38 | 94% | cascade deadline |
| `34044040517` | 52,5 | 50,4 | 33 | 96% | cascade deadline |

Le righe A/B coprono il 93-96% della fase (`cleared` coincide esattamente con
`runPhases.jobsCleared`): l'artifact e' un registro fedele della fase cascade, e
si puo' usare come misura senza correzioni.

---

## Parte 1 — Perche' il gate rifiuta queste aziende

### Dove sta il gate

Il gate e' `isIncomplete(job)` in
`frontaliere-si-o-no/scripts/relocalize-pending-jobs.mjs:421`. Il cascade non lo
consulta direttamente: `clearRetranslationFlags`
(`scripts/relocalize-pending-jobs.mjs:710-722`) conta come «liberato» il job che
soddisfa `job.needsRetranslation && !isIncomplete(job)`, e il delta di quel
contatore per azienda e' il campo `cleared` della riga A/B
(`scripts/relocalize-pending-jobs.mjs:1594-1602`). Il campo `attempted` e' invece
l'insieme degli slug della stessa azienda **il cui contenuto locale e' cambiato**
rispetto allo snapshot pre-crawler (`changedSlugsSince`,
`scripts/relocalize-pending-jobs.mjs:374`).

I rami di rifiuto, in ordine, per ogni locale di `['it','en','de','fr']`:

| riga | controllo |
|---|---|
| `:448` | titolo < 3 char o descrizione < 120 char |
| `:479-487` | `titleLooksUntranslated(...).untranslated` |
| `:491` | descrizione identica alla sorgente (match esatto) |
| `:496-499` | descrizione identica alla sorgente (normalizzata) |
| `:511-518` | lingua della descrizione ≠ locale con confidenza ≥ 0,65 |
| `:526-539` | descrizione «sottile»: `normDesc.length < normSrc.length * thinRatio`, con `thinRatio` 0,45 (sorgente it), 0,50 (fr/de), **0,55 (en)** |

**Verifica della trappola nota di questo workspace:** `detectTextLocale` ritorna
un oggetto, e un confronto `!== loc` sarebbe sempre vero. Non e' il caso qui:
tutti e cinque i chiamanti nel sito leggono `.lang`
(`scripts/lib/job-locale-utils.mjs:141`,
`scripts/lib/dedicated-crawler-common.mjs:1284,3093,3117,3148`), e il ramo `:518`
usa `detectLanguageWithConfidence(...).lang !== locale`. **Ipotesi smentita: non
c'e' quel bug in questo percorso.**

### Distribuzione dei motivi, stato corrente delle 7 aziende

Sui job che `needsTranslation()` seleziona oggi:

```
weisse-arena     45 x 487 titleLooksUntranslated,  2 x 538 thin-desc
marriott          8 x 487,  3 x 499 desc~=source,  2 x 538
vf-international  6 x 538,  3 x 487
arxada            4 x 538,  1 x 487
banca-sempione    2 x 487
usi / delvitech   (nessun job incompleto oggi: solo flag residui)
```

Sotto-motivo di `titleLooksUntranslated` (59 occorrenze totali):

```
34  reason=source-copy
14  reason=binnen-i
 5  reason=compound-residue
 4  reason=source-function-word
 2  reason=source-orthography
```

`source-copy` e' `scripts/lib/job-locale-utils.mjs:668-671`: uguaglianza
normalizzata esatta fra il titolo del locale e il titolo sorgente.

### Le tre classi di rifiuto

**Classe A — rifiuto tautologico da `sourceLang` mal appuntato. E' il caso `usi`,
ed e' la conferma dell'ipotesi `fachkraft.ch` della issue, con una precisazione.**

I due job che compongono lo 0/28 di `usi` sono
`posizioni-di-dottorandi-usi-lugano` e `tirocinio-usi-mendrisio`. Entrambi hanno
`sourceLang: "en"` mentre il testo sorgente e' **italiano**. Lo slot `en`
contiene quindi l'originale italiano, e il gate confronta lo slot `it` contro di
esso. Lo stesso job, a due commit consecutivi del sito:

```
=== 2bbcc4ed234 (2026-09-06 07:39) ===
sourceLang en   title "Posizioni di dottorandi"
 t[it] "Posizioni di dottorandi"     t[en] "Posizioni di dottorandi"
 d[it] len=7365                      d[en] len=7000
 -> 487 titleLooksUntranslated @it  reason=source-copy  ev="Posizioni di dottorandi"

=== 68afae8882d (2026-09-06 10:35) ===
 t[it] "Posizioni di dottorato"      t[en] "Posizioni di dottorandi"
 d[it] len=3251                      d[en] len=6753(norm)
 -> 538 thin-desc @it   3251/6753  (ratio 0,48 < 0,55)
```

**I due controlli sono mutuamente insoddisfacibili in questa configurazione.** La
run delle 07:39 fallisce sul titolo; la run successiva ripara il titolo e la
descrizione italiana crolla sotto la soglia; la run dopo ripara la descrizione e
il titolo torna a coincidere. Sui quattro stati storici estratti, `usi` oscilla
esattamente fra `487 source-copy` e `538 thin-desc`, mai altro. Il rifiuto e'
**corretto alla lettera del gate ogni volta**, e cio' nonostante non esiste
output che li passi entrambi finche' lo slot `en` contiene italiano.

Quindi: **ipotesi della issue confermata per `usi`, ma la riparazione a monte non
e' «nella selezione», e' nel pin di `sourceLang`.** Il gate e' innocente; la
sorgente e' etichettata male.

**Classe B — rifiuto corretto ma insoddisfacibile per costruzione: titoli
internazionali.** I 34 `source-copy` includono, verbatim dai dati:

```
"Global Wealth Management – Consultant (Lugano)"   (banca-sempione, @fr)
"Reservations Agent (long term) - W VERBIER"       (marriott, @fr)
"Waiter/tress Brasserie & U-Yama (Winter 26/27) - W VERBIER"  (marriott, @it)
"Co-Lead Guest Experience"                         (weisse-arena, @it)
"Guest Experience Host"                            (weisse-arena, @it)
"Senior Global Planner"                            (vf-international, @it)
```

Sono titoli che un traduttore lascia com'erano perche' lasciarli e' la scelta
giusta. Il gate legge «uguale alla sorgente ⇒ non tradotto» e rifiuta. Il
modello, richiamato, riproduce la stessa stringa: rifiuto deterministico, run
dopo run.

**Classe C — difetto reale, riprodotto identico ogni run.** `binnen-i` (14 casi)
e' il suffisso tedesco inclusivo portato dentro la traduzione:

```
weisse-arena @en  reason=binnen-i  ev="manager: in"
weisse-arena @en  reason=binnen-i  ev="specialists:in"
weisse-arena @it  reason=binnen-i  ev="Allrounder: in"
```

E `538 thin-desc` e' congelato. Le stesse coppie di lunghezze su `vf` a quattro
commit consecutivi che coprono un giorno intero e quattro run del cascade:

```
1bbe624fc02: 2591/5532 3143/6094 1692/4216 1729/4009 2042/5053 3249/7942
2bbcc4ed234: 2591/5532 3143/6094 1692/4216 1729/4009 2042/5053 3249/7942
68afae8882d:           3143/6094 1692/4216 1729/4009 2042/5053 3249/7942 3570/6530
f4319c3c07d:           3143/6094 1692/4216 1729/4009 2042/5053 3249/7942 2574/5416 1654/4501
```

Byte identici. Il provider produce ogni volta la stessa traduzione troncata, e il
gate la rifiuta ogni volta per la stessa ragione.

### Perche' «ogni run ci riprova da capo»: il valvola di rinuncia esiste gia' e non scatta

Il codice ha gia' un freno per-job: `MAX_RETRANSLATION_ATTEMPTS = 3`
(`scripts/relocalize-pending-jobs.mjs:89`) → `localeMismatchSuppressed`. **Non
scatta**, per tre motivi indipendenti, tutti verificati:

1. **Il contatore avanza solo se l'output e' cambiato.**
   `reconcileRetranslationState` a `scripts/relocalize-pending-jobs.mjs:338`:
   `if (!attempted) return 'waiting';` — e `attempted` viene da `attemptedSlugs`
   (`:1069`), che e' l'insieme degli slug il cui contenuto locale e' **cambiato**
   (`:374`). Un job la cui ritraduzione produce byte identici non conta come
   tentativo e resta in coda per sempre. **12 righe su 72 nella serie hanno
   `attempted == 0`** — il crawler e' girato, nulla e' cambiato, il contatore non
   e' avanzato: `arxada` 5 righe/6,5 min, `corner-banca` 3/0,4, `weisse-arena`
   3/0,4, `vf-international` 1/6,0 min. In totale 13,3 min strutturalmente
   incapaci di far avanzare la rinuncia.
2. **Il blocco di ri-flag azzera il contatore.**
   `scripts/relocalize-pending-jobs.mjs:1497-1502`: quando il job e' incompleto e
   il flag e' assente, il cascade rimette `needsRetranslation = true` **e**
   `retranslationAttempts = 0`.
3. **Il re-crawl riscrive lo slice da zero.**
   `scripts/assemble-jobs-dataset.mjs:2029-2032` ricostruisce il payload
   `{crawlerKey, assembledAt, jobs}`, e il commit «Auto-update crawler group»
   riporta job incompleti (misurato su `usi`: `incomplete` passa da 3 a 13 al
   commit `1bbe624fc02`).

Il contatore osservato lo conferma: dopo un giorno intero di run, `vf` ha
`retranslationAttempts` in `[1,1,2,1,1,1,2,3]` e **una sola** soppressione;
`arxada` ne ha zero.

**Conclusione della parte 1.** L'ipotesi della issue e' confermata in senso
stretto — il rifiuto e' corretto e la riparazione sta a monte — ma la causa non
e' una sola. `usi` e' un `sourceLang` mal appuntato (riparabile a monte, costo di
finestra trascurabile). `weisse-arena`, `marriott`, `banca-sempione` sono per lo
piu' titoli internazionali che nessun output puo' far passare senza rovinarli.
`vf-international` e `arxada` sono descrizioni troncate riprodotte byte per byte.
In tutti e tre i casi **il costo per la finestra non e' il rifiuto: e' il fatto
che il freno esistente non puo' fisicamente scattare.**

---

## Parte 2 — La regola di salto

### Perche' a livello di azienda e non di job

Il freno per-job esiste e le tre vie di azzeramento sopra lo disarmano. Ripararlo
significa toccare la semantica di `attempted` a `:338`/`:1069`, ma il commento a
`:353-359` dichiara che l'attuale scelta e' deliberata («unchanged ⇒ not
attempted» e' il lato sicuro, perche' l'alternativa rischia di sopprimere in
massa la coda mai raggiunta — la regressione di issue #5976 citata a `:97`).
Contare come tentativo la sola presenza in coda riporterebbe quel rischio.

Un contatore **per azienda** non ha quel problema: e' un'osservazione sul
risultato di una chiamata `runSharedCrawler` che e' effettivamente avvenuta, non
un'inferenza su un job non raggiunto, e sopravvive all'azzeramento del contatore
per-job e al re-crawl.

### La regola

> **Salta un'azienda per le prossime K run del cascade dopo N righe consecutive
> con `cleared == 0`. Riarmala quando la scadenza e' passata, oppure prima se il
> testo sorgente dell'azienda e' cambiato.**

Simulazione retroattiva sui 10 artifact, in ordine cronologico
(`sim.py`, replicabile con lo script della parte 3):

| N | K | min liberati | % finestra | `cleared` persi | righe saltate |
|---|---|---|---|---|---|
| 1 | 2 | 45,9 | 19,3% | 3 | 26 |
| 1 | 3 | 48,5 | 20,4% | 5 | 29 |
| **2** | **3** | **23,9** | **10,1%** | **2** | **16** |
| 2 | 6 | 26,9 | 11,3% | 2 | 19 |
| 3 | 3 | 10,8 | 4,5% | 2 | 9 |

**N = 2, K = 3 e' il punto scelto**: libera 23,9 min (10,1% della serie)
perdendone 2 job su 186 (1,1%). N = 1 raddoppia il guadagno ma triplica la
perdita e sfratta aziende che stavano solo avendo una run storta. N = 3, su una
serie di 10 run, quasi non scatta.

Aziende che la regola salterebbe, e quante volte:
`arxada` 4, `marriott` 3, `usi` 3, `weisse-arena` 2, e una volta ciascuna
`delvitech-sa`, `banca-sempione`, `corner-banca`, `vf-international`.

**Fa rientrare un'azienda riparabile?** Si, per costruzione: K = 3 run e' meno di
un giorno (10 run in ~41 ore) e il riarmo su cambio della sorgente e' immediato.
La prova nella serie: `marriott` ha `cleared == 0` su tre run consecutive
(33946200758, 33975963053, 34015450260) e poi 1 su ciascuna delle due successive.
Con N=2/K=3 sarebbe stata saltata per le tre run intermedie e sarebbe rientrata
in tempo per la ripresa; il conto «2 cleared persi» in tabella e' esattamente
quello, ed e' il prezzo dichiarato.

**Cosa la regola NON cattura.** La riga `burkhalter-group` da 28,6 min per 1 job
(run `34022638117`) e le righe `vf` da 440-646 s: un'azienda che libera un solo
job resetta il contatore. Il gruppo delle sette aziende a bassa accettazione non
e' l'insieme che spreca di piu' — lo e' l'insieme delle **righe sterili**, che
costa 57,7 min (24,3%) contro i 23,9 che questa regola recupera. Una seconda
leva, indipendente e complementare, sarebbe un tetto per-azienda-per-run sul
tempo del crawler; non e' stata simulata qui e non fa parte di questa proposta.

### Dove va, esattamente

**Punto di innesto (filtro):**
`frontaliere-si-o-no/scripts/relocalize-pending-jobs.mjs:1371`

```js
const companyKeys = [...companyJobCounts.keys()];
```

E' l'unica riga da cui il ciclo per-azienda (`:1450`) prende il suo input, sta
dopo l'ordinamento per traffico (`:1355`) e prima dell'emissione dello shadow
preflight (`:1373`), quindi il salto risulta visibile nella diagnostica gia'
esistente senza aggiungerne.

**Punto di aggiornamento (contatore):**
`frontaliere-si-o-no/scripts/relocalize-pending-jobs.mjs:1594-1602` — dove la
riga A/B viene composta e `row.cleared` e' gia' calcolato. Il contatore e' la
stessa quantita' che l'artifact registra, quindi la misura e l'intervento
leggono lo stesso numero e non possono divergere.

**Dove persiste lo stato.** Non sullo slice per-crawler:
`scripts/assemble-jobs-dataset.mjs:2029-2032` ricostruisce il payload
`{crawlerKey, assembledAt, jobs}` da zero a ogni assemblaggio e cancellerebbe
qualsiasi chiave in piu'. Serve un file nuovo, piccolo, aggiunto all'elenco di
path del commit gia' esistente:

`frontaliere-si-o-no/.github/workflows/translate-pending-logic.yml:360`

```
bash scripts/lib/git-commit-data.sh --slice-only "🌐 Auto-translate pending jobs" data/jobs/by-crawler/ data/translation-cache/ data/jobs-crawler-config.json data/slug-registry.json data/translation-stats-history.json
```

**Nota sul confine.** Il corpus **non ha una copia** di
`relocalize-pending-jobs.mjs`: `frontaliere-articles/.github/workflows/translate-pending.yml:55-75`
fa un checkout sparse di `valerielinc-ops/frontaliere-si-o-no` e ne esegue lo
script (`translate-pending-logic.yml:316`). Lo script quindi si corregge **solo
nel sito** e non ha voce in `loop-sync-manifest.json`. Solo il workflow e'
mirrorato, `identical`, come `.github/corpus-workflows/translate-pending.yml` →
`.github/workflows/translate-pending.yml` del corpus. `translate-pending-logic.yml`
sul sito e' la sorgente e va rigenerata; l'artefatto in `.github/corpus-workflows/`
non va toccato a mano.

---

## Parte 3 — Quanto vale

Sulla serie di 10 run misurata (237,5 min di finestra, 186 job liberati, resa
globale **0,78 job/min**; resa delle sole righe produttive **1,03 job/min**), con
N = 2 e K = 3:

- **23,9 minuti di finestra liberati**, cioe' **2,4 min per run**, il 10,1% della
  finestra della serie.
- **2 job liberati persi** (le due righe `marriott` a `cleared = 1` cadute dentro
  un raffreddamento).
- Job in piu' a parita' di finestra: `23,9 × 0,78 = 18,7` alla resa globale,
  `23,9 × 1,03 = 24,7` alla resa produttiva. **Netto: da +16,7 a +22,7 job sulla
  serie, cioe' da +1,7 a +2,3 job per run** — dal +9% al +12% su 186.

La conversione minuti → job e' lecita perche' **tutte e 8 le run con `runPhases`
si fermano su `cascade deadline`**, mai su `queue exhausted`: c'e' sempre
un'azienda successiva pronta a prendersi il tempo liberato. Se una run futura
finisse per coda esaurita, per quella run il guadagno sarebbe zero e la stima
andrebbe rifatta.

### Comando di misura prima/dopo

Eseguibile cosi' com'e'; misura la stessa quantita' su cui e' costruita questa
nota. Va lanciato una volta prima dell'intervento (baseline) e di nuovo dopo
almeno 10 run strumentate.

```bash
#!/usr/bin/env bash
# Resa della finestra del cascade sulle ultime N run strumentate.
set -euo pipefail
REPO=nanakokyobashi-rgb/frontaliere-articles
OUT=$(mktemp -d)
gh api "repos/$REPO/actions/artifacts" --paginate \
  -q '.artifacts[] | select(.name|startswith("translation-thinking-ab")) | select(.expired==false) | [.id,.name] | @tsv' \
| head -n "${1:-10}" | while IFS=$'\t' read -r id name; do
    gh api "repos/$REPO/actions/artifacts/$id/zip" > "$OUT/$id.zip" 2>/dev/null || continue
    unzip -o -q "$OUT/$id.zip" -d "$OUT/$id"
  done
python3 - "$OUT" <<'PY'
import json,glob,sys,collections
rows=[]
for f in glob.glob(sys.argv[1]+'/*/translation-thinking-ab.json'):
    j=json.load(open(f))
    for r in j['rows']: r['run']=j['salt'].split('#')[0]; rows.append(r)
ms=sum(r['elapsedMs'] for r in rows); cl=sum(r['cleared'] for r in rows)
nr=len(set(r['run'] for r in rows))
ster=[r for r in rows if r['cleared']==0]
print(f"run={nr} righe={len(rows)} finestra={ms/60000:.1f}min liberati={cl}")
print(f"resa={cl/(ms/60000):.2f} job/min   finestra sterile (cleared==0)={sum(r['elapsedMs'] for r in ster)/60000:.1f}min ({100*sum(r['elapsedMs'] for r in ster)/ms:.1f}%) su {len(ster)} righe")
c=collections.defaultdict(lambda:[0,0,0.0])
for r in rows:
    e=c[r['companyKey']]; e[0]+=r['attempted']; e[1]+=r['cleared']; e[2]+=r['elapsedMs']/60000
print("azienda                                        att  cle    min   acc")
for k,v in sorted(c.items(), key=lambda kv:-kv[1][2])[:8]:
    print("%-46s %3d %4d %6.1f %5s"%(k,v[0],v[1],v[2], f"{v[1]/v[0]:.2f}" if v[0] else "n/a"))
PY
rm -rf "$OUT"
```

**Baseline registrata il 2026-09-07** (output verbatim del comando qui sopra):

```
run=10 righe=72 finestra=237.5min liberati=186
resa=0.78 job/min   finestra sterile (cleared==0)=57.7min (24.3%) su 37 righe
```

**Criterio di successo:** `resa` sale sopra 0,86 job/min (+10%) e `finestra
sterile` scende sotto il 20%, su una finestra totale comparabile. La resa e' la
cifra che conta perche' e' l'unica confrontabile fra run con finestre da 2 e da
52 minuti — e' la stessa derivata che la issue #20 chiedeva di emettere.

**Attenzione alla retention:** l'artifact `translation-thinking-ab` scade a 14
giorni. La baseline sopra e' la forma persistita della serie 2026-09-05/07; dopo
il 2026-09-19 il comando non potra' piu' ricostruirla e il confronto dovra'
partire dai numeri riportati qui.

---

## Cosa non sono riuscito a stabilire

- **La conversione esatta minuti → job liberati.** Ho due stime (0,78 e 1,03
  job/min) e non un numero. Il tempo liberato va alla prossima azienda in ordine
  di traffico (`orderPendingByTraffic`,
  `scripts/relocalize-pending-jobs.mjs:1355`), non a un'azienda media, e gli
  artifact non registrano quali aziende sono state rinviate. Il vero moltiplicatore
  e' misurabile solo dopo l'intervento.
- **Quanto varrebbe riparare invece la semantica di `attempted`** a
  `scripts/relocalize-pending-jobs.mjs:338`/`:1069`. So che 12 righe su 72 hanno
  `attempted == 0` (13,3 min) e che quei job non possono strutturalmente
  raggiungere la soppressione, ma l'artifact e' per azienda e non per job: non
  posso contare quanti job sarebbero stati soppressi ne' con che ritardo.
- **Se i titoli della classe B siano davvero irreparabili.** Ho la prova che il
  gate li rifiuta e che l'output non cambia, non la prova che nessun prompt
  possa produrre un titolo accettabile. Distinguere le due cose richiede una
  prova di traduzione fuori pipeline, che sarebbe un intervento.
- **Il conto della issue «82 tentativi / 70,7 min» su esattamente i nove artifact
  che cita.** Ho rimisurato su dieci (ne e' arrivato uno nel frattempo) e non ho
  ricostruito il sottoinsieme originale. I due conti sono comunque a meno di un
  punto percentuale l'uno dall'altro.
- **Se `usi` abbia il `sourceLang` sbagliato per un difetto del crawler o per un
  pin esplicito.** `pinnedTitleSourceLang(job)`
  (`scripts/lib/job-locale-utils.mjs:738`) ha la precedenza su
  `detectTextLocale` in `dedicated-crawler-common.mjs:3117`, ma i job di `usi`
  non portano il campo, quindi il valore `en` viene dal rilevamento. Non ho
  seguito il rilevamento fino alla sua sorgente: sarebbe il primo passo di un
  ticket a se'.

**Nota metodologica.** Il tallying dei motivi di rifiuto viene da una
riproduzione dell'ordine dei rami di `isIncomplete`, non da una strumentazione
del gate. La riproduzione e' stata validata su 507 stati-job con zero
disaccordi rispetto alla `isIncomplete` importata, quindi l'attribuzione del
**primo** ramo che scatta e' affidabile quanto il verdetto stesso. E'
un'inferenza solo nel caso di un job che scatterebbe su piu' rami: li' ho
attribuito al primo in ordine di codice, che e' anche l'ordine in cui il gate
ritorna.
