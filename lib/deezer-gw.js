/*
 * Deezer without an API key: the same endpoint the Deezer website calls.
 *
 * `gw-light.php` is Deezer's own internal gateway. It authenticates with the
 * ordinary web-session cookie plus a CSRF token (`checkForm`) rather than an
 * OAuth app, which is exactly what makes a key-free copy possible - you log into
 * Deezer as yourself and the writes ride that session.
 *
 * The method names here are the real ones: called without a session they answer
 * NEED_USER_AUTH_REQUIRED, while an invented name answers GATEWAY_ERROR.
 *
 * Two ways in, same call shape:
 *   - `cookieTransport(arl)`        plain Node fetch with the `arl` cookie pasted in.
 *   - `browserTransport(getRequest)` calls carried by the logged-in browser profile's
 *     cookie jar, so the cookies never have to be extracted - and no tab is used.
 *
 * Being undocumented, this can change without notice. The registered-app path in
 * lib/deezer.js is the stable one; this is the no-setup one.
 */
import { HttpError } from './http.js';

const BASE = 'https://www.deezer.com/ajax/gw-light.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const url = (method, token) =>
  `${BASE}?method=${method}&input=3&api_version=1.0&api_token=${encodeURIComponent(token || '')}`;

/** Transport over the pasted `arl` cookie. Keeps the session cookies Deezer sets. */
export function cookieTransport(arl) {
  let jar = `arl=${arl}`;
  return async (method, token, payload) => {
    const res = await fetch(url(method, token), {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'text/plain;charset=UTF-8',
        Cookie: jar,
      },
      body: JSON.stringify(payload ?? {}),
    });
    const extra = (res.headers.getSetCookie?.() || [])
      .map(c => c.split(';')[0])
      .filter(c => !c.startsWith('arl='));
    if (extra.length) jar = [`arl=${arl}`, ...extra].join('; ');
    return res.json();
  };
}

/**
 * Transport over the logged-in browser profile's cookie jar, with no tab involved.
 *
 * `getRequest` hands back Playwright's request helper for the persistent context,
 * so these calls carry the same session cookies as the browser without touching -
 * or opening - a single page. An earlier version ran the fetch inside a Deezer tab,
 * which broke the login itself: as soon as the tab navigated to an SSO provider,
 * every status check spawned a new tab on top of the login in progress.
 */
