# Step 5 - PM Demo Console (two interfaces, multi-company, on-demand analysis)

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md), section 4, Step 5
**Builds on:** [Step 4, the verified loop](./step4-end-to-end-mvp-verification.md)
**Status: complete and verified (2026-07-10 through 2026-07-13).**

> **Superseding work in design (2026-07-21):** Danish asked on 7/20 that this console be merged into the frontend team's real product screens, which now live in the shared repo. The design for that is [`design-docs/frontend-sync/demo-ui-frontend-merge-design-doc.md`](../../frontend-sync/demo-ui-frontend-merge-design-doc.md). Nothing below has changed yet; this doc still describes what runs today.

A standalone web console for demoing the loop visually: sign in, place or receive a call from the browser, watch the live transcript, run a post-call analysis on demand. Deliberately not the frontend team's Next.js app (too complex for a demo, and their build is another team's concern). Everything lives in `sip/demo-ui/`.

| Section | What's there |
|---|---|
| [1. Architecture](#1-architecture-a-second-renderer-of-the-existing-log-stream) | Why a separate mini server; how events reach the browser |
| [2. Two interfaces](#2-two-interfaces-over-one-real-call) | Sales dashboard and client phone, synced over one real call |
| [3. Multi-company + knowledge base](#3-multi-company-routing-and-per-company-knowledge-base) | Number dialed picks the business, its KB, and its voice |
| [4. Post-call analysis](#4-post-call-analysis-on-demand-same-concept-as-the-batch-pipeline) | On-demand sales-coach analysis with clickable key topics |
| [5. Run it](#5-run-it) | Commands, demo accounts, PM demo flow |
| [6. Verification log](#6-verification-log) | Dated verification records |
| [7. Auth and users](#7-auth-and-users) | Demo-only login, honest limits |
| [8. Debugging log](#8-debugging-log-call-dropped-the-instant-the-softphone-was-answered-2026-07-13) | The instant-disconnect saga and its four fixes |

## 1. Architecture: a second renderer of the existing log stream

| Option | Why not / why yes |
|---|---|
| Reuse the frontend team's Next.js app (localhost:3000) | Too complex, couples the SIP MVP to another team's build, no event path into it today |
| Terminal only (Step 3.3 logging) | Works, but not PM-friendly |
| **Small stdlib-only Python server + static pages (chosen)** | Zero new dependencies, isolated in `sip/demo-ui/`, bridge script needs only an additive hook |

The design principle: **the UI renders the same `log()` stream the terminal already shows.** The bridge's `log()` also queues each event to a daemon thread that POSTs it to the UI server; if the UI server is down, events drop silently and the call loop is unaffected. Since 2026-07-13 the bridge also sends a heartbeat event every 10s (see section 8 for why).

```
+----------------------------+          +-----------------------------+
|  step2_stt_bridge.py       |          |  demo_ui_server.py          |
|  (pipeline + log() hook    |  POST    |  (port 8400)                |
|   + 10s heartbeat)         | -------> |  /internal/events           |
+----------------------------+          +-----------------------------+
                                                       |
                                                       |  Server-Sent Events
                                                       |  (role-tagged)
                                                       v
                                         +-----------------------------+
                                         |  Browser (login required)   |
                                         |  sales.html | client.html   |
                                         +-----------------------------+
```

> **What's Server-Sent Events (SSE):**
> A one-way HTTP stream from server to browser. The browser opens `/api/events` once and the server keeps pushing lines. Simpler than WebSockets (plain HTTP, auto-reconnect built into the browser's `EventSource`), and one-way is all a display needs.

Files:

| File | Purpose |
|---|---|
| `sip/demo-ui/demo_ui_server.py` | The whole server: login, static pages, role-tagged SSE fan-out, ARI calling, call history, on-demand analysis, Supabase mirror (Step 6) |
| `sip/demo-ui/demo_users.json` | Demo accounts (one per business), plaintext passwords, demo-only |
| `sip/demo-ui/static/login.html` | Sign-in page |
| `sip/demo-ui/static/home.html` + `home.js` | Post-login chooser: open the sales and client views |
| `sip/demo-ui/static/sales.html` + `sales.js` | Sales dashboard: live transcript, pipeline log, history, analysis |
| `sip/demo-ui/static/client.html` + `client.js` | Client phone: incoming-call ring, live conversation only |
| `sip/demo-ui/static/style.css` | Shared styles (system fonts only, no CDN, works offline) |
| `sip/demo-ui/call-history/` | One JSON record per call (created at runtime) |

## 2. Two interfaces over one real call

| Interface | Page | Shows | Places |
|---|---|---|---|
| Sales dashboard | `/sales.html` | Live transcript, pipeline log, call history, **post-call analysis** | "Call a customer" |
| Client phone | `/client.html` | Phone screen: incoming-call ring, live conversation. No log, no analysis | "Call [business]" |

Whichever side places the call, the other side shows an incoming-call screen. The audio is still the Linphone softphone in both directions (it is the client's voice); the two pages are synced visual views of that one real call, and the ring is a UI state broadcast by the server. In-browser microphone audio is the WebRTC item deferred in Step 7.

```
Sales calls client (outbound)          Client calls sales (inbound)
  sales page: "Calling..."               client page: "Calling..."
  server originates -> softphone RINGS   server originates -> softphone RINGS
  client page: "Incoming: <business>"    sales page: "Incoming: Client"
  answer softphone -> AI conversation    answer softphone -> AI conversation
  both pages show the transcript         both pages show the transcript
  sales page (only) can run analysis
```

Wiring: `POST /api/call {direction}` sets a ringing state, broadcasts `incoming_call` to the receiving role, and originates through ARI (softphone first, then the dialplan extension, so it is the same path as dialing from Linphone directly). The bridge's `arrived` event flips both pages to the live call. `POST /api/hangup` cancels a ring or ends a live call. SSE streams are role-tagged (`/api/events?role=sales|client`); `analysis_ready` is sent only to `role=sales`.

> **What's originate:**
> An ARI request that asks Asterisk to create a call leg itself, instead of waiting for one to come in. Here the leg goes to the softphone first; the `extension`/`context` parameters send the answered call into the `[sip-mvp]` dialplan.

**Honest caveat on the sales-only analysis:** this is interface-level separation for the demo, not a hardened access boundary. Both views share one demo login, so a determined user could still hit `/api/calls/<id>` directly. Real per-role authorization is future work (Step 7).

## 3. Multi-company routing and per-company knowledge base

Which business answers is decided by the number dialed. Each is a B2B company whose AI sales rep works a prospect through a five-stage pipeline (Prospect -> Contact -> Demo -> Proposal -> Closing); each has its own knowledge base (product, pricing, pipeline playbook) and TTS voice.

| Line | Business | Sells | Voice | Knowledge base |
|---|---|---|---|---|
| 1000 | Pacific Beef Trading | USDA beef export | `aura-2-thalia-en` | `sip/knowledge-base/pacificbeef.md` |
| 2000 | GlobiFYE | AI voice agents (product: DialForge) | `aura-2-arcas-en` | `sip/knowledge-base/globifye.md` |

`sip/knowledge-base/companies.json` is the single source of truth (extension, voice, KB file per company); the bridge and the UI server both read it, so adding a third company is a one-file change plus a dialplan line.

The dialplan passes the company key as a second Stasis argument; the bridge reads it off `StasisStart`, loads that company's system prompt, and switches the TTS voice for the call:

```
Caller dials 1000                     Caller dials 2000
        |                                     |
        v                                     v
[sip-mvp] 1000 ->                     [sip-mvp] 2000 ->
  Stasis(sip-mvp-app, pacificbeef)      Stasis(sip-mvp-app, globifye)
        |                                     |
        +------------------+------------------+
                           v
        bridge StasisStart: company_key = event["args"][0]
                           v
        conversation_history = [that company's system prompt]
        current_voice        = thalia | arcas
                           v
        rest of the loop answers as that business
```

> **Why a Stasis argument, not the dialed number:**
> The extension is also readable from the event, and the bridge falls back to it. But an explicit key in the dialplan keeps the company mapping in one obvious place and survives a change of extension numbers.

**How the KB grounds the agent:** the company's entire `sip/knowledge-base/<company>.md` (roughly 550-650 tokens today) is injected into the LLM system prompt for the call, with an instruction to answer only from it and never invent prices, hours, or availability. This is full-prompt injection, not RAG; at the current KB size that is the right call (zero added latency, no retrieval misses). The retrieval evolution and its trigger conditions are Step 7 territory, detailed in the [RAG design doc](../rag-per-company-kb-design-doc.md). Each company row in the dialer has a **KB** button showing exactly what the agent answers from.

**Fallback when there is no grounded answer (added 2026-07-13):** whenever the KB does not cover a question, or a company has no KB connected at all (`kb_file` missing or empty in `companies.json`), the agent replies with the standard line, then collects the caller's name and phone number:

> "I'm not sure I have the details you're looking for, but I can have a team member follow up with you. May I have your name and a phone number, please?"

The exact wording is `FALLBACK_LINE` in `step2_stt_bridge.py`. A company with no KB runs entirely on this fallback prompt until its KB (or later the RAG library, Step 7) is connected; the loader picks up a new KB file automatically on the next bridge restart.

The `asterisk-config/` folder is bind-mounted into the container at `/etc/asterisk`, so a dialplan edit only needs `docker exec asterisk-mvp asterisk -rx "dialplan reload"`.

## 4. Post-call analysis: on demand, same concept as the batch pipeline

The analysis is a port of `ai-pipeline/lib/llm.ts` (same sales-coach prompt shape, same `llama-3.3-70b-versatile` on Groq), so the PM sees one consistent analysis concept across the pre-recorded workflow and the live SIP loop.

| Batch pipeline (`lib/llm.ts`) | SIP demo (`demo_ui_server.py`) |
|---|---|
| Speakers inferred by the LLM from context | Speakers pre-labeled: Client = caller, Agent = the AI |
| LangChain `withStructuredOutput` + Zod schema | Groq JSON mode + the schema spelled out in the prompt |
| Runs as a pipeline step | Runs only when the sales user clicks **Run analysis** (`POST /api/analyze/<call_id>`) |

On-demand was a deliberate change (2026-07-13): it saves a paid LLM call per call and lets the user pick which calls to analyze. The rendered analysis includes clickable **key topics**: each topic chip jumps the transcript to the moment it starts (transcript bubbles carry their seconds-into-call timestamps). Caller turns are labeled **Client** everywhere (transcript, incoming-call screen, analysis speakers), and the transcript is a single left-aligned column.

## 5. Run it

Two terminals, both from `globifye-ai/`. Both must use the venv Python (system `python3` does not have the dependencies; that exact mistake caused the section 8 debugging session):

```bash
# terminal 1 -- the pipeline
venv/bin/python -u sip/scripts/step2_stt_bridge.py

# terminal 2 -- the demo UI
venv/bin/python sip/demo-ui/demo_ui_server.py
```

Expected output in terminal 2:

```
Demo UI running at http://localhost:8400
Waiting for bridge events on POST /internal/events (from step2_stt_bridge.py)
Supabase mirror: ON -> https://... (or OFF with instructions if keys are missing)
```

Demo accounts (password `demo123` for all), two sales-rep logins per company: `alice@pacificbeef.com`, `dana@pacificbeef.com` (Pacific Beef Trading, line 1000); `bob@globifye.com`, `marcus@globifye.com` (GlobiFYE, line 2000).

**Demo flow for the PM:**

1. Sign in; land on the chooser; open the sales dashboard and the client phone in separate windows.
2. From either side, place a call. The other side shows the incoming-call screen; Linphone rings; answer it.
3. Talk to the agent. Final transcripts appear as chat lines on both views; the sales dashboard's bottom log panel shows the raw stream (every STT partial, with the same `+ms` stamps as the terminal).
4. Hang up. On the sales dashboard, click **Run analysis**: summary, clickable key topics, objections with coaching suggestions, what went well. Past calls stay in the history list.

## 6. Verification log

**2026-07-10 (initial console, single-page version), all passed:** login/session round-trip, protected-page redirects, dial input validation, and a full simulated call (events POSTed to `/internal/events`) producing SSE delivery, a saved call record, and a real Groq analysis. Note: the dial-by-number endpoint used that day (`/api/dial`) has since been replaced by direction-based `/api/call`.

**2026-07-10 (multi-company), all passed:** dialplan reload showed both extensions with correct Stasis arguments; per-company dial responses; KB endpoints; two simulated calls each tagged with the right business and analyzed with the right business context; bridge company-load path checked in isolation (both KB files resolve, voices distinct).

**2026-07-10 (two interfaces), all passed:** with one `role=sales` and one `role=client` SSE stream open, a simulated call delivered transcript/connected/ended events to both, while `analysis_ready` reached sales only (client stream: 0 occurrences). `POST /api/call {sales_to_client}` broadcast `incoming_call` with `target_role=client`; `/api/hangup` cancelled the ring on both.

**2026-07-13 (refinements), all passed:** analysis no longer auto-runs (record shows `analysis: null` after call end until the button is clicked); `POST /api/analyze/<id>` returns the analysis and labels speakers "Client"; unknown call ids get a clean 404.

## 7. Auth and users

Demo-only: users live in `demo_users.json` (plaintext passwords), sessions are in-memory cookies, no HTTPS. Each account belongs to one of the two businesses, and the dialer marks that business as "your line". Do not expose port 8400 beyond localhost/LAN. Real authentication and per-role authorization are future work (Step 7).

## 8. Debugging log: call dropped the instant the softphone was answered (2026-07-13)

**Symptom:** clicking "Call a customer" rang the softphone, but answering disconnected instantly.

**Root cause:** the bridge script was not running (an earlier start with system `python3` had failed on `ModuleNotFoundError`; deps live in the venv). A call reaching `Stasis(sip-mvp-app)` with no application connected is hung up by Asterisk the moment it is answered. The UI's liveness check was fooled: Asterisk keeps the app listed in `ari show apps` (and returns 200 on `GET /ari/applications/sip-mvp-app`) even after the bridge exits, because leftover channels keep the registration alive.

| Fault | Evidence | Fix |
|---|---|---|
| Bridge not running | `ps` showed 0 bridge processes; the demo server had zero `arrived`/`AGENT` events from the real attempts | Start with the venv: `venv/bin/python -u sip/scripts/step2_stt_bridge.py` |
| Liveness check gave a false "OK" | ARI app registration lingered with no process running | Bridge heartbeats to the UI server every 10s; `/api/call` rings only if a heartbeat arrived in the last 30s, otherwise returns "Bridge script isn't running" |
| Bridge could die silently on one bad call | 16 orphaned externalMedia channels + bridges, 94-140h old, from an exited process | Each ARI event handled in `try/except`: one bad call is logged and skipped, the process stays up |
| Every call leaked its bridge + externalMedia channel | The same 16 orphaned `UnicastRTP` channels | `StasisEnd` tears down that call's bridge + externalMedia channel (verified: 0 leaks after a call) |

**Diagnostic note:** `logger.conf` only records `notice,warning,error`, so call-lifecycle detail is not in the container's `messages.log`. Watch the bridge's own stdout (run with `-u`) or `docker exec asterisk-mvp asterisk -rx "core show channels"`.

## Next

[Step 6 - Supabase data sync](./step6-supabase-sync.md): getting every call, transcript, and analysis into the database.
