# Spotify → Deezer

Copies a Spotify playlist into Deezer. Paste a playlist link, watch every track get
matched against the Deezer catalogue, fix or drop the doubtful ones, then write the
result into a new or existing Deezer playlist.

**No API keys, no app registrations.** The one thing it needs from you is proof that
your Deezer account is yours: paste your `arl` session cookie once (four clicks in
devtools, instructions in the app). Everything else — reading the Spotify playlist,
searching Deezer, matching — needs nothing at all.

By default everything runs on this machine as a single-user tool, and nothing is sent
anywhere except to Spotify's and Deezer's own servers. Add Google credentials and it
becomes a small multi-user app instead, where everyone signs in and connects their own
Deezer account — see [More than one user](#more-than-one-user).

```
start.bat                 # installs, opens http://localhost:4870, runs the server
npm start                 # same thing without the browser
npm test                  # 46 offline tests
npm run probe             # match a sample track list against live Deezer
```

## First run

1. `start.bat`
2. **Connect Deezer with your session cookie.** In your *normal* browser, signed in to
   deezer.com: `F12` → **Application** → **Cookies** → `https://www.deezer.com` → copy
   the value of `arl` (a long string, ~190 characters) and paste it into the box on the
   page. It is validated against Deezer before it is kept, and stored encrypted in
   `data/users.json` on this machine. That cookie *is* your Deezer session — treat it
   like a password.
3. Paste a Spotify playlist link, **Match tracks**, tick what you want, **Add to Deezer**.

Why the cookie and not a login form: Deezer will not complete a sign-in inside an
automated browser. Tested with a real click on its Log in button — the page simply
re-renders with no error message at all, and its Google/Facebook buttons never finish
loading. The **try browser login** button is still there and opens a real Chrome window
in case that ever changes, but the cookie is the route that works.

The other supported route is a registered Deezer app (`.env`), which uses the
documented OAuth API — see below.

### Optional: API keys

Registering apps buys two things, and nothing else:

| | keyless | with keys |
| --- | --- | --- |
| Spotify playlist length | first 100 tracks instantly, longer read by scrolling a headless browser (~30 s for 200) | any length in one request |
| Spotify ISRC | not published on public pages | yes → exact identity matching |
| Spotify editorial playlists (Discover Weekly, Release Radar) | **readable** | 404 — app tokens cannot see them |
| Deezer writes | your own web session | documented OAuth API, stable |

See `.env.example`. Keys are used automatically whenever they are present.

## More than one user

Filling in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` puts a Google sign-in in front
of the app. Nothing else needs configuring, and leaving them empty keeps the
single-user behaviour above exactly as it was.

```
https://console.cloud.google.com/apis/credentials
  Create credentials → OAuth client ID → Web application
  Authorised redirect URI: http://localhost:4870/api/auth/google/callback
```

What changes:

* The page is **gated** until you sign in. Google is the identity provider and
  nothing more — the scopes are `openid email profile`, no Google API is called
  afterwards, and the token is dropped once the name, email and picture are read.
* **Every account connects its own Deezer**, by pasting its own `arl` cookie or by
  authorising the registered Deezer app against its own account. Connections are kept
  per identity in `data/users.json`, and the credentials in it are encrypted
  (AES-256-GCM) under `APP_SECRET`, or under a `data/secret.key` generated on first
  run. A copy is always written to the Deezer account of the person who asked for it.
* **`ALLOWED_EMAILS` is the door.** Addresses, `@whole-domains`, or both. Empty means
  anybody with a Google account can sign in and connect their own Deezer through your
  server — fine on localhost, a bad idea on a public URL, and the server says so at
  startup.
* **`PUBLIC_URL`** is the origin redirect URIs are built from; `https` there also marks
  the session cookie `Secure`. The cookie is signed, `HttpOnly`, `SameSite=Lax` and
  carries nothing but the identity id and an issue time, and state-changing requests
  additionally check `Origin`.
* **The browser-login route is refused** in this mode. One Chrome profile holds one
  Deezer login, so offering it would let whoever signed in most recently write into
  somebody else's library. The cookie paste and the Deezer app are per-account; the
  shared profile is not.
* An install that was single-user keeps working: `data/gw.json` and `data/token.json`
  are folded into the `local` record on first start, encrypted, and removed.

`DEEZER_ARL` in `.env` deliberately applies to the single-user mode only — one
machine-wide cookie handed to whoever signs in is the same mistake as the shared
browser profile.

## How the keyless side works

**Reading Spotify.** `open.spotify.com/embed/playlist/{id}` ships the track list as
JSON inside the page its iframe player runs on: one request, no browser, and it
covers editorial playlists that a registered app is refused. It caps at 100 tracks,
so longer playlists are read by scrolling the ordinary public page in a headless
browser and harvesting rows as they render (the list is virtualised — rows only
exist in the DOM near the viewport).

Not used: Spotify's web-player token endpoint, which answers *"Usage of this
endpoint is not permitted under the Spotify Developer Terms"*. The keyless path
stays on ordinary public pages.

**Writing Deezer.** `gw-light.php` is the gateway Deezer's own website calls. It
authenticates with the normal web-session cookie plus a CSRF token (`checkForm`)
instead of an OAuth app, so `playlist.create` and `playlist.addSongs` work as you.
Two ways in, same calls: plain Node carrying the pasted `arl` cookie (the route that
works), or the cookie jar of a browser profile logged in through the **try browser
login** window (the route Deezer's bot defences currently close off).

Three of its argument quirks are worth knowing, all confirmed against a scratch
playlist rather than guessed: `songs` is a list of `[trackId, 0]` pairs where the
second element is *not* a position; `offset: -1` appends at the end while `offset: 0`
inserts the batch *above* everything already in the playlist (which reads as the
playlist having been replaced); and one already-present track rejects the whole batch
with `ERROR_DATA_EXISTS`, so a rejected batch is resent without the tracks the
playlist already has. Removal is `playlist.deleteSongs`, and it needs the same pair
shape — a flat list of ids answers `true` and removes nothing. `playlist.updateSongs`
does not exist.

Being undocumented, that gateway can change without notice — `lib/deezer.js` (the
registered-app path) is the stable route, `lib/deezer-gw.js` the no-setup one.

The status polling deliberately never touches a tab. Deezer's login lives on
`account.deezer.com`, a different host from `www.deezer.com`, so an earlier version
that ran its check inside a Deezer tab kept deciding the tab had "wandered off" and
opening a fresh one on top of the login every 2.5 seconds. Checks now go through the
context's cookie jar (`ctx.request`), which needs no page at all.

## How matching works

Deezer and Spotify agree on almost nothing except the recording itself, so the
matcher works from the most certain signal down:

1. **ISRC** (only with Spotify keys) — Deezer can look one up directly
   (`/track/isrc:…`). That is identity, not similarity. The hit is trusted only when
   it is *playable in your country*: Deezer often carries the same recording twice
   and the ISRC can land on the copy whose licence is dead locally, in which case
   search finds the playable one.
2. **Free-text search** — the reliable workhorse. Deezer's scoped field search
   silently answers "no results" for plenty of real titles (verified with *BIRDS OF A
   FEATHER*), so plain text goes first.
3. **Scoped search** (`artist:"Queen" track:"Bohemian Rhapsody"`) as a second
   opinion, on the decoration-stripped title.
4. **Transliterated search** — Deezer stores Greek artists under both spellings
   (`Σάκης Ρουβάς` and `Sakis Rouvas`) while Spotify picks one, so the query is
   retried romanised. Greek tracks that would otherwise never match do.

Every candidate is scored 0–100 on title (55), artist (30) and duration (15), with
four rules that keep the confident tier honest:

- **Decoration is stripped, identity is not.** "Remastered 2011", "(Deluxe Edition)"
  and "(feat. X)" are noise. "Live", "Remix", "Acoustic" are *not* — a version marker
  on one side only caps the score into the review tier. This matters because Deezer's
  `title_short` hides them: "Bohemian Rhapsody (Live At Wembley)" shortens to
  "Bohemian Rhapsody", which would otherwise look like a perfect match.
- **A different performer is not a match.** Search results are full of karaoke and
  tribute recordings with exactly the right title.
- **A duration gulf means a different version** — extended mix, edit, or a 45-second
  skit sharing a name with a five-minute song.
- **Unavailable in your country never auto-selects.**

≥ 78 is ticked automatically, 55–77 is shown unticked as *needs review*, the rest is
*not found*. Nothing is written to Deezer that you did not tick.

Measured keyless, from a cold cache: *Top 50 Global* → 49 matched / 1 rejected
(genuinely a different song) in 15 s. *Rock Classics*, 200 tracks → 199 matched /
1 review (Deezer only has a live cut) in 77 s including the browser read.

## Using it

1. Paste the link → **Match tracks**. Results stream in as they resolve.
2. Filter to **Needs review** and work through them: **change** offers the other
   candidates plus a free Deezer search box, **find** does the same for the misses.
3. Pick the destination, which is always an explicit choice rather than something
   inferred:
   * **New playlist** — a fresh Deezer playlist, named after the Spotify one. Every
     match run refills that box from Spotify, so a second copy is never filed under
     the previous playlist's name; **Spotify name** puts it back if you overtype it.
     A warning appears if you already have a Deezer playlist by that name.
   * **Existing playlist** → **Append** adds to the *end* and skips tracks already
     in there, so re-running is safe. **Replace** empties the playlist first and
     asks before it does.
4. **Export CSV** dumps the whole match table, including what was not found.

## Layout

```
server.js               Express routes, the auth gate, SSE conversion stream
lib/auth.js             Google sign-in: authorization code flow, allow list
lib/session.js          signed session cookies, and the origin the app answers on
lib/users.js            one record per identity: profile + that person's Deezer
lib/secret.js           the local key, and encryption of what lands on disk
lib/paths.js            where the data directory is
lib/spotify-public.js   keyless read: embed JSON, then browser scroll for >100
lib/spotify.js          keyed read: client-credentials token, paged track reads
lib/deezer-gw.js        keyless write: Deezer's own gateway over your web session
lib/deezer.js           keyed write: OAuth, plus the public search used by both
lib/browser.js          Chrome/Edge/Chromium: headed login profile, headless scraper
lib/match.js            the strategy above, plus scoring
lib/normalize.js        title/artist normalisation and Greek transliteration
lib/convert.js          the fan-out over a playlist (6 lookups in flight)
lib/store.js            disk cache of every ISRC/search answer
lib/http.js             rate limiter + retrying JSON fetch
public/                 the single-page UI
scripts/probe.js        match a track list from the command line
```

Three things about Deezer worth knowing before touching `lib/deezer.js`: errors
arrive as HTTP 200 with an `{error:{…}}` body; the quota reports as `code 4` rather
than a 429; and a burst of searches gets an *Access Denied* HTML page from its edge
well before the documented 50 requests / 5 s, which is why the limiter sits at 22 and
an unparseable body is treated as a throttle and retried. The disk cache is what
makes a re-run instant — the same playlist twice costs no requests at all.
