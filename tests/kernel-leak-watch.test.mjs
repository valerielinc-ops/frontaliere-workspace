// bin/kernel-leak-watch: sentinella del leak kernel di macOS 26.x (kalloc.1024
// perso a ogni exec di uno script #! annidato). Il 2026-09-24 tre loop bash
// orfani avevano accumulato 10,6 GB wired in 3,4 giorni senza che nessuno se
// ne accorgesse: qui si fissa che l'allarme scatti su tasso o totale, che la
// notifica rispetti il cooldown e che l'orfano compaia fra i sospetti.
//
// zprint, ps e osascript sono finti (script sh in una cartella temporanea);
// vm_stat e sysctl puntano a un path inesistente, cosi' il test non dipende
// dallo stato della macchina che lo esegue.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const WATCH = join(ROOT, 'bin', 'kernel-leak-watch');
const T0 = 1_790_000_000;

const FAKE_ZPRINT = `#!/bin/sh
printf '%s\\n' '                            elem         cur         max        cur         max         cur  alloc  alloc'
printf '%s\\n' 'zone name                   size        size        size      #elts       #elts       inuse   size  count'
printf '%s\\n' '-------------------------------------------------------------------------------------------------------------'
printf 'data.kalloc.1024.extra       1024          0K          0K          0           0    99999999     0K      0\\n'
printf 'data.kalloc.1024            1024          0K          0K          0           0    %s     0K      0\\n' "$FAKE_D"
printf 'data_shared.kalloc.1024     1024          0K          0K          0           0    %s     0K      0\\n' "$FAKE_DS"
`;

// ps finto: elenco completo per i sospetti A, un PID nuovo sotto 4242 a ogni
// campione per i sospetti B, e il comando del padre per -p.
const FAKE_PS = `#!/bin/sh
case "$*" in
  *etime*)
    printf '%s\\n' \\
      '    1     0 30-00:00:00 /sbin/launchd' \\
      ' 4242     1 2-00:00:00 bash /tmp/x/watch.sh' \\
      ' 4243     1 3-00:00:00 /usr/libexec/logd' \\
      ' 4244     1 10:00 bash /tmp/y/giovane.sh' \\
      ' 4245     1 5-00:00:00 /bin/zsh' \\
      ' 4246   700 5-00:00:00 bash /tmp/z/non-orfano.sh'
    ;;
  *" -p "*)
    for a in "$@"; do last=$a; done
    if [ "$last" = 4242 ]; then echo 'bash /tmp/x/watch.sh'; else echo '?'; fi
    ;;
  *)
    n=$(cat "$FAKE_DIR/ps-count" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" >"$FAKE_DIR/ps-count"
    printf '%s\\n' '1 0' '4242 1' "$((50000 + n)) 4242"
    ;;
esac
`;

