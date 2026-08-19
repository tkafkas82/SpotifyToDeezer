/*
 * Browser plumbing for the no-API-key path.
 *
 * Two very different uses, so two contexts:
 *   - `session()` is a *headed, persistent* profile under data/browser. You log
 *     into Deezer in it once and the cookies stay there, which is what replaces a
 *     registered app: writing to your library needs proof it is you, and a login
 *     is that proof.
 *   - `scraper()` is a throwaway headless context for reading a long Spotify
 *     playlist, where no login is involved and nothing should be kept.
 *
 * Chrome or Edge is used when installed (no browser download at all); the
 * Playwright-managed Chromium is the fallback.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { HttpError } from './http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(HERE, '..', 'data', 'browser');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CHANNELS = [
  { channel: 'chrome', probe: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] },
  { channel: 'msedge', probe: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'] },
];

/** Which browser to drive, or null to let Playwright use its own Chromium. */
export function pickChannel() {
  for (const { channel, probe } of CHANNELS) {
    if (probe.some(p => fs.existsSync(p))) return channel;
  }
  return null;
}

const launchOpts = extra => {
  const channel = pickChannel();
  return { ...(channel ? { channel } : {}), ...extra };
};

const wrap = err => {
  const first = err.message.split('\n')[0];
  // Distinct causes, distinct advice: a profile still held by a window from an
  // earlier run is nothing like a browser that is not installed.
  if (/already in use|existing browser session/i.test(first)) {
    return new HttpError(409, 'A Deezer window from an earlier run is still open - close it and try again.');
  }
  return new HttpError(500, `Could not start a browser (${first}). Install Chrome, or run "npx playwright install chromium".`);
};

let persistent = null;
let headedNow = false;

/**
 * The persistent context that holds the Deezer login.
 *
 * Headed only when someone actually has to look at it (the login). Everything
 * afterwards - status checks, creating playlists - runs headless off the cookies
 * already in the profile, so no window ever appears unasked. Chrome refuses to
 * open one profile twice, hence the swap rather than a second context.
 */
export async function session({ headed = false } = {}) {
  if (persistent && (headedNow || !headed)) return persistent;
  if (persistent) await closeSession();      // headless is up, a headed one is wanted
  fs.mkdirSync(PROFILE, { recursive: true });
  try {
    persistent = await chromium.launchPersistentContext(PROFILE, launchOpts({
      headless: !headed,
      viewport: { width: 1200, height: 860 },
      // A login page that decides it is being automated tends to loop instead of
      // logging you in, and the headless UA ("HeadlessChrome") is a giveaway that
      // Deezer's gateway has no reason to accept either.
      userAgent: UA,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    }));
  } catch (err) {
    throw wrap(err);
  }
  headedNow = headed;
  persistent.on('close', () => { persistent = null; headedNow = false; });
  return persistent;
}

export function sessionOpen() {
  return Boolean(persistent);
}

/**
 * Playwright's request helper bound to the persistent context, which means it
 * sends that profile's cookies. This is how the Deezer gateway is called without
 * a tab: reusing a tab meant that the moment you clicked "continue with Google"
 * and the tab left www.deezer.com, the next status check opened a fresh one on top
 * of the login you were in the middle of.
 */
export async function requestApi({ headed = false } = {}) {
  const ctx = await session({ headed });
  return ctx.request;
}

/** True once a login has been done here before - the profile outlives the process. */
export function profileExists() {
  return fs.existsSync(path.join(PROFILE, 'Default'));
}

export async function closeSession() {
  const ctx = persistent;
  persistent = null;
  await ctx?.close().catch(() => {});
}

/** Deletes the stored login. */
export async function forgetSession() {
  await closeSession();
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

/**
 * Shows `url` in the headed profile - only ever called for a login the user asked
 * for. Any existing tab is reused wherever it has wandered to (an SSO provider,
 * a captcha), and it is left alone rather than navigated back.
 */
export async function showPage(url) {
  const ctx = await session({ headed: true });
  const loaded = ctx.pages().filter(p => p.url() && p.url() !== 'about:blank');
  const page = loaded[0] || ctx.pages()[0] || await ctx.newPage();
  // Only a fresh window gets navigated: if a login is already underway - possibly
  // on account.deezer.com or at an SSO provider - it is left exactly where it is.
  if (!loaded.length) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Repeated clicks must not pile up blank tabs.
  for (const stray of ctx.pages()) {
    if (stray !== page && (!stray.url() || stray.url() === 'about:blank')) await stray.close().catch(() => {});
  }
  await page.bringToFront().catch(() => {});
  return page;
}

/** Throwaway headless context, closed by the caller. */
export async function scraper() {
  try {
    const browser = await chromium.launch(launchOpts({ headless: true }));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    return { ctx, close: () => browser.close().catch(() => {}) };
  } catch (err) {
    throw wrap(err);
  }
}
