/*
 * Server for the Spotify -> Deezer playlist copier.
 *
 * Both sides work two ways:
 *
 *   Spotify   registered app (ISRC + any length)  |  public pages, no credentials
 *   Deezer    registered app via OAuth            |  your own logged-in web session
 *
 * The keyless route is the default; credentials are used whenever they are
 * present, because they are the stable route and the ISRC makes matching exact.
 * `resolveReader`/`resolveWriter` are the two places that choose.
 *
 * Who "you" are depends on one switch, GOOGLE_CLIENT_ID/SECRET:
 *
 *   absent   single user, this machine. The Deezer connection is the machine's,
 *            exactly as before, under the fixed `local` identity.
 *   present  Google sign-in is required and every Deezer connection belongs to
 *            the account that made it - see lib/users.js. The shared Chrome
 *            profile login is refused in this mode: one browser profile holds one
 *            Deezer login, so offering it would let whoever signed in most
 *            recently write into somebody else's library.
 *
 * Where the records live is a separate question from who they belong to, and it
 * is answered by the environment: data/users.json on a machine with a disk, Redis
 * over HTTP when KV_REST_API_URL is set, which is what makes a serverless
 * deployment possible. Nothing per-user is held between requests - two instances
 * of this app must not disagree about who owns which Deezer - so the record is
 * loaded once per request and hung on `req.who`.
 *
 * The conversion is streamed over SSE: a 500-track playlist is minutes of
 * rate-limited Deezer lookups, and a silent three-minute POST is
 * indistinguishable from a hang.
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HttpError } from './lib/http.js';
import * as spotifyApi from './lib/spotify.js';
import * as spotifyPublic from './lib/spotify-public.js';
import * as deezerApi from './lib/deezer.js';
import { DeezerApi } from './lib/deezer.js';
import { GwClient, cookieTransport, browserTransport } from './lib/deezer-gw.js';
import * as browser from './lib/browser.js';
import * as auth from './lib/auth.js';
import * as sessions from './lib/session.js';
import * as users from './lib/users.js';
import { keyIsGenerated } from './lib/secret.js';
import { convertPlaylist } from './lib/convert.js';
import { cache, flush } from './lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4870;
const DEEZER_HOME = 'https://www.deezer.com/';
const OAUTH_COOKIE = 'sd_oauth';
const DEEZER_OAUTH_COOKIE = 'sd_deezer_oauth';

/** True while there is no identity provider: one machine, one user, no sign-in. */
const singleUser = () => !auth.configured();

/**
 * Which commit is running. Printed at startup and served in /api/config, because
 * "restart the server" and "the fix did not work" look identical otherwise.
 */
