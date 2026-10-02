// bin/agent-host-tune: tuning del Mac usato solo come host remoto degli
// agenti. Qui si fissa che apply e revert siano un'andata e ritorno esatta
// (il revert ripristina il valore originale, non un default), che i servizi
// gia' spenti prima dell'apply restino spenti dopo il revert, che --dry-run non
// cambi nulla e che le voci utente e di sistema rifiutino l'utente sbagliato.
//
// launchctl, defaults, plutil, pmset, mdutil e pkill sono finti (script sh in
// una cartella temporanea che tengono lo stato in file): il test non tocca la
// macchina che lo esegue.
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const TUNE = join(ROOT, 'bin', 'agent-host-tune');

const FAKE_LAUNCHCTL = `#!/bin/sh
echo "launchctl $*" >>"$FAKE_DIR/log"
case "$1" in
  print-disabled) printf '\\tdisabled services = {\\n'; cat "$FAKE_DIR/disabled"; printf '\\t}\\n' ;;
  disable|enable)
    l=\${2#gui/*/}
    grep -v "\\"$l\\"" "$FAKE_DIR/disabled" >"$FAKE_DIR/disabled.tmp"
    printf '\\t\\t"%s" => %sd\\n' "$l" "$1" >>"$FAKE_DIR/disabled.tmp"
    mv "$FAKE_DIR/disabled.tmp" "$FAKE_DIR/disabled"
    ;;
  print)
    pid=$(awk -v l="\${2#gui/*/}" '$1 == l { print $2 }' "$FAKE_DIR/running")
    if [ -n "$pid" ]; then printf '\\tstate = running\\n\\tpid = %s\\n' "$pid"; else echo 'state = not running'; fi
    ;;
esac
exit 0
`;

// 4243 ignora SIGTERM, come tipsd sulla macchina vera; 4245 rifiuta anche
// SIGKILL, come ScreenTimeAgent.
const FAKE_KILL = `#!/bin/sh
echo "kill $*" >>"$FAKE_DIR/log"
sig=$1
shift
for pid in "$@"; do
  [ "$pid" = 4245 ] && continue
  if [ "$sig" = -KILL ] || [ "$pid" != 4243 ]; then
    grep -v " $pid\\$" "$FAKE_DIR/running" >"$FAKE_DIR/running.tmp"
    mv "$FAKE_DIR/running.tmp" "$FAKE_DIR/running"
  fi
done
`;

const FAKE_DEFAULTS = `#!/bin/sh
echo "defaults $*" >>"$FAKE_DIR/log"
host=std
if [ "$1" = -currentHost ]; then host=cur; shift; fi
f="$FAKE_DIR/prefs/$(printf '%s_%s_%s' "$host" "$2" "$3" | tr '/ ' '__')"
case "$1" in
  read) [ -f "$f" ] || exit 1; cat "$f" ;;
  write)
    v=$5
    case "$v" in true|YES) v=1 ;; false|NO) v=0 ;; esac
    printf '%s\\n' "$v" >"$f"
    ;;
  delete) [ -f "$f" ] || exit 1; rm "$f" ;;
esac
`;

const FAKE_PLUTIL = `#!/bin/sh
echo "plutil $*" >>"$FAKE_DIR/log"
case "$1" in
  -extract) [ -f "$4.$2" ] || exit 1; cat "$4.$2" ;;
  -replace) printf '%s\\n' "$4" >"$5.$2" ;;
  -remove) rm -f "$3.$2" ;;
esac
`;

const FAKE_PMSET = `#!/bin/sh
echo "pmset $*" >>"$FAKE_DIR/log"
case "$1" in
  -g)
    [ "$2" = custom ] || exit 0
    printf 'Battery Power:\\n sleep 99\\n displaysleep 99\\nAC Power:\\n'
    cat "$FAKE_DIR/pmset"
    ;;
  -c|-a)
    shift
    while [ "$#" -ge 2 ]; do
      grep -v "^ $1 " "$FAKE_DIR/pmset" >"$FAKE_DIR/pmset.tmp"
      printf ' %s %s\\n' "$1" "$2" >>"$FAKE_DIR/pmset.tmp"
      mv "$FAKE_DIR/pmset.tmp" "$FAKE_DIR/pmset"
      shift 2
    done
    ;;
esac
`;

const FAKE_MDUTIL = `#!/bin/sh
echo "mdutil $*" >>"$FAKE_DIR/log"
case "$1" in
  -s) printf '%s:\\n\\tIndexing %s.\\n' "$2" "$(cat "$FAKE_DIR/spotlight")" ;;
  -a) if [ "$3" = off ]; then echo disabled; else echo enabled; fi >"$FAKE_DIR/spotlight" ;;
esac
`;

