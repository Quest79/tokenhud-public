# TokenHUD

A local dashboard for your Claude Code and Codex usage: live requests, output speed (tok/s), cost estimates, context and cache health, model comparisons, and plan meters (5-hour and weekly).

It runs entirely on your own computer. It reads the logs Claude Code and Codex already write and shows them in a window.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org) 22.5 or newer
- Microsoft Edge (already on Windows), or Rust if you want the tray app
- Claude Code and/or Codex, used at least once (so there are logs to read)

## Setup

1. Download or clone this repo.
2. Double-click **`TokenHUD.bat`**. The first run installs packages and builds the app, then opens the dashboard. Later runs just open it.
3. Done. The dashboard fills in from your existing logs and updates live while you work.

To run it by hand instead:

```
npm install
npm run build
node server/server.mjs
```

Then open http://127.0.0.1:4317 (change the port with the `TOKENHUD_PORT` environment variable).

### Optional extras (all off until you turn them on)

- **Plan % tracking:** reads your 5-hour and weekly plan meters every minute, only while you are actively using Claude. Turn on in Settings → Plan % tracking.
- **Status line feed and hooks:** exact "what is Claude doing right now" and cache timers. Install from the Settings page. It shows the change to `~/.claude/settings.json` first, backs that file up, keeps any status line you already have, and has a Remove button.
- **Always-on server:** keeps the data server running in the background with the window closed. Install [NSSM](https://nssm.cc) (`winget install NSSM.NSSM`), copy `nssm.exe` to `runtime\nssm.exe`, then double-click **`Install TokenHUD Service.bat`** (one admin prompt). Undo with `Install TokenHUD Service.bat remove`.

## What it reads

Only files already on your computer, read-only:

- Claude Code transcripts: `~/.claude/projects/`
- Codex sessions: `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/session_index.jsonl`, `~/.codex/logs_2.sqlite`
- Only with Plan % tracking on: your Claude Code login token from `~/.claude/.credentials.json` (and `~/.claude-acct2/` for a second account, if you have one)

## What it stores

Everything stays in one local folder, `%APPDATA%\TokenHUD\`:

- `cache.json`: token counts, timings, costs, session titles and your prompt text, so the dashboard starts fast
- `settings.json`: your dashboard settings
- `integration.json`: what was added to Claude Code's settings, so it can be removed cleanly

Delete that folder at any time to wipe everything TokenHUD has stored.

## What it sends

- **Nothing to the author, and nothing to any analytics or telemetry service.** No tracking, no crash reports, no update checks, no fonts or scripts loaded from the internet.
- The server listens on `127.0.0.1` only, so other devices on your network cannot reach it.
- **One exception, off by default:** with Plan % tracking on, it sends your own Claude Code login token to `api.anthropic.com` (Anthropic's usage endpoint) to read your own plan meters, the same call Claude Code makes. Nothing else goes with it.

## What it does not collect

- No account details, emails, names, API keys or payment info
- It never opens your project files. Transcripts can contain code Claude read; TokenHUD shows that only when you click a tool call, and does not copy it into its cache.
- Nothing from your browser, clipboard or screen
