/*
 * One record per person, in data/users.json.
 *
 * A Deezer connection used to be global to the process: data/gw.json held the one
 * `arl`, data/token.json the one OAuth token. With Google sign-in in front, the
 * connection belongs to whoever is signed in, so both move in here keyed by
 * identity - `google:<sub>`, or the fixed `local` identity when sign-in is off,
 * which is what keeps the keyless single-user flow working unchanged.
 *
 * The credentials are encrypted (lib/secret.js): an `arl` is a live Deezer
 * session, and several people's now share one file. Everything else - names,
 * pictures, timestamps - stays readable, because a file you cannot inspect is a
 * file you cannot debug.
 *
 * Writes are small, rare (a connect, a disconnect) and must not tear the file, so
 * they are synchronous write-then-rename rather than a queue.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, dataPath } from './paths.js';
import { encrypt, decrypt } from './secret.js';

const DATA = DATA_DIR;
const FILE = dataPath('users.json');

export const LOCAL_ID = 'local';
export const googleId = sub => `google:${sub}`;

let db = { version: 1, users: {} };

try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (raw && typeof raw.users === 'object' && raw.users) db = { version: 1, users: raw.users };
} catch { /* first run */ }

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const blank = () => ({ identity: null, deezer: {} });
const record = id => (db.users[id] ||= blank());

export const get = id => db.users[id] || null;
export const list = () => Object.entries(db.users).map(([id, u]) => ({ id, ...u }));

/** Remembers who signed in. Returns the stored identity, with firstSeen kept. */
export function upsertIdentity(id, identity) {
  const user = record(id);
  const now = new Date().toISOString();
  user.identity = {
    ...identity,
    firstSeen: user.identity?.firstSeen || now,
    lastSeen: now,
  };
  save();
  return user.identity;
}

export function touch(id) {
  const user = get(id);
  if (!user?.identity) return;
  const now = new Date().toISOString();
  // A timestamp is not worth a disk write on every request.
  if (now.slice(0, 13) === String(user.identity.lastSeen).slice(0, 13)) return;
  user.identity.lastSeen = now;
  save();
}

// --- the Deezer connection ----------------------------------------------

export function setArl(id, arl) {
  record(id).deezer.arl = encrypt(arl);
  save();
}

/**
 * The stored `arl`, or null. DEEZER_ARL in the environment is a fallback for the
 * local identity only: it is one machine-wide value and handing it to whichever
 * Google account happens to sign in would be lending them a Deezer session.
 */
export function arl(id) {
  const stored = get(id)?.deezer?.arl;
  const value = stored ? decrypt(stored) : null;
  if (value) return value;
  return id === LOCAL_ID ? (process.env.DEEZER_ARL || null) : null;
}

export function setOauth(id, session) {
  record(id).deezer.oauth = session && session.accessToken
    ? { accessToken: encrypt(session.accessToken), expiresAt: session.expiresAt ?? null, user: session.user || null }
    : null;
  save();
}

export function oauth(id) {
  const stored = get(id)?.deezer?.oauth;
  if (!stored?.accessToken) return null;
  const accessToken = decrypt(stored.accessToken);
  if (!accessToken) return null;                       // key changed - treat as gone
  if (stored.expiresAt && stored.expiresAt <= Date.now()) return null;
  return { accessToken, expiresAt: stored.expiresAt ?? null, user: stored.user || null };
}

/** `which` is 'arl' | 'oauth' | 'all'. */
export function disconnect(id, which = 'all') {
  const user = get(id);
  if (!user) return;
  if (which === 'all') user.deezer = {};
  else delete user.deezer[which];
  save();
}

// --- migration from the single-user files --------------------------------

/**
 * Folds a pre-sign-in installation into the `local` record so an upgrade does not
 * ask for the cookie again, then removes the old files - their contents live on
 * here, encrypted. Runs once: after it, `local` has a deezer entry.
 */
export function migrateLegacy({ log = () => {} } = {}) {
  if (get(LOCAL_ID)?.deezer && Object.keys(get(LOCAL_ID).deezer).length) return;
  const moved = [];

  const gwFile = path.join(DATA, 'gw.json');
  try {
    const value = JSON.parse(fs.readFileSync(gwFile, 'utf8'))?.arl;
    if (value) {
      setArl(LOCAL_ID, value);
      fs.rmSync(gwFile, { force: true });
      moved.push('data/gw.json');
    }
  } catch { /* nothing to move */ }

  const tokenFile = path.join(DATA, 'token.json');
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (raw?.accessToken) {
      setOauth(LOCAL_ID, raw);
      fs.rmSync(tokenFile, { force: true });
      moved.push('data/token.json');
    }
  } catch { /* nothing to move */ }

  if (moved.length) log(`   moved ${moved.join(' and ')} into data/users.json (encrypted)`);
}
