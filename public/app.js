/*
 * UI for the copier.
 *
 * The row list is pre-allocated the moment the playlist header arrives and then
 * filled in as match events land: the server matches six tracks at a time, so
 * results come back out of order, and pre-allocating is what keeps the list in
 * playlist order without buffering everything until the end.
 *
 * Connecting Deezer without app credentials is a two-step affair - open a browser
 * window, then wait for the login to happen in it - so that button starts a poll
 * rather than awaiting a single request.
 *
 * Two shapes of the same page, decided by the server's `auth.enabled`: a local
 * single-user tool, or a signed-in one where the page is gated until Google says
 * who you are and every Deezer connection is your own. `body.gated` is what hides
 * the working parts in the second case.
 */

const $ = sel => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  playlist: null,
  tracks: [],          // { spotify, status, best, candidates, selected, node }
  filter: 'all',
  deezerReady: false,
  cfg: null,
  targets: [],         // the Deezer playlists that can be written to
  dest: 'new',         // 'new' = copy into a fresh playlist, 'existing' = write into one
  writeMode: 'append', // only meaningful for 'existing': 'append' | 'replace'
  namedByHand: false,  // has the name box been typed into for this run?
  mode: 'copy',        // 'copy' = Spotify -> Deezer, 'grow' = suggest songs for a Deezer playlist
  grow: null,          // { source, playlist, rows: [{ track, selected, node }], shown: Map id -> track }
};

