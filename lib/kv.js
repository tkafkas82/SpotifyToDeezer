/*
 * Redis over HTTP, in thirty lines and no dependency.
 *
 * This exists for one reason: on a serverless host there is no disk to keep the
 * user records on. Upstash (which is what both the Vercel KV integration and a
 * direct Upstash database hand you) speaks a REST dialect where a command is a
 * JSON array in the request body - `["GET","user:x"]` - so a plain fetch is the
 * whole client. Nothing here needs a connection, a pool, or a shutdown hook,
 * which is exactly what a function that may only live for one request wants.
 *
 * Commands are POSTed to the root rather than built into the path, so a key or a
 * value containing slashes needs no escaping.
 */
import { HttpError } from './http.js';

/** Vercel's KV integration and a hand-made Upstash database name these differently. */
const url = () => (process.env.KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_URL
  || process.env.REDIS_REST_URL
  || '').replace(/\/+$/, '');

const token = () => process.env.KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || process.env.REDIS_REST_TOKEN
  || '';

export const configured = () => Boolean(url() && token());

/** Which env vars answered, for the startup banner. */
export function describe() {
  if (!configured()) return null;
  try {
    return new URL(url()).host;
  } catch {
    return 'an invalid KV_REST_API_URL';
  }
}

async function command(...parts) {
  const res = await fetch(url(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parts),
    // A store this app cannot reach is a failed request, not a hung one.
    signal: AbortSignal.timeout(10_000),
  }).catch(err => {
    // fetch() says only "fetch failed"; the reason - ENOTFOUND for a database
    // that was deleted, ECONNREFUSED, a TLS error - is on the cause.
    const why = err.cause?.code || err.cause?.message || err.message;
    throw new HttpError(503, `The account store at ${describe()} is unreachable (${why}).`);
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    // 401 here means the token, not the caller - say so rather than passing a
    // bare 401 up to a browser that would then ask the user to sign in again.
    const why = body?.error || `HTTP ${res.status}`;
    throw new HttpError(503, `The account store refused ${parts[0]}: ${why}`);
  }
  return body?.result ?? null;
}

export const get = key => command('GET', key);
export const set = (key, value) => command('SET', key, value);
export const del = key => command('DEL', key);