export function browserTransport(getRequest) {
  return async (method, token, payload) => {
    const request = await getRequest();
    const res = await request.post(url(method, token), {
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      data: JSON.stringify(payload ?? {}),
      timeout: 30_000,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, `Deezer answered with something that is not JSON: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  };
}

export class GwClient {
  constructor(transport) {
    this.transport = transport;
    this.token = null;
    this.userInfo = null;
  }

  /** Fetches (and caches) the CSRF token plus who the session belongs to. */
  async refresh() {
    const body = await this.transport('deezer.getUserData', '', {});
    const r = body?.results;
    if (!r?.checkForm) throw new HttpError(502, 'Deezer did not hand out a session token');
    this.token = r.checkForm;
    const id = Number(r.USER?.USER_ID || 0);
    this.userInfo = id
      ? {
        id,
        name: r.USER.BLOG_NAME || r.USER.FIRSTNAME || `user ${id}`,
        country: r.COUNTRY || null,
        picture: r.USER.USER_PICTURE
          ? `https://e-cdns-images.dzcdn.net/images/user/${r.USER.USER_PICTURE}/56x56-000000-80-0-0.jpg`
          : null,
        link: `https://www.deezer.com/profile/${id}`,
      }
      : null;
    return this.userInfo;
  }

  async user() {
    if (!this.token) await this.refresh();
    return this.userInfo;
  }

  async requireUser() {
    const user = await this.user();
    if (!user) throw new HttpError(401, 'That browser session is not logged into Deezer yet.');
    return user;
  }

  async call(method, payload, { retried = false } = {}) {
    if (!this.token) await this.refresh();
    const body = await this.transport(method, this.token, payload);
    const err = body?.error;
    const problems = Array.isArray(err) ? [] : Object.keys(err || {});
    if (!problems.length) return body.results;

    // A stale CSRF token is the common case after the process has been up a while.
    if (!retried && problems.some(p => /TOKEN|CSRF/i.test(p))) {
      await this.refresh();
      return this.call(method, payload, { retried: true });
    }
    if (problems.includes('NEED_USER_AUTH_REQUIRED')) {
      throw new HttpError(401, 'Deezer wants a logged-in session for that - connect Deezer first.');
    }
    throw new HttpError(502, `Deezer: ${problems.map(p => `${p}: ${err[p]}`).join('; ')}`);
  }

  async createPlaylist(title, description = '') {
    await this.requireUser();
    const id = await this.call('playlist.create', { title, description, songs: [] });
    const playlistId = typeof id === 'object' ? id?.PLAYLIST_ID || id?.id : id;
    if (!playlistId) throw new HttpError(502, 'Deezer did not return a playlist id');
    return { id: String(playlistId), link: `https://www.deezer.com/playlist/${playlistId}` };
  }

  /**
   * `songs` is a list of [trackId, 0] pairs - the second element is not a
   * position, and `offset` is what decides where the batch lands: -1 puts it at
   * the end, while 0 pushes it in *front* of everything already there, which is
   * what made an append look like the playlist had been replaced. Some builds
   * reject the field outright; omitting it also appends.
   *
   * Deezer refuses a whole batch when a single one of its tracks is already in
   * the playlist (ERROR_DATA_EXISTS), so that case drops the ones it already has
   * and sends the rest.
   */
  async addSongs(playlistId, trackIds) {
    await this.requireUser();
    const ids = [...new Set(trackIds.map(String))];
    if (!ids.length) return 0;

    const send = (list, withOffset) => this.call('playlist.addSongs', {
      playlist_id: String(playlistId),
      songs: list.map(id => [id, 0]),
      ...(withOffset ? { offset: -1 } : {}),
    });

    try {
      await send(ids, true);
      return ids.length;
    } catch (err) {
      if (err.status !== 502) throw err;
      if (/DATA_EXISTS/i.test(err.message)) {
        const have = await this.playlistTrackIds(playlistId);
        const rest = ids.filter(id => !have.has(id));
        if (!rest.length) return 0;
        await send(rest, true);
        return rest.length;
      }
      await send(ids, false);
      return ids.length;
    }
  }

  /**
   * Drops tracks from a playlist - what the "replace the contents" mode is built
   * from. The [id, 0] pair shape matters here: a flat list of ids is accepted
   * with `true` and removes nothing at all.
   */
  async removeSongs(playlistId, trackIds) {
    await this.requireUser();
    const ids = [...new Set(trackIds.map(String))];
    if (!ids.length) return 0;
    await this.call('playlist.deleteSongs', {
      playlist_id: String(playlistId),
      songs: ids.map(id => [id, 0]),
    });
    return ids.length;
  }

  async playlistTrackIds(playlistId) {
    const ids = new Set();
    for (let start = 0; start < 5000; start += 500) {
      const page = await this.call('playlist.getSongs', { playlist_id: String(playlistId), nb: 500, start });
      const data = page?.data || [];
      data.forEach(t => ids.add(String(t.SNG_ID)));
      if (data.length < 500) break;
    }
    return ids;
  }

  /**
   * The user's own playlists. Read through the *public* API rather than the
   * gateway: it is documented, needs no token, and the profile id is all it takes.
   */
  async myPlaylists() {
    const user = await this.requireUser();
    const body = await fetch(`https://api.deezer.com/user/${user.id}/playlists?limit=100`, {
      headers: { 'User-Agent': UA },
    }).then(r => r.json());
    return (body?.data || [])
      .filter(p => !p.is_loved_track && String(p.creator?.id ?? user.id) === String(user.id))
      .map(p => ({
        id: String(p.id),
        title: p.title,
        nbTracks: p.nb_tracks,
        link: p.link,
        picture: p.picture_small || null,
        public: p.public,
      }));
  }
}
