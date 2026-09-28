/*
 * Growing a Deezer playlist with songs like the ones already in it.
 *
 * Deezer has no "recommend for this playlist" call, public or otherwise, but its
 * gateway answers Track Mix - the ~80 songs its own "Mix" button plays after a
 * given song - for any song, even to a logged-out session. So a playlist is its
 * own query: every song in it (up to SEED_LIMIT of them) asks for its mix, and a
 * candidate that several of the playlist's songs lead to is a far better bet
 * than one that a single song's mix happens to open with.
 *
 * Ranking, in order: how many seeds suggested it, then how early in those mixes
 * it came. Tracks already in the playlist are dropped - including other versions
 * of them, which a mix is full of (the edit, the live take, the remaster) - and no
 * artist gets more than a couple of slots, because the mix of any song leans hard
 * on that song's own artist and a playlist does not want ten of them in a row.
 *
 * `suggest` takes its mix lookup as a parameter, so the ranking is tested offline.
 */
import { HttpError } from './http.js';
import { titleKey, artistKeys } from './normalize.js';

export const SEED_LIMIT = 25;
const CONCURRENCY = 5;
const MAX_TRACKS = 2000;
const API = 'https://api.deezer.com';
const COVER = md5 => (md5 ? `https://e-cdns-images.dzcdn.net/images/cover/${md5}/56x56-000000-80-0-0.jpg` : null);

// Share links from the apps are redirects; only these hosts are followed, so a
// pasted link cannot make the server fetch an arbitrary address.
const SHORT_LINK_HOSTS = new Set(['link.deezer.com', 'deezer.page.link']);

/** The playlist id in a Deezer link (or a bare id), or null. */
export function parsePlaylistId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d+)/i.exec(s);
  return m ? m[1] : null;
}

/** Same, following a short share link first. */
export async function resolvePlaylistId(input) {
  const direct = parsePlaylistId(input);
  if (direct) return direct;
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !SHORT_LINK_HOSTS.has(url.host.toLowerCase())) return null;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return res ? parsePlaylistId(res.url) : null;
}

/** One shape for a track, whether it came from the public API or the gateway. */
export function fromGw(s) {
  const artists = (s.ARTISTS?.length ? s.ARTISTS.map(a => a.ART_NAME) : [s.ART_NAME]).filter(Boolean);
  const title = [s.SNG_TITLE, s.VERSION].filter(Boolean).join(' ').trim();
  return {
    id: String(s.SNG_ID),
    title,
    artists,
    durationMs: Number(s.DURATION || 0) * 1000,
    link: `https://www.deezer.com/track/${s.SNG_ID}`,
    cover: COVER(s.ALB_PICTURE),
    preview: (s.MEDIA || []).find(m => m.TYPE === 'preview')?.HREF || null,
  };
}

function fromApi(t) {
  return {
    id: String(t.id),
    title: t.title,
    artists: [t.artist?.name].filter(Boolean),
    durationMs: Number(t.duration || 0) * 1000,
    link: t.link || `https://www.deezer.com/track/${t.id}`,
    cover: t.album?.cover_small || null,
    preview: t.preview || null,
  };
}

async function apiGet(pathname) {
  const body = await fetch(`${API}${pathname}`, { signal: AbortSignal.timeout(15_000) })
    .then(r => r.json())
    .catch(err => { throw new HttpError(502, `Deezer did not answer (${err.message})`); });
  return body;
}

/**
 * Title and tracks of a playlist. The public API reads any public playlist with
 * no session at all; a private one needs the owner's own session, which `gw` is
 * when the user has connected Deezer with a cookie.
 */
export async function readPlaylist(id, { gw = null } = {}) {
  const head = await apiGet(`/playlist/${id}`);
  if (!head?.error) {
    const tracks = (head.tracks?.data || []).map(fromApi);
    // The first page rides along with the playlist; the rest is paged.
    for (let index = tracks.length; index < Math.min(head.nb_tracks || 0, MAX_TRACKS); index += 100) {
      const page = await apiGet(`/playlist/${id}/tracks?index=${index}&limit=100`);
      const data = page?.data || [];
      tracks.push(...data.map(fromApi));
      if (data.length < 100) break;
    }
    return {
      id: String(id),
      title: head.title,
      link: head.link || `https://www.deezer.com/playlist/${id}`,
      picture: head.picture_small || null,
      creator: head.creator?.name || null,
      tracks,
    };
  }

  if (!gw) {
    throw new HttpError(404, 'Deezer will not show that playlist - it is private, or the link is wrong. '
      + 'For a private playlist of your own, connect Deezer with your cookie first.');
  }
  const page = await gw.call('deezer.pagePlaylist', {
    playlist_id: String(id), nb: MAX_TRACKS, start: 0, lang: 'en', tab: 0, tags: true, header: true,
  });
  const data = page?.DATA;
  if (!data) throw new HttpError(404, 'Deezer has no playlist with that id');
  return {
    id: String(id),
    title: data.TITLE,
    link: `https://www.deezer.com/playlist/${id}`,
    picture: data.PLAYLIST_PICTURE
      ? `https://e-cdns-images.dzcdn.net/images/playlist/${data.PLAYLIST_PICTURE}/56x56-000000-80-0-0.jpg`
      : null,
    creator: data.PARENT_USERNAME || null,
    tracks: (page.SONGS?.data || []).map(fromGw),
  };
}

