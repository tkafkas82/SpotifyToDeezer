/*
 * Signed session cookies, without a cookie library.
 *
 * The cookie carries only who you are (`sub`) and when it was issued; the profile
 * and the Deezer credentials live server-side in data/users.json. It is signed
 * with a key derived from the app secret, so a hand-edited cookie cannot claim
 * somebody else's Deezer account, and it expires on its own after MAX_AGE_MS even
 * if the browser decides to keep it.
 *
 * HttpOnly because nothing in the page needs to read it, and SameSite=Lax so a
 * cross-site POST cannot ride the session - which is also why the state-changing
 * routes in server.js check the Origin header.
 */
import { hmac, sameDigest } from './secret.js';

export const COOKIE = 'sd_session';
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The origin this server is reachable at - decides redirect URIs and Secure. */
export function baseUrl(port) {
  const configured = process.env.PUBLIC_URL || process.env.BASE_URL;
  return (configured || `http://localhost:${port}`).replace(/\/+$/, '');
}

export const isHttps = port => baseUrl(port).startsWith('https:');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

/** `<base64url payload>.<hmac>` - a JWT-shaped thing without the algorithm choice. */
export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(body)}`;
}

export function verify(token, { maxAgeMs = MAX_AGE_MS, now = Date.now() } = {}) {
  const [body, mac, ...rest] = String(token || '').split('.');
  if (!body || !mac || rest.length) return null;
  if (!sameDigest(mac, hmac(body))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.sub) return null;
  // A clock-skew allowance, but a cookie issued in the future is not honoured.
  if (!Number.isFinite(payload.iat) || payload.iat > now + 60_000) return null;
  if (now - payload.iat > maxAgeMs) return null;
  return payload;
}

const serialize = (name, value, { maxAgeMs: age = 0, secure = false, sameSite = 'Lax' }) => [
  `${name}=${encodeURIComponent(value)}`,
  'Path=/',
  'HttpOnly',
  `SameSite=${sameSite}`,
  `Max-Age=${Math.floor(age / 1000)}`,
  secure ? 'Secure' : null,
].filter(Boolean).join('; ');

export function setCookie(res, name, value, opts = {}) {
  res.append('Set-Cookie', serialize(name, value, { maxAgeMs: MAX_AGE_MS, ...opts }));
}

export function clearCookie(res, name, opts = {}) {
  res.append('Set-Cookie', serialize(name, '', { ...opts, maxAgeMs: 0 }));
}

/** The signed session on a request, or null. */
export function fromRequest(req) {
  const jar = parseCookies(req.headers.cookie);
  return jar[COOKIE] ? verify(jar[COOKIE]) : null;
}
