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

const wrap = err => new HttpError(500,
  `Could not start a browser (${err.message.split('\n')[0]}). Install Chrome, or run "npx playwright install chromium".`);

let persistent = null;

/** Headed persistent context that holds the Deezer login. */
export async function session() {
  if (persistent && !persistent.isClosed?.()) return persistent;
  fs.mkdirSync(PROFILE, { recursive: true });
  try {
    persistent = await chromium.launchPersistentContext(PROFILE, launchOpts({
      headless: false,
      viewport: { width: 1200, height: 860 },
      args: ['--disable-blink-features=AutomationControlled'],
    }));
  } catch (err) {
    throw wrap(err);
  }
  persistent.on('close', () => { persistent = null; });
  return persistent;
}

export function sessionOpen() {
  return Boolean(persistent);
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

/** A page in the persistent context, reusing an existing tab for the same host. */
export async function pageFor(url) {
  const ctx = await session();
  const host = new URL(url).host;
  const existing = ctx.pages().find(p => {
    try { return new URL(p.url()).host === host; } catch { return false; }
  });
  const page = existing || await ctx.newPage();
  if (!existing || page.url() === 'about:blank') {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
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
