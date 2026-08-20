/*
 * Deezer side: search (anonymous) + playlist writes (OAuth).
 *
 * Two Deezer quirks drive the shape of this file:
 *   1. Errors arrive as HTTP 200 with an {error:{code,message}} body, so every
 *      response has to be inspected rather than trusted.
 *   2. The quota is ~50 requests / 5 seconds per app, and blowing it returns
 *      error code 4 rather than a 429 - which is why `call` retries that code
 *      specifically after a pause.
 *
 * The searching half is anonymous and stays module-level - it is shared by every
 * signed-in user and by the matcher. The writing half is a `DeezerApi` instance
 * built around one person's access token, because with Google sign-in in front
 * there is no longer any such thing as "the" connected Deezer account: the token
 * is handed in by the caller (server.js, out of lib/users.js) rather than read
 * from a file this module owns.
 */
import { fetchJson, HttpError, makeLimiter } from './http.js';
import { baseUrl } from './session.js';

const API = 'https://api.deezer.com';
const CONNECT = 'https://connect.deezer.com/oauth';

// The documented quota is ~50 requests / 5 s, but a burst of *searches* gets an
// "Access Denied" HTML page from Deezer's edge well before that, so this sits
// deliberately below it. The disk cache is what keeps runs fast, not the rate.
const limit = makeLimiter({ max: 22, windowMs: 5000, concurrency: 4 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function configured() {
  return Boolean(process.env.DEEZER_APP_ID && process.env.DEEZER_APP_SECRET);
}

export function redirectUri(port) {
  return process.env.DEEZER_REDIRECT_URI || `${baseUrl(port)}/api/deezer/callback`;
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

/**
 * Turns the callback code into a session record: `{ accessToken, expiresAt, user }`.
 * Storing it is the caller's business - one Deezer account per signed-in person.
 */
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
  const accessToken = body.access_token;
  const me = await call('/user/me', { token: accessToken });
  return {
    accessToken,
    expiresAt: expires > 0 ? Date.now() + expires * 1000 : null,
    user: {
      id: me.id,
      name: me.name,
      link: me.link,
      picture: me.picture_small || null,
      country: me.country || null,
    },
  };
}

// --- API calls -----------------------------------------------------------

async function call(pathname, { token = null, method = 'GET', params = {} } = {}) {
  const q = new URLSearchParams(params);
  if (token) q.set('access_token', token);
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

/**
 * One person's authenticated Deezer, over a registered app.
 *
 * `onExpired` is called when Deezer stops accepting the token, so the caller can
 * drop the stored session instead of leaving a dead connection on screen.
 */
export class DeezerApi {
  constructor(session, { onExpired = null } = {}) {
    this.session = session;
    this.onExpired = onExpired;
  }

  get user() {
    return this.session?.user || null;
  }

  token() {
    const s = this.session;
    if (!s?.accessToken) throw new HttpError(401, 'Not connected to Deezer - use "Connect Deezer" first.');
    if (s.expiresAt && s.expiresAt <= Date.now()) {
      this.onExpired?.();
      throw new HttpError(401, 'The Deezer session expired - connect again.');
    }
    return s.accessToken;
  }

  async call(pathname, opts = {}) {
    try {
      return await call(pathname, { ...opts, token: this.token() });
    } catch (err) {
      if (err.status === 401) this.onExpired?.();
      throw err;
    }
  }

  async myPlaylists() {
    const me = this.user;
    const body = await this.call('/user/me/playlists', { params: { limit: '100' } });
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

  async createPlaylist(title) {
    const body = await this.call('/user/me/playlists', { method: 'POST', params: { title } });
    if (!body?.id) throw new HttpError(502, 'Deezer did not return a playlist id');
    return { id: body.id, link: `https://www.deezer.com/playlist/${body.id}` };
  }

  /** Track ids already in a playlist, so a re-run appends instead of duplicating. */
  async playlistTrackIds(playlistId) {
    const ids = new Set();
    let pathname = `/playlist/${playlistId}/tracks`;
    let params = { limit: '100', index: '0' };
    for (let guard = 0; guard < 100; guard++) {
      const body = await this.call(pathname, { params });
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
  async addTracks(playlistId, trackIds, onProgress) {
    const ids = [...new Set(trackIds.map(String))];
    let added = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.call(`/playlist/${playlistId}/tracks`, { method: 'POST', params: { songs: chunk.join(',') } });
      added += chunk.length;
      onProgress?.({ added, total: ids.length });
    }
    return added;
  }

  /**
   * Removes tracks again - the other half of the "replace the contents" mode.
   * Same comma-separated `songs` list as the add, so the same chunk size applies.
   */
  async removeTracks(playlistId, trackIds) {
    const ids = [...new Set(trackIds.map(String))];
    let removed = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.call(`/playlist/${playlistId}/tracks`, { method: 'DELETE', params: { songs: chunk.join(',') } });
      removed += chunk.length;
    }
    return removed;
  }

  async setPlaylistDescription(playlistId, description) {
    try {
      await this.call(`/playlist/${playlistId}`, { method: 'POST', params: { description } });
    } catch { /* cosmetic - never fail a copy over the description */ }
  }
}