const mmss = ms => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let toastTimer;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('bad', bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 8000 : 4000);
}

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status}` }));
  // A session that expired while the page was open should put the sign-in gate
  // back rather than let every button fail with the same 401.
  if (res.status === 401 && data.signIn) loadConfig();
  return data;
};

// --- account -------------------------------------------------------------

/** The Google half of the header: who you are, and the way out. */
function renderMe(auth) {
  const box = $('#me');
  box.replaceChildren();
  if (!auth.enabled || !auth.user) return;
  if (auth.user.picture) {
    const img = el('img');
    img.src = auth.user.picture;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';   // Google's CDN 403s a referred request
    box.append(img);
  }
  box.append(el('span', null, auth.user.name));
  if (auth.user.email && auth.user.email !== auth.user.name) box.append(el('span', 'muted', auth.user.email));
  const out = el('button', 'ghost', 'Sign out');
  out.onclick = async () => {
    await post('/api/auth/logout');
    location.href = '/';
  };
  box.append(out);
}

async function loadConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  state.cfg = cfg;
  const auth = cfg.auth || { enabled: false, user: null };
  const dz = cfg.deezer;
  const user = dz.oauthUser || dz.sessionUser;
  state.deezerReady = Boolean(user);

  renderMe(auth);
  const gated = auth.enabled && !auth.user;
  document.body.classList.toggle('gated', gated);
  $('#signin-card').classList.toggle('hidden', !gated);
  $('#build').textContent = `build ${cfg.build || '?'}`;
  if (gated) {
    $('#signin-note').textContent = auth.restricted
      ? 'This server only accepts the accounts on its allow list.'
      : '';
    $('#account').replaceChildren();
    return cfg;
  }

  const box = $('#account');
  box.replaceChildren();

  if (user) {
    if (user.picture) {
      const img = el('img');
      img.src = user.picture;
      img.alt = '';
      box.append(img);
    }
    const how = dz.oauthUser ? 'app login' : dz.sessionMode === 'arl' ? 'arl cookie' : 'browser session';
    box.append(el('span', 'dot on'), el('span', null, `Deezer: ${user.name}`), el('span', 'muted', `(${how})`));
    const drop = el('button', 'ghost', 'Disconnect');
    drop.onclick = async () => {
      if (dz.oauthUser) await post('/api/deezer/logout');
      else await post('/api/deezer/session/forget');
      toast('Disconnected from Deezer');
      loadConfig();
    };
    box.append(drop);
    loadTargets();
  } else if (dz.sessionError) {
    // A stored cookie that Deezer would not answer for right now. Saying "not
    // connected" here reads as "paste it again", which fixes nothing.
    box.append(el('span', 'dot'), el('span', null, 'Deezer: no answer just now'));
    box.append(el('span', 'muted', dz.sessionError));
    const again = el('button', 'ghost', 'retry');
    again.onclick = () => loadConfig();
    box.append(again);
  } else {
    box.append(el('span', 'dot'), el('span', null, 'Deezer: not connected'));
    // The browser profile holds one machine-wide Deezer login, so the server only
    // offers it when it has a single user by definition.
    if (dz.browserLogin) {
      const login = el('button', 'ghost', 'try browser login');
      login.title = 'Deezer usually refuses to sign in inside an automated browser - the cookie below is the reliable route';
      login.onclick = () => connectSession(login);
      box.append(login);
    }
    if (dz.hasKeys) {
      const oauth = el('button', 'ghost', 'use app keys');
      oauth.onclick = () => { location.href = '/api/deezer/login'; };
      box.append(oauth);
    }
  }

  // The cookie box stays up until something is actually connected: a stored
  // cookie that has stopped working is exactly when it is needed most.
  $('#arl-card').classList.toggle('hidden', Boolean(user));
  $('#arl-storage').textContent = auth.enabled
    ? 'It is stored encrypted against your account on this server, and used only for your own copies.'
    : 'It is stored encrypted in data/users.json on this machine.';
  $('#arl-browser-note').textContent = dz.browserLogin
    ? 'Deezer will not complete a login inside an automated browser - its form silently re-renders '
      + 'instead of signing you in - so the "try browser login" button up there is a long shot. This '
      + 'cookie is the reliable way in. App credentials in .env also work if you would rather register an app.'
    : dz.hasKeys
      ? 'Or use "use app keys" up there to authorise this app against your Deezer account instead.'
      : '';

  $('#source-hint').textContent = cfg.spotify.hasKeys
    ? 'Reading with your Spotify app credentials: exact ISRC matching, any playlist length. Spotify’s own editorial playlists (Discover Weekly, Release Radar) are invisible to app tokens.'
    : 'No credentials needed — the playlist is read off Spotify’s public pages, editorial playlists included. The first 100 tracks arrive instantly; longer playlists are read in a background browser, which takes a few seconds more.';
  return cfg;
}

/** Opens the Deezer window, then waits for the login to land in it. */
async function connectSession(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Opening browser...';
  try {
    const res = await post('/api/deezer/session/open');
    if (res.error) throw new Error(res.error);
    if (res.user) {
      toast(`Connected as ${res.user.name}`);
      return loadConfig();
    }

    button.textContent = 'Waiting for login...';
    toast('Log into Deezer in the window that just opened. Heads up: Deezer often refuses to complete a '
      + 'login in an automated browser — if the form just re-appears with no error, use the cookie box below.');
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2500));
      const { user } = await fetch('/api/deezer/session/check').then(r => r.json());
      if (user) {
        // The window has done its job; the login stays in the profile and later
        // writes reuse it without anything appearing on screen.
        await post('/api/deezer/session/close');
        toast(`Connected as ${user.name}`);
        return loadConfig();
      }
    }
    toast('No login came through — that is Deezer refusing an automated browser, not you. '
      + 'Use the cookie box instead.', true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function loadTargets() {
  try {
    const { playlists, error } = await fetch('/api/deezer/playlists').then(r => r.json());
    if (error) return;
    state.targets = playlists || [];
    const sel = $('#target');
    const keep = sel.value;
    sel.replaceChildren(new Option('Pick a playlist...', ''));
    for (const p of state.targets) sel.append(new Option(`${p.title} (${p.nbTracks})`, p.id));
    sel.value = keep;
    const mine = $('#grow-mine');
    const keepMine = mine.value;
    mine.replaceChildren(new Option('or one of yours...', ''));
    for (const p of state.targets) mine.append(new Option(`${p.title} (${p.nbTracks})`, p.id));
    mine.value = keepMine;
    syncDest();
    syncGrow();
  } catch { /* not connected yet - the dock stays on "new playlist" */ }
}

/**
 * Destination is a choice the user makes, never one inferred from which field
 * happens to be filled in: "new playlist" and "add to this existing one" do very
 * different things to a playlist that took an afternoon to build.
 */
function syncDest() {
  const existing = state.dest === 'existing';
  $('#dest-new').classList.toggle('hidden', existing);
  $('#dest-existing').classList.toggle('hidden', !existing);
  [...$('#dest').children].forEach(b => b.classList.toggle('on', b.dataset.dest === state.dest));
  [...$('#write-mode').children].forEach(b => b.classList.toggle('on', b.dataset.mode === state.writeMode));

  const chosen = state.targets.find(p => String(p.id) === $('#target').value);
  $('#push').textContent = !existing
    ? 'Copy to new playlist'
    : state.writeMode === 'replace' ? 'Replace contents' : 'Add to playlist';

  // The name collision is the trap worth calling out: copying a playlist a second
  // time into a "new" playlist leaves two Deezer lists with one name, which reads
  // exactly like the first one having been overwritten.
  const hint = $('#dock-hint');
  const name = $('#new-name').value.trim();
  const twin = !existing && name && state.targets.find(p => p.title.toLowerCase() === name.toLowerCase());
  if (twin) {
    hint.textContent = `You already have a Deezer playlist called "${twin.title}" (${twin.nbTracks} tracks). `
      + 'This makes a second one with the same name - pick "Existing playlist" to add to that one instead.';
  } else if (existing && chosen && state.writeMode === 'replace') {
    hint.textContent = `"${chosen.title}" will be emptied first - its ${chosen.nbTracks} `
      + `track${chosen.nbTracks === 1 ? '' : 's'} are removed, then these are added.`;
  } else if (existing && chosen) {
    hint.textContent = `Added to the end of "${chosen.title}" - the ${chosen.nbTracks} `
      + `track${chosen.nbTracks === 1 ? '' : 's'} in it stay, and anything already there is skipped.`;
  } else {
    hint.textContent = '';
  }
  hint.classList.toggle('hidden', !hint.textContent);
}

/** Fills the name box from the Spotify playlist, as it does on a first run. */
function nameFromSpotify() {
  const name = state.playlist?.name;
  if (!name) return;
  $('#new-name').value = name;
  state.namedByHand = false;
  syncDest();
}

// --- conversion ----------------------------------------------------------

function resetRun() {
  state.playlist = null;
  state.tracks = [];
  $('#rows').replaceChildren();
  $('#bar-fill').style.width = '0';
  $('#counts').replaceChildren();
  $('#prog-text').textContent = 'Reading the Spotify playlist...';
  $('#pl-name').textContent = '';
  $('#pl-meta').textContent = '';
  $('#push-result').classList.add('hidden');
  $('#step-progress').classList.remove('hidden');
  $('#step-results').classList.add('hidden');
  $('#dock').classList.add('hidden');
}

function start() {
  const url = $('#url').value.trim();
  if (!url) return toast('Paste a Spotify playlist link first', true);
  state.namedByHand = false;
  resetRun();
  $('#go').disabled = true;

  const src = `/api/convert?playlist=${encodeURIComponent(url)}`;
  const es = new EventSource(src);
  const finish = () => { es.close(); $('#go').disabled = false; };
  // An EventSource that never opened was answered with an ordinary error
  // response, whose body it cannot read - so it has no way to say why.
  let opened = false;
  es.addEventListener('open', () => { opened = true; });

  es.addEventListener('loading', e => {
    const { loaded, total } = JSON.parse(e.data);
    $('#prog-text').textContent = `Reading Spotify: ${loaded}/${total || '?'} tracks`;
  });

  es.addEventListener('playlist', e => {
    state.playlist = JSON.parse(e.data);
    const p = state.playlist;
    $('#pl-name').textContent = p.name;
    $('#pl-meta').textContent = [p.owner, `${p.count} tracks`, p.source === 'browser' ? 'read in a browser' : null]
      .filter(Boolean).join(' - ');
    if (p.warning) toast(p.warning, true);
    // Every run gets the name of the playlist it is copying - carrying the
    // previous one over is how a copy ends up filed under the wrong title.
    nameFromSpotify();
    buildRows(p.count);
    $('#step-results').classList.remove('hidden');
    $('#dock').classList.remove('hidden');
  });

  es.addEventListener('track', e => {
    const t = JSON.parse(e.data);
    const row = state.tracks[t.index];
    if (!row) return;
    Object.assign(row, t, { selected: t.status === 'matched' });
    renderRow(row);
    updateSelection();
  });

  es.addEventListener('progress', e => {
    const { done, total } = JSON.parse(e.data);
    $('#bar-fill').style.width = `${(done / Math.max(total, 1)) * 100}%`;
    $('#prog-text').textContent = `Matching on Deezer: ${done}/${total}`;
  });

  es.addEventListener('done', e => {
    const { counts, total } = JSON.parse(e.data);
    $('#prog-text').textContent = `Done - ${total} tracks`;
    $('#bar-fill').style.width = '100%';
    const c = $('#counts');
    c.replaceChildren();
    const add = (label, n) => {
      const s = el('span');
      s.append(el('b', null, String(n || 0)), ` ${label}`);
      c.append(s);
    };
    add('matched', counts.matched);
    add('need review', counts.review);
    add('not found', counts.missing);
    if (counts.skipped) add('skipped (local files)', counts.skipped);
    finish();
  });

  es.addEventListener('error', async e => {
    // A payload means the server said why; a bare error means the stream dropped,
    // or never started.
    let message = null;
    try { message = JSON.parse(e.data).message; } catch { /* transport-level */ }
    finish();
    $('#prog-text').textContent = 'Stopped';
    if (!message && !opened) message = await whyRefused(src);
    toast(message || 'The connection to the server dropped', true);
  });
}

/**
 * Ask the same URL again with fetch, which - unlike EventSource - can read an
 * error response. Aborted as soon as it turns out to be a stream after all, so a
 * request that would have worked this time does not run a whole conversion.
 */
async function whyRefused(src) {
  const ac = new AbortController();
  try {
    const res = await fetch(src, { signal: ac.signal });
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      ac.abort();
      return null;
    }
    const body = await res.json().catch(() => null);
    return body?.error || `The server answered ${res.status}`;
  } catch {
    return 'Cannot reach the server - check the connection';
  }
}

function buildRows(count) {
  const frag = document.createDocumentFragment();
  state.tracks = Array.from({ length: count }, (_, i) => {
    const node = el('div', 'trk');
    node.dataset.index = String(i);
    const row = { index: i, status: 'pending', node, selected: false, candidates: [] };
    frag.append(node);
    renderRow(row);
    return row;
  });
  $('#rows').replaceChildren(frag);
}

const BADGE = {
  matched: ['ok', 'match'],
  review: ['rev', 'review'],
  missing: ['no', 'not found'],
  skipped: ['na', 'skipped'],
  pending: ['na', '...'],
};

function renderRow(row) {
  const n = row.node;
  n.replaceChildren();
  n.classList.toggle('miss', row.status === 'missing');
  n.classList.toggle('hidden', !matchesFilter(row));

  const box = el('input');
  box.type = 'checkbox';
  box.checked = Boolean(row.selected && row.best);
  box.disabled = !row.best;
  box.onchange = () => { row.selected = box.checked; updateSelection(); };
  n.append(box);

  const left = el('div', 'side sp');
  left.append(
    el('div', 't', row.spotify ? row.spotify.title : 'loading...'),
    el('div', 'a', row.spotify ? `${row.spotify.artists[0] || ''} - ${mmss(row.spotify.durationMs)}` : ''),
  );
  n.append(left, el('div', 'to', row.status === 'missing' ? '✗' : '→'));

  const right = el('div', 'side dz');
  if (row.best) {
    const t = el('div', 't');
    const a = el('a', null, row.best.title);
    a.href = row.best.link;
    a.target = '_blank';
    a.rel = 'noreferrer';
    t.append(a);
    const detail = [row.best.artists.join(', '), mmss(row.best.durationMs)];
    if (!row.best.readable) detail.push('unavailable in your country');
    right.append(t, el('div', 'a', detail.join(' - ')));
  } else {
    right.append(el('div', 'none', row.error
      || (row.status === 'skipped' ? row.reason || 'skipped' : row.status === 'pending' ? '' : 'nothing on Deezer')));
  }
  n.append(right);

  const [cls, text] = BADGE[row.status] || BADGE.pending;
  // A hand-picked track has no score - it has your word for it, which is better.
  const scored = row.best && row.status !== 'skipped' && typeof row.best.score === 'number';
  const badge = el('span', `badge ${cls}`, row.method === 'manual' ? 'chosen' : scored ? `${text} ${row.best.score}` : text);
  const right2 = el('div', 'right');
  right2.append(badge);
  if (row.spotify && row.status !== 'skipped') {
    const fix = el('button', 'ghost', row.best ? 'change' : 'find');
    fix.onclick = () => openPicker(row);
    right2.append(fix);
  }
  n.append(right2);
}

function matchesFilter(row) {
  if (state.filter === 'all') return true;
  return row.status === state.filter;
}

function updateSelection() {
  const n = state.tracks.filter(t => t.selected && t.best).length;
  $('#sel-count').textContent = String(n);
  $('#sel-label').textContent = n === 1 ? 'track selected' : 'tracks selected';
  $('#push').disabled = n === 0;
}

// --- manual picker -------------------------------------------------------

let pickerRow = null;

function openPicker(row) {
  pickerRow = row;
  $('#picker-title').textContent = `${row.spotify.artists[0] || ''} - ${row.spotify.title}`;
  $('#picker-q').value = row.spotify.query || `${row.spotify.artists[0] || ''} ${row.spotify.title}`.trim();
  renderPicks(row.candidates || []);
  $('#picker').showModal();
}

function renderPicks(list) {
  const box = $('#picker-list');
  box.replaceChildren();
  if (!list.length) {
    box.append(el('p', 'muted', 'No candidates. Edit the query above and search Deezer directly.'));
    return;
  }
  for (const c of list) {
    const pick = el('div', 'pick');
    const meta = el('div', 'meta');
    meta.append(
      el('div', 't', c.title),
      el('div', 'a', [c.artists.join(', '), c.album, mmss(c.durationMs), c.readable ? null : 'unavailable']
        .filter(Boolean).join(' - ')),
    );
    const right = el('div', 'right');
    if (typeof c.score === 'number') right.append(el('span', 'badge na', String(c.score)));
    right.append(el('button', 'ghost', 'use'));
    pick.append(meta, right);
    pick.onclick = () => {
      Object.assign(pickerRow, { best: c, status: 'matched', method: 'manual', selected: true, error: null });
      renderRow(pickerRow);
      updateSelection();
      $('#picker').close();
    };
    box.append(pick);
  }
}

async function pickerSearch() {
  const q = $('#picker-q').value.trim();
  if (!q) return;
  $('#picker-list').replaceChildren(el('p', 'muted', 'Searching...'));
  try {
    const { results, error } = await fetch(`/api/deezer/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (error) throw new Error(error);
    renderPicks(results || []);
  } catch (err) {
    $('#picker-list').replaceChildren(el('p', 'muted', err.message));
  }
}

