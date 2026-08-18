# Workspace frontaliereticino.ch

La root da cui si apre la sessione di lavoro sui due repo del progetto:

- [`frontaliere-si-o-no`](https://github.com/valerielinc-ops/frontaliere-si-o-no) — il sito e la SPA
- [`frontaliere-articles`](https://github.com/nanakokyobashi-rgb/frontaliere-articles) — il corpus degli articoli e il motore di render

Qui non c'e' codice applicativo. C'e' **cio' che vale per entrambi i repo** e che
altrimenti non starebbe da nessuna parte: `CLAUDE.md` con il funzionamento del
sistema, gli agenti, gli script condivisi e lo stato delle sessioni lunghe.

I due repo **non** sono sottomoduli: si clonano dentro questa cartella e restano
indipendenti, con i loro branch e le loro PR.

```bash
git clone https://github.com/valerielinc-ops/frontaliere-workspace.git frontaliere
cd frontaliere
git clone https://github.com/valerielinc-ops/frontaliere-si-o-no.git
git clone https://github.com/nanakokyobashi-rgb/frontaliere-articles.git
```

**Parti da [`CLAUDE.md`](CLAUDE.md).** Nessun segreto sta qui dentro: vivono in
Firebase Remote Config e arrivano nell'ambiente con `source bin/rc-env.sh`.