const BUILD = (() => {
  try {
    const head = fs.readFileSync(path.join(HERE, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const hash = ref ? fs.readFileSync(path.join(HERE, '.git', ref), 'utf8').trim() : head;
    return hash.slice(0, 7);
  } catch {
    return 'unknown';
  }
})();

const app = express();
app.use(express.json({ limit: '4mb' }));

const secureCookies = sessions.isHttps(PORT);

const fail = (res, err) => {
  const status = err instanceof HttpError ? err.status : 502;
  if (!(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message });
};

// --- who is asking -------------------------------------------------------

/**
 * The record behind a request, or null when sign-in is on and nobody is signed in.
 * Everything per-user goes through the returned account.
 */
async function whoami(req) {
  if (singleUser()) return users.load(users.LOCAL_ID);
  const session = sessions.fromRequest(req);
  if (!session) return null;
  const account = await users.load(session.sub);
  if (!account.identity) return null;              // signed out server-side, or new key
  if (!auth.allowed(account.email)) return null;   // allow list tightened since
  return account;
}

/** Routes reachable without being signed in - the sign-in flow itself, and config. */
const OPEN_ROUTES = new Set([
  '/api/config',
  '/api/auth/google',
  '/api/auth/google/callback',
  '/api/auth/logout',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A state-changing call has to come from this app's own origin. The session cookie
 * is already SameSite=Lax, so this is the second lock rather than the only one:
 * it costs a header comparison and it closes the fetch-from-another-page case.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                   // curl, or a same-origin navigation
  try {
    const asked = new URL(origin);
    const declared = process.env.PUBLIC_URL || process.env.BASE_URL;
    return declared ? asked.origin === new URL(declared).origin : asked.host === req.headers.host;
  } catch {
    return false;
  }
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (!SAFE_METHODS.has(req.method) && !sameOrigin(req)) {
    return res.status(403).json({ error: 'Refused: that request came from another site.' });
  }
  try {
    req.who = await whoami(req);
  } catch (err) {
    // The store being unreachable is not the caller's fault, and answering 401
    // would send them round the sign-in loop for nothing.
    return fail(res, err);
  }
  if (OPEN_ROUTES.has(req.path)) return next();
  if (!req.who) {
    // An OAuth callback landing here is a browser navigation, not a fetch: send it
    // to the page, which explains itself, rather than answering it with JSON.
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      return res.redirect('/?auth=required');
    }
    return res.status(401).set('Cache-Control', 'no-store')
      .json({ error: 'Sign in with Google first.', signIn: true });
  }
  req.who.touch().catch(() => {});    // last-seen is not worth failing a request over
  return next();
});

// --- Google sign-in ------------------------------------------------------

app.get('/api/auth/google', (req, res) => {
  try {
    if (singleUser()) throw new HttpError(404, 'Google sign-in is not configured on this server.');
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    // The pair rides in a short-lived signed cookie rather than server memory, so
    // a restart mid-sign-in - or a second worker - does not lose the round trip.
    sessions.setCookie(res, OAUTH_COOKIE, sessions.sign({ sub: state, nonce, iat: Date.now() }), {
      maxAgeMs: 10 * 60_000,
      secure: secureCookies,
    });
    res.redirect(auth.authUrl({ port: PORT, state, nonce }));
  } catch (err) { fail(res, err); }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const bounce = (params) => res.redirect(`/?${new URLSearchParams(params)}`);
  try {
    if (singleUser()) throw new HttpError(404, 'Google sign-in is not configured on this server.');
    const { code, state, error: denied } = req.query;
    sessions.clearCookie(res, OAUTH_COOKIE, { secure: secureCookies });
    if (denied) return bounce({ auth: 'denied' });

    const jar = sessions.parseCookies(req.headers.cookie);
    const pending = sessions.verify(jar[OAUTH_COOKIE], { maxAgeMs: 10 * 60_000 });
    if (!code || !state || !pending || pending.sub !== String(state)) {
      return bounce({ auth: 'error', message: 'That sign-in did not come back to the browser it started in - try again.' });
    }

    const profile = await auth.exchangeCode(String(code), { port: PORT, nonce: pending.nonce });
    if (!profile.emailVerified) {
      return bounce({ auth: 'error', message: 'That Google account has no verified email address.' });
    }
    if (!auth.allowed(profile.email)) {
      return bounce({ auth: 'denied', message: `${profile.email} is not on this server's allow list.` });
    }

    const id = users.googleId(profile.sub);
    const account = await users.load(id);
    await account.signedIn({
      provider: 'google',
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    });
    sessions.setCookie(res, sessions.COOKIE, sessions.sign({ sub: id, iat: Date.now() }), { secure: secureCookies });
    return bounce({ auth: 'signedin' });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return bounce({ auth: 'error', message: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  // Only the cookie goes: the Deezer connection stays on the record, ready for
  // the next sign-in. "Disconnect Deezer" is the button that forgets that.
  sessions.clearCookie(res, sessions.COOKIE, { secure: secureCookies });
  res.json({ ok: true });
});

// --- the two Deezer session flavours -------------------------------------

/*
 * One gateway client per Deezer session, so a 500-track push does not re-fetch the
 * CSRF token for every batch of 200.
 *
 * Keyed by a fingerprint of the cookie rather than by identity: a cookie replaced
 * on another instance of this app - or in another request - must not keep being
 * answered by the client built around the old one. That makes the cache
 * self-invalidating, which matters when there is no way to tell the other instance
 * anything.
 */
const gwClients = new Map();
const fingerprint = value => crypto.createHash('sha256').update(value).digest('base64url').slice(0, 12);

function gwClient(account) {
  const arl = account.arl();
  const key = arl ? `${account.id}:${fingerprint(arl)}` : `${account.id}:browser`;
  if (gwClients.has(key)) return gwClients.get(key);

  let client = null;
  if (arl) client = new GwClient(cookieTransport(arl));
  else if (singleUser() && account.id === users.LOCAL_ID) {
    client = new GwClient(browserTransport(() => browser.requestApi()));
  }
  // A long-lived process with many users would otherwise accumulate one entry per
  // cookie ever seen. There is nothing in a client worth keeping.
  if (gwClients.size > 64) gwClients.clear();
  gwClients.set(key, client);
  return client;
}

/**
 * Who the key-free session belongs to: `{ user }`, or `{ user: null, error }`.
 *
 * The distinction matters more than it looks. A cookie Deezer has stopped
 * honouring comes back as a session with no user, and the answer to that really is
 * "paste a fresh one". Deezer failing to answer at all - a throttle, an edge
 * serving HTML - throws instead, and telling somebody to re-copy a cookie that is
 * perfectly good sends them on a wild goose chase.
 *
 * `mayOpen` allows starting the *headless* browser profile to answer the question
 * - no window, just the cookies already on disk. Without a profile there is
 * nothing to ask, so a first-time visitor never triggers a browser launch. With
 * sign-in on there is no browser route at all, only the pasted cookie.
 */
async function deezerSession(account, { mayOpen = false } = {}) {
  const client = gwClient(account);
  if (!client) return { user: null };
  const viaBrowser = !account.arl();
  if (viaBrowser && !(browser.sessionOpen() || (mayOpen && browser.profileExists()))) return { user: null };
  try {
    return { user: await client.refresh() };
  } catch (err) {
    return { user: null, error: err };
  }
}

const gwWriter = (client, mode) => ({
  mode,
  myPlaylists: () => client.myPlaylists(),
  createPlaylist: (title, description) => client.createPlaylist(title, description),
  playlistTrackIds: id => client.playlistTrackIds(id),
  addTracks: async (id, ids) => {
    let added = 0;
    for (let i = 0; i < ids.length; i += 200) {
      added += await client.addSongs(id, ids.slice(i, i + 200));
    }
    return added;
  },
  removeTracks: async (id, ids) => {
    let removed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      removed += await client.removeSongs(id, ids.slice(i, i + 200));
    }
    return removed;
  },
});

/** That user's registered-app Deezer, or null when they have not connected one. */
function oauthApi(account) {
  const session = account.oauth();
  if (!session) return null;
  return new DeezerApi(session, {
    // Deezer has stopped accepting it; leaving it on the record would show a
    // connection that cannot write.
    onExpired: () => { account.disconnect('oauth').catch(() => {}); },
  });
}

const apiWriter = api => ({
  mode: 'oauth',
  myPlaylists: () => api.myPlaylists(),
  createPlaylist: async (title, description) => {
    const made = await api.createPlaylist(title);
    if (description) await api.setPlaylistDescription(made.id, description);
    return made;
  },
  playlistTrackIds: id => api.playlistTrackIds(id),
  addTracks: (id, ids) => api.addTracks(id, ids),
  removeTracks: (id, ids) => api.removeTracks(id, ids),
});

/** Registered app first when that user has connected one, else their web session. */
async function resolveWriter(who) {
  const api = oauthApi(who);
  if (api) return apiWriter(api);
  const session = await deezerSession(who, { mayOpen: true });
  if (session.user) {
    return gwWriter(gwClient(who), who.arl() ? 'arl' : 'browser');
  }
  // Deezer's own complaint beats a guess about the cookie being stale.
  if (session.error) throw session.error;
  throw new HttpError(401, who.arl()
    ? 'That Deezer cookie is not a logged-in session any more - paste a fresh one.'
    : singleUser()
      ? 'Connect Deezer first (paste your session cookie, or open the browser login).'
      : 'Connect your Deezer account first - paste your session cookie below.');
}

const resolveReader = () => (spotifyApi.configured() ? spotifyApi : spotifyPublic);

// --- config --------------------------------------------------------------

app.get('/api/config', async (req, res) => {
  try {
    const who = req.who;
    const deezer = {
      hasKeys: deezerApi.configured(),
      oauthUser: null,
      sessionUser: null,
      sessionMode: 'arl',
      sessionError: null,
      sessionOpen: false,
      hasProfile: false,
      browserLogin: false,
      browserChannel: null,
    };
    if (who) {
      deezer.oauthUser = oauthApi(who)?.user || null;
      const session = await deezerSession(who, { mayOpen: true });
      deezer.sessionUser = session.user;
      // Reported rather than thrown: the rest of the page works without Deezer,
      // and a page that will not load at all is worse than one saying "not now".
      deezer.sessionError = session.error?.message || null;
      // The browser profile is a single machine-wide login, so it is only ever
      // offered when this server has one user by definition.
      deezer.browserLogin = singleUser();
      deezer.sessionMode = who.arl() ? 'arl' : 'browser';
      deezer.sessionOpen = singleUser() && browser.sessionOpen();
      deezer.hasProfile = singleUser() && browser.profileExists();
      deezer.browserChannel = singleUser() ? (browser.pickChannel() || 'chromium') : null;
    }
    res.set('Cache-Control', 'no-store').json({
      auth: {
        enabled: !singleUser(),
        user: who && !singleUser() ? {
          name: who.identity.name,
          email: who.identity.email,
          picture: who.identity.picture,
        } : null,
        restricted: auth.allowList().length > 0,
        // Which store answered, for the debugging question "did my connection go
        // somewhere else?". Told to people who are signed in, not to visitors.
        store: who ? users.where() : null,
      },
      spotify: {
        mode: spotifyApi.configured() ? 'api' : 'public',
        hasKeys: spotifyApi.configured(),
      },
      deezer,
      redirectUri: deezerApi.redirectUri(PORT),
      cacheSize: cache.size,
      build: BUILD,
    });
  } catch (err) { fail(res, err); }
});

// --- Deezer: key-free session -------------------------------------------

app.post('/api/deezer/session/open', async (req, res) => {
  try {
    if (!singleUser()) {
      throw new HttpError(409, 'This server has more than one user, so the shared browser login is off: '
        + 'paste your own Deezer session cookie instead.');
    }
    if (req.who.arl()) {
      const { user, error } = await deezerSession(req.who, { mayOpen: true });
      if (error) throw error;
      if (!user) throw new HttpError(401, 'That Deezer cookie is not logged in.');
      return res.json({ user, opened: false });
    }
    // A stored login answers for itself headlessly; only a missing one is worth
    // putting a window on someone's screen for.
    const known = (await deezerSession(req.who, { mayOpen: true })).user;
    if (known) return res.json({ user: known, opened: false });

    await browser.showPage(`${DEEZER_HOME}login`);
    res.json({ user: null, opened: true });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/session/check', async (req, res) => {
  try {
    // Never opens or touches a window: the login in progress must be left alone.
    const { user, error } = await deezerSession(req.who);
    res.set('Cache-Control', 'no-store').json({ user, error: error?.message || null });
  } catch (err) { fail(res, err); }
});

/**
 * How a Deezer account gets attached to whoever is signed in: paste the `arl`
 * cookie of an already logged-in deezer.com. Validated before it is stored, so a
 * bad paste says so at once instead of failing later at the write, and kept
 * encrypted under that identity only.
 */
app.post('/api/deezer/session/arl', async (req, res) => {
  try {
    // Accept the bare value, "arl=...", or a whole document.cookie dump - people
    // copy whichever of those the devtools panel happens to give them.
    const pasted = String(req.body?.arl || '').trim();
    const value = (pasted.match(/arl=([A-Za-z0-9._-]{50,})/) || [])[1]
      || (/^[A-Za-z0-9._-]{50,}$/.test(pasted) ? pasted : '');
    if (!value) {
      throw new HttpError(400, 'No arl value in that - it is a long string of letters and digits, around 190 characters.');
    }
    const probe = new GwClient(cookieTransport(value));
    const user = await probe.refresh();
    if (!user) throw new HttpError(401, 'That cookie is not a logged-in Deezer session - copy it again from a tab where you are signed in.');

    await req.who.setArl(value);
    if (singleUser()) await browser.closeSession();      // no window is needed any more
    res.json({ user });
  } catch (err) { fail(res, err); }
});

app.post('/api/deezer/session/close', async (req, res) => {
  try {
    if (singleUser()) await browser.closeSession();   // cookies stay in the profile
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.post('/api/deezer/session/forget', async (req, res) => {
  try {
    await req.who.disconnect('arl');
    if (singleUser()) await browser.forgetSession();
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// --- Deezer: registered app (OAuth) -------------------------------------

app.get('/api/deezer/login', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    // The state rides in a signed cookie, and remembers *which* signed-in user
    // started this: a callback must not be able to file a Deezer account against
    // somebody else's record, and in-process memory would not survive the second
    // instance - or the cold start - that answers the callback.
    sessions.setCookie(res, DEEZER_OAUTH_COOKIE, sessions.sign({ sub: state, uid: req.who.id, iat: Date.now() }), {
      maxAgeMs: 10 * 60_000,
      secure: secureCookies,
    });
    res.redirect(deezerApi.authUrl({ port: PORT, state }));
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/callback', async (req, res) => {
  const { code, state, error_reason: denied } = req.query;
  sessions.clearCookie(res, DEEZER_OAUTH_COOKIE, { secure: secureCookies });
  if (denied) return res.redirect('/?deezer=denied');
  if (!code) return res.redirect('/?deezer=error&message=' + encodeURIComponent('Deezer sent no code'));

  const jar = sessions.parseCookies(req.headers.cookie);
  const pending = sessions.verify(jar[DEEZER_OAUTH_COOKIE], { maxAgeMs: 10 * 60_000 });
  if (!state || !pending || pending.sub !== String(state) || pending.uid !== req.who.id) {
    return res.redirect('/?deezer=error&message=' + encodeURIComponent('Stale or forged callback state - try connecting again'));
  }
  try {
    const session = await deezerApi.exchangeCode(String(code), PORT);
    await req.who.setOauth(session);
    res.redirect('/?deezer=connected');
  } catch (err) {
    res.redirect('/?deezer=error&message=' + encodeURIComponent(err.message));
  }
});

app.post('/api/deezer/logout', async (req, res) => {
  try {
    await req.who.disconnect('oauth');
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// --- Deezer: reads ------------------------------------------------------

app.get('/api/deezer/playlists', async (req, res) => {
  try {
    const writer = await resolveWriter(req.who);
    res.set('Cache-Control', 'no-store').json({ playlists: await writer.myPlaylists() });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, 'Nothing to search for');
    res.set('Cache-Control', 'no-store').json({ results: await deezerApi.search(q, { limit: 12 }) });
  } catch (err) { fail(res, err); }
});

// --- conversion (SSE) ----------------------------------------------------

app.get('/api/convert', async (req, res) => {
  const id = spotifyApi.parsePlaylistId(req.query.playlist);
  if (!id) return res.status(400).json({ error: 'That does not look like a Spotify playlist link' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => { closed = true; });
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keeps intermediaries (and impatient browsers) from dropping a slow stream.
  const beat = setInterval(() => !closed && res.write(': beat\n\n'), 15_000);

  try {
    const playlist = await resolveReader().getPlaylist(id, p => send('loading', p));
    const { tracks, ...meta } = playlist;
    send('playlist', { ...meta, count: tracks.length });

    const counts = await convertPlaylist({ tracks, send, isClosed: () => closed, cache });
    await flush();
    send('done', { counts, total: tracks.length });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send('error', { message: err.message });
  } finally {
    clearInterval(beat);
    if (!closed) res.end();
  }
});

// --- write to Deezer -----------------------------------------------------

/**
 * Writes the chosen tracks to Deezer - always to the playlists of the identity
 * making the request.
 *
 * `mode` only matters for an existing playlist and is deliberately explicit
 * rather than inferred: `append` keeps what is there and adds what is missing,
 * `replace` empties the playlist first. Guessing between those two is how a copy
 * quietly turns into a wipe.
 */
app.post('/api/deezer/push', async (req, res) => {
  try {
    const { trackIds, playlistId, title, description, mode } = req.body || {};
    const ids = [...new Set((Array.isArray(trackIds) ? trackIds : []).map(String).filter(Boolean))];
    if (!ids.length) throw new HttpError(400, 'No tracks to add');
    if (mode && !['append', 'replace'].includes(mode)) throw new HttpError(400, `Unknown write mode "${mode}"`);
    const writeMode = playlistId ? (mode || 'append') : 'new';
    const writer = await resolveWriter(req.who);

    let target;
    if (playlistId) {
      // An id arrives from the browser, so it is checked against that user's own
      // playlists rather than trusted: writing into a playlist id you were handed
      // is exactly what must not be possible on a shared server.
      const own = await writer.myPlaylists();
      const mine = own.find(p => String(p.id) === String(playlistId));
      if (!mine) throw new HttpError(403, 'That playlist is not one of yours.');
      target = { id: String(mine.id), link: mine.link || `https://www.deezer.com/playlist/${mine.id}`, created: false };
    } else {
      const name = String(title || '').trim() || 'Imported from Spotify';
      const made = await writer.createPlaylist(name, String(description || '').slice(0, 500));
      target = { ...made, created: true };
    }

    let removed = 0;
    let fresh = ids;
    if (!target.created) {
      const existing = await writer.playlistTrackIds(target.id);
      if (writeMode === 'replace') {
        // Everything goes, including tracks that are about to be added back, so
        // the playlist ends up in the order of this copy rather than interleaved.
        if (existing.size) removed = await writer.removeTracks(target.id, [...existing]);
      } else {
        // Appending should not duplicate what is already there - Deezer stores
        // the same track twice happily enough, and rejects the batch for trying.
        fresh = ids.filter(x => !existing.has(String(x)));
      }
    }

    const added = fresh.length ? await writer.addTracks(target.id, fresh) : 0;
    res.json({
      playlistId: target.id,
      link: target.link,
      created: target.created,
      mode: writeMode,
      added,
      removed,
      duplicatesSkipped: ids.length - fresh.length,
      via: writer.mode,
    });
  } catch (err) { fail(res, err); }
});

app.use(express.static(path.join(HERE, 'public'), { extensions: ['html'] }));

/**
 * The checks that are worth refusing to start over, rather than failing later on
 * somebody's first sign-in.
 */
function preflight() {
  const problems = [];
  if (users.usingKv() && keyIsGenerated()) {
    problems.push('APP_SECRET must be set when the records live in a key-value store: '
      + 'a key generated per instance would sign everybody out on every cold start '
      + 'and make the stored Deezer credentials unreadable.');
  }
  if (!singleUser() && !process.env.GOOGLE_CLIENT_SECRET) {
    problems.push('GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is not.');
  }
  return problems;
}

function banner() {
  console.log(`Spotify -> Deezer on ${sessions.baseUrl(PORT)}  (build ${BUILD})`);
  console.log(`   Sign-in: ${singleUser() ? 'off - single user, this machine' : 'Google'}`);
  console.log(`   Records: ${users.where()}`);
  console.log(`   Spotify: ${spotifyApi.configured() ? 'app credentials (exact ISRC matching)' : 'no credentials - reading public pages'}`);
  console.log(`   Deezer:  ${deezerApi.configured() ? 'app credentials available' : 'per-user session cookie'}`);
  if (singleUser()) return;
  if (!auth.allowList().length) {
    console.log('   ! ALLOWED_EMAILS is empty: anybody with a Google account can sign in and');
    console.log('     connect their own Deezer. Set it to a list of addresses or @domains.');
  }
  if (keyIsGenerated()) {
    console.log('   ! APP_SECRET is unset: sessions and stored Deezer credentials are keyed');
    console.log('     off data/secret.key. Losing that file signs everybody out.');
  }
  if (!process.env.PUBLIC_URL && !process.env.BASE_URL) {
    console.log(`   ! PUBLIC_URL is unset, so redirect URIs are built as ${sessions.baseUrl(PORT)}`);
  }
  if (!spotifyApi.configured() && !users.usingKv()) return;
  if (!spotifyApi.configured()) {
    console.log('   ! No Spotify credentials: playlists over 100 tracks are read by driving a');
    console.log('     browser, which a serverless host cannot do. Set them there.');
  }
}

const fatal = preflight();
if (fatal.length) {
  for (const line of fatal) console.error(`Refusing to start: ${line}`);
  // On a serverless host there is nothing to exit from, so the app is still
  // exported - every request will fail loudly on the same missing key.
  if (!process.env.VERCEL) process.exit(1);
}

await users.migrateLegacy({ log: line => console.log(line) });

/*
 * Serverless hosts import this module and call the exported app themselves, one
 * request at a time, so there is nothing to listen on and no signal to handle.
 * Everything below is for the case where this process *is* the server.
 */
if (!process.env.VERCEL) {
  app.listen(PORT, banner);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await flush();
      await browser.closeSession();
      process.exit(0);
    });
  }
} else {
  banner();
}

export default app;
