import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPlaylist } from '../lib/convert.js';

const tracks = n => Array.from({ length: n }, (_, i) => ({
  title: `Song ${i}`, artists: ['Someone'], durationMs: 200_000,
}));

const collect = () => {
  const events = [];
  return { events, send: (event, data) => events.push({ event, data }) };
};

test('every track is reported exactly once, with its playlist index', async () => {
  const { events, send } = collect();
  const counts = await convertPlaylist({
    tracks: tracks(25),
    send,
    match: async sp => ({ status: 'matched', best: { id: sp.title, score: 100 }, candidates: [] }),
  });

  const seen = events.filter(e => e.event === 'track').map(e => e.data.index).sort((a, b) => a - b);
  assert.deepEqual(seen, [...Array(25).keys()]);
  assert.equal(counts.matched, 25);
  assert.equal(events.filter(e => e.event === 'progress').length, 25);
  // The last progress event has to close the bar, whatever order results landed in.
  assert.deepEqual(events.filter(e => e.event === 'progress').at(-1).data, { done: 25, total: 25 });
});

test('a failing lookup costs one track, not the run', async () => {
  const { events, send } = collect();
  const counts = await convertPlaylist({
    tracks: tracks(6),
    send,
    match: async sp => {
      if (sp.title === 'Song 3') throw new Error('Deezer said no');
      return { status: 'matched', best: { id: sp.title, score: 90 }, candidates: [] };
    },
  });

  assert.equal(counts.matched, 5);
  assert.equal(counts.missing, 1);
  const failed = events.find(e => e.event === 'track' && e.data.index === 3);
  assert.equal(failed.data.status, 'missing');
  assert.equal(failed.data.error, 'Deezer said no');
});

test('local files are skipped without a lookup', async () => {
  const { events, send } = collect();
  let lookups = 0;
  const list = tracks(3);
  list[1].local = true;
  const counts = await convertPlaylist({
    tracks: list,
    send,
    match: async () => { lookups++; return { status: 'matched', best: { id: 1, score: 100 }, candidates: [] }; },
  });

  assert.equal(lookups, 2);
  assert.equal(counts.skipped, 1);
  assert.equal(events.find(e => e.event === 'track' && e.data.index === 1).data.reason, 'local file');
});

test('a disconnected client stops the work instead of finishing it', async () => {
  const { events, send } = collect();
  let closed = false;
  await convertPlaylist({
    tracks: tracks(50),
    send,
    concurrency: 2,
    isClosed: () => closed,
    match: async sp => {
      if (sp.title === 'Song 5') closed = true;
      return { status: 'matched', best: { id: sp.title, score: 100 }, candidates: [] };
    },
  });

  const done = events.filter(e => e.event === 'track').length;
  assert.ok(done < 50, `expected an early stop, matched all ${done}`);
});

test('an empty playlist completes cleanly', async () => {
  const { events, send } = collect();
  const counts = await convertPlaylist({ tracks: [], send, match: async () => { throw new Error('never'); } });
  assert.deepEqual(counts, { matched: 0, review: 0, missing: 0, skipped: 0 });
  assert.equal(events.length, 0);
});
