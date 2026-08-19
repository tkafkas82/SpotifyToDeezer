/*
 * Reading a Spotify playlist with no credentials at all.
 *
 * Path 1 - the embed page. `open.spotify.com/embed/playlist/{id}` ships the track
 * list as JSON inside the HTML (the payload its iframe player runs on). One
 * request, no browser, and it works on the editorial playlists that a registered
 * app gets a 404 for. It caps at 100 tracks and carries no ISRC.
 *
 * Path 2 - the public web page, scrolled in a headless browser, for playlists
 * longer than that cap. Slower, but complete.
 *
 * Deliberately NOT used: Spotify's web-player token endpoint. It answers
 * "Usage of this endpoint is not permitted under the Spotify Developer Terms",
 * so the keyless path stays on ordinary public pages.
 *
 * The cost of going keyless is the ISRC: without it, matching leans on
 * title/artist/duration instead of an exact identifier, so expect a few more
 * tracks in the review tier. Fill in API keys and lib/spotify.js takes over.
 */
import { HttpError } from './http.js';
import * as browser from './browser.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED_CAP = 100;

/**
 * Spotify's public pages give the credit as one string ("Post Malone, Swae Lee"),
 * and splitting it is wrong for names that contain a comma ("Tyler, The Creator").
 * So both readings are kept and used for different things: `artists` (the split
 * parts) for display and search queries, `credit` (the whole string) as one more
 * name for the scorer to try against Deezer's own spelling.
 */
function artistsFrom(subtitle) {
  const credit = String(subtitle || '').trim();
  const artists = credit.split(/,\s*|\s+&\s+|\s+x\s+/i).map(s => s.trim()).filter(Boolean);
  return { artists, credit };
}

const durationFrom = text => {
  const bits = String(text || '').trim().split(':').map(Number);
  if (bits.some(Number.isNaN) || bits.length < 2) return 0;
  const [h, m, s] = bits.length === 3 ? bits : [0, ...bits];
  return ((h * 60 + m) * 60 + s) * 1000;
};

const embedUrl = id => `https://open.spotify.com/embed/playlist/${id}`;

/**
 * The embed page, fetched directly, or through Chrome when the direct request
 * cannot get out. On a corporate network Node has no idea about the system proxy
 * or its PAC file while the browser does, so a connect timeout here is worth one
 * retry through a browser before giving up.
 */
