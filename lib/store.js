/*
 * Disk-backed lookup cache.
 *
 * Deezer answers are stable and the quota is the scarce resource, so every ISRC
 * lookup and search query is remembered. Re-running the same playlist (or a
 * different playlist sharing tracks) then costs no requests at all, which is the
 * difference between a 10-second and a 3-minute second run.
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

export async function flush() {
  timer = null;
  if (!dirty) return;
  dirty = false;
  // Oldest-first insertion order means slicing the tail keeps the recent entries.
  const entries = [...map.entries()].slice(-MAX_ENTRIES);
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  await fsp.writeFile(FILE, JSON.stringify(Object.fromEntries(entries)));
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
