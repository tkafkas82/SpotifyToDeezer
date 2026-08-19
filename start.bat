@echo off
REM Spotify -> Deezer playlist copier
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
if not exist .env (
  echo Creating .env from .env.example - put your Spotify and Deezer app keys in it.
  copy /y .env.example .env >nul
  notepad .env
)
echo Starting Spotify-to-Deezer on http://localhost:4870 ...
start "" http://localhost:4870
node --env-file-if-exists=.env --env-file-if-exists=.env.local server.js
