@echo off
REM Spotify -> Deezer playlist copier. No API keys needed.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
echo Starting Spotify-to-Deezer on http://localhost:4870 ...
echo (Optional: put Spotify/Deezer app keys in .env - see .env.example)
start "" http://localhost:4870
node --env-file-if-exists=.env --env-file-if-exists=.env.local server.js