/** Deezer's Track Mix for one song, as tracks. */
export async function trackMix(gw, songId) {
  const res = await gw.call('song.getSearchTrackMix', { sng_id: String(songId), start_with_input_track: false });
  return (res?.data || []).map(fromGw);
}

/**
 * A "same song" key: other versions of one recording collapse onto it. Looser on
 * purpose than the matcher, which must tell an edit from the album cut - here
 * "(Edit)", "[Live]" or "- Remastered 2020" are all just the song again.
 */
const songKey = t => {
  const bare = t.title.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '');
  return `${titleKey(bare || t.title)}|${artistKeys(t.artists, t.title)[0] || ''}`;
};

/** Up to `limit` seeds spread over the whole playlist, not just its first page. */
export function pickSeeds(tracks, limit = SEED_LIMIT) {
  if (tracks.length <= limit) return [...tracks];
  const step = tracks.length / limit;
  return Array.from({ length: limit }, (_, i) => tracks[Math.floor(i * step)]);
}

/**
 * @param {object} o
 * @param {Array} o.tracks   what is in the playlist now
 * @param {number} o.count   how many suggestions to return
 * @param {Function} o.mix   seed track -> Promise<track[]>
 * @param {Array} [o.exclude] tracks already offered ({ id, title, artists }), or bare ids
 */
export async function suggest({ tracks, count, mix, exclude = [], seedLimit = SEED_LIMIT }) {
  if (!tracks.length) throw new HttpError(400, 'That playlist is empty - there is nothing to base suggestions on.');

  // An earlier batch counts as "have" too, versions and all: after "Zakrini", the
  // next batch should not open with "Zakrini (Instrumental)".
  const shown = exclude.filter(x => x && typeof x === 'object' && x.title && Array.isArray(x.artists));
  const haveIds = new Set([...tracks.map(t => t.id), ...exclude.map(x => String(x?.id ?? x))]);
  const haveSongs = new Set([...tracks, ...shown].map(songKey));
  const seeds = pickSeeds(tracks, seedLimit);

  const pool = new Map();   // songKey -> candidate
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < seeds.length) {
      const seed = seeds[next++];
      let list;
      try {
        list = await mix(seed);
      } catch {
        failed++;
        continue;
      }
      const seen = new Set();   // a mix repeats songs; each seed votes once per song
      list.forEach((t, i) => {
        if (haveIds.has(t.id)) return;
        const key = songKey(t);
        if (haveSongs.has(key) || seen.has(key)) return;
        seen.add(key);
        const c = pool.get(key) || { track: t, hits: 0, weight: 0, from: [] };
        c.hits++;
        c.weight += 1 - i / Math.max(list.length, 1);
        c.from.push({ i, label: `${seed.artists[0] || ''} - ${seed.title}` });
        pool.set(key, c);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, seeds.length) }, worker));

  if (failed === seeds.length) throw new HttpError(502, 'Deezer did not answer for any of the songs in that playlist - try again in a minute.');

  const ranked = [...pool.values()].sort((a, b) => b.hits - a.hits || b.weight - a.weight);

  // A couple of songs per artist; relaxed only if that leaves the list short.
  const perArtist = count > 30 ? 3 : 2;
  const picked = [];
  const perArtistCount = new Map();
  const leftovers = [];
  for (const c of ranked) {
    if (picked.length >= count) break;
    const artist = artistKeys(c.track.artists)[0] || '';
    const n = perArtistCount.get(artist) || 0;
    if (n >= perArtist) { leftovers.push(c); continue; }
    perArtistCount.set(artist, n + 1);
    picked.push(c);
  }
  for (const c of leftovers) {
    if (picked.length >= count) break;
    picked.push(c);
  }

  return {
    seeds: seeds.length,
    failedSeeds: failed,
    // The seeds whose mixes it came earliest in are the ones it is most like.
    suggestions: picked.map(c => ({
      ...c.track,
      hits: c.hits,
      because: c.from.sort((a, b) => a.i - b.i).slice(0, 2).map(f => f.label),
    })),
  };
}
