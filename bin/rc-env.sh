#!/usr/bin/env bash
# Carica i secret da Firebase Remote Config (progetto frontaliere-ticino)
# nell'ambiente della shell corrente.
#
#   source bin/rc-env.sh
#
# Il lavoro vero lo fa generator/scripts/load-rc-env.mjs in frontaliere-articles:
# legge il template Remote Config e stampa righe `export KEY='value'`.
# Qui aggiungiamo solo la scoperta del service account e il controllo errori,
# perche' quello script e' non-bloccante per design (exit 0 anche quando non
# carica nulla) — in locale un silenzio del genere e' indistinguibile da un
# successo, e si finisce a debuggare l'assenza di una chiave invece dell'auth.
# Ogni fallimento esce con una riga "✖" che ne dice la causa: gh-nanako e il
# launcher del coordinator riportano quelle righe.

set -uo pipefail

# La root del workspace e' la cartella che contiene questo bin/, non $HOME/Projects:
# derivarla dallo script invece che dalla home rende il file immune a un altro trasloco.
_rc_self="${BASH_SOURCE[0]:-$0}"
_rc_bin="$(cd "$(dirname "$_rc_self")" && pwd)"
WORKSPACE="${WORKSPACE:-$(cd "$_rc_bin/.." && pwd)}"
unset _rc_self
LOADER="$WORKSPACE/frontaliere-articles/generator/scripts/load-rc-env.mjs"
: "${GOOGLE_APPLICATION_CREDENTIALS:=$HOME/.config/frontaliere/sa-frontaliere-ticino.json}"
export GOOGLE_APPLICATION_CREDENTIALS

if [ ! -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "✖ Service account mancante: $GOOGLE_APPLICATION_CREDENTIALS" >&2
  echo "  Riscaricalo dalla console Firebase (progetto frontaliere-ticino)" >&2
  echo "  e salvalo li' con chmod 600." >&2
  unset _rc_bin
  return 1 2>/dev/null || exit 1
fi

# Il checkout principale del corpus e' sparse e il suo elenco si allunga a mano:
# quando il loader guadagna un import, il modulo nuovo e' tracciato ma non sul
# disco, node muore con ERR_MODULE_NOT_FOUND e piu' sotto restava solo "nessun
# secret, controlla l'auth" (il 2026-09-17 mancava il loader stesso, il
# 2026-10-08 un modulo che importa). rc-loader-closure.mjs aggiunge al checkout
# sparse i moduli tracciati che il loader raggiunge e nomina quelli che non
# riesce a riportare sul disco. Solo il suo stato 3 ferma il caricamento: un
# controllo che non parte non deve togliere i secret a nessuno.
if [ -f "$_rc_bin/rc-loader-closure.mjs" ]; then
  _rc_closure_status=0
  _rc_missing="$(node "$_rc_bin/rc-loader-closure.mjs" "$LOADER")" || _rc_closure_status=$?
  if [ "$_rc_closure_status" -eq 3 ]; then
    echo "✖ Il loader di Remote Config non e' caricabile: mancano moduli tracciati." >&2
    printf '%s\n' "$_rc_missing" | sed 's/^/  /' >&2
    unset _rc_bin _rc_closure_status _rc_missing
    return 1 2>/dev/null || exit 1
  fi
  unset _rc_closure_status _rc_missing
fi
unset _rc_bin

if [ ! -f "$LOADER" ]; then
  echo "✖ Loader non trovato: $LOADER" >&2
  return 1 2>/dev/null || exit 1
fi

# Lo script stampa gli export su stdout e la diagnostica su stderr, quindi
# la riga di stato resta visibile mentre valutiamo solo gli export.
_rc_status=0
_rc_out="$(node "$LOADER")" || _rc_status=$?
if [ "$_rc_status" -ne 0 ]; then
  # Il loader esce 0 anche quando non carica nulla: uno stato diverso e' node
  # che non l'ha caricato o l'ha visto morire, e l'auth non c'entra. Quello che
  # ha stampato fin li' puo' essere a meta' e non si valuta.
  echo "✖ Il loader di Remote Config e' uscito con stato $_rc_status: l'errore di node e' qui sopra." >&2
  unset _rc_out _rc_status
  return 1 2>/dev/null || exit 1
fi
unset _rc_status
if [ -z "$_rc_out" ]; then
  echo "✖ Remote Config non ha restituito nessun secret — controlla l'auth." >&2
  unset _rc_out
  return 1 2>/dev/null || exit 1
fi

eval "$_rc_out"
echo "✅ $(printf '%s\n' "$_rc_out" | grep -c '^export ') variabili caricate in questa shell."
unset _rc_out