const FAKE_LOG_ONLY = `#!/bin/sh
echo "$(basename "$0") $*" >>"$FAKE_DIR/log"
`;

// Una parte dello stato iniziale della macchina vera: Siri attiva, un servizio
// gia' spento a mano, Spotlight acceso, pmset di fabbrica sull'alimentatore.
const INITIAL_PMSET = [
  ' sleep 1', ' disksleep 10', ' displaysleep 10', ' powernap 1', ' lowpowermode 0',
  ' womp 1', ' tcpkeepalive 1', ' ttyskeepawake 1', ' proximitywake 1', ' hibernatemode 3',
].join('\n') + '\n';

let dir;
let env;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'agent-host-tune-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'prefs'));
  mkdirSync(join(dir, 'LaunchAgents'));
  const fakes = {
    launchctl: FAKE_LAUNCHCTL,
    defaults: FAKE_DEFAULTS,
    plutil: FAKE_PLUTIL,
    pmset: FAKE_PMSET,
    mdutil: FAKE_MDUTIL,
    pkill: FAKE_LOG_ONLY,
    kill: FAKE_KILL,
    fdesetup: FAKE_LOG_ONLY,
    sysctl: FAKE_LOG_ONLY,
  };
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(join(dir, 'disabled'), '\t\t"com.apple.tipsd" => disabled\n\t\t"com.example.other" => enabled\n');
  writeFileSync(join(dir, 'running'), '');
  writeFileSync(join(dir, 'prefs', 'std_com.apple.assistant.support_Assistant_Enabled'), '1\n');
  writeFileSync(join(dir, 'pmset'), INITIAL_PMSET);
  writeFileSync(join(dir, 'spotlight'), 'enabled');
  writeFileSync(join(dir, 'LaunchAgents', 'org.git-scm.git.hourly.plist'), '');
  env = {
    PATH: process.env.PATH,
    HOME: dir,
    FAKE_DIR: dir,
    AHT_LAUNCHCTL_BIN: join(bin, 'launchctl'),
    AHT_DEFAULTS_BIN: join(bin, 'defaults'),
    AHT_PLUTIL_BIN: join(bin, 'plutil'),
    AHT_PMSET_BIN: join(bin, 'pmset'),
    AHT_MDUTIL_BIN: join(bin, 'mdutil'),
    AHT_PKILL_BIN: join(bin, 'pkill'),
    AHT_FDESETUP_BIN: join(bin, 'fdesetup'),
    AHT_SYSCTL_BIN: join(bin, 'sysctl'),
    AHT_KILL_BIN: join(bin, 'kill'),
    AHT_KILL_GRACE_S: '0',
    AHT_LAUNCH_AGENTS_DIR: join(dir, 'LaunchAgents'),
    AHT_STATE_DIR: join(dir, 'state'),
    AHT_SYSTEM_STATE_DIR: join(dir, 'system-state'),
  };
}

function tune(args, uid = '501') {
  return spawnSync('/bin/sh', [TUNE, ...args], { env: { ...env, AHT_UID: uid }, encoding: 'utf8' });
}

