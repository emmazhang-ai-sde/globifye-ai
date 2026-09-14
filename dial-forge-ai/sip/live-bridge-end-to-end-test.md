# RAG Dashboard Config + Live Bridge Test

**Last updated:** 2026-09-12

This is the copy/paste runbook for testing the current RAG/dashboard configuration path and, only when needed, validating it through the live SIP bridge.

```
DialForge front-end product UI
  -> RAG / agent dashboard configuration
  -> knowledge profile / runtime capability binding
  -> optional live bridge phone-call validation
```

The current live bridge script is: ```/Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai/sip/scripts/stt_bridge_ai_human_transfer.py```

The current local bridge-side source of truth is:

```text
/Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai/sip/knowledge-base/companies.json
/Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai/sip/knowledge-base/knowledge_profiles.json
/Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai/sip/knowledge-base/globifye/
/Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai/sip/knowledge-base/pacificbeef/
```

The product front-end is the UI to use. The old `sip/demo-ui` browser pages are not part of the current target flow.

## 1. Start The Front-End Product UI

Open a terminal:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-front-end

python3 localHost/dial_forge_front_end_server.py
```

Expected: the front-end local server starts on:

```text
http://localhost:8000
```

Open the product UI from:

```text
http://localhost:8000/login.html
```

Useful front-end smoke check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/login.html
```

Expected output:

```text
200
```

Current local product demo credentials:

```text
alex.rivera@globifye.com / demo1234
sophia.patel@globifye.com / demo1234
marcus.reed@globifye.com / demo1234
elena.morales@globifye.com / demo1234
daniel.kim@globifye.com / demo1234
maya.chen@acmehealth.com / demo1234
```

## 2. Configure RAG / Agent Dashboard

Use the product front-end dashboard/configuration pages to edit the RAG or agent settings being customized.

For the current bridge to reflect a config change, that change must end up in the backend data that the bridge actually reads. Today that means either:

```text
sip/knowledge-base/companies.json
sip/knowledge-base/knowledge_profiles.json
sip/knowledge-base/<company_key>/
```

or a newer API/database source that has replaced those files.

Important: a config that only changes browser local state is not enough for the live bridge. The bridge process reads its company and knowledge profile binding at startup, then resolves the active company when a SIP call enters `sip-mvp-app`.

## 3. Validate The Bridge-Side Config Without A Phone Call

Run these checks after saving dashboard/config changes:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai

venv/bin/python -m unittest discover -s sip/scripts -p 'test_*.py'
```

These tests validate the knowledge profile binding, runtime context, exposed capability tools, and retrieval behavior without needing Asterisk, Linphone, or a live call.

## 4. Optional: Start The Live Bridge With Runtime Capability Tools

Only do this when you want to verify that the dashboard/RAG config works during an actual phone call.

Use `venv/bin/python`, not system `python3`, or the bridge may fail because dependencies are missing.

First confirm Asterisk is online:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai

docker ps --filter name=asterisk-mvp --format '{{.Names}} {{.Status}}'
```

Expected: the output includes `asterisk-mvp` and shows the container as running.

Then verify ARI:

```bash
curl -sS --max-time 2 -u sip-mvp-user:changeme_use_a_real_secret \
  http://localhost:8088/ari/asterisk/info
```

Expected: JSON from Asterisk. If this times out or returns unauthorized, fix the Asterisk container/config before starting the bridge.

Then start the bridge with the Runtime Capability System enabled:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai

ENABLE_RUNTIME_CAPABILITY_TOOLS=1 \
venv/bin/python -u sip/scripts/stt_bridge_ai_human_transfer.py
```

Expected startup logs:

```text
[CONTROL] listening on http://127.0.0.1:8500
[RTP] listening on UDP 9000
[ARI] connected, waiting for calls into sip-mvp-app
```

## 5. Alternative: Start The Live Bridge Without Runtime Capability Tools

Use this when you want the original phone behavior without the runtime tools layer:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai

venv/bin/python -u sip/scripts/stt_bridge_ai_human_transfer.py
```

Expected startup logs are the same:

```text
[CONTROL] listening on http://127.0.0.1:8500
[RTP] listening on UDP 9000
[ARI] connected, waiting for calls into sip-mvp-app
```

## 6. Check The Bridge Control Server

Run this in a second terminal while the bridge is running:

```bash
lsof -nP -iTCP:8500 -sTCP:LISTEN
```

Expected: a Python process listening on `127.0.0.1:8500` or `*:8500`.

## 7. Optional: Place A Real SIP Call With Linphone

Use Linphone only for the final live runtime validation. The front-end product UI does not replace the SIP caller unless the current product flow has real outbound SIP dialing wired in.

Current local extensions are defined by the Asterisk dialplan and `companies.json`:

| Dial in Linphone | Company / config scope |
|---|---|
| `1000` | Pacific Beef Trading / `pacificbeef` |
| `2000` | GlobiFYE / `globifye` |

To validate the GlobiFYE RAG/dashboard config, dial:

```text
2000
```

Expected bridge logs after the call arrives:

```text
[CALL] arrived: ...
[AGENT] GlobiFYE
[RUNTIME_CONTEXT] built for active call
[RUNTIME_TOOLS] exposed ...
```

Ask a question that should hit the configured knowledge base. With `ENABLE_RUNTIME_CAPABILITY_TOOLS=1`, the bridge should expose and, when the model chooses it, execute `retrieve_company_kb`.

## 8. One-Pass Copy/Paste Checklist: Config First

Terminal 1: front-end product UI.

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-front-end

python3 localHost/dial_forge_front_end_server.py
```

Terminal 2: bridge-side config tests.

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai

venv/bin/python -m unittest discover -s sip/scripts -p 'test_*.py'
```

Optional Terminal 3: live bridge with Runtime Capability System enabled.

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-ai

ENABLE_RUNTIME_CAPABILITY_TOOLS=1 \
venv/bin/python -u sip/scripts/stt_bridge_ai_human_transfer.py
```

Optional Terminal 4: confirm the bridge control server and front-end are listening.

```bash
lsof -nP -iTCP:8500 -sTCP:LISTEN
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/login.html
```

Then open `http://localhost:8000/login.html`, use the product front-end UI for configuration, and use Linphone only if you are doing the final live call validation.

## 9. Troubleshooting Notes

If the call reaches Asterisk but the bridge never receives it, confirm the ARI app is registered:

```bash
docker exec asterisk-mvp asterisk -rx "ari show apps"
```

Expected: `sip-mvp-app` appears in the app list after the bridge starts.

If the call drops as soon as it is answered, confirm the bridge process is running and was started with:

```bash
venv/bin/python -u sip/scripts/stt_bridge_ai_human_transfer.py
```

If port `8500` is already in use, find the existing process:

```bash
lsof -nP -iTCP:8500 -sTCP:LISTEN
```

Stop the old bridge process, then start the current one again.

## 10. What To Update When The Code Changes

When the latest startup program changes, update these parts first:

```text
Current live bridge script
Bridge command with ENABLE_RUNTIME_CAPABILITY_TOOLS=1
Bridge command without tools
Expected startup logs
Any required startup order changes
```
