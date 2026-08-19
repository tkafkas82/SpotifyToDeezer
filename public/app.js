/*
 * UI for the copier.
 *
 * The row list is pre-allocated the moment the playlist header arrives and then
 * filled in as match events land: the server matches six tracks at a time, so
 * results come back out of order, and pre-allocating is what keeps the list in
 * playlist order without buffering everything until the end.
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
  user: null,
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
  toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 8000 : 3500);
}

// --- account -------------------------------------------------------------

async function loadConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  state.user = cfg.deezerUser;

  const box = $('#account');
  box.replaceChildren();
  if (cfg.deezerUser) {
    if (cfg.deezerUser.picture) {
      const img = el('img');
      img.src = cfg.deezerUser.picture;
      img.alt = '';
      box.append(img);
    }
    box.append(el('span', 'dot on'), el('span', null, `Deezer: ${cfg.deezerUser.name}`));
    const out = el('button', 'ghost', 'Disconnect');
    out.onclick = async () => {
      await fetch('/api/deezer/logout', { method: 'POST' });
      loadConfig();
    };
    box.append(out);
    loadTargets();
  } else {
    box.append(el('span', 'dot'), el('span', null, 'Deezer: not connected'));
    const login = el('button', 'primary', 'Connect Deezer');
    login.disabled = !cfg.deezerConfigured;
    login.title = cfg.deezerConfigured ? '' : 'Set DEEZER_APP_ID / DEEZER_APP_SECRET in .env first';
    login.onclick = () => { location.href = '/api/deezer/login'; };
    box.append(login);
  }

  if (!cfg.spotifyConfigured) {
    $('#source-hint').textContent =
      'Spotify credentials are missing: put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env and restart.';
  }
  return cfg;
}

async function loadTargets() {
  try {
    const { playlists } = await fetch('/api/deezer/playlists').then(r => r.json());
    const sel = $('#target');
    const keep = sel.value;
    sel.replaceChildren(new Option('New Deezer playlist...', ''));
    for (const p of playlists || []) {
      sel.append(new Option(`${p.title} (${p.nbTracks})`, p.id));
    }
    sel.value = keep;
    syncTargetInputs();
  } catch { /* not connected yet - the dock stays on "new playlist" */ }
}

function syncTargetInputs() {
  $('#new-name').classList.toggle('hidden', Boolean($('#target').value));
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
  resetRun();
  $('#go').disabled = true;

  const es = new EventSource(`/api/convert?playlist=${encodeURIComponent(url)}`);
  const finish = () => { es.close(); $('#go').disabled = false; };

  es.addEventListener('loading', e => {
    const { loaded, total } = JSON.parse(e.data);
    $('#prog-text').textContent = `Reading Spotify: ${loaded}/${total || '?'} tracks`;
  });

  es.addEventListener('playlist', e => {
    state.playlist = JSON.parse(e.data);
    $('#pl-name').textContent = state.playlist.name;
    $('#pl-meta').textContent = [state.playlist.owner, `${state.playlist.count} tracks`].filter(Boolean).join(' - ');
    if (!$('#new-name').value) $('#new-name').value = state.playlist.name;
    buildRows(state.playlist.count);
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

  es.addEventListener('error', e => {
    // A payload means the server said why; a bare error means the stream dropped.
    let message = 'The connection to the local server dropped';
    try { message = JSON.parse(e.data).message; } catch { /* transport-level */ }
    $('#prog-text').textContent = 'Stopped';
    toast(message, true);
    finish();
  });
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
    el('div', 'a', row.spotify ? `${row.spotify.artists.join(', ')} - ${mmss(row.spotify.durationMs)}` : ''),
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
    right.append(el('div', 'none', row.error || (row.status === 'skipped' ? row.reason || 'skipped' : row.status === 'pending' ? '' : 'nothing on Deezer')));
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
  $('#picker-title').textContent = `${row.spotify.artists.join(', ')} - ${row.spotify.title}`;
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
      el('div', 'a', [c.artists.join(', '), c.album, mmss(c.durationMs), c.readable ? null : 'unavailable'].filter(Boolean).join(' - ')),
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
  if (!state.user) return toast('Connect Deezer first', true);

  const playlistId = $('#target').value;
  const title = $('#new-name').value.trim() || state.playlist?.name || 'Imported from Spotify';
  $('#push').disabled = true;
  $('#push').textContent = 'Adding...';

  try {
    const res = await fetch('/api/deezer/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackIds: chosen.map(t => t.best.id),
        playlistId: playlistId || undefined,
        title,
        description: state.playlist ? `Copied from Spotify: ${state.playlist.name}` : undefined,
      }),
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);

    const box = $('#push-result');
    box.replaceChildren();
    const link = el('a', null, res.created ? `Created "${title}" on Deezer` : 'Open the Deezer playlist');
    link.href = res.link;
    link.target = '_blank';
    link.rel = 'noreferrer';
    box.append(
      el('span', null, `Added ${res.added} track${res.added === 1 ? '' : 's'}`),
      res.duplicatesSkipped ? el('span', 'muted', ` (${res.duplicatesSkipped} already there)`) : el('span'),
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
    $('#push').textContent = 'Add to Deezer';
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

// --- wiring --------------------------------------------------------------

$('#go').onclick = start;
$('#url').addEventListener('keydown', e => { if (e.key === 'Enter') start(); });
$('#push').onclick = push;
$('#csv').onclick = exportCsv;
$('#target').onchange = syncTargetInputs;
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
if (params.has('deezer')) history.replaceState({}, '', location.pathname);

loadConfig();
syncTargetInputs();
