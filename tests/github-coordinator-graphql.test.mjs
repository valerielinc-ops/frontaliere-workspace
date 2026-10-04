import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubCoordinator,
  graphqlRequestBody,
  graphqlResponseError,
  parseGhApiArguments,
} from '../bin/github-coordinator.mjs';

const QUERY = 'query($owner:String!,$name:String!,$first:Int!){repository(owner:$owner,name:$name){name}}';

// A coordinator whose only network is a stub: records what the shim would send.
function stubCoordinator(response) {
  const sent = [];
  return {
    sent,
    coordinator: {
      async executeApi(request) {
        sent.push(request);
        return { ok: true, status: 200, headers: {}, ...response };
      },
    },
  };
}

test('gh api graphql mette -F/-f in variables e lascia query al primo livello, come il gh reale', () => {
  // Prima della fix il corpo era {query, owner, name, first}: GitHub vedeva
  // variabili nulle e rispondeva "Variable $owner of type String! was
  // provided invalid value".
  const parsed = parseGhApiArguments([
    'api', 'graphql',
    '-F', 'owner=valerielinc-ops',
    '-f', 'name=frontaliere-si-o-no',
    '-F', 'first=5',
    '--raw-field', `query=${QUERY}`,
    '--field=operationName=Repo',
  ]);
  assert.equal(parsed.path, '/graphql');
  assert.equal(parsed.method, 'POST');
  assert.deepEqual(parsed.body, {
    query: QUERY,
    operationName: 'Repo',
    variables: { owner: 'valerielinc-ops', name: 'frontaliere-si-o-no', first: 5 },
  });

  // Senza variabili gh non manda la chiave `variables`.
  assert.deepEqual(
    parseGhApiArguments(['api', 'graphql', '-f', 'query=query{viewer{login}}']).body,
    { query: 'query{viewer{login}}' },
  );
  assert.deepEqual(graphqlRequestBody({ query: 'q' }), { query: 'q' });
});

test('-F tipizza come magicFieldValue di gh: solo interi, booleani e null', () => {
  const variables = parseGhApiArguments([
    'api', 'graphql', '-f', `query=${QUERY}`,
    '-F', 'int=-42', '-F', 'yes=true', '-F', 'no=false', '-F', 'none=null',
    '-F', 'float=1.5', '-F', 'json=[1,2]', '-f', 'raw=7',
  ]).body.variables;
  assert.deepEqual(variables, {
    int: -42, yes: true, no: false, none: null,
    // gh usa strconv.Atoi: decimali e JSON restano stringhe; -f non tipizza mai.
    float: '1.5', json: '[1,2]', raw: '7',
  });
});

test('le forme che dipendono da cwd, stdin o annidamento passano al gh reale', () => {
  for (const field of ['query=@query.graphql', 'body=@-', 'owner={owner}', 'labels[]=bug', 'input[title]=x', `big=${'9'.repeat(20)}`]) {
    assert.equal(
      parseGhApiArguments(['api', 'graphql', '-f', `query=${QUERY}`, '-F', field]),
      null,
      field,
    );
  }
  // La paginazione GraphQL usa $endCursor/pageInfo, non l'header Link.
  assert.equal(parseGhApiArguments(['api', 'graphql', '--paginate', '-f', `query=${QUERY}`]), null);
  // -f resta letterale anche con @ o segnaposto, come nel gh reale.
  assert.deepEqual(
    parseGhApiArguments(['api', 'graphql', '-f', `query=${QUERY}`, '-f', 'note=@{owner}']).body.variables,
    { note: '@{owner}' },
  );
});

test('gh api REST con -F/-f: campi nel corpo (POST) o nella query string (GET), senza variables', () => {
  const post = parseGhApiArguments([
    'api', 'repos/o/r/issues', '-X', 'POST', '-f', 'title=Titolo', '-F', 'milestone=3', '-F', 'locked=false',
  ]);
  assert.equal(post.path, '/repos/o/r/issues');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { title: 'Titolo', milestone: 3, locked: false });

  const get = parseGhApiArguments(['api', 'repos/o/r/issues', '-X', 'GET', '-F', 'per_page=100', '-f', 'state=open']);
  assert.equal(get.method, 'GET');
  assert.equal(get.body, undefined);
  assert.equal(get.path, '/repos/o/r/issues?per_page=100&state=open');
});

test('una risposta GraphQL con errors esce 1, stampa il corpo e i messaggi come gh', async () => {
  const body = JSON.stringify({
    data: { repository: null },
    errors: [
      { type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'o/x'." },
      { message: 'second' },
    ],
  });
  const { coordinator, sent } = stubCoordinator({ body });
  const parsed = parseGhApiArguments(['api', 'graphql', '-f', `query=${QUERY}`, '-F', 'owner=o', '--jq', '.data']);
  const result = await GitHubCoordinator.prototype.executeParsedApi.call(coordinator, parsed);

  // Prima della fix: exitCode 0 e `errors` letti come dati.
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.stdout, `${body}\n`, '--jq non si applica a una risposta con errori');
  assert.equal(result.stderr, "gh: Could not resolve to a Repository with the name 'o/x'.\nsecond\n");
  assert.deepEqual(sent[0].body.variables, { owner: 'o' });
});

test('una risposta GraphQL senza errors resta exit 0 con --jq applicato', async () => {
  const { coordinator } = stubCoordinator({
    body: JSON.stringify({ data: { repository: { name: 'frontaliere-si-o-no' } } }),
  });
  const result = await GitHubCoordinator.prototype.executeParsedApi.call(
    coordinator,
    parseGhApiArguments(['api', 'graphql', '-f', `query=${QUERY}`, '--jq', '.data.repository.name']),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'frontaliere-si-o-no\n');
  assert.equal(graphqlResponseError('{"data":{},"errors":[]}', 200), null);
  assert.equal(graphqlResponseError('not json', 200), null);
  assert.equal(graphqlResponseError('{"errors":[{},{}]}', 200), 'GraphQL errors');
});

test('una risposta REST con un campo errors non cambia l\'uscita', async () => {
  // gh controlla `errors` solo per graphql o per HTTP >= 400.
  const body = JSON.stringify({ errors: [{ message: 'dato, non errore' }] });
  const { coordinator } = stubCoordinator({ body });
  const result = await GitHubCoordinator.prototype.executeParsedApi.call(
    coordinator,
    parseGhApiArguments(['api', 'repos/o/r/contents/x']),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${body}\n`);
});
