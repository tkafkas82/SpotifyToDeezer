import test from 'node:test';
import assert from 'node:assert/strict';
import { GwClient } from '../lib/deezer-gw.js';

/** A stand-in for the gateway: records calls, replies from a script. */
const fake = replies => {
  const calls = [];
  const transport = async (method, token, payload) => {
    calls.push({ method, token, payload });
    const reply = replies[method];
    const value = typeof reply === 'function' ? reply(calls.filter(c => c.method === method).length) : reply;
    return value ?? { error: { GATEWAY_ERROR: 'Undefined or invalid output' }, results: {} };
  };
  return { transport, calls };
};

const userData = (id = 0) => ({
  error: [],
  results: {
    checkForm: 'csrf-token-1',
    COUNTRY: 'GR',
    USER: id ? { USER_ID: id, BLOG_NAME: 'Tasos', USER_PICTURE: 'abc' } : { USER_ID: 0 },
  },
});

test('a logged-out session reports no user and refuses to write', async () => {
  const { transport } = fake({ 'deezer.getUserData': userData(0) });
  const client = new GwClient(transport);
  assert.equal(await client.user(), null);
  await assert.rejects(() => client.createPlaylist('x'), err => err.status === 401);
});

test('a logged-in session is identified from the same call', async () => {
  const { transport } = fake({ 'deezer.getUserData': userData(4242) });
  const user = await new GwClient(transport).user();
  assert.equal(user.id, 4242);
  assert.equal(user.name, 'Tasos');
  assert.match(user.picture, /^https:\/\//);
});

test('the CSRF token is fetched once and reused', async () => {
  const { transport, calls } = fake({
    'deezer.getUserData': userData(1),
    'playlist.create': { error: [], results: 909 },
  });
  const client = new GwClient(transport);
  await client.createPlaylist('First');
  await client.createPlaylist('Second');
  assert.equal(calls.filter(c => c.method === 'deezer.getUserData').length, 1);
  assert.equal(calls.filter(c => c.method === 'playlist.create').at(-1).token, 'csrf-token-1');
});

test('an expired token is refreshed and the call retried once', async () => {
  const { transport, calls } = fake({
    'deezer.getUserData': userData(1),
    // First attempt is rejected as a stale token, second succeeds.
    'playlist.create': n => (n === 1
      ? { error: { VALID_TOKEN_REQUIRED: 'Invalid CSRF token' }, results: {} }
      : { error: [], results: 777 }),
  });
  const client = new GwClient(transport);
  const made = await client.createPlaylist('Retried');
  assert.equal(made.id, '777');
  assert.equal(calls.filter(c => c.method === 'deezer.getUserData').length, 2);
  assert.match(made.link, /playlist\/777$/);
});

test('NEED_USER_AUTH_REQUIRED surfaces as a 401, not a generic failure', async () => {
  const { transport } = fake({
    'deezer.getUserData': userData(1),
    'playlist.addSongs': { error: { NEED_USER_AUTH_REQUIRED: 'Require user auth' }, results: {} },
  });
  await assert.rejects(
    () => new GwClient(transport).addSongs('1', ['1', '2']),
    err => err.status === 401 && /connect deezer/i.test(err.message),
  );
});

test('tracks are sent as [id, position] pairs, and the offset variant is retried', async () => {
  const { transport, calls } = fake({
    'deezer.getUserData': userData(1),
    // Some Deezer builds reject the `offset` field; the client must try it both ways.
    'playlist.addSongs': n => (n === 1
      ? { error: { DATA_ERROR: 'unexpected offset' }, results: {} }
      : { error: [], results: true }),
  });
  const added = await new GwClient(transport).addSongs('55', ['11', '22']);
  assert.equal(added, 2);
  const attempts = calls.filter(c => c.method === 'playlist.addSongs');
  assert.deepEqual(attempts[0].payload.songs, [['11', 0], ['22', 1]]);
  assert.equal(attempts[0].payload.offset, 0);
  assert.ok(!('offset' in attempts[1].payload));
});

test('an unknown gateway method is reported as a gateway error', async () => {
  const { transport } = fake({ 'deezer.getUserData': userData(1) });
  await assert.rejects(
    () => new GwClient(transport).call('bogus.method', {}),
    err => err.status === 502 && /GATEWAY_ERROR/.test(err.message),
  );
});

test('existing playlist ids are paged through', async () => {
  const page = Array.from({ length: 500 }, (_, i) => ({ SNG_ID: String(i) }));
  const { transport, calls } = fake({
    'deezer.getUserData': userData(1),
    'playlist.getSongs': n => ({ error: [], results: { data: n === 1 ? page : [{ SNG_ID: '9001' }] } }),
  });
  const ids = await new GwClient(transport).playlistTrackIds('7');
  assert.equal(ids.size, 501);
  assert.ok(ids.has('9001'));
  assert.equal(calls.filter(c => c.method === 'playlist.getSongs').length, 2);
});
