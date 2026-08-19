/*
 * Spotify side: read-only, client-credentials.
 *
 * We never act on behalf of a Spotify user, so an app token is enough - which
 * is why nothing here needs a browser round-trip. The trade-off is that only
 * public playlists are visible, and Spotify's own algorithmic/editorial
 * playlists (Discover Weekly, Release Radar, most "Made for you" mixes) answer
 * 404 to app tokens no matter how public they look.
 */
import { fetchJson, HttpError, makeLimiter } from './http.js';

const API = 'https://api.spotify.com/v1';
const limit = makeLimiter({ max: 20, windowMs: 1000, concurrency: 4 });

let token = null;          // { value, expiresAt }

export function configured() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

/** Accepts a share URL, a spotify: URI, or a bare id. */
export function parsePlaylistId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = s.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{16,}$/.test(s)) return s;
  return null;
}

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 30_000) return token.value;
  if (!configured()) throw new HttpError(500, 'Spotify credentials are missing - fill SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env');
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, { label: 'Spotify token' });
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}

async function api(path) {
  const t = await accessToken();
  return limit(() => fetchJson(path.startsWith('http') ? path : API + path, {
    headers: { Authorization: `Bearer ${t}` },
  }, { label: 'Spotify' }));
}

/**
 * Playlist header + every track, following pagination to the end.
 * onProgress({ loaded, total }) fires per page so a 900-track playlist can
 * report movement instead of looking hung.
 */
export async function getPlaylist(id, onProgress) {
  let head;
  try {
    head = await api(`/playlists/${id}?fields=id,name,description,external_urls,images,owner(display_name),tracks(total)`);
  } catch (err) {
    if (err.status === 404) {
      throw new HttpError(404, 'Spotify returned 404. The playlist is private, deleted, or one of Spotify\'s own algorithmic playlists (those are invisible to app tokens).');
    }
    throw err;
  }

  const tracks = [];
  const fields = 'items(is_local,track(id,name,duration_ms,type,external_ids(isrc),external_urls(spotify),artists(name),album(name))),next,total';
  let url = `${API}/playlists/${id}/tracks?limit=100&offset=0&fields=${encodeURIComponent(fields)}`;
  const total = head.tracks?.total || 0;

  while (url) {
    const page = await api(url);
    for (const item of page.items || []) {
      const t = item?.track;
      if (!t || t.type === 'episode') continue;      // removed tracks and podcasts
      tracks.push({
        id: t.id || null,
        local: Boolean(item.is_local),
        title: t.name || '',
        artists: (t.artists || []).map(a => a.name).filter(Boolean),
        album: t.album?.name || '',
        durationMs: t.duration_ms || 0,
        isrc: t.external_ids?.isrc || null,
        url: t.external_urls?.spotify || null,
      });
    }
    onProgress?.({ loaded: tracks.length, total });
    url = page.next;
  }

  return {
    id: head.id,
    name: head.name || 'Spotify playlist',
    description: head.description || '',
    owner: head.owner?.display_name || '',
    image: head.images?.[0]?.url || null,
    url: head.external_urls?.spotify || `https://open.spotify.com/playlist/${id}`,
    total,
    tracks,
  };
}
