# GlobiFYE — AI Team

This repository contains the work of the GlobiFYE AI subteam.

## Repository Structure

- **`ai-pipeline/`** — AI pipeline development and related code
- **`sip/`** — SIP voice-agent work: bridge scripts, demo console UI, knowledge base
- **`design-docs/`** — tech decision documentation and files coordinated with other teams
- **`[member-name]/`** — Individual folders for each AI team member's personal notes and working files

## How to run the frontends

There are three frontend areas in this repo. Each has its own README with full setup, environment variables, and troubleshooting; the quick-start commands are:

| Frontend | Start command (from repo root) | URL | Details |
|----------|-------------------------------|-----|---------|
| SIP demo console | `venv/bin/python sip/demo-ui/demo_ui_server.py` | http://localhost:8400 | [sip/demo-ui/README.md](sip/demo-ui/README.md) |
| AI pipeline web UI | `cd ai-pipeline && npm run dev` | http://localhost:3400 | [ai-pipeline/README.md](ai-pipeline/README.md) |
| Frontend team references | none, open the `.html` files directly in a browser | n/a | [design-docs/frontend-sync/README.md](design-docs/frontend-sync/README.md) |

Notes:

- Both the SIP demo console and the pipeline UI read secrets from `ai-pipeline/.env.local` (not committed). See each README for the variable list.
- The SIP demo console alone only shows the UI; a full live-call demo also needs Asterisk, a registered softphone, and the bridge script running. Start order is in [sip/demo-ui/README.md](sip/demo-ui/README.md).
