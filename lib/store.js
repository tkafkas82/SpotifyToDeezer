/*
 * Disk-backed lookup cache.
 *
 * Deezer answers are stable and the quota is the scarce resource, so every ISRC
 * lookup and search query is remembered. Re-running the same playlist (or a
 * different playlist sharing tracks) then costs no requests at all, which is the
 * difference between a 10-second and a 3-minute second run.
 *
 * The disk is an optimisation here and nothing more, so a filesystem that will not
 * take it (a serverless host, a container with no volume) costs speed rather than
 * correctness: the cache carries on in memory for the life of the process and the
 * writing is switched off after saying so once.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { dataPath } from './paths.js';

const FILE = dataPath('cache.json');
const MAX_ENTRIES = 20_000;

const map = new Map();
let dirty = false;
let timer = null;

try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw)) map.set(k, v);
} catch { /* first run */ }

function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(flush, 2000);
  timer.unref?.();
}

let writable = true;

export async function flush() {
  timer = null;
  if (!dirty || !writable) return;
  dirty = false;
  // Oldest-first insertion order means slicing the tail keeps the recent entries.
  const entries = [...map.entries()].slice(-MAX_ENTRIES);
  try {
    await fsp.mkdir(path.dirname(FILE), { recursive: true });
    await fsp.writeFile(FILE, JSON.stringify(Object.fromEntries(entries)));
  } catch (err) {
    writable = false;
    console.log(`   note: ${FILE} is not writable (${err.code || err.message}) - `
      + 'the lookup cache stays in memory only.');
  }
}

export const cache = {
  has: k => map.has(k),
  get: k => map.get(k),
  set(k, v) {
    map.set(k, v);
    schedule();
  },
  get size() { return map.size; },
  clear() {
    map.clear();
    schedule();
  },
};