// --- write to Deezer -----------------------------------------------------

async function push() {
  const chosen = state.tracks.filter(t => t.selected && t.best);
  if (!chosen.length) return;
  if (!state.deezerReady) return toast('Connect Deezer first', true);

  const existing = state.dest === 'existing';
  const playlistId = existing ? $('#target').value : '';
  if (existing && !playlistId) return toast('Pick which Deezer playlist to write to', true);

  const target = state.targets.find(p => String(p.id) === playlistId);
  if (existing && state.writeMode === 'replace' && !confirm(
    `Remove the ${target?.nbTracks ?? ''} track${target?.nbTracks === 1 ? '' : 's'} currently in `
    + `"${target?.title || 'that playlist'}" and put these ${chosen.length} in their place?`,
  )) return;

  const title = $('#new-name').value.trim() || state.playlist?.name || 'Imported from Spotify';
  const label = $('#push').textContent;
  $('#push').disabled = true;
  $('#push').textContent = existing && state.writeMode === 'replace' ? 'Replacing...' : 'Adding...';

  try {
    const res = await post('/api/deezer/push', {
      trackIds: chosen.map(t => t.best.id),
      playlistId: playlistId || undefined,
      mode: existing ? state.writeMode : undefined,
      title,
      description: state.playlist ? `Copied from Spotify: ${state.playlist.name}` : undefined,
    });
    if (res.error) throw new Error(res.error);

    const box = $('#push-result');
    box.replaceChildren();
    const link = el('a', null, res.created ? `Created "${title}" on Deezer` : 'Open the Deezer playlist');
    link.href = res.link;
    link.target = '_blank';
    link.rel = 'noreferrer';
    const note = res.removed
      ? ` (${res.removed} removed first)`
      : res.duplicatesSkipped ? ` (${res.duplicatesSkipped} already there)` : '';
    box.append(
      el('span', null, `Added ${res.added} track${res.added === 1 ? '' : 's'}`),
      note ? el('span', 'muted', note) : el('span'),
      el('span', null, ' - '),
      link,
    );
    box.classList.remove('hidden');
    toast(`Added ${res.added} tracks to Deezer`);
    loadTargets();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#push').disabled = false;
    $('#push').textContent = label;
    syncDest();
  }
}

