/*
 * The one local key everything else is derived from.
 *
 * Going multi-user means several people's Deezer credentials share one file on
 * this machine, and an `arl` cookie *is* a Deezer session - so what lands on disk
 * is encrypted rather than pasted in plaintext the way the single-user
 * data/gw.json did it.
 *
 * The master key is APP_SECRET when set (so a container can be handed its key and
 * keep working across a rebuild), otherwise a random one generated on first run
 * and kept in data/secret.key. Two purposes, two derived subkeys via HKDF, so a
 * session cookie signature can never be confused with record ciphertext.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dataPath } from './paths.js';

const KEY_FILE = dataPath('secret.key');

let master = null;

/** 32 raw bytes. Read once, then held in memory for the life of the process. */
export function masterKey() {
  if (master) return master;
  const fromEnv = process.env.APP_SECRET;
  if (fromEnv) {
    // Any passphrase length is accepted; hashing is what makes it 32 bytes.
    master = crypto.createHash('sha256').update(fromEnv, 'utf8').digest();
    return master;
  }
  try {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved.length >= 32) {
      master = Buffer.from(saved, 'base64');
      if (master.length === 32) return master;
    }
  } catch { /* first run */ }
  master = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  // 0600 is honoured on POSIX and ignored on Windows; asking costs nothing.
  fs.writeFileSync(KEY_FILE, master.toString('base64'), { mode: 0o600 });
  return master;
}

// hkdfSync hands back an ArrayBuffer; the cipher and HMAC both want a Buffer.
const subkey = info => Buffer.from(crypto.hkdfSync('sha256', masterKey(), Buffer.alloc(0), Buffer.from(info), 32));

let keys = null;
const purpose = name => {
  if (!keys) keys = { cookie: subkey('cookie-v1'), record: subkey('record-v1') };
  return keys[name];
};

/** Detached HMAC, base64url. Used to sign the session cookie. */
export function hmac(data) {
  return crypto.createHmac('sha256', purpose('cookie'))
    .update(data)
    .digest('base64url');
}

/** Constant-time compare of two base64url digests of the same length. */
export function sameDigest(a, b) {
  const left = Buffer.from(String(a || ''), 'base64url');
  const right = Buffer.from(String(b || ''), 'base64url');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/** AES-256-GCM, self-describing so the format can move on without a migration. */
export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', purpose('record'), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * Returns null rather than throwing on anything that will not open: a key that
 * changed (APP_SECRET edited, secret.key deleted) should read as "not connected"
 * and prompt for a fresh paste, not crash every request.
 */
export function decrypt(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) return null;
  try {
    const [, iv, tag, body] = blob.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', purpose('record'), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** True when the key is only as durable as data/secret.key - worth saying out loud. */
export const keyIsGenerated = () => !process.env.APP_SECRET;
