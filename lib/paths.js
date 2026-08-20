/*
 * Where the state lives.
 *
 * One place, because there are now four things in it - the lookup cache, the
 * per-user records, the encryption key and the browser profile - and they must
 * agree. SD_DATA_DIR moves the lot: a mounted volume when this runs in a
 * container, a temp directory when the tests exercise the user store.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.SD_DATA_DIR
  ? path.resolve(process.env.SD_DATA_DIR)
  : path.join(HERE, '..', 'data');

export const dataPath = (...parts) => path.join(DATA_DIR, ...parts);