const read = (name) => readFileSync(join(dir, name), 'utf8');
const pref = (name) => {
  const file = join(dir, 'prefs', name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
};
const disabledState = (label) => read('disabled').match(new RegExp(`"${label.replaceAll('.', '\\.')}" => (\\w+)`))?.[1];
const pmsetValue = (key) => read('pmset').match(new RegExp(`^ ${key} (\\S+)$`, 'm'))?.[1];

const MUTATING = /^(launchctl (disable|enable|bootout|bootstrap)|defaults (-currentHost )?(write|delete)|plutil -(replace|remove)|pmset -[ca] |mdutil -a|pkill|kill)/m;

describe('agent-host-tune', () => {
  beforeEach(setup);

  test('rifiuta argomenti sconosciuti e l\'utente sbagliato', () => {
    assert.equal(tune(['boh']).status, 64);
    assert.equal(tune([]).status, 64);
    assert.equal(tune(['apply'], '0').status, 77, 'apply con sudo agirebbe sul dominio gui sbagliato');
    assert.equal(tune(['apply-system'], '501').status, 77);
    assert.doesNotMatch(read('log'), MUTATING);
  });

  test('--dry-run e status non cambiano nulla', () => {
    const user = tune(['--dry-run', 'apply']);
    assert.equal(user.status, 0, user.stderr);
    assert.match(user.stdout, /^\+ .*launchctl disable gui\/501\/com\.apple\.photoanalysisd$/m);
    const system = tune(['apply-system', '--dry-run']);
    assert.equal(system.status, 0, system.stderr);
    assert.match(system.stdout, /^\+ .*pmset -c sleep 0 disksleep 0 displaysleep 1 powernap 0$/m);
    const status = tune(['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /servizi Apple disattivati +1\/60 +da applicare/);
    assert.doesNotMatch(read('log'), MUTATING);
    assert.equal(existsSync(join(dir, 'state')), false);
    assert.equal(existsSync(join(dir, 'system-state')), false);
  });

  test('apply e revert utente sono un\'andata e ritorno esatta', () => {
    // tipsd era gia' spento ma ancora vivo: va fermato anche lui.
    writeFileSync(join(dir, 'running'), [
      'com.apple.photoanalysisd 4242', 'com.apple.tipsd 4243', 'com.example.other 4244', 'com.apple.ScreenTimeAgent 4245',
    ].join('\n') + '\n');
    const first = tune(['apply']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(disabledState('com.apple.photoanalysisd'), 'disabled');
    // I PID seguono l'ordine della lista dei servizi.
    assert.match(read('log'), /^kill -TERM 4242 4245 4243$/m);
    assert.match(read('log'), /^kill -KILL 4245 4243$/m, 'SIGKILL solo a chi ha ignorato SIGTERM');
    assert.match(first.stdout, /processi fermati: 2, protetti da macOS fino al prossimo login: 1/);
    assert.match(read('running'), /com\.example\.other 4244/, 'servizi fuori lista intatti');
    assert.equal(pref('std_com.apple.assistant.support_Assistant_Enabled'), '0');
    assert.equal(pref('std_-g_NSAppSleepDisabled'), '1');
    assert.equal(pref('cur_com.apple.controlcenter_AirplayRecieverEnabled'), '0');
    assert.equal(read('LaunchAgents/org.git-scm.git.hourly.plist.ProcessType').trim(), 'Background');
    assert.match(read('log'), /^launchctl bootstrap gui\/501 .*org\.git-scm\.git\.hourly\.plist$/m);
    assert.doesNotMatch(read('state/services.changed'), /com\.apple\.tipsd/);

    // Un secondo apply non deve registrare come originale il valore tunato.
    assert.equal(tune(['apply']).status, 0);
    assert.match(read('state/defaults.prev'), /^-\|com\.apple\.assistant\.support\|Assistant Enabled\|bool\|1$/m);
    assert.equal(read('state/defaults.prev').match(/Assistant Enabled/g).length, 1);
    assert.match(tune(['status']).stdout, /servizi Apple disattivati +60\/60 +ok/);

    const revert = tune(['revert']);
    assert.equal(revert.status, 0, revert.stderr);
    assert.equal(disabledState('com.apple.photoanalysisd'), 'enabled');
    assert.equal(disabledState('com.apple.tipsd'), 'disabled', 'era gia\' spento prima dell\'apply');
    assert.equal(pref('std_com.apple.assistant.support_Assistant_Enabled'), '1');
    assert.equal(pref('std_-g_NSAppSleepDisabled'), null);
    assert.equal(existsSync(join(dir, 'LaunchAgents/org.git-scm.git.hourly.plist.ProcessType')), false);
    assert.equal(existsSync(join(dir, 'state/defaults.prev')), false);
  });

  test('apply-system e revert-system ripristinano pmset, Spotlight e preferenze', () => {
    const apply = tune(['apply-system'], '0');
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(pmsetValue('sleep'), '0');
    assert.equal(pmsetValue('displaysleep'), '1');
    assert.equal(pmsetValue('powernap'), '0');
    assert.equal(pmsetValue('proximitywake'), '0');
    assert.equal(pmsetValue('hibernatemode'), '3', 'l\'ibernazione resta com\'e\'');
    assert.match(read('log'), /^pmset -c sleep 0 disksleep 0 displaysleep 1 powernap 0$/m);
    assert.equal(read('spotlight').trim(), 'disabled');
    assert.equal(pref('std__Library_Preferences_com.apple.SoftwareUpdate_AutomaticallyInstallMacOSUpdates'), '0');
    assert.equal(pref('std__Library_Preferences_com.apple.Bluetooth_ControllerPowerState'), '0');

    const revert = tune(['revert-system'], '0');
    assert.equal(revert.status, 0, revert.stderr);
    for (const [key, value] of [['sleep', '1'], ['disksleep', '10'], ['displaysleep', '10'], ['powernap', '1'], ['proximitywake', '1']]) {
      assert.equal(pmsetValue(key), value, key);
    }
    assert.equal(read('spotlight').trim(), 'enabled');
    assert.equal(pref('std__Library_Preferences_com.apple.SoftwareUpdate_AutomaticallyInstallMacOSUpdates'), null);
  });
});
