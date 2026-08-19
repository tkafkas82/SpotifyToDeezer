/*
 * Title/artist normalisation.
 *
 * The two catalogues disagree constantly on decoration rather than identity:
 * "Bohemian Rhapsody - Remastered 2011" vs "Bohemian Rhapsody", "Song (feat. X)"
 * vs "Song", curly vs straight apostrophes, "&" vs "and". Everything below
 * strips decoration so the scorer compares the parts that actually identify a
 * recording, and pulls featured artists out of the title into the artist bag
 * (Spotify puts them in the title, Deezer usually in the artist list).
 *
 * Two things are deliberately preserved:
 *   - Version markers ("live", "remix", "acoustic"): those are different
 *     recordings, and treating them as noise is how a playlist asking for the
 *     live cut ends up with the studio one.
 *   - Non-Latin scripts. Greek, Cyrillic and the rest survive normalisation, and
 *     `latinKey` additionally transliterates Greek, because Deezer files Greek
 *     artists under both spellings ("Eleftheria Arvanitaki" and
 *     "Ελευθερία Αρβανιτάκη") while Spotify picks one.
 *
 * Source is ASCII-only apart from those tables - the interesting characters here
 * are combining marks and smart quotes, which do not survive a careless re-encode.
 */

// Parenthetical/suffix noise that never distinguishes one recording from another
// strongly enough to lose a match over.
const DECORATION = /\b(remaster(ed)?|re-?master|deluxe|expanded|edition|mono|stereo|album version|single version|original version|original mix|radio edit|radio version|bonus track|anniversary|reissue|explicit|clean|digital remaster|from ["'][^"']+["'])\b/i;

const FEAT = /\s*[([]?\s*\b(feat|ft|featuring|con|avec)\b\.?\s+([^)\]]+)[)\]]?/gi;

// Hyphen, non-breaking hyphen, figure dash, en dash, em dash.
const TAIL = /\s+[-‐‒–—]\s+([^-‐‒–—]+)$/;

// Words that join two artists rather than belong to one name.
const CONNECTOR = /\b(and|x|with|feat|ft|featuring|vs|versus|meets|presents|pres)\b/;

export function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Pull "feat. X, Y" out of a title. Returns { title, featured: [names] }. */
export function splitFeatured(title) {
  const featured = [];
  const cleaned = String(title || '').replace(FEAT, (_, __, names) => {
    names.split(/,|&|\band\b|\bx\b|\/|\+/i).forEach(n => {
      const t = n.trim();
      if (t) featured.push(t);
    });
    return ' ';
  });
  return { title: cleaned, featured };
}

/** Drop " - Remastered 2011" tails and "(Deluxe Edition)" chunks. */
export function stripDecoration(title) {
  let out = String(title || '');
  out = out.replace(TAIL, (m, tail) => (DECORATION.test(tail) ? '' : m));
  out = out.replace(/[([]([^)\]]*)[)\]]/g, (m, inner) => (DECORATION.test(inner) ? ' ' : m));
  return out;
}

/** Title/artist text reduced to comparable words, any script. */
export function normalize(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/ς/g, 'σ')                        // Greek final sigma
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/'/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^the /, '');                     // "The Beatles" === "Beatles"
}

// Digraphs first, then single letters. Not a standards-compliant transliteration
// (ELOT 743 has context rules this ignores) - it only has to land close enough
// for the similarity score, so "ευ" always becomes "ef" and never "ev".
const GREEK_DIGRAPHS = [
  ['ου', 'ou'], ['ευ', 'ef'], ['αυ', 'af'], ['αι', 'ai'], ['ει', 'ei'], ['οι', 'oi'],
  ['υι', 'yi'], ['μπ', 'b'], ['ντ', 'd'], ['γκ', 'g'], ['γγ', 'ng'], ['τσ', 'ts'], ['τζ', 'tz'],
];
const GREEK_LETTERS = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k',
  λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', τ: 't', υ: 'y',
  φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

/** Greek -> Latin, on already-normalized text. Leaves other scripts alone. */
export function greekToLatin(s) {
  let out = String(s || '');
  if (!/[Ͱ-Ͽ]/.test(out)) return out;
  for (const [from, to] of GREEK_DIGRAPHS) out = out.split(from).join(to);
  return [...out].map(ch => GREEK_LETTERS[ch] ?? ch).join('');
}

/** Canonical comparison form of a track title. */
export function titleKey(title) {
  const { title: noFeat } = splitFeatured(title);
  return normalize(stripDecoration(noFeat));
}

/** Same, transliterated - the form that bridges Greek and Latin spellings. */
export function latinKey(s) {
  return greekToLatin(normalize(s));
}

/** All artist names for a track, including any lifted out of the title. */
export function artistKeys(artists, title = '') {
  const { featured } = splitFeatured(title);
  return [...(artists || []), ...featured].map(normalize).filter(Boolean);
}

/**
 * Dice coefficient over character bigrams.
 *
 * Character bigrams rather than word bigrams because half the disagreements are
 * inside a word ("sunflower"/"sunflowers", "eleftheria"/"elefteria"), which a
 * word-level comparison scores as a flat zero.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = s => {
    const g = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
    return g.length ? g : [s];
  };
  const A = grams(a), B = grams(b);
  const pool = new Map();
  A.forEach(g => pool.set(g, (pool.get(g) || 0) + 1));
  let hits = 0;
  B.forEach(g => {
    const n = pool.get(g) || 0;
    if (n > 0) { hits++; pool.set(g, n - 1); }
  });
  return (2 * hits) / (A.length + B.length);
}

/** Compare two strings both as written and transliterated. */
export function crossScriptSimilarity(a, b) {
  const direct = similarity(a, b);
  const la = greekToLatin(a), lb = greekToLatin(b);
  return (la === a && lb === b) ? direct : Math.max(direct, similarity(la, lb));
}

/**
 * One credit line can hold several artists ("beyonce and jay z"); split it so a
 * single name still matches the whole. Deliberately *not* a substring test:
 * "queen" inside "queen machine" is a tribute band, not Queen.
 */
function parts(name) {
  const out = [name];
  if (CONNECTOR.test(name)) {
    name.split(CONNECTOR).forEach(p => {
      const t = p.trim();
      if (t && !CONNECTOR.test(` ${t} `)) out.push(t);
    });
  }
  return out;
}

/** Best pairwise artist similarity between two artist bags. */
export function artistScore(a = [], b = []) {
  const A = a.flatMap(parts), B = b.flatMap(parts);
  if (!A.length || !B.length) return 0;
  let best = 0;
  for (const x of A) {
    for (const y of B) {
      best = Math.max(best, crossScriptSimilarity(x, y));
      if (best === 1) return 1;
    }
  }
  return best;
}