function exportCsv() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['status', 'score', 'spotify_artists', 'spotify_title', 'spotify_isrc', 'deezer_id', 'deezer_artists', 'deezer_title', 'deezer_link'].join(',')];
  for (const t of state.tracks) {
    if (!t.spotify) continue;
    lines.push([
      t.status, t.best?.score ?? '', t.spotify.artists.join('; '), t.spotify.title, t.spotify.isrc ?? '',
      t.best?.id ?? '', t.best?.artists?.join('; ') ?? '', t.best?.title ?? '', t.best?.link ?? '',
    ].map(esc).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.playlist?.name || 'playlist').replace(/[^\w\- ]+/g, '_')}-deezer-matches.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- grow a Deezer playlist ---------------------------------------------

function setMode(mode) {
  state.mode = mode === 'grow' ? 'grow' : 'copy';
  document.body.classList.toggle('mode-grow', state.mode === 'grow');
  [...$('#modes').children].forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
  if (state.mode !== 'grow') stopPreview();
  try { localStorage.setItem('mode', state.mode); } catch { /* a convenience only */ }
}

// One preview plays at a time; starting another stops the first.
const player = new Audio();
let playingRow = null;
function stopPreview() {
  player.pause();
  if (playingRow) playingRow.querySelector('.play')?.classList.remove('on');
  playingRow = null;
}
player.addEventListener('ended', stopPreview);

