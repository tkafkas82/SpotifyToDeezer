/*
 * Local server for the Spotify -> Deezer playlist copier.
 *
 * Runs on your machine only: the Deezer OAuth token lives in data/token.json and
 * never leaves it, which is also why there is no user model here - one machine,
 * one Deezer account.
 *
 * The conversion is streamed over SSE rather than returned in one response
 * because a 500-track playlist takes minutes of rate-limited Deezer lookups, and
 * a silent three-minute POST is indistinguishable from a hang.
 */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { HttpError } from './lib/http.js';
import * as spotify from './lib/spotify.js';
import * as deezer from './lib/deezer.js';
import { convertPlaylist } from './lib/convert.js';
import { cache, flush } from './lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4870;

const app = express();
app.use(express.json({ limit: '4mb' }));

const pendingStates = new Set();

const fail = (res, err) => {
  const status = err instanceof HttpError ? err.status : 502;
  if (!(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message });
};

// --- config --------------------------------------------------------------

app.get('/api/config', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({
      spotifyConfigured: spotify.configured(),
      deezerConfigured: deezer.configured(),
      deezerUser: await deezer.currentUser(),
      redirectUri: deezer.redirectUri(PORT),
      cacheSize: cache.size,
    });
  } catch (err) { fail(res, err); }
});

// --- Deezer OAuth --------------------------------------------------------

app.get('/api/deezer/login', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.add(state);
    setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref?.();
    res.redirect(deezer.authUrl({ port: PORT, state }));
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
    await deezer.exchangeCode(String(code), PORT);
    res.redirect('/?deezer=connected');
  } catch (err) {
    res.redirect('/?deezer=error&message=' + encodeURIComponent(err.message));
  }
});

app.post('/api/deezer/logout', async (req, res) => {
  try {
    await deezer.logout();
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/playlists', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({ playlists: await deezer.myPlaylists() });
  } catch (err) { fail(res, err); }
});

app.get('/api/deezer/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, 'Nothing to search for');
    res.set('Cache-Control', 'no-store').json({ results: await deezer.search(q, { limit: 12 }) });
  } catch (err) { fail(res, err); }
});

// --- conversion (SSE) ----------------------------------------------------

app.get('/api/convert', async (req, res) => {
  const id = spotify.parsePlaylistId(req.query.playlist);
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
    const playlist = await spotify.getPlaylist(id, p => send('loading', p));
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

    let target;
    if (playlistId) {
      target = { id: String(playlistId), link: `https://www.deezer.com/playlist/${playlistId}`, created: false };
    } else {
      const name = String(title || '').trim() || 'Imported from Spotify';
      const made = await deezer.createPlaylist(name);
      target = { ...made, created: true };
      if (description) await deezer.setPlaylistDescription(made.id, String(description).slice(0, 500));
    }

    // Appending to an existing playlist should not duplicate what is already
    // there - Deezer happily stores the same track twice otherwise.
    let existing = new Set();
    if (!target.created) existing = await deezer.playlistTrackIds(target.id);
    const fresh = ids.filter(x => !existing.has(String(x)));

    const added = fresh.length ? await deezer.addTracks(target.id, fresh) : 0;
    res.json({
      playlistId: target.id,
      link: target.link,
      created: target.created,
      added,
      duplicatesSkipped: ids.length - fresh.length,
    });
  } catch (err) { fail(res, err); }
});

app.use(express.static(path.join(HERE, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Spotify -> Deezer running on http://localhost:${PORT}`);
  if (!spotify.configured()) console.log('!  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing - reading playlists will fail.');
  if (!deezer.configured()) console.log('!  DEEZER_APP_ID / DEEZER_APP_SECRET missing - writing playlists will fail.');
  console.log(`   Deezer redirect URL to register: ${deezer.redirectUri(PORT)}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flush();
    process.exit(0);
  });
}
