/*
 * Sign in with Google - the standard authorization-code flow, hand-rolled.
 *
 * It is a handful of fetches against two documented endpoints, so no dependency
 * is pulled in for it. Google is used purely as an identity provider: the only
 * scopes asked for are `openid email profile`, no Google API is ever called
 * afterwards, and the access token is dropped as soon as the profile has been read
 * out of the id_token.
 *
 * Enabled only when GOOGLE_CLIENT_ID/SECRET are present. Without them the app
 * stays the single-user local tool it was, which is what keeps `start.bat` a
 * no-registration affair.
 */
import { fetchJson, HttpError } from './http.js';
import { baseUrl } from './session.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function configured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(port) {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(port)}/api/auth/google/callback`;
}

export function authUrl({ port, state, nonce }) {
  if (!configured()) {
    throw new HttpError(500, 'Google sign-in is not configured - set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(port),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    // `select_account` rather than the default: on a shared machine the reason to
    // sign in again is usually to arrive as somebody else.
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${q}`;
}

/**
 * Reads the claims out of an id_token *without* verifying its signature, which is
 * sound only because of where this one comes from: straight back from Google's
 * token endpoint over TLS in a server-to-server call, never from the browser.
 * Google documents exactly that exemption. The claims that carry meaning here are
 * still checked - a token minted for a different app is the mistake worth
 * catching, and it costs one comparison.
 */
export function readIdToken(idToken, { now = Date.now(), audience = process.env.GOOGLE_CLIENT_ID, nonce = null } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new HttpError(502, 'Google returned an id_token that is not a JWT');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(502, 'Google returned an id_token whose payload will not parse');
  }
  if (!ISSUERS.includes(claims.iss)) throw new HttpError(502, `Unexpected id_token issuer "${claims.iss}"`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audience && !aud.includes(audience)) throw new HttpError(502, 'That id_token was issued for a different Google client');
  if (!claims.sub) throw new HttpError(502, 'Google returned an id_token with no subject');
  if (Number(claims.exp || 0) * 1000 <= now) throw new HttpError(401, 'That Google sign-in expired before it could be used - try again.');
  if (nonce && claims.nonce && claims.nonce !== nonce) throw new HttpError(401, 'That sign-in does not belong to this browser - try again.');
  return {
    sub: String(claims.sub),
    email: claims.email || null,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name || claims.email || `user ${claims.sub}`,
    picture: claims.picture || null,
  };
}

export async function exchangeCode(code, { port, nonce = null } = {}) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(port),
    grant_type: 'authorization_code',
  });
  const answer = await fetchJson(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, { label: 'Google token' });
  if (!answer || !answer.id_token) {
    const why = answer?.error_description || answer?.error || 'no id_token in the reply';
    throw new HttpError(502, `Google refused the sign-in: ${why}`);
  }
  return readIdToken(answer.id_token, { nonce });
}

/**
 * Who is allowed in. ALLOWED_EMAILS is a comma-separated list of addresses and/or
 * whole domains ("@example.com"); empty means anybody with a Google account, which
 * is fine behind localhost and a bad idea on a public URL - server.js says so at
 * startup.
 */
export function allowList() {
  return String(process.env.ALLOWED_EMAILS || '')
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

export function allowed(email) {
  const list = allowList();
  if (!list.length) return true;
  const address = String(email || '').toLowerCase();
  const at = address.indexOf('@');
  if (at < 1) return false;
  const domain = address.slice(at);
  return list.some(entry => (entry.startsWith('@') ? entry === domain : entry === address));
}
