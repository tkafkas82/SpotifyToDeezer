/*
 * Walking a playlist through the matcher.
 *
 * Split out of server.js so the fan-out has a seam to test against: `match` is
 * injectable, which is the difference between testing the ordering/counting
 * logic offline and only ever exercising it against the live Deezer API.
 *
 * Results are emitted with their playlist index rather than in order - several
 * tracks are in flight at once and the UI slots them into place - and a failed
 * lookup counts as "missing" rather than aborting the run: one dead track must
 * not cost the other 499.
 */
import { matchTrack, label, plainQuery } from './match.js';

export const CONCURRENCY = 6;

export async function convertPlaylist({
  tracks,
  send,
  isClosed = () => false,
  concurrency = CONCURRENCY,
  match = matchTrack,
  cache,
}) {
  const counts = { matched: 0, review: 0, missing: 0, skipped: 0 };
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (!isClosed()) {
      const index = next++;
      if (index >= tracks.length) return;
      const sp = tracks[index];
      const payload = { index, spotify: { ...sp, label: label(sp), query: plainQuery(sp) } };

      if (sp.local) {
        // A local file has no catalogue identity to look up.
        counts.skipped++;
        send('track', { ...payload, status: 'skipped', reason: 'local file', best: null, candidates: [] });
      } else {
        try {
          const m = await match(sp, { cache });
          counts[m.status] = (counts[m.status] || 0) + 1;
          send('track', { ...payload, ...m });
        } catch (err) {
          counts.missing++;
          send('track', { ...payload, status: 'missing', error: err.message, best: null, candidates: [] });
        }
      }
      send('progress', { done: ++done, total: tracks.length });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tracks.length)) }, worker));
  return counts;
}