/**
 * `more` asks for a fresh batch: everything already shown is left out, so the
 * button is "show me others", not a reshuffle of the same list.
 */
async function growSuggest(more = false) {
  const source = more ? state.grow?.source : ($('#grow-url').value.trim() || $('#grow-mine').value);
  if (!source) return toast('Paste a Deezer playlist link, or pick one of yours', true);

  const btn = more ? $('#grow-more') : $('#grow-go');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Asking Deezer...';
  stopPreview();
  try {
    const shown = more ? state.grow.shown : new Map();
    const res = await post('/api/grow/suggest', {
      playlist: source,
      count: Number($('#grow-count').value),
      exclude: [...shown.values()].map(({ id, title, artists }) => ({ id, title, artists })),
    });
    if (res.error) throw new Error(res.error);
    if (!res.suggestions.length) {
      return toast(more ? 'No more suggestions for this playlist' : 'Deezer had nothing to suggest for this one', true);
    }
    res.suggestions.forEach(t => shown.set(t.id, t));
    state.grow = {
      source,
      playlist: res.playlist,
      shown,
      rows: res.suggestions.map(track => ({ track, selected: true, node: null })),
    };
    renderGrow(res);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function renderGrow(res) {
  const { playlist, rows } = state.grow;
  $('#grow-name').textContent = playlist.title;
  const bits = [playlist.creator, `${playlist.count} songs`, `${rows.length} suggestions from ${res.seeds} of them`];
  if (res.failedSeeds) bits.push(`${res.failedSeeds} did not answer`);
  $('#grow-meta').textContent = bits.filter(Boolean).join(' - ');
  $('#grow-result').classList.add('hidden');

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const t = row.track;
    const n = el('div', 'sug');

    const box = el('input');
    box.type = 'checkbox';
    box.checked = row.selected;
    box.onchange = () => { row.selected = box.checked; syncGrow(); };

    const play = el('button', 'play ghost', '▶');
    play.type = 'button';
    play.title = t.preview ? 'Play a 30-second preview' : 'No preview for this one';
    play.disabled = !t.preview;
    play.onclick = () => {
      if (playingRow === n) return stopPreview();
      stopPreview();
      player.src = t.preview;
      player.play().catch(() => toast('The preview would not play', true));
      play.classList.add('on');
      playingRow = n;
    };

    let cover;
    if (t.cover) {
      cover = el('img');
      cover.src = t.cover;
      cover.alt = '';
      cover.loading = 'lazy';
    } else {
      cover = el('div', 'nocover');
    }

    const meta = el('div', 'meta');
    const title = el('div', 't');
    const a = el('a', null, t.title);
    a.href = t.link;
    a.target = '_blank';
    a.rel = 'noreferrer';
    title.append(a);
    meta.append(
      title,
      el('div', 'a', `${t.artists.join(', ')} - ${mmss(t.durationMs)}`),
      el('div', 'why', `like ${t.because.join(' and ')}${t.hits > t.because.length ? ` + ${t.hits - t.because.length} more` : ''}`),
    );

    const hits = el('div', 'hits', `${t.hits} of your songs`);
    hits.title = "How many of the playlist's songs led to this one";

    n.append(box, play, cover, meta, hits);
    row.node = n;
    frag.append(n);
  }
  $('#grow-rows').replaceChildren(frag);
  $('#grow-results').classList.remove('hidden');

  if (!playlist.mine) $('#grow-new-name').value = `${playlist.title} +`;
  syncGrow();
}

/**
 * Only the user's own playlist can be added to. Anybody else's is saved as a new
 * playlist of theirs: the original songs first, then the chosen suggestions.
 */
function syncGrow() {
  const g = state.grow;
  if (!g) return;
  const chosen = g.rows.filter(r => r.selected).length;
  const mine = g.playlist.mine;
  $('#grow-new-name').classList.toggle('hidden', mine);
  const add = $('#grow-add');
  add.textContent = mine
    ? `Add ${chosen} song${chosen === 1 ? '' : 's'} to "${g.playlist.title}"`
    : `Save as a new playlist with ${chosen} more`;
  add.disabled = !chosen || !state.deezerReady;
  $('#grow-hint').textContent = !state.deezerReady
    ? 'Connect Deezer (above) to add these - suggesting works without it.'
    : mine
      ? 'Added to the end of the playlist; the songs in it stay where they are.'
      : `"${g.playlist.title}" is not one of your playlists, so it cannot be changed - this makes a copy `
        + `of its ${g.playlist.count} songs in your account, with the chosen suggestions after them.`;
}

async function growAdd() {
  const g = state.grow;
  const chosen = g?.rows.filter(r => r.selected).map(r => r.track.id) || [];
  if (!chosen.length) return;
  const mine = g.playlist.mine;
  const title = $('#grow-new-name').value.trim() || `${g.playlist.title} +`;

  const btn = $('#grow-add');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  try {
    const res = await post('/api/deezer/push', mine
      ? { trackIds: chosen, playlistId: g.playlist.id, mode: 'append' }
      : {
        trackIds: [...g.playlist.trackIds, ...chosen],
        title,
        description: `${g.playlist.title}, with songs suggested by Deezer's Track Mix`,
      });
    if (res.error) throw new Error(res.error);

    const link = el('a', null, res.created ? `Open "${title}" on Deezer` : 'Open the playlist on Deezer');
    link.href = res.link;
    link.target = '_blank';
    link.rel = 'noreferrer';
    const summary = res.created
      ? `Created "${title}" with ${res.added} songs, ${chosen.length} of them new`
      : `Added ${res.added} song${res.added === 1 ? '' : 's'}`
        + (res.duplicatesSkipped ? ` (${res.duplicatesSkipped} already there)` : '');
    const box = $('#grow-result');
    box.replaceChildren(el('span', null, summary), el('span', null, ' - '), link);
    box.classList.remove('hidden');
    toast(summary);

    // What was just added is in the playlist now; it should not be offered again.
    g.rows.filter(r => r.selected).forEach(r => r.node.remove());
    g.rows = g.rows.filter(r => !r.selected);
    // A copy is the user's own playlist from here on, so more suggestions go into it.
    if (res.created) {
      g.playlist = {
        ...g.playlist,
        id: String(res.playlistId),
        title,
        mine: true,
        link: res.link,
        trackIds: [...g.playlist.trackIds, ...chosen],
      };
      g.source = String(res.playlistId);
      $('#grow-name').textContent = title;
    }
    loadTargets();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    syncGrow();
  }
}

// --- wiring --------------------------------------------------------------

async function saveArl() {
  const value = $('#arl').value.trim();
  if (!value) return toast('Paste the cookie value first', true);
  $('#arl-save').disabled = true;
  try {
    const res = await post('/api/deezer/session/arl', { arl: value });
    if (res.error) throw new Error(res.error);
    $('#arl').value = '';
    toast(`Connected as ${res.user.name}`);
    loadConfig();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#arl-save').disabled = false;
  }
}

$('#google-signin').onclick = () => { location.href = '/api/auth/google'; };
$('#arl-save').onclick = saveArl;
$('#arl').addEventListener('keydown', e => { if (e.key === 'Enter') saveArl(); });
$('#go').onclick = start;
$('#url').addEventListener('keydown', e => { if (e.key === 'Enter') start(); });
$('#push').onclick = push;
$('#csv').onclick = exportCsv;
$('#target').onchange = syncDest;
$('#use-sp-name').onclick = () => {
  if (!state.playlist) return toast('Match a Spotify playlist first', true);
  state.dest = 'new';
  nameFromSpotify();
};
$('#new-name').addEventListener('input', () => { state.namedByHand = true; syncDest(); });
$('#dest').onclick = e => {
  const btn = e.target.closest('[data-dest]');
  if (!btn) return;
  state.dest = btn.dataset.dest;
  // Coming back to a fresh copy with an untouched box means the Spotify name.
  if (state.dest === 'new' && !state.namedByHand) nameFromSpotify();
  syncDest();
};
$('#write-mode').onclick = e => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  state.writeMode = btn.dataset.mode;
  syncDest();
};
$('#modes').onclick = e => {
  const btn = e.target.closest('[data-mode]');
  if (btn) setMode(btn.dataset.mode);
};
$('#grow-go').onclick = () => growSuggest(false);
$('#grow-more').onclick = () => growSuggest(true);
$('#grow-add').onclick = growAdd;
$('#grow-url').addEventListener('keydown', e => { if (e.key === 'Enter') growSuggest(false); });
// The two sources are either/or: picking one of yours clears a pasted link, and typing a link clears the pick.
$('#grow-mine').onchange = () => { if ($('#grow-mine').value) $('#grow-url').value = ''; };
$('#grow-url').addEventListener('input', () => { if ($('#grow-url').value) $('#grow-mine').value = ''; });
const growSelect = on => {
  state.grow?.rows.forEach(r => { r.selected = on; r.node.querySelector('input').checked = on; });
  syncGrow();
};
$('#grow-all').onclick = () => growSelect(true);
$('#grow-none').onclick = () => growSelect(false);
$('#picker-search').onclick = pickerSearch;
$('#picker-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pickerSearch(); } });

$('#filters').onclick = e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  [...$('#filters').children].forEach(c => c.classList.toggle('on', c === btn));
  state.tracks.forEach(t => t.node.classList.toggle('hidden', !matchesFilter(t)));
};

