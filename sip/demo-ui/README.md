# SIP Demo Console UI

**Last updated:** 2026-07-16

A small, stdlib-only web console for demoing the SIP voice-agent loop to non-technical viewers. It serves two synced interfaces over the same real call: a **SALES dashboard** (live transcript, pipeline log, post-call analysis) and a **CLIENT phone** (incoming-call screen, live conversation). No framework, no build step: edit the files in `static/` and refresh the browser.

> **What's the demo console vs the bridge:**
> The console (`demo_ui_server.py`) only shows what is happening. The actual voice loop (audio in, STT, LLM, TTS, audio out) runs in `sip/scripts/step2_stt_bridge.py`, which POSTs its log events to this console. The console never touches audio.

## How to start (UI only)

From the repo root:

```bash
cd ~/GlobiFYE/globifye-ai
venv/bin/python sip/demo-ui/demo_ui_server.py
```

Then open http://localhost:8090 in a browser.

**Verify it is up:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/login
```

Expected output: `200`.

Log in with an account from `demo_users.json` (demo-only auth: plaintext passwords, in-memory sessions, do not expose this port beyond localhost/LAN). The role on the account decides which interface you land on (sales dashboard or client phone).

This is enough to view and edit the UI. Placing a real call needs the full stack below.

## How to start (full call demo)

The console is one of four pieces. Start order:

| # | Piece | How to start | Why it is needed |
|---|-------|--------------|------------------|
| 1 | Asterisk (Docker) | see `sip/design-docs-sip/` step1 setup doc | Owns the SIP call; exposes ARI on `localhost:8088` |
| 2 | Softphone (Linphone) | open Linphone, confirm `test-endpoint` is registered | Acts as the customer's phone (microphone/speaker) |
| 3 | Bridge script | `venv/bin/python sip/scripts/step2_stt_bridge.py` (own terminal) | Runs the actual STT -> LLM -> TTS loop and streams events to the console |
| 4 | This console | `venv/bin/python sip/demo-ui/demo_ui_server.py` (own terminal) | Shows the call live and runs post-call analysis |

## Configuration

There is no config file of its own. Settings live at the top of `demo_ui_server.py` (port `8090`, ARI credentials, softphone endpoint), and secrets are read from `ai-pipeline/.env.local`:

| Variable | Required? | Used for |
|----------|-----------|----------|
| `GROQ_API_KEY` | Yes for post-call analysis | Sales-coach analysis after each call (`llama-3.3-70b-versatile`) |
| `SUPABASE_SIP_URL` / `SUPABASE_SIP_SERVICE_ROLE_KEY` | Optional | Sync finished calls to Supabase; falls back to `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` |

If neither Supabase pair is set, calls are stored as JSON files under `call-history/` only. If `GROQ_API_KEY` is missing the server still starts but prints a warning and post-call analysis fails.

The company registry (`../knowledge-base/companies.json`) is shared with the bridge script: it maps each demo business to its extension, TTS voice, and knowledge base file.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `OSError: [Errno 48] Address already in use` on start | A previous instance of this server is still running on port 8090 | Find it with `lsof -nP -iTCP:8090 -sTCP:LISTEN`, then `kill <PID>` and start again, or just use the already-running one at http://localhost:8090 |
| `WARNING: GROQ_API_KEY missing` on start | `ai-pipeline/.env.local` missing or key not set | Add `GROQ_API_KEY=...` to `ai-pipeline/.env.local` |
| `ModuleNotFoundError: requests` / `groq` | Started with system Python instead of the repo venv | Use `venv/bin/python`, not `python3` |

## Files

- `demo_ui_server.py` — the whole server (HTTP, SSE fan-out, ARI originate, post-call analysis)
- `static/` — the UI: `login.html`, `home.html/.js`, `sales.html/.js`, `client.html/.js`, `style.css`
- `demo_users.json` — demo accounts
- `call-history/` — one JSON record per finished call
- `supabase-schema.sql` — table schema for the optional Supabase sync
