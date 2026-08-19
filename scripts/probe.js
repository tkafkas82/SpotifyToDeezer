/*
 * Match quality check without Spotify.
 *
 * Feeds a list of tracks straight through the matcher and prints the verdicts, so
 * scoring changes can be judged against real Deezer answers before touching a
 * playlist. Handy when there are no Spotify credentials to hand.
 *
 *   node scripts/probe.js                     # built-in sample
 *   node scripts/probe.js tracks.txt          # one "Artist - Title" per line
 *   node scripts/probe.js tracks.json         # [{title, artists, durationMs, isrc}]
 */
import fs from 'fs/promises';
import { convertPlaylist } from '../lib/convert.js';
import { cache, flush } from '../lib/store.js';

const SAMPLE = [
  { title: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'], durationMs: 354_320, isrc: 'GBUM71029604' },
  { title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200_040, isrc: 'USUG11904206' },
  { title: 'Sunflower - Spider-Man: Into the Spider-Verse', artists: ['Post Malone', 'Swae Lee'], durationMs: 158_040, isrc: 'USUM71814888' },
  // durationMs 0 = unknown, which is how a hand-written list arrives; the real
  // thing always carries Spotify's duration and scores higher for it.
  { title: 'Δύναται', artists: ['Ελευθερία Αρβανιτάκη'], durationMs: 0, isrc: null },
  { title: 'Ζήσε τη ζωή', artists: ['Σάκης Ρουβάς'], durationMs: 0, isrc: null },
  { title: 'Hotel California - 2013 Remaster', artists: ['Eagles'], durationMs: 391_000, isrc: null },
  { title: 'A Track Nobody Ever Recorded 12345', artists: ['Nobody Whatsoever'], durationMs: 180_000, isrc: null },
];

async function load(file) {
  if (!file) return SAMPLE;
  const raw = await fs.readFile(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(raw);
  return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [artist, ...rest] = line.split(' - ');
    return { title: rest.join(' - ') || artist, artists: rest.length ? [artist] : [], durationMs: 0, isrc: null };
  });
}

const tracks = await load(process.argv[2]);
const rows = [];

const counts = await convertPlaylist({
  tracks,
  cache,
  send: (event, data) => { if (event === 'track') rows.push(data); },
});

rows.sort((a, b) => a.index - b.index);
for (const r of rows) {
  const got = r.best ? `${r.best.title} / ${r.best.artists.join(', ')}${r.best.readable ? '' : ' [blocked here]'}` : '-';
  console.log(
    String(r.spotify.label).slice(0, 44).padEnd(46),
    r.status.padEnd(8),
    (r.method || '-').padEnd(7),
    String(r.best?.score ?? '').padStart(3),
    ' ', got,
  );
}
console.log('\n', counts, `- cache holds ${cache.size} lookups`);
await flush();