const setAll = fn => {
  state.tracks.forEach(t => {
    t.selected = Boolean(t.best) && fn(t);
    renderRow(t);
  });
  updateSelection();
};
$('#sel-all').onclick = () => setAll(() => true);
$('#sel-none').onclick = () => setAll(() => false);
$('#sel-sure').onclick = () => setAll(t => t.status === 'matched');

// OAuth round-trip feedback, then clean the query string out of the address bar.
const params = new URLSearchParams(location.search);
if (params.get('deezer') === 'connected') toast('Connected to Deezer');
if (params.get('deezer') === 'denied') toast('Deezer authorisation was declined', true);
if (params.get('deezer') === 'error') toast(params.get('message') || 'Deezer connection failed', true);
if (params.get('auth') === 'signedin') toast('Signed in');
if (params.get('auth') === 'required') toast('Sign in first', true);
if (params.get('auth') === 'denied') toast(params.get('message') || 'That Google account cannot use this server', true);
if (params.get('auth') === 'error') toast(params.get('message') || 'Google sign-in failed', true);
if (params.has('deezer') || params.has('auth')) history.replaceState({}, '', location.pathname);

let savedMode = 'copy';
try { savedMode = localStorage.getItem('mode') || 'copy'; } catch { /* private window */ }
setMode(savedMode);
loadConfig();
syncDest();
