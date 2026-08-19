/*
 * Deezer side: search (anonymous) + playlist writes (OAuth).
 *
 * Two Deezer quirks drive the shape of this file:
 *   1. Errors arrive as HTTP 200 with an {error:{code,message}} body, so every
 *      response has to be inspected rather than trusted.
 *   2. The quota is ~50 requests / 5 seconds per app, and blowing it returns
 *      error code 4 rather than a 429 - which is why `call` retries that code
 *      specifically after a pause.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchJson, HttpError, makeLimiter } from './http.js';

const API = 'https://api.deezer.com';
const CONNECT = 'https://connect.deezer.com/oauth';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, '..', 'data', 'token.json');

const limit = makeLimiter({ max: 40, windowMs: 5000, concurrency: 6 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let session = null;            // { accessToken, expiresAt, user }
let loaded = false;

export function configured() {
  return Boolean(process.env.DEEZER_APP_ID && process.env.DEEZER_APP_SECRET);
}

export function redirectUri(port) {
  return process.env.DEEZER_REDIRECT_URI || `http://localhost:${port}/api/deezer/callback`;
}

// --- session persistence -------------------------------------------------

async function loadSession() {
  if (loaded) return session;
  loaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
    if (raw?.accessToken && (!raw.expiresAt || raw.expiresAt > Date.now())) session = raw;
  } catch { /* no stored session yet */ }
  return session;
}

async function saveSession(next) {
  session = next;
  loaded = true;
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(next, null, 2));
}

export async function currentUser() {
  const s = await loadSession();
  return s?.user || null;
}

export async function logout() {
  session = null;
  loaded = true;
  await fs.rm(TOKEN_FILE, { force: true });
}

async function requireToken() {
  const s = await loadSession();
  if (!s?.accessToken) throw new HttpError(401, 'Not connected to Deezer - use "Connect Deezer" first.');
  if (s.expiresAt && s.expiresAt <= Date.now()) {
    await logout();
    throw new HttpError(401, 'The Deezer session expired - connect again.');
  }
  return s.accessToken;
}

// --- OAuth ---------------------------------------------------------------

export function authUrl({ port, state }) {
  if (!configured()) throw new HttpError(500, 'Deezer credentials are missing - fill DEEZER_APP_ID / DEEZER_APP_SECRET in .env');
  const q = new URLSearchParams({
    app_id: process.env.DEEZER_APP_ID,
    redirect_uri: redirectUri(port),
    perms: 'basic_access,manage_library,offline_access',
    state,
  });
  return `${CONNECT}/auth.php?${q}`;
}

export async function exchangeCode(code, port) {
  const q = new URLSearchParams({
    app_id: process.env.DEEZER_APP_ID,
    secret: process.env.DEEZER_APP_SECRET,
    code,
    output: 'json',
  });
  // Without output=json this endpoint answers with a query string, not JSON.
  const body = await fetchJson(`${CONNECT}/access_token.php?${q}`, {}, { label: 'Deezer token' });
  if (!body?.access_token) throw new HttpError(502, `Deezer refused the code: ${JSON.stringify(body).slice(0, 200)}`);
  // expires === 0 means "never", which is what offline_access buys.
  const expires = Number(body.expires || 0);
  await saveSession({
    accessToken: body.access_token,
    expiresAt: expires > 0 ? Date.now() + expires * 1000 : null,
    user: null,
  });
  const me = await call('/user/me', { auth: true });
  const user = {
    id: me.id,
    name: me.name,
    link: me.link,
    picture: me.picture_small || null,
    country: me.country || null,
  };
  await saveSession({ ...session, user });
  return user;
}

// --- API calls -----------------------------------------------------------

