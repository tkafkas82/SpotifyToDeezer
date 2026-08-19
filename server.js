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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HttpError } from './lib/http.js';
import * as spotifyApi from './lib/spotify.js';
import * as spotifyPublic from './lib/spotify-public.js';
import * as deezerApi from './lib/deezer.js';
import * as deezerSearch from './lib/deezer.js';
import { GwClient, cookieTransport, browserTransport } from './lib/deezer-gw.js';
import * as browser from './lib/browser.js';
import { convertPlaylist } from './lib/convert.js';
import { cache, flush } from './lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4870;
const DEEZER_HOME = 'https://www.deezer.com/';

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

// --- the pasted-cookie shortcut ------------------------------------------

const GW_FILE = path.join(HERE, 'data', 'gw.json');
let storedArl = null;
try {
  storedArl = JSON.parse(fs.readFileSync(GW_FILE, 'utf8')).arl || null;
} catch { /* nothing saved */ }

const arl = () => process.env.DEEZER_ARL || storedArl;

const pendingStates = new Set();

const fail = (res, err) => {
  const status = err instanceof HttpError ? err.status : 502;
  if (!(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message });
};

// --- the two Deezer session flavours -------------------------------------

// Cookie transport whenever an `arl` is available, otherwise the browser profile.
let gw = null;
function gwClient() {
  if (!gw) {
    gw = arl()
      ? new GwClient(cookieTransport(arl()))
      : new GwClient(browserTransport(() => browser.requestApi()));
  }
  return gw;
}

/**
 * Who the key-free session belongs to.
 *
 * `mayOpen` allows starting the *headless* profile to answer the question - no
 * window, just the cookies already on disk. Without a profile there is nothing to
 * ask, so a first-time visitor never triggers a browser launch.
 */
async function sessionUser({ mayOpen = false } = {}) {
  const usable = arl() || browser.sessionOpen() || (mayOpen && browser.profileExists());
  if (!usable) return null;
  try {
    return await gwClient().refresh();
  } catch {
    return null;
  }
}

const gwWriter = client => ({
  mode: arl() ? 'arl' : 'browser',
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
  if (await sessionUser({ mayOpen: true })) return gwWriter(gwClient());
  throw new HttpError(401, arl()
    ? 'That Deezer cookie is not a logged-in session any more - paste a fresh one.'
    : 'Connect Deezer first (a browser window opens; log in there once).');
}

const resolveReader = () => (spotifyApi.configured() ? spotifyApi : spotifyPublic);

// --- config --------------------------------------------------------------

app.get('/api/config', async (req, res) => {
  try {
    const user = await sessionUser({ mayOpen: true });
    res.set('Cache-Control', 'no-store').json({
      spotify: {
        mode: spotifyApi.configured() ? 'api' : 'public',
        hasKeys: spotifyApi.configured(),
      },
      deezer: {
        hasKeys: deezerApi.configured(),
        oauthUser: deezerApi.configured() ? await deezerApi.currentUser() : null,
        sessionUser: user,
        sessionMode: arl() ? 'arl' : 'browser',
        sessionOpen: browser.sessionOpen(),
        hasProfile: browser.profileExists(),
        browserChannel: browser.pickChannel() || 'chromium',
      },
      redirectUri: deezerApi.redirectUri(PORT),
      cacheSize: cache.size,
      build: BUILD,
    });
  } catch (err) { fail(res, err); }
});

// --- Deezer: key-free session -------------------------------------------

app.post('/api/deezer/session/open', async (req, res) => {
  try {
    if (arl()) {
      const user = await sessionUser({ mayOpen: true });
      if (!user) throw new HttpError(401, 'That Deezer cookie is not logged in.');
      return res.json({ user, opened: false });
    }
    // A stored login answers for itself headlessly; only a missing one is worth
    // putting a window on someone's screen for.
    const known = await sessionUser({ mayOpen: true });
    if (known) return res.json({ user: known, opened: false });

    await browser.showPage(`${DEEZER_HOME}login`);
    res.json({ user: null, opened: true });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/session/check', async (req, res) => {
  try {
    // Never opens or touches a window: the login in progress must be left alone.
    res.set('Cache-Control', 'no-store').json({ user: await sessionUser() });
  } catch (err) { fail(res, err); }
});

/**
 * The escape hatch from the login window: paste the `arl` cookie of an already
 * logged-in deezer.com. Validated before it is stored, so a bad paste says so at
 * once instead of failing later at the write.
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

    fs.mkdirSync(path.dirname(GW_FILE), { recursive: true });
    fs.writeFileSync(GW_FILE, JSON.stringify({ arl: value }, null, 2));
    storedArl = value;
    gw = null;
    await browser.closeSession();      // no window is needed any more
    res.json({ user });
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
    storedArl = null;
    fs.rmSync(GW_FILE, { force: true });
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
  console.log(`Spotify -> Deezer running on http://localhost:${PORT}  (build ${BUILD})`);
  console.log(`   Spotify: ${spotifyApi.configured() ? 'app credentials (exact ISRC matching)' : 'no credentials - reading public pages'}`);
  console.log(`   Deezer:  ${deezerApi.configured() ? 'app credentials available' : arl() ? 'saved cookie session' : 'browser login (no credentials needed)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flush();
    await browser.closeSession();
    process.exit(0);
  });
}
