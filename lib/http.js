/*
 * Shared HTTP plumbing.
 *
 * Deezer's public API answers roughly 50 requests per 5 seconds per app and
 * punishes a burst with a *200 response* carrying {error:{code:4}} rather than
 * a 429, so the limiter here is not optional politeness - without it a 200-track
 * playlist silently half-matches.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Token bucket: at most `max` calls in any `windowMs`, plus a concurrency cap. */
export function makeLimiter({ max, windowMs, concurrency }) {
  const stamps = [];          // completion times inside the current window
  let active = 0;
  const queue = [];

  const pump = () => {
    while (queue.length && active < concurrency) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
      if (stamps.length >= max) {   // `active` calls already have a stamp; don't double-count
        setTimeout(pump, windowMs - (now - stamps[0]) + 25);
        return;
      }
      const { fn, resolve, reject } = queue.shift();
      active++;
      stamps.push(now);
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  };

  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch + JSON + retries. Retries 429/5xx and network blips with backoff;
 * everything else fails fast so the caller sees the real error.
 */
export async function fetchJson(url, options = {}, { retries = 3, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 400 * 2 ** attempt;
        if (attempt < retries) { await sleep(Math.min(wait, 10_000)); continue; }
        throw new HttpError(res.status, `${label || url} responded ${res.status}`);
      }
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch { throw new HttpError(res.status, `${label || url} returned non-JSON: ${text.slice(0, 120)}`); }
      if (!res.ok) {
        const msg = body?.error?.message || body?.error_description || body?.error || res.statusText;
        throw new HttpError(res.status, `${label || url}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      }
      return body;
    } catch (err) {
      lastErr = err;
      // Only network-level failures are worth another go; HttpError already retried above.
      if (err instanceof HttpError || attempt === retries) throw err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr;
}