const FAKE_NOTIFY = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DIR/notify.log"
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-leak-watch-'));
  for (const [name, body] of [['zprint', FAKE_ZPRINT], ['ps', FAKE_PS], ['notify', FAKE_NOTIFY]]) {
    writeFileSync(join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

function run(dir, { now, ds, d = 1000, env = {} }) {
  const res = spawnSync('/bin/bash', [WATCH], {
    encoding: 'utf8',
    env: {
      HOME: dir,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      FAKE_DIR: dir,
      FAKE_DS: String(ds),
      FAKE_D: String(d),
      KLW_STATE_DIR: join(dir, 'state'),
      KLW_ZPRINT_BIN: join(dir, 'zprint'),
      KLW_PS_BIN: join(dir, 'ps'),
      KLW_NOTIFY_BIN: join(dir, 'notify'),
      KLW_VM_STAT_BIN: join(dir, 'missing'),
      KLW_SYSCTL_BIN: join(dir, 'missing'),
      KLW_SAMPLE_INTERVAL_S: '0',
      KLW_NOW: String(now),
      ...env,
    },
  });
  assert.equal(res.status, 0, `exit ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res;
}

const alertPath = (dir) => join(dir, 'state', 'kernel-leak-watch.alert');
const tsvRows = (dir) => readFileSync(join(dir, 'state', 'kernel-leak-watch.tsv'), 'utf8')
  .split('\n').filter(Boolean).map((line) => line.split('\t'));
const notifyCalls = (dir) => {
  const log = join(dir, 'notify.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
};

test('(a) prima esecuzione: TSV creato, nessun allarme', () => {
  const dir = fixture();
  try {
    const res = run(dir, { now: T0, ds: 1_000_000, d: 2_000 });
    const rows = tsvRows(dir);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], ['2026-09-21T14:13:20Z', String(T0), '1000000', '2000', '', '', '']);
    assert.match(res.stdout, /action=sample .*rate_per_h=na .*alert=none/);
    assert.equal(existsSync(alertPath(dir)), false);
    assert.deepEqual(notifyCalls(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('tasso orario e cooldown della notifica', () => {
  let dir;
  before(() => { dir = fixture(); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('(b) +200000 elementi in 60 minuti: allarme e una notifica', () => {
    run(dir, { now: T0, ds: 1_000_000 });
    const res = run(dir, { now: T0 + 3600, ds: 1_200_000 });
    assert.match(res.stdout, /rate_per_h=200000 window_s=3600 .*alert=rate\b/);
    const alert = readFileSync(alertPath(dir), 'utf8');
    assert.match(alert, /ALLARME 2026-09-21T15:13:20Z \(motivo: rate\)/);
    assert.match(alert, /tasso: 200000 elementi\/h su 3600 s/);
    assert.match(alert, /data_shared\.kalloc\.1024 in uso: 1200000/);
    assert.match(alert, /solo il reboot la libera/);
    const calls = notifyCalls(dir);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^-e display notification ".*1201000 elementi.*" with title "Leak kernel macOS"$/);
  });

  test('(c) terza esecuzione nel cooldown: alert aggiornato, nessuna seconda notifica', () => {
    const res = run(dir, { now: T0 + 4500, ds: 1_250_000 });
    // Riferimento: la riga di 75 minuti prima (l'unica di almeno 50 minuti fa).
    assert.match(res.stdout, /rate_per_h=200000 window_s=4500 /);
    assert.match(res.stdout, /action=notify_skipped reason=cooldown/);
    const alert = readFileSync(alertPath(dir), 'utf8');
    assert.match(alert, /ALLARME 2026-09-21T15:28:20Z/);
    assert.match(alert, /data_shared\.kalloc\.1024 in uso: 1250000/);
    assert.equal(notifyCalls(dir).length, 1);
    assert.equal(tsvRows(dir).length, 3);
  });
});

test('(d) totale sopra soglia con tasso basso: allarme per totale', () => {
  const dir = fixture();
  try {
    run(dir, { now: T0, ds: 3_500_000 });
    const res = run(dir, { now: T0 + 3600, ds: 3_500_100 });
    assert.match(res.stdout, /rate_per_h=100 .*alert=total\b/);
    const alert = readFileSync(alertPath(dir), 'utf8');
    assert.match(alert, /\(motivo: total\)/);
    assert.match(alert, /totale: 3501100 elementi \(~3419 MB wired\), soglia 3000000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(e) la shell orfana da 2 giorni compare fra i sospetti A, il ricambio fra i B', () => {
  const dir = fixture();
  try {
    run(dir, { now: T0, ds: 3_500_000 });
    const alert = readFileSync(alertPath(dir), 'utf8');
    const section = (title) => alert.split(title)[1].split('\n\n')[0];
    const a = section('Sospetti A');
    assert.match(a, /pid=4242 age_s=172800 bash \/tmp\/x\/watch\.sh/);
    assert.doesNotMatch(a, /giovane|non-orfano|logd|zsh|launchd/);
    const b = section('Sospetti B');
    assert.match(b, /ppid=4242 nuovi_pid=4 bash \/tmp\/x\/watch\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('soglia non numerica: errore d\'uso, exit 64', () => {
  const dir = fixture();
  try {
    const res = spawnSync('/bin/bash', [WATCH], {
      encoding: 'utf8',
      env: { HOME: dir, PATH: '/usr/bin:/bin', KLW_STATE_DIR: join(dir, 'state'), KLW_TOTAL_ALERT: '3M' },
    });
    assert.equal(res.status, 64);
    assert.match(res.stderr, /KLW_TOTAL_ALERT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
