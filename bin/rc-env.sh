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

set -uo pipefail

# La root del workspace e' la cartella che contiene questo bin/, non $HOME/Projects:
# derivarla dallo script invece che dalla home rende il file immune a un altro trasloco.
_rc_self="${BASH_SOURCE[0]:-$0}"
WORKSPACE="${WORKSPACE:-$(cd "$(dirname "$_rc_self")/.." && pwd)}"
unset _rc_self
LOADER="$WORKSPACE/frontaliere-articles/generator/scripts/load-rc-env.mjs"
: "${GOOGLE_APPLICATION_CREDENTIALS:=$HOME/.config/frontaliere/sa-frontaliere-ticino.json}"
export GOOGLE_APPLICATION_CREDENTIALS

if [ ! -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "✖ Service account mancante: $GOOGLE_APPLICATION_CREDENTIALS" >&2
  echo "  Riscaricalo dalla console Firebase (progetto frontaliere-ticino)" >&2
  echo "  e salvalo li' con chmod 600." >&2
  return 1 2>/dev/null || exit 1
fi

if [ ! -f "$LOADER" ]; then
  echo "✖ Loader non trovato: $LOADER" >&2
  return 1 2>/dev/null || exit 1
fi

# Lo script stampa gli export su stdout e la diagnostica su stderr, quindi
# la riga di stato resta visibile mentre valutiamo solo gli export.
_rc_out="$(node "$LOADER")"
if [ -z "$_rc_out" ]; then
  echo "✖ Remote Config non ha restituito nessun secret — controlla l'auth." >&2
  unset _rc_out
  return 1 2>/dev/null || exit 1
fi

eval "$_rc_out"
echo "✅ $(printf '%s\n' "$_rc_out" | grep -c '^export ') variabili caricate in questa shell."
unset _rc_out
