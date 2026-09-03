---
name: add-repo-workspace
description: Aggiungere un terzo repo al workspace frontaliere (clonarlo dentro ~/Projects/frontaliere, gitignorarlo, documentarlo). Usare quando si vuole includere un nuovo repo che si affianca a frontaliere-si-o-no e frontaliere-articles.
---

Il caso e' previsto: il sito e' grande e altre parti potrebbero staccarsi, come
gia' successo a `packages/articles` → `frontaliere-articles` (issue #4959).

```bash
cd ~/Projects/frontaliere
git clone https://github.com/<owner>/<nuovo-repo>.git
printf '/<nuovo-repo>/\n' >> .gitignore     # la root non versiona i repo figli
```

Poi una riga nella tabella dei repo di `CLAUDE.md`, e — se il repo nuovo ha regole
sue (gate della PR, mirror, cicli) — una sezione che dica **dove si fa la
correzione**, che e' la domanda che fa perdere piu' tempo quando i repo sono piu'
di uno. `CLAUDE.md` resta la sorgente condivisa: Claude lo legge nativamente e
Codex tramite `project_doc_fallback_filenames` in `.codex/config.toml`; non creare
una seconda copia in `AGENTS.md`. Gli agenti, i settings e `bin/` della root
valgono gia' per chiunque arrivi.