async function call(pathname, { auth = false, method = 'GET', params = {} } = {}) {
  const q = new URLSearchParams(params);
  if (auth) q.set('access_token', await requireToken());
  const url = `${API}${pathname}${q.toString() ? `?${q}` : ''}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const body = await limit(() => fetchJson(url, { method }, { label: 'Deezer' }));
    const err = body?.error;
    if (!err) return body;
    const code = Number(err.code);
    if (code === 4) {                       // quota exceeded - back off and retry
      await sleep(1200 * (attempt + 1));
      continue;
    }
    const message = err.message || err.type || 'request failed';
    if (code === 300 || code === 200 || /token|permission|OAuth/i.test(message)) {
      throw new HttpError(401, `Deezer: ${message}`);
    }
    throw new HttpError(502, `Deezer: ${message}`);
  }
  throw new HttpError(429, 'Deezer kept refusing on quota - try again in a minute.');
}

const shape = t => t && ({
  id: t.id,
  title: t.title || '',
  titleShort: t.title_short || t.title || '',
  artists: [...new Set([t.artist?.name, ...(t.contributors || []).map(c => c.name)].filter(Boolean))],
  album: t.album?.title || '',
  durationMs: (t.duration || 0) * 1000,
  cover: t.album?.cover_small || null,
  link: t.link || `https://www.deezer.com/track/${t.id}`,
  readable: t.readable !== false,
  isrc: t.isrc || null,
});

/** Exact lookup by ISRC - the only match that needs no guessing. */
export async function trackByIsrc(isrc) {
  try {
    const t = await call(`/track/isrc:${encodeURIComponent(isrc)}`);
    return t?.id ? shape(t) : null;
  } catch (err) {
    if (err.status === 502) return null;   // "no data" arrives as an error body
    throw err;
  }
}

export async function search(q, { limit: n = 10, strict = false } = {}) {
  const params = { q, limit: String(n) };
  if (strict) params.strict = 'on';
  const body = await call('/search', { params });
  return (body?.data || []).map(shape).filter(Boolean);
}

export async function myPlaylists() {
  const me = await currentUser();
  const body = await call('/user/me/playlists', { auth: true, params: { limit: '100' } });
  return (body?.data || [])
    .filter(p => !p.is_loved_track && String(p.creator?.id ?? me?.id) === String(me?.id))
    .map(p => ({
      id: p.id,
      title: p.title,
      nbTracks: p.nb_tracks,
      link: p.link,
      picture: p.picture_small || null,
      public: p.public,
    }));
}

export async function createPlaylist(title) {
  const body = await call('/user/me/playlists', { auth: true, method: 'POST', params: { title } });
  if (!body?.id) throw new HttpError(502, 'Deezer did not return a playlist id');
  return { id: body.id, link: `https://www.deezer.com/playlist/${body.id}` };
}

/** Track ids already in a playlist, so a re-run appends instead of duplicating. */
export async function playlistTrackIds(playlistId) {
  const ids = new Set();
  let pathname = `/playlist/${playlistId}/tracks`;
  let params = { limit: '100', index: '0' };
  for (let guard = 0; guard < 100; guard++) {
    const body = await call(pathname, { auth: true, params });
    (body?.data || []).forEach(t => ids.add(String(t.id)));
    if (!body?.next) break;
    const next = new URL(body.next);
    pathname = next.pathname;
    params = Object.fromEntries(next.searchParams);
    delete params.access_token;
  }
  return ids;
}

/**
 * Add tracks in chunks. Deezer takes a comma-separated `songs` list but starts
 * dropping the tail on long ones, so 50 per call is the safe ceiling.
 */
export async function addTracks(playlistId, trackIds, onProgress) {
  const ids = [...new Set(trackIds.map(String))];
  let added = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await call(`/playlist/${playlistId}/tracks`, { auth: true, method: 'POST', params: { songs: chunk.join(',') } });
    added += chunk.length;
    onProgress?.({ added, total: ids.length });
  }
  return added;
}

export async function setPlaylistDescription(playlistId, description) {
  try {
    await call(`/playlist/${playlistId}`, { auth: true, method: 'POST', params: { description } });
  } catch { /* cosmetic - never fail a copy over the description */ }
}
