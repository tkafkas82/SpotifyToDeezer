/*
 * One record per person, wherever this happens to be running.
 *
 * A Deezer connection used to be global to the process: data/gw.json held the one
 * `arl`, data/token.json the one OAuth token. With Google sign-in in front, the
 * connection belongs to whoever is signed in, keyed by identity - `google:<sub>`,
 * or the fixed `local` identity when sign-in is off, which is what keeps the
 * keyless single-user flow working unchanged.
 *
 * Two places to keep them, chosen by the environment rather than by a flag:
 *
 *   file   data/users.json. The default, and what a laptop or a container with a
 *          volume wants.
 *   kv     Redis over HTTP (lib/kv.js), when KV_REST_API_URL and its token are
 *          set. Serverless hosts have no writable disk and no shared instance, so
 *          a file there would mean every cold start forgetting who connected what.
 *
 * Everything is therefore async, and nothing is cached between requests: two
 * instances of this app must not disagree about who owns which Deezer. The
 * credentials are encrypted (lib/secret.js) either way - an `arl` *is* a live
 * Deezer session, and several people's now share one store.
 */
import fs from 'fs';
import { DATA_DIR, dataPath } from './paths.js';
import { encrypt, decrypt } from './secret.js';
import * as kv from './kv.js';

const FILE = dataPath('users.json');

export const LOCAL_ID = 'local';
export const googleId = sub => `google:${sub}`;

export const usingKv = () => kv.configured();
export const where = () => (usingKv() ? `redis at ${kv.describe()}` : 'data/users.json');

// --- the two drivers -----------------------------------------------------

const fileDriver = {
  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return raw?.users && typeof raw.users === 'object' ? raw.users : {};
    } catch {
      return {};                                   // first run
    }
  },
  async get(id) {
    return this.read()[id] || null;
  },
  async put(id, record) {
    const users = this.read();
    users[id] = record;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename: a torn users.json would lock everybody out at once.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  },
};

const kvDriver = {
  key: id => `user:${id}`,
  async get(id) {
    const raw = await kv.get(this.key(id));
    if (!raw) return null;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  },
  async put(id, record) {
    await kv.set(this.key(id), JSON.stringify(record));
  },
};

const driver = () => (usingKv() ? kvDriver : fileDriver);

// --- one person's record -------------------------------------------------

const blank = () => ({ identity: null, deezer: {} });

// Answered for the `local` id rather than stored: it is implied by there being no
// identity provider at all, and writing it down would leave a fake sign-in on the
// record of an install that later turns Google on.
const LOCAL_IDENTITY = { provider: 'local', name: 'this machine' };

/**
 * A loaded record, and every operation on it. Held for the length of one request
 * only: it is a snapshot, not a cache.
 */
export class Account {
  constructor(id, record) {
    this.id = id;
    this.record = record || blank();
    this.record.deezer ||= {};
  }

  get identity() {
    if (this.record.identity) return this.record.identity;
    return this.id === LOCAL_ID ? LOCAL_IDENTITY : null;
  }

  get email() {
    return this.record.identity?.email || null;
  }

  save() {
    return driver().put(this.id, this.record);
  }

  // --- the Deezer connection --------------------------------------------

  /**
   * The stored `arl`, or null. DEEZER_ARL in the environment is a fallback for
   * the local identity only: it is one machine-wide value, and handing it to
   * whichever Google account happens to sign in would be lending them a Deezer
   * session.
   */
  arl() {
    const value = this.record.deezer.arl ? decrypt(this.record.deezer.arl) : null;
    if (value) return value;
    return this.id === LOCAL_ID ? (process.env.DEEZER_ARL || null) : null;
  }

  setArl(value) {
    this.record.deezer.arl = encrypt(value);
    return this.save();
  }

  oauth() {
    const stored = this.record.deezer.oauth;
    if (!stored?.accessToken) return null;
    const accessToken = decrypt(stored.accessToken);
    if (!accessToken) return null;                 // key changed - treat as gone
    if (stored.expiresAt && stored.expiresAt <= Date.now()) return null;
    return { accessToken, expiresAt: stored.expiresAt ?? null, user: stored.user || null };
  }

  setOauth(session) {
    this.record.deezer.oauth = session?.accessToken
      ? {
        accessToken: encrypt(session.accessToken),
        expiresAt: session.expiresAt ?? null,
        user: session.user || null,
      }
      : null;
    return this.save();
  }

  /** `which` is 'arl' | 'oauth' | 'all'. */
  disconnect(which = 'all') {
    if (which === 'all') this.record.deezer = {};
    else delete this.record.deezer[which];
    return this.save();
  }

  // --- identity ---------------------------------------------------------

  /** Remembers who signed in, keeping the first time they ever did. */
  signedIn(identity) {
    const now = new Date().toISOString();
    this.record.identity = {
      ...identity,
      firstSeen: this.record.identity?.firstSeen || now,
      lastSeen: now,
    };
    return this.save();
  }

  /** Last-seen, at hour resolution: a timestamp is not worth a write per request. */
  async touch() {
    if (this.id === LOCAL_ID || !this.record.identity) return;
    const now = new Date().toISOString();
    if (now.slice(0, 13) === String(this.record.identity.lastSeen).slice(0, 13)) return;
    this.record.identity.lastSeen = now;
    await this.save();
  }
}

export async function load(id) {
  return new Account(id, await driver().get(id));
}

// --- migration from the single-user files --------------------------------

/**
 * Folds a pre-sign-in installation into the `local` record so an upgrade does not
 * ask for the cookie again, then removes the old files - their contents live on
 * in the record, encrypted. File driver only: those files are on the disk of the
 * machine that was the single user.
 */
export async function migrateLegacy({ log = () => {} } = {}) {
  if (usingKv()) return;
  const local = await load(LOCAL_ID);
  if (Object.keys(local.record.deezer).length) return;
  const moved = [];

  const gwFile = dataPath('gw.json');
  try {
    const value = JSON.parse(fs.readFileSync(gwFile, 'utf8'))?.arl;
    if (value) {
      await local.setArl(value);
      fs.rmSync(gwFile, { force: true });
      moved.push('data/gw.json');
    }
  } catch { /* nothing to move */ }

  const tokenFile = dataPath('token.json');
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (raw?.accessToken) {
      await local.setOauth(raw);
      fs.rmSync(tokenFile, { force: true });
      moved.push('data/token.json');
    }
  } catch { /* nothing to move */ }

  if (moved.length) log(`   moved ${moved.join(' and ')} into data/users.json (encrypted)`);
}
