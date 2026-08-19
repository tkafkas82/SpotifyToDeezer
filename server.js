/*
 * Local server for the Spotify -> Deezer playlist copier.
 *
 * Everything runs on this machine, and both sides work two ways:
 *
 *   Spotify   registered app (ISRC + any length)  |  public pages, no credentials
 *   Deezer    registered app via OAuth            |  your own logged-in web session
 *
 * The keyless route is the default; credentials are used whenever they are
 * present, because they are the stable route and the ISRC makes matching exact.
 * `resolveReader`/`resolveWriter` are the two places that choose.
 *
 * The conversion is streamed over SSE: a 500-track playlist is minutes of
 * rate-limited Deezer lookups, and a silent three-minute POST is
 * indistinguishable from a hang.
 */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { HttpError } from './lib/http.js';
import * as spotifyApi from './lib/spotify.js';
import * as spotifyPublic from './lib/spotify-public.js';
import * as deezerApi from './lib/deezer.js';
import * as deezerSearch from './lib/deezer.js';
import { GwClient, cookieTransport, pageTransport } from './lib/deezer-gw.js';
import * as browser from './lib/browser.js';
import { convertPlaylist } from './lib/convert.js';
import { cache, flush } from './lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4870;
const DEEZER_HOME = 'https://www.deezer.com/';

const app = express();
app.use(express.json({ limit: '4mb' }));

const pendingStates = new Set();

const fail = (res, err) => {
  const status = err instanceof HttpError ? err.status : 502;
  if (!(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message });
};

// --- the two Deezer session flavours -------------------------------------

// Cookie transport when an `arl` is pasted in .env, otherwise the logged-in tab.
let gw = null;
function gwClient() {
  if (!gw) {
    gw = process.env.DEEZER_ARL
      ? new GwClient(cookieTransport(process.env.DEEZER_ARL))
      : new GwClient(pageTransport(() => browser.pageFor(DEEZER_HOME)));
  }
  return gw;
}

/** Who the key-free session belongs to, without ever opening a window uninvited. */
async function sessionUser({ mayOpenBrowser = false } = {}) {
  if (!process.env.DEEZER_ARL && !browser.sessionOpen() && !mayOpenBrowser) return null;
  try {
    return await gwClient().refresh();
  } catch {
    return null;
  }
}

const gwWriter = client => ({
  mode: process.env.DEEZER_ARL ? 'arl' : 'browser',
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
});

const apiWriter = () => ({
  mode: 'oauth',
  myPlaylists: () => deezerApi.myPlaylists(),
  createPlaylist: async (title, description) => {
    const made = await deezerApi.createPlaylist(title);
    if (description) await deezerApi.setPlaylistDescription(made.id, description);
    return made;
  },
  playlistTrackIds: id => deezerApi.playlistTrackIds(id),
  addTracks: (id, ids) => deezerApi.addTracks(id, ids),
});

/** Registered app first when it is actually connected, else the web session. */
async function resolveWriter() {
  if (deezerApi.configured() && await deezerApi.currentUser()) return apiWriter();
  if (await sessionUser()) return gwWriter(gwClient());
  throw new HttpError(401, process.env.DEEZER_ARL
    ? 'That DEEZER_ARL cookie is not a logged-in Deezer session any more - grab a fresh one.'
    : 'Connect Deezer first (a browser window opens; log in there once).');
}

const resolveReader = () => (spotifyApi.configured() ? spotifyApi : spotifyPublic);

// --- config --------------------------------------------------------------

app.get('/api/config', async (req, res) => {
  try {
    const user = await sessionUser();
    res.set('Cache-Control', 'no-store').json({
      spotify: {
        mode: spotifyApi.configured() ? 'api' : 'public',
        hasKeys: spotifyApi.configured(),
      },
      deezer: {
        hasKeys: deezerApi.configured(),
        oauthUser: deezerApi.configured() ? await deezerApi.currentUser() : null,
        sessionUser: user,
        sessionMode: process.env.DEEZER_ARL ? 'arl' : 'browser',
        sessionOpen: browser.sessionOpen(),
        hasProfile: browser.profileExists(),
        browserChannel: browser.pickChannel() || 'chromium',
      },
      redirectUri: deezerApi.redirectUri(PORT),
      cacheSize: cache.size,
    });
  } catch (err) { fail(res, err); }
});

