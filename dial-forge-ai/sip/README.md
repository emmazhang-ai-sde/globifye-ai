# SIP Voice Agent - Demo

A phone-call AI agent: a caller talks to a company's AI over SIP, and a browser console shows the call live from both the sales and the customer side.

Design docs: [`design-docs-sip/`](design-docs-sip/). This README is just how to run it.

```
Softphone (Linphone)  <->  Asterisk (Docker)  <->  stt_bridge_ai_human_transfer.py  (STT -> LLM -> TTS + handoff)
                                                                        |  events
                                                                        v
                                                                 demo_ui_server.py  ->  browser (localhost:8400)
```

## Folders

| Path | What |
|---|---|
| `scripts/stt_bridge_ai_human_transfer.py` | Latest runtime: call audio -> Modulate STT -> Groq LLM -> Deepgram Aura TTS -> back into the call, with AI-human-AI handoff |
| `scripts/archive/` | Older bridge and transport experiments kept for reference only |
| `demo-ui/` | The web console (stdlib Python server + static pages) |
| `knowledge-base/` | Per-company KB + `companies.json` (extension, voice, KB file) |

## Prerequisites

- Docker running, and the `asterisk-mvp` container (see the Step 1 doc if it does not exist yet).
- Python deps in the repo venv. **Always use `venv/bin/python`** - the system `python3` does not have them.
- A softphone (Linphone) registered to `test-endpoint` (Step 1 doc).
- API keys in `ai-pipeline/.env.local` (Deepgram, Groq, Modulate; Supabase is optional).

## Run it - three terminals, all from `globifye-ai/`

```bash
# 1. Asterisk (the SIP server). Container already exists -> start it:
docker start asterisk-mvp
#    First time only, if the container does not exist:
#    docker run -d --name asterisk-mvp \
#      -p 5060:5060/udp -p 8088:8088/tcp -p 10000-10100:10000-10100/udp \
#      -v $(pwd)/asterisk-config:/etc/asterisk andrius/asterisk

# 2. The pipeline (STT -> LLM -> TTS). Must be the venv Python, with -u:
venv/bin/python -u sip/scripts/stt_bridge_ai_human_transfer.py

# 3. The web console:
venv/bin/python sip/demo-ui/demo_ui_server.py
```

Terminal 3 should print:

```
Demo UI running at http://localhost:8400
Waiting for bridge events on POST /internal/events (from stt_bridge_ai_human_transfer.py)
Supabase mirror: ON -> https://...   (or OFF if no key)
```

## The web pages (localhost)

Open **http://localhost:8400** and sign in (accounts below). After login you land on the chooser; open each view in its own window for a side-by-side demo.

| Page | URL | What it is |
|---|---|---|
| Sign in | `http://localhost:8400/login.html` | Demo login |
| Chooser | `http://localhost:8400/home.html` | Pick a view |
| Sales dashboard | `http://localhost:8400/sales.html` | Live transcript, pipeline log, call history, post-call analysis |
| Customer phone | `http://localhost:8400/client.html` | Incoming-call screen + live conversation |

Demo accounts (password `demo123`):

| Email | Company | Line |
|---|---|---|
| `alice@pacificbeef.com` | Pacific Beef Trading | 1000 |
| `dana@pacificbeef.com` | Pacific Beef Trading | 1000 |
| `bob@globifye.com` | GlobiFYE | 2000 |
| `marcus@globifye.com` | GlobiFYE | 2000 |

Two sales-rep logins per company.

## The call (softphone routing)

Place the call from either browser view, or dial directly from Linphone. The number reaches the matching business, whose AI sales rep answers grounded in that company's knowledge base and works the prospect through a five-stage pipeline (Prospect -> Contact -> Demo -> Proposal -> Closing):

| Dial | Business | Sells | Voice |
|---|---|---|---|
| `1000` | Pacific Beef Trading | USDA beef export (B2B) | `aura-2-thalia-en` |
| `2000` | GlobiFYE | AI voice agents — product: DialForge (B2B) | `aura-2-arcas-en` |

Answer the softphone when it rings - that carries the caller's voice for both browser views. Talk, then hang up; on the sales dashboard click **Run analysis** for the post-call summary.

## Quick checks

```bash
# Is Asterisk up and the bridge registered to it?
docker exec asterisk-mvp asterisk -rx "ari show apps"      # lists sip-mvp-app
docker exec asterisk-mvp asterisk -rx "dialplan show sip-mvp"   # shows 1000 + 2000
```

If a call rings but drops the instant you answer, the bridge (terminal 2) is not running - it must be started with `venv/bin/python`, not system `python3`.
