/*
 * The records in a key-value store instead of a file - the shape a serverless
 * deployment needs, where there is no disk and no shared instance.
 *
 * Redis is stood in for by a fetch stub that speaks the same REST dialect Upstash
 * does, so this tests our half: that a command goes out as a JSON array, that what
 * is stored is the encrypted blob and never the cookie itself, that a reload sees
 * what another instance wrote, and that a store which cannot be reached fails as a
 * 503 rather than as an authentication problem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-kv-'));
process.env.SD_DATA_DIR = DIR;
process.env.APP_SECRET = 'test-secret-not-a-real-one';
process.env.KV_REST_API_URL = 'https://fake-kv.upstash.io';
process.env.KV_REST_API_TOKEN = 'fake-token';
delete process.env.DEEZER_ARL;

const users = await import('../lib/users.js');

/** A Redis of sorts, plus the log of everything that was sent to it. */
const redis = new Map();
const sent = [];
let behaviour = 'ok';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const parts = JSON.parse(opts.body);
  sent.push({ url: String(url), auth: opts.headers?.Authorization, parts });
  if (behaviour === 'unreachable') throw new TypeError('fetch failed');
  if (behaviour === 'refuses') {
    return { ok: false, status: 401, json: async () => ({ error: 'WRONGPASS invalid token' }) };
  }
  const [command, key, value] = parts;
  let result = null;
  if (command === 'GET') result = redis.has(key) ? redis.get(key) : null;
  if (command === 'SET') { redis.set(key, value); result = 'OK'; }
  if (command === 'DEL') { result = redis.delete(key) ? 1 : 0; }
  return { ok: true, status: 200, json: async () => ({ result }) };
};

test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('the store is the key-value one when its variables are set', () => {
  assert.equal(users.usingKv(), true);
  assert.equal(users.where(), 'redis at fake-kv.upstash.io');
});

test('a connection is stored under its own key, encrypted, and read back', async () => {
  const id = users.googleId('111');
  await (await users.load(id)).setArl('the-real-arl-value');

  // A fresh load is what another instance - or the next cold start - would do.
  assert.equal((await users.load(id)).arl(), 'the-real-arl-value');

  const writes = sent.filter(s => s.parts[0] === 'SET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].parts[1], `user:${id}`);
  assert.equal(writes[0].auth, 'Bearer fake-token');
  // The cookie itself must never be what travels or what sits in the store.
  assert.doesNotMatch(writes[0].parts[2], /the-real-arl-value/);
  assert.match(JSON.parse(writes[0].parts[2]).deezer.arl, /^v1\./);
  assert.doesNotMatch(redis.get(`user:${id}`), /the-real-arl-value/);
});

test('one account cannot see another, and an unknown one is simply empty', async () => {
  await (await users.load(users.googleId('222'))).setArl('arl-of-222');
  assert.equal((await users.load(users.googleId('111'))).arl(), 'the-real-arl-value');
  assert.equal((await users.load(users.googleId('222'))).arl(), 'arl-of-222');

  const stranger = await users.load(users.googleId('999'));
  assert.equal(stranger.arl(), null);
  assert.equal(stranger.oauth(), null);
  assert.equal(stranger.identity, null);
});

test('an identity and its Deezer survive a round trip through the store', async () => {
  const id = users.googleId('333');
  const account = await users.load(id);
  await account.signedIn({ provider: 'google', sub: '333', email: 'a@b.c', name: 'Three' });
  await account.setOauth({ accessToken: 'tok', expiresAt: null, user: { id: 9, name: 'Deezer Three' } });

  const reloaded = await users.load(id);
  assert.equal(reloaded.identity.name, 'Three');
  assert.equal(reloaded.oauth().accessToken, 'tok');
  assert.equal(reloaded.oauth().user.name, 'Deezer Three');
  assert.doesNotMatch(redis.get(`user:${id}`), /"tok"/);
});

test('disconnecting removes the credential and nothing else', async () => {
  const id = users.googleId('333');
  await (await users.load(id)).disconnect('oauth');
  const after = await users.load(id);
  assert.equal(after.oauth(), null);
  assert.equal(after.identity.name, 'Three');      // still signed in
});

test('DEEZER_ARL is not a fallback for a hosted account', async () => {
  process.env.DEEZER_ARL = 'machine-wide-arl';
  assert.equal((await users.load(users.googleId('444'))).arl(), null);
  delete process.env.DEEZER_ARL;
});

test('legacy files on disk are left alone: they belong to a single-user install', async () => {
  fs.writeFileSync(path.join(DIR, 'gw.json'), JSON.stringify({ arl: 'x'.repeat(192) }));
  await users.migrateLegacy();
  assert.equal(fs.existsSync(path.join(DIR, 'gw.json')), true);
  assert.equal((await users.load(users.LOCAL_ID)).arl(), null);
  fs.rmSync(path.join(DIR, 'gw.json'));
});

test('a store that cannot be reached is a 503, not a sign-in problem', async () => {
  behaviour = 'unreachable';
  await assert.rejects(users.load(users.googleId('111')), err => {
    // 401 here would send the user round the sign-in loop for a fault that is ours.
    assert.equal(err.status, 503);
    assert.match(err.message, /unreachable/);
    return true;
  });

  behaviour = 'refuses';
  await assert.rejects(users.load(users.googleId('111')), err => {
    assert.equal(err.status, 503);
    assert.match(err.message, /WRONGPASS/);
    return true;
  });
  behaviour = 'ok';
});
