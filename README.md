# Spotify → Deezer

Copies a Spotify playlist into Deezer. Paste a playlist link, watch every track get
matched against the Deezer catalogue, fix or drop the doubtful ones, then write the
result into a new or existing Deezer playlist.

Runs entirely on this machine — the Deezer token lives in `data/token.json` and
nothing is sent anywhere except to Spotify's and Deezer's own APIs.

```
start.bat                 # installs, opens http://localhost:4870, runs the server
npm start                 # same thing without the browser
npm test                  # 20 offline tests (matching rules + fan-out logic)
npm run probe             # match a sample track list against live Deezer, no Spotify needed
```

## Setup

Two free app registrations, both about a minute of work.

**Spotify** — <https://developer.spotify.com/dashboard> → *Create app*. Any redirect
URI is fine (the app only uses the client-credentials flow); `http://localhost:4870/callback`
does. Copy the Client ID and Client Secret.

**Deezer** — <https://developers.deezer.com/myapps> → *Create a new application*:

| Field | Value |
| --- | --- |
| Application domain | `localhost` |
| Redirect URL after authentication | `http://localhost:4870/api/deezer/callback` |

Then fill in `.env` (copied from `.env.example` on first run):

```ini
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
DEEZER_APP_ID=...
DEEZER_APP_SECRET=...
```

Restart, click **Connect Deezer**, approve the `manage_library` permission. That
consent is what lets the app write playlists; reading the Spotify side needs no
login at all.

## How matching works

Deezer and Spotify agree on almost nothing except the recording itself, so the
matcher works from the most certain signal down:

1. **ISRC.** Spotify exposes each track's ISRC and Deezer can look one up directly
   (`/track/isrc:...`). That is identity, not similarity — it is right even when the
   titles are spelled differently. Roughly 85% of a typical playlist resolves here.
   The hit is only trusted when it is *playable in your country*: Deezer often
   carries the same recording twice and the ISRC can land on the copy whose licence
   is dead locally, in which case the search fallback finds the playable one.
2. **Scoped search** on the decoration-stripped title (`artist:"Queen" track:"Bohemian Rhapsody"`),
   for tracks with no ISRC or no ISRC hit.
3. **Free-text search**, which catches the tracks Deezer files under a different
   primary artist.
4. **Transliterated search.** Deezer stores Greek artists under both spellings
   (`Σάκης Ρουβάς` and `Sakis Rouvas`) while Spotify picks one, so the query is
   retried romanised. Greek titles that would otherwise never match do.

Every candidate is scored 0–100 on title (55), artist (30) and duration (15), with
four rules that keep the confident tier honest:

- **Decoration is stripped, identity is not.** "Remastered 2011", "(Deluxe Edition)"
  and "(feat. X)" are noise. "Live", "Remix", "Acoustic" are *not* — those are
  different recordings, and a version marker on one side only caps the score into
  the review tier. This matters because Deezer's `title_short` hides them:
  "Bohemian Rhapsody (Live At Wembley)" shortens to "Bohemian Rhapsody", which would
  otherwise score as a perfect match.
- **A different performer is not a match.** Search results are full of karaoke and
  tribute recordings with the exact right title; a weak artist score halves the
  total, and a middling one caps it below auto-accept.
- **A duration gulf means a different version** — extended mix, edit, or a 45-second
  skit sharing a name with a five-minute song.
- **Unavailable in your country never auto-selects.**

Scores ≥ 78 are ticked automatically, 55–77 are shown unticked as *needs review*,
the rest are *not found*. Nothing gets written to Deezer that you did not tick.

## Using it

1. Paste the playlist link → **Match tracks**. Results stream in as they resolve.
2. Filter to **Needs review** and work through them: **change** opens the other
   candidates plus a free Deezer search box, **find** does the same for the misses.
3. Pick the destination — a new playlist (name prefilled from Spotify) or one of
   your existing ones — and hit **Add to Deezer**. Appending to an existing playlist
   skips tracks already in it, so re-running is safe.
4. **Export CSV** dumps the full match table, including what was not found.

Public playlists only. Spotify's own algorithmic and editorial playlists (Discover
Weekly, Release Radar, most *Made for you* mixes) return 404 to any third-party app
token — copy them into a playlist of your own first, and that copy works.

## Layout

```
server.js            Express routes; SSE for the conversion stream
lib/spotify.js       client-credentials token, playlist + paged track reads
lib/deezer.js        OAuth, search, ISRC lookup, playlist create/append
lib/match.js         the strategy above, plus scoring
lib/normalize.js     title/artist normalisation and Greek transliteration
lib/convert.js       the fan-out over a playlist (6 lookups in flight)
lib/store.js         disk cache of every ISRC/search answer
lib/http.js          rate limiter + retrying JSON fetch
public/              the single-page UI
scripts/probe.js     match a track list from the command line
```

Two things about Deezer worth knowing if you touch `lib/deezer.js`: errors arrive as
HTTP 200 with an `{error:{...}}` body, and the quota (~50 requests / 5 s) reports as
`code 4` rather than a 429. Both are handled in `call()`; the disk cache in
`lib/store.js` means a second run of the same playlist costs no requests at all.
