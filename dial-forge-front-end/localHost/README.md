# Front-end demo localHost
This folder contains a Python script to locally host the front-end with the landingPage being the application's entry point.
This document details how to start the script and troubleshoot it.

## How to start (local host only)
from the repo root:
```bash
cd ~/dial-forge/dial-forge-front-end/
python3 localHost/dial_forge_front_end_server.py
```

Then open http://localhost:8000 in a browser.

## Product login integration

Use the front-end local server as the product UI entry point:

```text
http://localhost:8000/login.html
```

The local server exposes the first product auth endpoints:

```text
POST /api/auth/login
GET  /api/me
POST /api/auth/logout
```

For local development, the server attempts Supabase Auth first. If Supabase Auth
is unavailable or a local demo user has not been seeded yet, it can fall back to:

```text
localHost/product_demo_users.json
```

Seed or refresh the demo users in Supabase:

```bash
python3 localHost/sync_product_demo_users_to_supabase.py
```

Seed or refresh the GlobiFYE demo contacts that were previously hardcoded in
static product screens such as `powerDialer.html`:

```bash
python3 localHost/sync_product_demo_contacts_to_supabase.py
```

The current Supabase `contacts` table stores the shared CRM basics:
`organization_id`, `name`, `email`, `phone`, and `company`. UI-only fields from
the static mock data, such as `title`, `priority`, `status`, and `avatar_url`,
are kept in `product_demo_contacts.json` for the next schema/API step.

Seed or refresh the GlobiFYE power dialer queue from those contacts:

```bash
python3 localHost/sync_product_demo_call_queue_to_supabase.py
```

The local product API exposes the queue for the signed-in user's organization:

```text
GET /api/call-queue
PATCH /api/call-queue/:queue_id
```

Power Dialer operation write-back currently uses the existing database status
vocabulary:

```text
UI connected / voicemail -> DB completed
UI skipped / hungup       -> DB failed
UI waiting / calling      -> DB queued
```

Useful queue smoke check:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alex.rivera@globifye.com","password":"demo1234"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -s http://localhost:8000/api/call-queue \
  -H "Authorization: Bearer $TOKEN"

curl -s -X PATCH http://localhost:8000/api/call-queue/14 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"connected"}'
```

Power Dialer outcome/event persistence is defined in:

```text
dial-forge-ai/ai-pipeline/supabase/migrations/002_call_queue_events.sql
```

Apply that SQL once in the shared Supabase project before expecting event rows
to persist. Until the table exists, `PATCH /api/call-queue/:queue_id` still
updates `call_queue.status` and returns an `event.persisted=false` payload with
the event that would have been written.

After the migration is applied, inspect events for a queue item:

```bash
curl -s http://localhost:8000/api/call-queue/14/events \
  -H "Authorization: Bearer $TOKEN"
```

Seeded demo credentials:

```text
alex.rivera@globifye.com / demo1234
sophia.patel@globifye.com / demo1234
marcus.reed@globifye.com / demo1234
elena.morales@globifye.com / demo1234
daniel.kim@globifye.com / demo1234
maya.chen@acmehealth.com / demo1234
```

Useful smoke checks:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"maya.chen@acmehealth.com","password":"demo1234"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -s http://localhost:8000/api/me \
  -H "Authorization: Bearer $TOKEN"
```

The browser stores the local token under `dialforgeAuthToken` and normalized
current-user data under `dialforgeCurrentUser`. When Supabase Auth succeeds, the
token is a Supabase access token and `/api/me` hydrates the user from Supabase
Auth metadata plus `public.users` and `public.organizations`.

## SIP handoff integration

The front-end local server also proxies SIP demo API requests:

```text
http://localhost:8000/sip-demo/* -> http://127.0.0.1:8400/*
```

This lets `activeCall.html` call the SIP demo server from the same browser
origin. The SIP demo server then proxies handoff control to the bridge process
on `127.0.0.1:8500`.

For AI-human-AI handoff testing, run these three processes:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai
venv/bin/python -u sip/scripts/stt_bridge_ai_human_transfer.py
venv/bin/python -u sip/demo-ui/demo_ui_server.py

cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-front-end
python3 localHost/dial_forge_front_end_server.py
```

Useful smoke checks:

```bash
curl -s http://localhost:8000/sip-demo/api/call-room
curl -s -X POST http://localhost:8000/sip-demo/api/handoff/accept
curl -s -X POST http://localhost:8000/sip-demo/api/handoff/resume-ai \
  -H 'Content-Type: application/json' \
  -d '{"handback_note":"Returning to AI from the front-end"}'
curl -s -X POST http://localhost:8000/sip-demo/api/handoff/failure \
  -H 'Content-Type: application/json' \
  -d '{"status":"declined","reason":"Human declined from front-end"}'
```

When no call is active, the handoff endpoints should return `409 no active
call`. That means the proxy path is working; place/answer a SIP call before
testing successful take-over or return-to-AI behavior.

**Verify it is up:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/landingPage.html
```

Expected output: `200`

### Stopping the server
Press:
```text
Ctrl + c
```
in the terminal running the server.

**Verify it is down:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/landingPage.html
```

Expected output: `000`