async function embedHtml(id) {
  try {
    const res = await fetch(embedUrl(id), { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (res.status === 404) throw new HttpError(404, 'Spotify has no public playlist with that id.');
    if (!res.ok) throw new HttpError(res.status, `Spotify's embed page answered ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const { ctx, close } = await browser.scraper().catch(() => {
      throw new HttpError(502, `Cannot reach open.spotify.com (${err.cause?.code || err.message}) - check the VPN or proxy on this connection.`);
    });
    try {
      const page = await ctx.newPage();
      await page.goto(embedUrl(id), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return await page.content();
    } catch (viaBrowser) {
      const why = String(viaBrowser.message).split(/[\r\n]/)[0];
      throw new HttpError(502, `Cannot reach open.spotify.com (${err.cause?.code || err.message}); a browser could not either (${why}). Check the VPN or proxy on this connection.`);
    } finally {
      await close();
    }
  }
}

/** Track list from the embed payload. Up to 100 tracks, no ISRC. */
export async function getEmbedPlaylist(id) {
  const html = await embedHtml(id);
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!raw) throw new HttpError(502, 'Spotify changed its embed page - no track data in it any more.');

  let entity;
  try {
    entity = JSON.parse(raw[1])?.props?.pageProps?.state?.data?.entity;
  } catch {
    throw new HttpError(502, 'Spotify\'s embed payload did not parse as JSON.');
  }
  if (!entity?.trackList) throw new HttpError(502, 'Spotify\'s embed payload carried no track list.');

  const tracks = entity.trackList.map(t => ({
    id: String(t.uri || '').split(':').pop() || null,
    local: false,
    title: t.title || '',
    ...artistsFrom(t.subtitle),
    album: '',
    durationMs: t.duration || 0,
    isrc: null,
    url: t.uri ? `https://open.spotify.com/track/${String(t.uri).split(':').pop()}` : null,
  }));

  return {
    id,
    name: entity.name || entity.title || 'Spotify playlist',
    description: '',
    owner: entity.subtitle || '',
    image: entity.coverArt?.sources?.at(-1)?.url || null,
    url: `https://open.spotify.com/playlist/${id}`,
    total: tracks.length,
    tracks,
    source: 'embed',
    // The cap is silent: exactly 100 means "probably more where that came from".
    truncated: tracks.length >= EMBED_CAP,
  };
}

/**
 * Full track list by scrolling the public page. The list is virtualised, so rows
 * only exist in the DOM while near the viewport - hence collecting by row number
 * as we go rather than reading the whole thing at the end.
 */
export async function getBrowserPlaylist(id, onProgress) {
  const { ctx, close } = await browser.scraper();
  try {
    const page = await ctx.newPage();
    await page.goto(`https://open.spotify.com/playlist/${id}`, { waitUntil: 'domcontentloaded' });

    const rowSel = '[data-testid="tracklist-row"]';
    await page.waitForSelector(rowSel, { timeout: 20_000 }).catch(() => {
      throw new HttpError(404, 'That playlist page showed no tracks - it may be private or deleted.');
    });

    // `h1` alone picks up the sidebar's "Your Library".
    const name = await page.evaluate(() =>
      document.querySelector('[data-testid="entityTitle"]')?.innerText?.trim()
      || document.querySelector('main h1')?.innerText?.trim()
      || document.title.replace(/\s*\|\s*Spotify.*$/, '')
      || 'Spotify playlist');
    const expected = await page.evaluate(() => {
      const m = document.body.innerText.match(/([\d.,]+)\s+songs?/i);
      return m ? Number(m[1].replace(/[.,]/g, '')) : 0;
    });

    const byIndex = new Map();
    let idle = 0;

    const harvest = async () => {
      const rows = await page.$$eval(rowSel, els => els.map(row => {
        const cells = row.querySelectorAll('[role="gridcell"], [aria-colindex]');
        const index = Number(row.querySelector('[aria-colindex="1"]')?.innerText.trim());
        const link = row.querySelector('a[href^="/track/"]');
        const artists = [...row.querySelectorAll('a[href^="/artist/"]')].map(a => a.innerText.trim());
        const times = [...cells].map(c => c.innerText.trim()).filter(t => /^\d+:\d{2}(:\d{2})?$/.test(t));
        return {
          index,
          spotifyId: link?.getAttribute('href')?.split('/').pop() || null,
          title: link?.innerText.trim() || '',
          artists,
          duration: times.at(-1) || '',
        };
      }));
      for (const r of rows) {
        if (Number.isFinite(r.index) && r.title && !byIndex.has(r.index)) byIndex.set(r.index, r);
      }
    };

    // Scrolling has to happen inside the page: a mouse wheel lands wherever the
    // pointer is, while the track list lives in its own scroll container.
    const scrollStep = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('*')]
        .filter(e => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!el) return false;
      el.scrollTop += el.clientHeight * 0.85;
      return true;
    });

    // 600 steps is far more than any playlist needs; the idle counter ends the
    // loop in practice and the cap only stops a runaway.
    for (let step = 0; step < 600; step++) {
      const before = byIndex.size;
      await harvest();
      onProgress?.({ loaded: byIndex.size, total: expected || 0 });
      if (expected && byIndex.size >= expected) break;
      idle = byIndex.size > before ? 0 : idle + 1;
      if (idle >= 8) break;                       // nothing new for eight scrolls
      if (!await scrollStep()) break;
      await page.waitForTimeout(220);
    }

    const tracks = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => ({
        id: r.spotifyId,
        local: false,
        title: r.title,
        artists: r.artists,
        credit: r.artists.join(', '),
        album: '',
        durationMs: durationFrom(r.duration),
        isrc: null,
        url: r.spotifyId ? `https://open.spotify.com/track/${r.spotifyId}` : null,
      }));

    if (!tracks.length) throw new HttpError(502, 'Could not read any tracks off that playlist page.');

    return {
      id,
      name,
      description: '',
      owner: '',
      image: null,
      url: `https://open.spotify.com/playlist/${id}`,
      total: expected || tracks.length,
      tracks,
      source: 'browser',
      truncated: Boolean(expected) && tracks.length < expected,
    };
  } finally {
    await close();
  }
}

/**
 * Keyless read: the cheap embed first, the browser only when the playlist is
 * longer than the embed hands out.
 */
export async function getPlaylist(id, onProgress) {
  const embed = await getEmbedPlaylist(id);
  onProgress?.({ loaded: embed.tracks.length, total: embed.tracks.length });
  if (!embed.truncated) return embed;

  try {
    const full = await getBrowserPlaylist(id, onProgress);
    return full.tracks.length > embed.tracks.length ? { ...full, name: full.name || embed.name, image: embed.image } : embed;
  } catch (err) {
    // Better a truncated copy the user is told about than no copy at all.
    return { ...embed, warning: `Only the first ${embed.tracks.length} tracks: ${err.message}` };
  }
}
