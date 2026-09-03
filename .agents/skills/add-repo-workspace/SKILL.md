---
name: add-repo-workspace
description: Aggiungere un nuovo repository al workspace frontaliere, clonandolo accanto ai repo esistenti, escludendolo dal repository root e documentandone i confini operativi. Usare quando un altro repo deve entrare nel workspace condiviso.
---

Il caso e' previsto: il sito e' grande e altre parti possono staccarsi, come gia'
successo a `packages/articles` -> `frontaliere-articles` (issue #4959).

```bash
cd /Users/saggesel/Projects/frontaliere
git clone https://github.com/<owner>/<nuovo-repo>.git
```

Poi:

1. aggiungi `/<nuovo-repo>/` al blocco dei repo figli in `.gitignore`;
2. aggiorna la tabella dei repo e, se necessario, il titolo che ne indica il numero in `CLAUDE.md`;
3. documenta dove si applicano le correzioni, quali gate governano PR e merge e come il nuovo repo comunica con gli altri;
4. verifica con `git check-ignore -v <nuovo-repo>/` che la root non lo versioni.

`CLAUDE.md` e' intenzionalmente la sorgente condivisa: Claude lo legge in modo
nativo e Codex lo carica tramite `project_doc_fallback_filenames` in
`.codex/config.toml`. Non creare una seconda copia in `AGENTS.md`.

Gli agenti, gli hook e i comandi della root valgono gia' per ogni repo aggiunto,
salvo una regola piu' specifica dichiarata nel nuovo repository.
