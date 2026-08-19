/*
 * Matching one Spotify track to one Deezer track.
 *
 * Strategy, cheapest and most certain first:
 *   1. ISRC. Spotify hands out the recording's ISRC and Deezer can look one up
 *      directly, so this is identity, not a guess - right even when the two
 *      catalogues spell the title differently. It is only trusted when the hit is
 *      playable: Deezer often carries the same recording twice, and the ISRC can
 *      land on the copy whose licence is dead in this country.
 *   2. Field-scoped search (artist:"..." track:"...") on the decoration-stripped
 *      title, for the tracks with no ISRC or no ISRC hit.
 *   3. Plain free-text search, which is what saves the cases where Deezer files
 *      the track under a different primary artist.
 *   4. Transliterated search, for Greek (and other non-Latin) catalogues where
 *      Deezer's metadata is romanised and Spotify's is not, or vice versa.
 *
 * Every candidate is scored on title/artist/duration, and three gates keep the
 * confident tier honest - see `score`. Anything short of confident is handed to
 * the user rather than quietly written into their playlist.
 */
import {
  titleKey, artistKeys, normalize, latinKey, similarity, crossScriptSimilarity,
  artistScore, splitFeatured, stripDecoration,
} from './normalize.js';
import * as deezer from './deezer.js';

export const AUTO = 78;        // >= this: take it
export const REVIEW = 55;      // >= this: show it, let the user decide

// Markers that identify a *different recording* of the same song. If one side
// carries one and the other does not, the match is a candidate, never a certainty.
const VERSION = /\b(live|remix|acoustic|unplugged|instrumental|karaoke|demo|cover|reprise|extended|orchestral|symphonic|a ?cappella|sped ?up|slowed|edit|rework|dub|mixed)\b/gi;

export function versionTags(title) {
  const found = new Set(String(title || '').toLowerCase().match(VERSION) || []);
  return [...found].sort().join(',');
}

/** 0-100 confidence that `dz` is the same recording as `sp`. */
export function score(sp, dz) {
  const spTitle = titleKey(sp.title);
  const dzTitle = titleKey(dz.titleShort || dz.title);
  const title = Math.max(
    crossScriptSimilarity(spTitle, dzTitle),
    // Deezer's `title` often carries the "(feat. X)" that title_short drops.
    crossScriptSimilarity(spTitle, titleKey(dz.title)),
  );

  const artist = artistScore(artistKeys(sp.artists, sp.title), artistKeys(dz.artists, dz.title));

  const diff = Math.abs((sp.durationMs || 0) - (dz.durationMs || 0));
  const duration = !sp.durationMs || !dz.durationMs
    ? 0.6                                    // unknown on one side: neutral-ish
    : diff <= 2000 ? 1
    : Math.max(0, 1 - (diff - 2000) / 13_000);

  let total = title * 55 + artist * 30 + duration * 15;

  // A title that matches on every word is worth a nudge over near-misses like
  // "Sorry" vs "Sorry Not Sorry", which bigrams alone rate generously.
  if (spTitle && spTitle === dzTitle) total += 3;

  // Unavailable here: cap it below the auto threshold so a playable alternative
  // always outranks it and the user gets asked.
  if (!dz.readable) total = Math.min(total * 0.85, AUTO - 1);

  // Three gates, because a matching title on its own is not identity.
  //   - A different performer is the karaoke/tribute trap: Deezer search is full
  //     of "Blinding Lights" by nobody in particular.
  if (artist < 0.35) total *= 0.5;
  else if (artist < 0.7) total = Math.min(total, AUTO - 3);
  //   - A duration gulf means a different version - extended mix, edit, or a
  //     45-second skit sharing a name with a 5-minute song.
  if (sp.durationMs && dz.durationMs && diff > 20_000) total = Math.min(total, AUTO - 8);
  //   - A version marker on one side only. Deezer's title_short hides these
  //     ("Bohemian Rhapsody (Live At Wembley)" shortens to "Bohemian Rhapsody"),
  //     so without this check a live recording scores as a perfect match.
  if (versionTags(sp.title) !== versionTags(dz.title)) total = Math.min(total, AUTO - 3);

  return Math.max(0, Math.min(100, Math.round(total)));
}

/** The decoration-free "artist title" text this track searches best under. */
export function plainQuery(sp) {
  return `${sp.artists?.[0] || ''} ${stripDecoration(splitFeatured(sp.title).title).trim()}`.trim();
}

/** Search queries to try, in order, until something scores well enough. */
function queries(sp) {
  const title = stripDecoration(splitFeatured(sp.title).title).trim();
  const artist = sp.artists?.[0] || '';
  const clean = s => s.replace(/"/g, '');
  const out = [
    ['s', `artist:"${clean(artist)}" track:"${clean(title)}"`],
    ['f', `${artist} ${title}`.trim()],
  ];
  // Greek metadata is romanised on one side about as often as not, so try the
  // transliterated spelling both scoped and free-text before giving up.
  const la = latinKey(artist), lt = latinKey(title);
  if (`${la} ${lt}`.trim() !== normalize(`${artist} ${title}`)) {
    if (la && lt) out.push(['l', `artist:"${la}" track:"${lt}"`]);
    out.push(['l', `${la} ${lt}`.trim()]);
  }
  return out.filter(([, q]) => q.trim());
}

/**
 * Match a single Spotify track.
 * `cache` is any Map-like { has, get, set } - see lib/store.js for the persisted one.
 */
export async function matchTrack(sp, { cache } = {}) {
  const seen = new Map();      // deezer id -> scored candidate
  const consider = list => {
    for (const dz of list || []) {
      if (!dz?.id || seen.has(String(dz.id))) continue;
      seen.set(String(dz.id), { ...dz, score: score(sp, dz), via: dz.via });
    }
  };
  const best = () => [...seen.values()].sort((a, b) => b.score - a.score)[0] || null;

  const lookup = async (key, fn) => {
    if (cache?.has(key)) return cache.get(key);
    const value = await fn();
    cache?.set(key, value);
    return value;
  };

  if (sp.isrc) {
    const hit = await lookup(`isrc:${sp.isrc}`, () => deezer.trackByIsrc(sp.isrc));
    if (hit?.readable) {
      const exact = { ...hit, score: 100, via: 'isrc' };
      return { status: 'matched', method: 'isrc', best: exact, candidates: [exact] };
    }
    if (hit) consider([{ ...hit, via: 'isrc' }]);   // kept as a fallback candidate
  }

  for (const [tag, q] of queries(sp)) {
    const results = await lookup(`q:${tag}:${q}`, () => deezer.search(q, { limit: 8 }));
    consider((results || []).map(r => ({ ...r, via: tag === 's' ? 'search' : tag === 'l' ? 'latin' : 'text' })));
    if ((best()?.score || 0) >= AUTO) break;
  }

  const candidates = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  const top = candidates[0] || null;
  const status = !top ? 'missing' : top.score >= AUTO ? 'matched' : top.score >= REVIEW ? 'review' : 'missing';
  return { status, method: top?.via || null, best: top, candidates };
}

/** Human-readable "Artist - Title" for exports and logs. */
export function label(t) {
  return `${(t.artists || []).join(', ')} - ${t.title}`;
}

/** Exposed for tests: the normalized comparison keys used by the scorer. */
export const keys = { titleKey, artistKeys, normalize, similarity };
