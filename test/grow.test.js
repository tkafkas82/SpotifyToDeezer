import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest, pickSeeds, parsePlaylistId } from '../lib/grow.js';

const t = (id, title, artist) => ({ id: String(id), title, artists: [artist], durationMs: 200_000 });

test('a song several seeds lead to outranks one that opens a single mix', async () => {
  const tracks = [t(1, 'A', 'X'), t(2, 'B', 'Y'), t(3, 'C', 'Z')];
  const mixes = {
    1: [t(10, 'Lonely pick', 'P'), t(20, 'Shared', 'Q')],
    2: [t(20, 'Shared', 'Q')],
    3: [t(20, 'Shared', 'Q'), t(30, 'Other', 'R')],
  };
  const { suggestions } = await suggest({ tracks, count: 3, mix: s => mixes[s.id] });
  assert.equal(suggestions[0].id, '20');
  assert.equal(suggestions[0].hits, 3);
  assert.deepEqual(suggestions.map(s => s.id).sort(), ['10', '20', '30']);
});

test('what is already in the playlist - or another version of it - is never suggested', async () => {
  const tracks = [t(1, 'Bloodflow', 'Grandbrothers')];
  const mix = async () => [
    t(1, 'Bloodflow', 'Grandbrothers'),
    t(2, 'Bloodflow (Edit)', 'Grandbrothers'),
    t(3, 'Bloodflow - Remastered 2020', 'Grandbrothers'),
    t(4, 'Alone in Kyoto', 'Air'),
  ];
  const { suggestions } = await suggest({ tracks, count: 10, mix });
  assert.deepEqual(suggestions.map(s => s.id), ['4']);
});

test('another version of a song already offered stays out of the next round', async () => {
  const tracks = [t(1, 'A', 'X')];
  const mix = async () => [t(2, 'Zakrini (Instrumental)', 'Bachar Mar-Khalife'), t(3, 'C', 'Z')];
  const { suggestions } = await suggest({
    tracks, count: 10, mix, exclude: [t(9, 'Zakrini', 'Bachar Mar-Khalife')],
  });
  assert.deepEqual(suggestions.map(s => s.id), ['3']);
});

test('turned-down ids stay out on the next round', async () => {
  const tracks = [t(1, 'A', 'X')];
  const mix = async () => [t(2, 'B', 'Y'), t(3, 'C', 'Z')];
  const { suggestions } = await suggest({ tracks, count: 10, mix, exclude: ['2'] });
  assert.deepEqual(suggestions.map(s => s.id), ['3']);
});

test('one artist does not take over the list while others are available', async () => {
  const tracks = [t(1, 'Seed', 'S')];
  const mix = async () => [
    ...Array.from({ length: 6 }, (_, i) => t(100 + i, `Song ${i}`, 'Bonobo')),
    t(200, 'Other 1', 'Air'),
    t(201, 'Other 2', 'Moby'),
  ];
  const { suggestions } = await suggest({ tracks, count: 4, mix });
  assert.equal(suggestions.filter(s => s.artists[0] === 'Bonobo').length, 2);
  assert.equal(suggestions.length, 4);
});

test('the per-artist cap gives way rather than returning a short list', async () => {
  const tracks = [t(1, 'Seed', 'S')];
  const mix = async () => Array.from({ length: 6 }, (_, i) => t(100 + i, `Song ${i}`, 'Bonobo'));
  const { suggestions } = await suggest({ tracks, count: 5, mix });
  assert.equal(suggestions.length, 5);
});

test('a seed whose mix fails costs that seed only', async () => {
  const tracks = [t(1, 'A', 'X'), t(2, 'B', 'Y')];
  const mix = async s => { if (s.id === '1') throw new Error('boom'); return [t(3, 'C', 'Z')]; };
  const out = await suggest({ tracks, count: 5, mix });
  assert.equal(out.failedSeeds, 1);
  assert.deepEqual(out.suggestions.map(s => s.id), ['3']);
});

test('seeds are spread over a long playlist, not taken from its start', () => {
  const tracks = Array.from({ length: 100 }, (_, i) => t(i, `S${i}`, 'A'));
  const seeds = pickSeeds(tracks, 10);
  assert.equal(seeds.length, 10);
  assert.equal(seeds[0].id, '0');
  assert.equal(seeds[9].id, '90');
});

test('playlist ids are read out of the links people paste', () => {
  assert.equal(parsePlaylistId('https://www.deezer.com/en/playlist/15801470101'), '15801470101');
  assert.equal(parsePlaylistId('https://www.deezer.com/playlist/123?utm_source=x'), '123');
  assert.equal(parsePlaylistId('https://www.deezer.com/pt-br/playlist/9'), '9');
  assert.equal(parsePlaylistId('15801470101'), '15801470101');
  assert.equal(parsePlaylistId('https://www.deezer.com/en/album/302127'), null);
});
