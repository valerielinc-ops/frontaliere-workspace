#!/bin/sh
# SessionStart di Claude Code: esporta nelle shell della sessione i valori che
# dipendono dalla macchina, WORKSPACE e GOOGLE_APPLICATION_CREDENTIALS.
#
# Perche'. .claude/settings.json e' condiviso fra i Mac del proprietario, e il
# suo blocco "env" non espande $HOME: un path assoluto vale per un solo utente
# (/Users/saggesel sul laptop principale, /Users/luigisaggese sull'host agenti)
# e sull'altro punta a una cartella inesistente. Claude Code applica gli export
# scritti in $CLAUDE_ENV_FILE prima di ogni comando Bash della sessione, quindi
# qui si ricavano da $HOME e dalla posizione di questo script.
#
# Un valore gia' presente vince sempre (settings.local.json, ambiente): lo
# script lo rimpiazza solo se manca o, per WORKSPACE, se non e' un workspace.
# Codex non ha un equivalente: i suoi valori per-macchina stanno nel
# ~/.codex/config.toml dell'utente, non nel .codex/config.toml del progetto.
set -u

[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
ws=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 0

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

{
  # Da un worktree della root i repo figli non ci sono: in quel caso WORKSPACE
  # non si esporta e i consumatori usano i loro fallback (CLAUDE_PROJECT_DIR).
  if [ -z "${WORKSPACE:-}" ] || [ ! -d "$WORKSPACE/frontaliere-si-o-no" ]; then
    [ -d "$ws/frontaliere-si-o-no" ] && printf 'export WORKSPACE=%s\n' "$(quote "$ws")"
  fi
  if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
    sa="$HOME/.config/frontaliere/sa-frontaliere-ticino.json"
    [ -f "$sa" ] && printf 'export GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$(quote "$sa")"
  fi
} >>"$CLAUDE_ENV_FILE"
exit 0
