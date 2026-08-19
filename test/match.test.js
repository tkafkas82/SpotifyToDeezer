import test from 'node:test';
import assert from 'node:assert/strict';
import { titleKey, artistScore, artistKeys, normalize, latinKey } from '../lib/normalize.js';
import { score, versionTags, plainQuery, AUTO, REVIEW } from '../lib/match.js';

const sp = (title, artists, durationMs = 200_000) => ({ title, artists, durationMs });
const dz = (title, artists, durationMs = 200_000, extra = {}) => ({
  title, titleShort: title, artists, durationMs, readable: true, ...extra,
});
const bag = (...names) => names.map(normalize);

test('decoration is stripped, identity is not', () => {
  assert.equal(titleKey('Bohemian Rhapsody - Remastered 2011'), 'bohemian rhapsody');
  assert.equal(titleKey('Hotel California (2013 Remaster)'), 'hotel california');
  assert.equal(titleKey('Sunflower (feat. Swae Lee)'), 'sunflower');
  // Live and remix versions are different recordings - they must survive.
  assert.equal(titleKey('Song - Live at Wembley'), 'song live at wembley');
  assert.equal(titleKey('Song (Kygo Remix)'), 'song kygo remix');
});

test('accents, ampersands, smart quotes and a leading "the" normalise away', () => {
  assert.equal(normalize('Beyonce'), normalize('Beyoncé'));
  assert.equal(normalize('Simon & Garfunkel'), 'simon and garfunkel');
  assert.equal(normalize('Don’t Stop'), normalize("Don't Stop"));
  assert.equal(normalize('The Weeknd'), normalize('Weeknd'));
});

test('non-Latin titles survive normalisation', () => {
  // The whole point: a Greek title must not normalise down to an empty string.
  assert.equal(normalize('Ζήσε τη ζωή'), 'ζησε τη ζωη');
  assert.ok(normalize('Москва').length > 0);
});

test('Greek transliteration lines up with romanised Deezer metadata', () => {
  assert.equal(latinKey('Ελευθερία Αρβανιτάκη'), 'eleftheria arvanitaki');
  assert.equal(latinKey('Γιάννης Πάριος'), 'giannis parios');
  assert.ok(artistScore(bag('Ελευθερία Αρβανιτάκη'), bag('Eleftheria Arvanitaki')) > 0.95);
});

test('featured artists move from the title into the artist bag', () => {
  assert.deepEqual(artistKeys(['Post Malone'], 'Sunflower (feat. Swae Lee)'), ['post malone', 'swae lee']);
});

test('artist matching tolerates extra credits', () => {
  assert.equal(artistScore(bag('The Weeknd'), bag('The Weeknd', 'Daft Punk')), 1);
  assert.equal(artistScore(bag('The Weeknd'), bag('Weeknd')), 1);
  assert.equal(artistScore(bag('Jay-Z'), bag('Beyonce and Jay Z')), 1);
  assert.ok(artistScore(bag('Post Malone'), bag('Swae Lee')) < 0.4);
});

test('version markers are compared, not ignored', () => {
  assert.equal(versionTags('Song (Live at Wembley)'), 'live');
  assert.equal(versionTags('Song'), '');
  assert.equal(versionTags('Song - Remastered'), '');
});

test('the search query drops decoration and featured artists', () => {
  assert.equal(plainQuery(sp('Bohemian Rhapsody - Remastered 2011', ['Queen'])), 'Queen Bohemian Rhapsody');
  assert.equal(plainQuery(sp('Sunflower (feat. Swae Lee)', ['Post Malone'])), 'Post Malone Sunflower');
});

test('an identical recording scores as an automatic match', () => {
  const s = score(sp('Blinding Lights', ['The Weeknd'], 200_040), dz('Blinding Lights', ['The Weeknd'], 200_000));
  assert.ok(s >= AUTO, `expected >= ${AUTO}, got ${s}`);
});

test('a remaster tag does not cost the match', () => {
  const s = score(
    sp('Bohemian Rhapsody - Remastered 2011', ['Queen'], 354_000),
    dz('Bohemian Rhapsody', ['Queen'], 355_000),
  );
  assert.ok(s >= AUTO, `expected >= ${AUTO}, got ${s}`);
});

test('a live recording hidden behind title_short is not an automatic match', () => {
  // Deezer shortens "Bohemian Rhapsody (Live At Wembley Stadium)" to the plain
  // title, so title and duration alone rate this a perfect hit.
  const s = score(
    sp('Bohemian Rhapsody - Remastered 2011', ['Queen'], 354_000),
    { ...dz('Bohemian Rhapsody (Live At Wembley Stadium / July 1986)', ['Queen'], 351_000), titleShort: 'Bohemian Rhapsody' },
  );
  assert.ok(s < AUTO, `expected < ${AUTO}, got ${s}`);
});

test('a tribute band is not an automatic match', () => {
  const s = score(sp('Bohemian Rhapsody', ['Queen'], 354_000), dz('Bohemian Rhapsody', ['Queen Machine'], 355_000));
  assert.ok(s < AUTO, `expected < ${AUTO}, got ${s}`);
});

test('a different song by the same artist is not an automatic match', () => {
  const s = score(sp('Sorry', ['Justin Bieber'], 200_000), dz('Sorry Not Sorry', ['Justin Bieber'], 203_000));
  assert.ok(s < AUTO, `expected < ${AUTO}, got ${s}`);
});

test('a karaoke lookalike by another artist is rejected outright', () => {
  const s = score(sp('Blinding Lights', ['The Weeknd'], 200_000), dz('Blinding Lights', ['Karaoke Kings'], 199_000));
  assert.ok(s < REVIEW, `expected < ${REVIEW}, got ${s}`);
});

test('a wildly different duration drops a same-title match below auto', () => {
  const s = score(sp('Intro', ['Some Band'], 45_000), dz('Intro', ['Some Band'], 300_000));
  assert.ok(s < AUTO, `expected < ${AUTO}, got ${s}`);
});

test('an unavailable track is never auto-selected', () => {
  const s = score(
    sp('Blinding Lights', ['The Weeknd']),
    dz('Blinding Lights', ['The Weeknd'], 200_000, { readable: false }),
  );
  assert.ok(s < AUTO, `expected < ${AUTO}, got ${s}`);
});
