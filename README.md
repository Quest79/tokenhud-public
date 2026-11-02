# TokenHUD

A local dashboard for Claude Code and Codex token use: live requests, output speed, cost estimates, context and cache health, and plan meters.

- Reads the transcript logs Claude Code and Codex already keep on your machine. Nothing is sent anywhere.
- The server binds to `127.0.0.1` only (port 4317, override with `TOKENHUD_PORT`).
- Optional: plan % tracking calls the Anthropic usage endpoint with your own Claude Code login, off by default.

## Run

Double-click `TokenHUD.bat` (Windows), or:

```
npm ci
npm run build
node server/server.mjs
```

Then open http://127.0.0.1:4317.
