#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class VerifyError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'VerifyError';
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const options = {};
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') {
      return { help: true };
    }
    if (!['--repo', '--base', '--patch', '--expected'].includes(option)) {
      throw new VerifyError(`Opzione non riconosciuta: ${option}.`);
    }
    if (seen.has(option)) {
      throw new VerifyError(`Opzione ripetuta: ${option}.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value === '--') {
      throw new VerifyError(`Valore mancante per ${option}.`);
    }
    seen.add(option);
    options[option.slice(2)] = value;
    index += 1;
  }

  for (const required of ['repo', 'base', 'patch']) {
    if (!options[required]) {
      throw new VerifyError(`Parametro obbligatorio mancante: --${required}.`);
    }
  }
  return options;
}

function printUsage() {
  process.stderr.write(
    'Uso: node bin/verify-patch-index.mjs --repo PATH --base REF --patch FILE [--expected FILE]\n',
  );
}

function assertDirectory(candidate, label) {
  try {
    if (!fs.statSync(candidate).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new VerifyError(`${label} non è una directory leggibile.`);
  }
}

function assertRegularFile(candidate, label) {
  try {
    if (!fs.statSync(candidate).isFile()) throw new Error('not a file');
  } catch {
    throw new VerifyError(`${label} non esiste o non è un file leggibile.`);
  }
}

function assertRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || path.win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new VerifyError(`${label} non è un path relativo sicuro.`);
  }
  return value;
}

function readExpected(expectedPath) {
  if (!expectedPath) return new Map();
  const resolvedPath = path.resolve(expectedPath);
  assertRegularFile(resolvedPath, 'Il file --expected');

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch {
    throw new VerifyError('Il file --expected non è JSON valido.');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new VerifyError('Il file --expected deve essere un oggetto path → SHA-256.');
  }

  const expected = new Map();
  for (const [relativePath, hash] of Object.entries(parsed)) {
    const safePath = assertRelativePath(relativePath, `Path atteso ${relativePath}`);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new VerifyError(`SHA-256 atteso non valido per ${safePath}.`);
    }
    expected.set(safePath, hash.toLowerCase());
  }
  return expected;
}

function gitEnvironment(indexFile) {
  const environment = { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
  for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
    delete environment[variable];
  }
  if (indexFile) environment.GIT_INDEX_FILE = indexFile;
  return environment;
}

function runGit(repo, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...args], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout),
    }));
  });
}

async function runGitChecked(repo, args, environment, label) {
  const result = await runGit(repo, args, environment);
  if (result.code !== 0) {
    throw new VerifyError(`${label} fallito.`, 3);
  }
  return result.stdout;
}

async function hashIndexPath(repo, environment, relativePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-C',
      repo,
      'show',
      '--format=',
      '--no-ext-diff',
      '--no-textconv',
      `:${relativePath}`,
    ], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hash = crypto.createHash('sha256');
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code === 0 ? hash.digest('hex') : null);
    });
  });
}

function parseRawDiff(output) {
  const fields = output.toString('utf8').split('\0');
  const changes = [];
  for (let index = 0; index < fields.length - 1;) {
    const header = fields[index++];
    if (header === '') continue;
    const firstPath = fields[index++];
    if (!header.startsWith(':') || firstPath === undefined) {
      throw new VerifyError('Output Git non interpretabile.', 3);
    }
    const [oldMode, newMode, , , status] = header.slice(1).split(' ');
    if (!oldMode || !newMode || !status) {
      throw new VerifyError('Output Git non interpretabile.', 3);
    }
    const relativePath = assertRelativePath(firstPath, 'Path modificato');
    changes.push({
      path: relativePath,
      status: status[0],
      oldMode: oldMode === '000000' ? null : oldMode,
      mode: newMode === '000000' ? null : newMode,
    });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return changes;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const repo = path.resolve(options.repo);
  const patchPath = path.resolve(options.patch);
  const expected = readExpected(options.expected);
  assertDirectory(repo, 'Il repository');
  assertRegularFile(patchPath, 'Il file --patch');

  const environment = gitEnvironment();
  await runGitChecked(repo, ['rev-parse', '--show-toplevel'], environment, 'Il repository Git');
  const baseOutput = await runGitChecked(
    repo,
    ['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`],
    environment,
    'La risoluzione del base',
  );
  const actualBase = baseOutput.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(actualBase)) {
    throw new VerifyError('La risoluzione del base non ha restituito un commit valido.', 3);
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-patch-index-'));
  const indexFile = path.join(tempDirectory, 'index');
  try {
    const indexedEnvironment = gitEnvironment(indexFile);
    await runGitChecked(repo, ['read-tree', actualBase], indexedEnvironment, 'git read-tree');
    await runGitChecked(
      repo,
      ['apply', '--cached', '--check', '--binary', '--', patchPath],
      indexedEnvironment,
      'git apply --cached --check',
    );
    await runGitChecked(
      repo,
      ['apply', '--cached', '--binary', '--', patchPath],
      indexedEnvironment,
      'git apply --cached',
    );

    const tree = (await runGitChecked(repo, ['write-tree'], indexedEnvironment, 'git write-tree'))
      .toString('utf8')
      .trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) {
      throw new VerifyError('git write-tree non ha restituito un tree valido.', 3);
    }

    const diff = await runGitChecked(
      repo,
      [
        'diff',
        '--cached',
        '--raw',
        '-z',
        '--no-renames',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        actualBase,
        '--',
      ],
      indexedEnvironment,
      'git diff',
    );
    const changedPaths = parseRawDiff(diff);
    const pathsToHash = new Set([
      ...changedPaths.map((change) => change.path),
      ...expected.keys(),
    ]);
    const hashes = new Map();
    for (const relativePath of [...pathsToHash].sort((left, right) => left.localeCompare(right))) {
      hashes.set(relativePath, await hashIndexPath(repo, indexedEnvironment, relativePath));
    }

    const expectedMismatch = Object.create(null);
    for (const [relativePath, expectedHash] of expected) {
      const actualHash = hashes.get(relativePath) ?? null;
      if (actualHash !== expectedHash) {
        expectedMismatch[relativePath] = { expected: expectedHash, actual: actualHash };
      }
    }

    process.stdout.write(`${JSON.stringify({
      actualBase,
      tree,
      changedPaths,
      hashes: Object.fromEntries(hashes),
      expectedMismatch,
    })}\n`);
    return Object.keys(expectedMismatch).length ? 4 : 0;
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  const message = error instanceof VerifyError ? error.message : 'Errore inatteso durante la verifica.';
  process.stderr.write(`verify-patch-index: ${message}\n`);
  process.exitCode = error instanceof VerifyError ? error.exitCode : 1;
});