// --- Deezer: key-free session -------------------------------------------

app.post('/api/deezer/session/open', async (req, res) => {
  try {
    if (process.env.DEEZER_ARL) {
      const user = await sessionUser({ mayOpenBrowser: true });
      if (!user) throw new HttpError(401, 'That DEEZER_ARL cookie is not logged in.');
      return res.json({ user, opened: false });
    }
    // Land on the login page when there is no stored session, on the home page
    // when there is - going straight to /login while already signed in is a
    // confusing thing to show someone.
    const user = browser.profileExists() ? await sessionUser({ mayOpenBrowser: true }) : null;
    await browser.pageFor(user ? DEEZER_HOME : 'https://www.deezer.com/login');
    res.json({ user, opened: true });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/session/check', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({ user: await sessionUser({ mayOpenBrowser: false }) });
  } catch (err) { fail(res, err); }
});

app.post('/api/deezer/session/close', async (req, res) => {
  try {
    await browser.closeSession();   // cookies stay in the profile
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.post('/api/deezer/session/forget', async (req, res) => {
  try {
    gw = null;
    await browser.forgetSession();
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// --- Deezer: registered app (OAuth) -------------------------------------

app.get('/api/deezer/login', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.add(state);
    setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref?.();
    res.redirect(deezerApi.authUrl({ port: PORT, state }));
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/callback', async (req, res) => {
  const { code, state, error_reason: denied } = req.query;
  if (denied) return res.redirect('/?deezer=denied');
  if (!code) return res.redirect('/?deezer=error&message=' + encodeURIComponent('Deezer sent no code'));
  if (!state || !pendingStates.delete(String(state))) {
    return res.redirect('/?deezer=error&message=' + encodeURIComponent('Stale or forged callback state - try connecting again'));
  }
  try {
    await deezerApi.exchangeCode(String(code), PORT);
    res.redirect('/?deezer=connected');
  } catch (err) {
    res.redirect('/?deezer=error&message=' + encodeURIComponent(err.message));
  }
});

app.post('/api/deezer/logout', async (req, res) => {
  try {
    await deezerApi.logout();
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// --- Deezer: reads that need no session ---------------------------------

app.get('/api/deezer/playlists', async (req, res) => {
  try {
    const writer = await resolveWriter();
    res.set('Cache-Control', 'no-store').json({ playlists: await writer.myPlaylists() });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, 'Nothing to search for');
    res.set('Cache-Control', 'no-store').json({ results: await deezerSearch.search(q, { limit: 12 }) });
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

app.post('/api/deezer/push', async (req, res) => {
  try {
    const { trackIds, playlistId, title, description } = req.body || {};
    const ids = [...new Set((Array.isArray(trackIds) ? trackIds : []).map(String).filter(Boolean))];
    if (!ids.length) throw new HttpError(400, 'No tracks to add');
    const writer = await resolveWriter();

    let target;
    if (playlistId) {
      target = { id: String(playlistId), link: `https://www.deezer.com/playlist/${playlistId}`, created: false };
    } else {
      const name = String(title || '').trim() || 'Imported from Spotify';
      const made = await writer.createPlaylist(name, String(description || '').slice(0, 500));
      target = { ...made, created: true };
    }

    // Appending to an existing playlist should not duplicate what is already
    // there - Deezer happily stores the same track twice otherwise.
    const existing = target.created ? new Set() : await writer.playlistTrackIds(target.id);
    const fresh = ids.filter(x => !existing.has(String(x)));

    const added = fresh.length ? await writer.addTracks(target.id, fresh) : 0;
    res.json({
      playlistId: target.id,
      link: target.link,
      created: target.created,
      added,
      duplicatesSkipped: ids.length - fresh.length,
      via: writer.mode,
    });
  } catch (err) { fail(res, err); }
});

app.use(express.static(path.join(HERE, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Spotify -> Deezer running on http://localhost:${PORT}`);
  console.log(`   Spotify: ${spotifyApi.configured() ? 'app credentials (exact ISRC matching)' : 'no credentials - reading public pages'}`);
  console.log(`   Deezer:  ${deezerApi.configured() ? 'app credentials available' : process.env.DEEZER_ARL ? 'arl cookie session' : 'browser login (no credentials needed)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flush();
    await browser.closeSession();
    process.exit(0);
  });
}
