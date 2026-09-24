#!/usr/bin/env node
/**
 * Typecheck entrypoint per gli agenti.
 *
 * `tsconfig.json` del sito e' gia' incremental, ma una chiamata diretta a
 * `npm exec tsc -- --noEmit` puo' bypassare la convenzione e ricostruire tutto.
 * Questo wrapper usa sempre il TypeScript locale, un tsbuildinfo dedicato al
 * lavoro Codex e, con --changed, evita il giro quando il diff non contiene
 * sorgenti tipizzate. Un progetto TypeScript non viene falsamente ridotto a
 * singoli file: quando cambia un .ts/.tsx si verifica il progetto e la sua
 * chiusura d'importazione.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const WORKSPACE = path.resolve(path.dirname(THIS_FILE), '..');

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function changedFiles(repoRoot) {
  const files = new Set();
  const base = git(repoRoot, ['rev-parse', '--verify', 'origin/main']).trim();
  if (base) {
    for (const file of git(repoRoot, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]).split('\n')) {
      if (file.trim()) files.add(file.trim());
    }
  }
  for (const file of git(repoRoot, ['diff', '--name-only', '--no-renames', 'HEAD']).split('\n')) {
    if (file.trim()) files.add(file.trim());
  }
  for (const file of git(repoRoot, ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (file.trim()) files.add(file.trim());
  }
  return [...files].sort();
}

export function relevantToTypecheck(file) {
  return /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|package\.json)$/.test(file) ||
    /\.(?:ts|tsx|mts|cts)$/.test(file);
}

export function parseArgs(argv) {
  let repo;
  let project = 'tsconfig.json';
  let changed = false;
  let full = false;
  let json = false;
  const extra = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthrough) {
      extra.push(arg);
    } else if (arg === '--') {
      passthrough = true;
    } else if (arg === '--changed') {
      changed = true;
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--repo') {
      repo = argv[++i];
    } else if (arg === '--project' || arg === '-p') {
      project = argv[++i];
    } else {
      extra.push(arg);
    }
  }
  return { repo, project, changed, full, json, extra };
}

function resolveRepo(value) {
  const candidate = path.resolve(value || process.env.FRONTALIERE_TYPECHECK_REPO || path.join(WORKSPACE, 'frontaliere-si-o-no'));
  return candidate;
}

export function runTypecheck({ repoRoot, project, extra, emit = true }) {
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    const stderr = `TypeScript locale assente: ${tsc}\n`;
    if (emit) process.stderr.write(stderr);
    return { status: 2, stdout: '', stderr };
  }
  const infoDir = path.join(repoRoot, '.cache', 'codex');
  mkdirSync(infoDir, { recursive: true });
  const infoFile = path.join(infoDir, 'tsconfig.tsbuildinfo');
  const args = [
    tsc,
    '--noEmit',
    '--pretty',
    'false',
    '--incremental',
    '--tsBuildInfoFile',
    infoFile,
    '--project',
    path.resolve(repoRoot, project),
    ...extra,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (emit && stdout) process.stdout.write(stdout);
  if (emit && stderr) process.stderr.write(stderr);
  if (result.error) {
    const errorText = `${stderr}Impossibile eseguire typecheck: ${result.error.message}\n`;
    if (emit) process.stderr.write(`Impossibile eseguire typecheck: ${result.error.message}\n`);
    return { status: 2, stdout, stderr: errorText };
  }
  if (result.signal) {
    const errorText = `${stderr}Typecheck terminato da ${result.signal}\n`;
    if (emit) process.stderr.write(`Typecheck terminato da ${result.signal}\n`);
    return { status: 2, stdout, stderr: errorText };
  }
  return { status: result.status ?? 2, stdout, stderr };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repoRoot = resolveRepo(options.repo);
  if (!existsSync(path.join(repoRoot, 'tsconfig.json')) && !existsSync(path.resolve(repoRoot, options.project))) {
    process.stderr.write(`tsconfig non trovato in ${repoRoot}\n`);
    return 2;
  }

  const files = options.changed ? changedFiles(repoRoot) : [];
  const relevant = files.filter(relevantToTypecheck);
  if (options.changed && !options.full && relevant.length === 0) {
    const payload = { skipped: true, reason: 'nessun file TypeScript o configurazione del progetto nel diff', files };
    process.stdout.write(options.json ? `${JSON.stringify(payload)}\n` : `typecheck saltato: ${payload.reason}\n`);
    return 0;
  }
  if (options.changed && !options.json) {
    process.stdout.write(`typecheck incremental: ${relevant.length} file rilevanti su ${files.length} file cambiati\n`);
  }
  const result = runTypecheck({ ...options, repoRoot, emit: !options.json });
  if (options.json) process.stdout.write(`${JSON.stringify({ skipped: false, status: result.status, files, relevant, stdout: result.stdout, stderr: result.stderr })}\n`);
  return result.status;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE;
if (isMain) process.exitCode = main();
