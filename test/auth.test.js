/*
 * The sign-in half, offline.
 *
 * Nothing here talks to Google: what is worth testing is the part that decides
 * who a request belongs to. A cookie that can be re-signed by hand, a record
 * store that hands one person's Deezer cookie to another, or an id_token accepted
 * because it merely parses - those are the failures that matter, and all three are
 * pure functions of local state.
 *
 * SD_DATA_DIR points the store at a temp directory, and APP_SECRET is fixed so
 * the run does not depend on (or create) data/secret.key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-users-'));
process.env.SD_DATA_DIR = DIR;
process.env.APP_SECRET = 'test-secret-not-a-real-one';
delete process.env.DEEZER_ARL;

const secret = await import('../lib/secret.js');
const sessions = await import('../lib/session.js');
const auth = await import('../lib/auth.js');
const users = await import('../lib/users.js');

const claims = (extra = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'client-123',
  sub: '110000000000000000001',
  email: 'someone@example.com',
  email_verified: true,
  name: 'Someone',
  exp: Math.floor(Date.now() / 1000) + 600,
  ...extra,
});
const idToken = payload => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify(payload)).toString('base64url'),
  'signature-not-checked',
].join('.');

// --- migration (first: it is the only test that expects an empty `local`) ---

test('an existing single-user install keeps its Deezer connection', () => {
  fs.writeFileSync(path.join(DIR, 'gw.json'), JSON.stringify({ arl: 'a'.repeat(192) }));
  fs.writeFileSync(path.join(DIR, 'token.json'), JSON.stringify({
    accessToken: 'legacy-token', expiresAt: null, user: { id: 7, name: 'Old' },
  }));

  users.migrateLegacy();

  assert.equal(users.arl(users.LOCAL_ID), 'a'.repeat(192));
  assert.equal(users.oauth(users.LOCAL_ID).accessToken, 'legacy-token');
  // The old files are gone, and what replaced them is not readable at a glance.
  assert.equal(fs.existsSync(path.join(DIR, 'gw.json')), false);
  assert.equal(fs.existsSync(path.join(DIR, 'token.json')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(DIR, 'users.json'), 'utf8'), /aaaaaaaa|legacy-token/);
});

// --- encryption at rest --------------------------------------------------

test('a stored credential round-trips, and anything tampered with does not', () => {
  const blob = secret.encrypt('an arl value');
  assert.equal(secret.decrypt(blob), 'an arl value');

  const [v, iv, tag, body] = blob.split('.');
  const flipped = [v, iv, tag, Buffer.from('different').toString('base64url')].join('.');
  assert.equal(secret.decrypt(flipped), null);      // GCM tag rejects it
  assert.equal(secret.decrypt('not a blob'), null);
  assert.equal(secret.decrypt(undefined), null);
  assert.notEqual(secret.encrypt('same'), secret.encrypt('same'));   // fresh IV each time
});

// --- session cookies -----------------------------------------------------

test('a session cookie cannot be re-pointed at another identity', () => {
  const token = sessions.sign({ sub: 'google:111', iat: Date.now() });
  assert.equal(sessions.verify(token).sub, 'google:111');

  const forged = `${Buffer.from(JSON.stringify({ sub: 'google:222', iat: Date.now() })).toString('base64url')}.${token.split('.')[1]}`;
  assert.equal(sessions.verify(forged), null);
  assert.equal(sessions.verify(`${token}.extra`), null);
  assert.equal(sessions.verify('rubbish'), null);
  assert.equal(sessions.verify(''), null);
});

test('a session cookie ages out, and one dated in the future is refused', () => {
  const old = sessions.sign({ sub: 'google:111', iat: Date.now() - 40 * 24 * 3600_000 });
  assert.equal(sessions.verify(old), null);
  assert.ok(sessions.verify(old, { maxAgeMs: 60 * 24 * 3600_000 }));

  assert.equal(sessions.verify(sessions.sign({ sub: 'x', iat: Date.now() + 10 * 60_000 })), null);
  assert.equal(sessions.verify(sessions.sign({ iat: Date.now() })), null);          // no subject
});

test('cookie headers are parsed as browsers send them', () => {
  const jar = sessions.parseCookies('sd_session=abc.def; other=1; spaced = 2 ; broken');
  assert.equal(jar.sd_session, 'abc.def');
  assert.equal(jar.other, '1');
  assert.equal(jar.spaced, '2');
  assert.equal('broken' in jar, false);
  assert.deepEqual(sessions.parseCookies(undefined), {});
  // The first value wins, so a second cookie of the same name cannot shadow it.
  assert.equal(sessions.parseCookies('a=first; a=second').a, 'first');
});

test('cookies are HttpOnly and SameSite, and Secure only when the origin is https', () => {
  const headers = [];
  const res = { append: (_, value) => headers.push(value) };
  sessions.setCookie(res, 'sd_session', 'v', { secure: false });
  sessions.setCookie(res, 'sd_session', 'v', { secure: true });
  sessions.clearCookie(res, 'sd_session');
  assert.match(headers[0], /HttpOnly/);
  assert.match(headers[0], /SameSite=Lax/);
  assert.doesNotMatch(headers[0], /Secure/);
  assert.match(headers[1], /Secure/);
  assert.match(headers[2], /Max-Age=0/);
});

test('PUBLIC_URL decides the origin, and https there means secure cookies', () => {
  assert.equal(sessions.baseUrl(4870), 'http://localhost:4870');
  assert.equal(sessions.isHttps(4870), false);
  process.env.PUBLIC_URL = 'https://copier.example.com/';
  assert.equal(sessions.baseUrl(4870), 'https://copier.example.com');
  assert.equal(sessions.isHttps(4870), true);
  assert.equal(auth.redirectUri(4870), 'https://copier.example.com/api/auth/google/callback');
  delete process.env.PUBLIC_URL;
});

// --- the Google id_token -------------------------------------------------

test('an id_token is read only when its issuer, audience and expiry hold up', () => {
  const opts = { audience: 'client-123' };
  const who = auth.readIdToken(idToken(claims()), opts);
  assert.equal(who.sub, '110000000000000000001');
  assert.equal(who.email, 'someone@example.com');
  assert.equal(who.emailVerified, true);

  // A token minted for somebody else's app is the one worth catching.
  assert.throws(() => auth.readIdToken(idToken(claims({ aud: 'another-app' })), opts), /different Google client/);
  assert.throws(() => auth.readIdToken(idToken(claims({ iss: 'https://evil.example' })), opts), /issuer/);
  assert.throws(() => auth.readIdToken(idToken(claims({ exp: Math.floor(Date.now() / 1000) - 1 })), opts), /expired/);
  assert.throws(() => auth.readIdToken(idToken(claims({ sub: undefined })), opts), /no subject/);
  assert.throws(() => auth.readIdToken('two.parts', opts), /not a JWT/);
  // An aud array is legal, and the nonce must match the one that started the flow.
  assert.ok(auth.readIdToken(idToken(claims({ aud: ['client-123', 'other'] })), opts));
  assert.throws(() => auth.readIdToken(idToken(claims({ nonce: 'aaa' })), { ...opts, nonce: 'bbb' }), /this browser/);
});

test('the allow list accepts addresses and whole domains', () => {
  delete process.env.ALLOWED_EMAILS;
  assert.equal(auth.allowed('anyone@example.com'), true);      // empty list = open

  process.env.ALLOWED_EMAILS = 'me@gmail.com, @company.gr';
  assert.equal(auth.allowed('me@gmail.com'), true);
  assert.equal(auth.allowed('ME@Gmail.com'), true);
  assert.equal(auth.allowed('someone@company.gr'), true);
  assert.equal(auth.allowed('someone@else.com'), false);
  assert.equal(auth.allowed('me@gmail.com.evil.com'), false);
  assert.equal(auth.allowed(null), false);
  delete process.env.ALLOWED_EMAILS;
});

// --- the per-user store --------------------------------------------------

test('each identity gets its own Deezer, and nobody can read another one', () => {
  const a = users.googleId('111');
  const b = users.googleId('222');
  users.setArl(a, 'arl-of-a');
  users.setArl(b, 'arl-of-b');

  assert.equal(users.arl(a), 'arl-of-a');
  assert.equal(users.arl(b), 'arl-of-b');
  assert.equal(users.arl(users.googleId('333')), null);        // never connected

  users.disconnect(a, 'arl');
  assert.equal(users.arl(a), null);
  assert.equal(users.arl(b), 'arl-of-b');                      // untouched
});

test('DEEZER_ARL in the environment belongs to the local user only', () => {
  users.disconnect(users.LOCAL_ID, 'all');
  process.env.DEEZER_ARL = 'arl-from-env';
  assert.equal(users.arl(users.LOCAL_ID), 'arl-from-env');
  // Otherwise the first Google account to sign in would inherit the machine's session.
  assert.equal(users.arl(users.googleId('444')), null);
  delete process.env.DEEZER_ARL;
});

test('an expired OAuth session reads as not connected', () => {
  const id = users.googleId('555');
  users.setOauth(id, { accessToken: 'live', expiresAt: null, user: { id: 1, name: 'A' } });
  assert.equal(users.oauth(id).accessToken, 'live');

  users.setOauth(id, { accessToken: 'stale', expiresAt: Date.now() - 1000, user: null });
  assert.equal(users.oauth(id), null);

  users.setOauth(id, null);
  assert.equal(users.oauth(id), null);
});

test('signing in remembers when it first happened', () => {
  const id = users.googleId('666');
  const first = users.upsertIdentity(id, { provider: 'google', sub: '666', email: 'a@b.c', name: 'A' });
  const again = users.upsertIdentity(id, { provider: 'google', sub: '666', email: 'a@b.c', name: 'A Renamed' });
  assert.equal(again.firstSeen, first.firstSeen);
  assert.equal(again.name, 'A Renamed');
  assert.equal(users.get(id).identity.email, 'a@b.c');
});

test('the store survives a reload of the file it just wrote', async () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, 'users.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.ok(onDisk.users[users.googleId('222')].deezer.arl.startsWith('v1.'));
  assert.equal(fs.existsSync(path.join(DIR, 'users.json.tmp')), false);   // renamed, not left behind
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
