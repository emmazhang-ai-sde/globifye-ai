"""
SIP loop PM-demo UI server.

A deliberately small, stdlib-only web console for demoing the SIP voice-agent
loop (step2_stt_bridge.py) to non-technical viewers. It does four things:

1. Serves two synced interfaces over the same real call (static/ folder, no
   framework, no build step -- fully separate from the frontend team's app):
   a SALES dashboard (live transcript + pipeline log + post-call analysis)
   and a CLIENT phone (incoming-call screen + live conversation, no analysis).
   Which side rings depends on the call direction; see /api/call.
2. Receives every log() event from step2_stt_bridge.py via POST
   /internal/events (see the DEMO UI ADDITION block in that file) and fans
   it out to connected browsers over Server-Sent Events, filtered by role so
   the analysis reaches only the sales interface.
3. Places a call through ARI originate: Asterisk rings the registered
   softphone (test-endpoint / Linphone), and once answered the call runs the
   normal [sip-mvp] dialplan into the Stasis app. The softphone stays the
   microphone/speaker (the customer's voice); this server never touches audio.
4. When a call ends, runs the same sales-coach post-call analysis the batch
   pipeline uses (ported from ai-pipeline/lib/llm.ts) via Groq, and keeps a
   JSON record per call under call-history/.

Run it in its own terminal, next to the bridge script:

    cd globifye-ai
    venv/bin/python sip/demo-ui/demo_ui_server.py

Demo-only auth: users live in demo_users.json, sessions are in-memory
cookies, passwords are plaintext. This is a demo console, not a product
login -- do not expose this port beyond localhost/LAN.
"""

import json
import os
import queue
import secrets
import threading
import time
import urllib.parse
from http import cookies as http_cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from groq import Groq

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PORT = 8090

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
USERS_PATH = os.path.join(BASE_DIR, "demo_users.json")
HISTORY_DIR = os.path.join(BASE_DIR, "call-history")
# Shared with the bridge script -- same companies.json + knowledge base files
KB_DIR = os.path.join(BASE_DIR, "..", "knowledge-base")

# Same ARI settings as sip/scripts/step2_stt_bridge.py
ARI_HOST = "localhost:8088"
ARI_USER = "sip-mvp-user"
ARI_PASSWORD = "changeme_use_a_real_secret"
APP_NAME = "sip-mvp-app"

# The registered softphone endpoint ([test-endpoint] in pjsip.conf) and the
# dialplan context that routes the demo extensions into the Stasis app
# (extensions.conf [sip-mvp]).
SOFTPHONE_ENDPOINT = "PJSIP/test-endpoint"
DIAL_CONTEXT = "sip-mvp"

# Post-call analysis model -- matches the batch pipeline (ai-pipeline/lib/llm.ts)
ANALYSIS_MODEL = "llama-3.3-70b-versatile"


# --- Same zero-dependency .env.local parser as step2_stt_bridge.py ---
def _load_env_local():
    env_path = os.path.join(BASE_DIR, "..", "..", "ai-pipeline", ".env.local")
    env = {}
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        print(f"WARNING: {env_path} not found -- GROQ_API_KEY will be empty")
    return env


_env = _load_env_local()
GROQ_KEY = _env.get("GROQ_API_KEY", "")
if not GROQ_KEY:
    print("WARNING: GROQ_API_KEY missing -- post-call analysis will fail")

groq_client = Groq(api_key=GROQ_KEY)

# --- Supabase sync (2026-07-13): calls land in the merged backend project.
# The ai-pipeline's project and the SIP project are now the SAME project, so
# fall back to the main NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
# when the SIP-specific names aren't set. (Before this fallback existed, the
# key was present under the main name only, so the sync silently ran OFF.)
# If neither is set, the demo runs exactly as before: JSON files only. ---
SUPABASE_SIP_URL = (
    _env.get("SUPABASE_SIP_URL") or _env.get("NEXT_PUBLIC_SUPABASE_URL", "")
).rstrip("/")
SUPABASE_SIP_KEY = (
    _env.get("SUPABASE_SIP_SERVICE_ROLE_KEY") or _env.get("SUPABASE_SERVICE_ROLE_KEY", "")
)
SUPABASE_ENABLED = bool(SUPABASE_SIP_URL and SUPABASE_SIP_KEY)

# ---------------------------------------------------------------------------
# Users + sessions (demo-only)
# ---------------------------------------------------------------------------

with open(USERS_PATH) as f:
    USERS = {u["email"]: u for u in json.load(f)}

# Company registry -- same companies.json the bridge script loads. Maps each
# business to its extension, TTS voice, and knowledge base file.
with open(os.path.join(KB_DIR, "companies.json")) as f:
    COMPANIES = json.load(f)
_EXT_TO_COMPANY = {c["extension"]: key for key, c in COMPANIES.items()}
# Call records store the business by display name; recordings.did_number wants
# the number that was dialled to reach it.
_EXT_FOR_COMPANY = {c["display_name"]: c["extension"] for c in COMPANIES.values()}


def _company_public(key):
    """The fields the browser is allowed to see for a company."""
    c = COMPANIES[key]
    return {
        "key": key,
        "display_name": c["display_name"],
        "extension": c["extension"],
        "blurb": c["blurb"],
    }


def _me_payload(user):
    """Identity for the logged-in user, including their own company's line."""
    c = COMPANIES[user["company_key"]]
    return {
        "name": user["name"],
        "company": c["display_name"],
        "company_key": user["company_key"],
        "extension": c["extension"],
    }


_sessions = {}  # token -> user dict
_sessions_lock = threading.Lock()


def _session_user(handler):
    cookie_header = handler.headers.get("Cookie", "")
    jar = http_cookies.SimpleCookie(cookie_header)
    morsel = jar.get("demo_session")
    if morsel is None:
        return None
    with _sessions_lock:
        return _sessions.get(morsel.value)


# ---------------------------------------------------------------------------
# SSE fan-out
# ---------------------------------------------------------------------------

_sse_clients = []  # list of {"q": Queue, "role": "sales"|"client"|None}
_sse_lock = threading.Lock()


def broadcast(event_type, payload, roles=None):
    """Fan an event out to connected browsers. roles=None reaches everyone;
    a set (e.g. {"sales"}) reaches only clients with a matching role. This is
    how the post-call analysis stays on the sales interface only -- the client
    browser never receives it."""
    msg = json.dumps({"type": event_type, **payload})
    with _sse_lock:
        clients = list(_sse_clients)
    for c in clients:
        if roles is None or c["role"] in roles:
            c["q"].put(msg)


# ---------------------------------------------------------------------------
# Call state -- rebuilt from the bridge's log() event stream
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_current_call = None  # dict while a call is live, else None
# Set between "place call" and "call connected": who is ringing whom. Cleared
# when the real call connects (bridge "arrived") or is cancelled.
_ringing = None  # {direction, caller, target_role, company, channel_id} or None
_dialed_by = None  # user who last pressed Call in the UI, for tagging records
_recent_log = []  # last N raw log lines, replayed to newly connected browsers
RECENT_LOG_MAX = 200

# Last time the bridge sent anything (incl. its heartbeat). This -- not the ARI
# app registration, which lingers after the bridge dies -- is how /api/call
# knows the bridge is actually running before it rings the softphone.
_bridge_last_seen = None
BRIDGE_ALIVE_WINDOW = 30  # seconds; heartbeat is every 10s


def _new_call_record(channel_id):
    return {
        "id": time.strftime("%Y%m%d-%H%M%S") + "-" + channel_id.replace(".", "-"),
        "channel_id": channel_id,
        "started_at": time.time(),
        "ended_at": None,
        "dialed_by": _dialed_by,
        "company": None,  # display name of the business called; set by the AGENT event
        "direction": None,  # sales_to_client | client_to_sales
        "caller": None,  # who initiated (business name or "Customer")
        "turns": [],  # {role: customer|agent, text, at_sec}
        "analysis": None,
        "analysis_error": None,
    }


def _sb_headers(extra=None):
    h = {
        "apikey": SUPABASE_SIP_KEY,
        "Content-Type": "application/json",
    }
    # Legacy service_role keys are JWTs and also go in the Authorization
    # header. New-format secret keys (sb_secret_...) are not JWTs -- the
    # apikey header alone carries the role, and a non-JWT Bearer would 401.
    if SUPABASE_SIP_KEY.startswith("eyJ"):
        h["Authorization"] = f"Bearer {SUPABASE_SIP_KEY}"
    if extra:
        h.update(extra)
    return h


# SIP calls land in the SAME tables the ai-pipeline MVP already uses in the
# merged backend project (recordings / transcript / analysis / topics), plus
# the backend's own organizations / agent_configs / contacts. Only sip_calls is
# SIP-specific: telephony metadata linking back to its recordings row.
_mirror_lock = threading.Lock()
_org_cache = {}  # company display name -> {organization_id, agent_config_id, agent_name}


def _org_and_agent(company_name):
    """Resolve a business to its organizations row and its AI agent_configs row.
    Both are seeded in the DB (one org + one agent per company)."""
    if not company_name:
        return {}
    if company_name in _org_cache:
        return _org_cache[company_name]
    base = f"{SUPABASE_SIP_URL}/rest/v1"
    try:
        orgs = requests.get(
            f"{base}/organizations",
            headers=_sb_headers(),
            params={"name": f"eq.{company_name}", "select": "id"},
            timeout=8,
        ).json()
        if not orgs:
            return {}
        oid = orgs[0]["id"]
        acs = requests.get(
            f"{base}/agent_configs",
            headers=_sb_headers(),
            params={"organization_id": f"eq.{oid}", "select": "id,name", "limit": 1},
            timeout=8,
        ).json()
        info = {
            "organization_id": oid,
            "agent_config_id": acs[0]["id"] if acs else None,
            "agent_name": acs[0]["name"] if acs else None,
        }
        _org_cache[company_name] = info
        return info
    except (requests.RequestException, ValueError, KeyError, IndexError):
        return {}


def _sb_post(path, body, want_row=False):
    prefer = "return=representation" if want_row else "return=minimal"
    r = requests.post(
        f"{SUPABASE_SIP_URL}/rest/v1/{path}",
        headers=_sb_headers({"Prefer": prefer}),
        json=body,
        timeout=8,
    )
    r.raise_for_status()
    return r.json()[0] if want_row else None


def mirror_call_to_supabase(call):
    """Idempotent, best-effort sync of one call into the merged project:
    recordings row (created once, id remembered in the local JSON record),
    transcript rows (replaced), sip_calls row (upserted), and -- once the
    user has run it -- the analysis row + its topics (written once).
    A failure logs a warning and never affects the live demo."""
    if not SUPABASE_ENABLED:
        return
    base = f"{SUPABASE_SIP_URL}/rest/v1"
    org = _org_and_agent(call.get("company"))
    with _mirror_lock:
        try:
            if not call.get("recording_id"):
                # Columns below are the merged backend project's real
                # `recordings` schema (already SIP-aware). Nullable FKs
                # (organization_id, contact_id, recorded_by, agent_config_id)
                # are left null: the demo companies are not rows in
                # `organizations`, and inventing a link would be false data.
                #
                # call_mode is left null on purpose. recordings_call_mode_check
                # accepts only 'inbound' (and null) -- 'outbound', 'ai', 'human'
                # are all rejected -- so the vocabulary is the backend team's to
                # define. The direction is recorded precisely in sip_calls.direction
                # anyway, so nothing is lost by leaving this null until they say
                # what an AI voice call should carry here.
                sid = call.get("channel_id")

                # Idempotent: recordings.sip_session_id is UNIQUE, so if this
                # call was already pushed, reuse that row instead of colliding.
                existing = requests.get(
                    f"{base}/recordings?sip_session_id=eq.{sid}&select=id",
                    headers=_sb_headers(),
                    timeout=8,
                ).json() if sid else []

                if existing:
                    call["recording_id"] = existing[0]["id"]
                else:
                    duration = None
                    if call.get("ended_at"):
                        duration = int(round(call["ended_at"] - call["started_at"]))
                    row = _sb_post(
                        "recordings",
                        {
                            "audio_url": None,  # call audio capture not built yet
                            "duration_seconds": duration,
                            "did_number": _EXT_FOR_COMPANY.get(call.get("company")),
                            "caller_number": None,  # softphone demo: no real caller ID
                            "sip_provider": "asterisk",
                            "sip_session_id": sid,
                            "status": "completed",
                            "organization_id": org.get("organization_id"),
                            "agent_config_id": org.get("agent_config_id"),
                        },
                        want_row=True,
                    )
                    call["recording_id"] = row["id"]
                _write_call_file(call)

            rid = call["recording_id"]

            # Replace transcript rows (idempotent; same shape the batch
            # pipeline reads: speaker / content_raw / sentence_start_sec).
            requests.delete(
                f"{base}/transcript?recording_id=eq.{rid}", headers=_sb_headers(), timeout=8
            )
            if call.get("turns"):
                # Each row says WHO spoke: the AI agent's configured name, or
                # the caller's name once analysis has captured it (null until then).
                agent_name = org.get("agent_name") or "AI Agent"
                client_name = call.get("contact_name")
                _sb_post(
                    "transcript",
                    [
                        {
                            "recording_id": rid,
                            "speaker": "Agent" if t["role"] == "agent" else "Client",
                            "speaker_role": "agent" if t["role"] == "agent" else "client",
                            "speaker_name": agent_name if t["role"] == "agent" else client_name,
                            "organization_id": org.get("organization_id"),
                            "content_raw": t["text"],
                            "content_clean": t["text"],  # no filler-strip pass in SIP yet
                            "sentence_start_sec": t.get("at_sec"),
                            "sequence_index": i,
                        }
                        for i, t in enumerate(call["turns"])
                    ],
                )

            # SIP-specific metadata, linked to the recordings row.
            requests.post(
                f"{base}/sip_calls",
                headers=_sb_headers(
                    {"Prefer": "resolution=merge-duplicates,return=minimal"}
                ),
                json={
                    "id": call["id"],
                    "recording_id": rid,
                    "started_at": call.get("started_at"),
                    "ended_at": call.get("ended_at"),
                    "company": call.get("company"),
                    "direction": call.get("direction"),
                    "caller": call.get("caller"),
                    "dialed_by": call.get("dialed_by"),
                    "channel_id": call.get("channel_id"),
                },
                timeout=8,
            ).raise_for_status()

            # Analysis + topics, once, same rows lib/llm.ts writeAnalysis writes
            # (minus gpu_jobs, which tracks the batch pipeline's own job queue).
            if call.get("analysis") and not call.get("analysis_synced"):
                a = call["analysis"]
                arow = _sb_post(
                    "analysis",
                    {
                        "recording_id": rid,
                        "summary": a.get("summary"),
                        "key_topics": a.get("key_topics"),
                        "objection_analysis": a.get("objections"),
                        "what_went_well": a.get("what_went_well"),
                    },
                    want_row=True,
                )
                topics = [
                    {
                        "recording_id": rid,
                        "analysis_id": arow["id"],
                        "name": t.get("name"),
                        "start_time": t.get("start_time"),
                        "sequence_index": i,
                    }
                    for i, t in enumerate(a.get("key_topics") or [])
                ]
                if topics:
                    _sb_post("topics", topics)

                # The caller identified themselves (the agent asks when it can't
                # answer): record them as a real contact, link the recording, and
                # put their name on their own transcript turns. Never invented --
                # if the LLM found no name, nothing is written.
                cname = (a.get("caller_name") or "").strip() or None
                cphone = (a.get("caller_phone") or "").strip() or None
                if cname or cphone:
                    contact_id = _upsert_contact(
                        base, org.get("organization_id"), cname, cphone, call.get("company")
                    )
                    if contact_id:
                        requests.patch(
                            f"{base}/recordings?id=eq.{rid}",
                            headers=_sb_headers({"Prefer": "return=minimal"}),
                            json={"contact_id": contact_id, "caller_number": cphone},
                            timeout=8,
                        ).raise_for_status()
                    if cname:
                        requests.patch(
                            f"{base}/transcript?recording_id=eq.{rid}&speaker_role=eq.client",
                            headers=_sb_headers({"Prefer": "return=minimal"}),
                            json={"speaker_name": cname},
                            timeout=8,
                        ).raise_for_status()
                        call["contact_name"] = cname

                call["analysis_synced"] = True
                _write_call_file(call)
        except requests.RequestException as e:
            detail = ""
            if getattr(e, "response", None) is not None:
                try:  # surface the constraint name, not a truncated blob
                    body = e.response.json()
                    detail = f" -- {body.get('message')} | {body.get('details')}"
                except ValueError:
                    detail = f" -- {e.response.text[:300]}"
            print(f"WARNING: Supabase sync failed for {call.get('id')}: {e}{detail}")


def _upsert_contact(base, org_id, name, phone, company):
    """Find-or-create the caller in `contacts`. Matched on phone within the
    org when we have one, else on name. contacts.id has no default, so the
    next id is computed under the mirror lock (single-call demo, no race)."""
    try:
        params = {"select": "id", "limit": 1}
        if org_id is not None:
            params["organization_id"] = f"eq.{org_id}"
        params["phone" if phone else "name"] = f"eq.{phone or name}"
        found = requests.get(
            f"{base}/contacts", headers=_sb_headers(), params=params, timeout=8
        ).json()
        if found:
            cid = found[0]["id"]
            requests.patch(
                f"{base}/contacts?id=eq.{cid}",
                headers=_sb_headers({"Prefer": "return=minimal"}),
                json={k: v for k, v in (("name", name), ("phone", phone)) if v},
                timeout=8,
            ).raise_for_status()
            return cid

        rows = requests.get(
            f"{base}/contacts",
            headers=_sb_headers(),
            params={"select": "id", "order": "id.desc", "limit": 1},
            timeout=8,
        ).json()
        next_id = (rows[0]["id"] + 1) if rows else 1
        row = _sb_post(
            "contacts",
            {
                "id": next_id,
                "organization_id": org_id,
                "name": name,
                "phone": phone,
                "company": company,
            },
            want_row=True,
        )
        return row["id"]
    except (requests.RequestException, ValueError, KeyError, IndexError) as e:
        print(f"WARNING: contact upsert failed ({name or phone}): {e}")
        return None


def _write_call_file(call):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    path = os.path.join(HISTORY_DIR, f"{call['id']}.json")
    with open(path, "w") as f:
        json.dump(call, f, indent=2)


def _save_call(call):
    _write_call_file(call)
    if SUPABASE_ENABLED:
        # Off the hot path -- never block or fail the call loop on the DB.
        threading.Thread(
            target=mirror_call_to_supabase, args=(call,), daemon=True
        ).start()


def backfill_unsynced_calls():
    """On startup with the mirror ON: push any local call records that never
    made it to the database (e.g. calls made while the key was missing)."""
    for call in _load_calls():
        if not call.get("recording_id") or (
            call.get("analysis") and not call.get("analysis_synced")
        ):
            print(f"Supabase backfill: syncing {call['id']}")
            mirror_call_to_supabase(call)


def _load_calls():
    if not os.path.isdir(HISTORY_DIR):
        return []
    calls = []
    for name in sorted(os.listdir(HISTORY_DIR), reverse=True):
        if name.endswith(".json"):
            try:
                with open(os.path.join(HISTORY_DIR, name)) as f:
                    calls.append(json.load(f))
            except (json.JSONDecodeError, OSError):
                continue
    return calls


def handle_bridge_event(event):
    """One log() line from the bridge: update call state, then fan out."""
    global _current_call, _dialed_by, _ringing, _bridge_last_seen

    _bridge_last_seen = time.time()  # any event, incl. heartbeat, proves liveness

    tag = event.get("tag", "")
    text = event.get("text", "")
    ms = event.get("ms")

    if tag == "BRIDGE":
        return  # heartbeat only -- liveness recorded above, nothing to display

    # Raw line for the log panel, same shape as the terminal output
    stamp = f" +{ms}ms" if ms is not None else ""
    raw_line = f"[{tag}{stamp}] {text}".rstrip()
    with _state_lock:
        _recent_log.append(raw_line)
        del _recent_log[:-RECENT_LOG_MAX]

    ended_call = None
    connected_call = None
    turn_at_sec = None  # seconds-into-call for this turn, for transcript navigation
    with _state_lock:
        if tag == "CALL" and text.startswith("arrived:"):
            _current_call = _new_call_record(text.split("arrived:", 1)[1].strip())
            # The real call is up: carry over the ringing direction/caller and
            # stop ringing on both interfaces.
            if _ringing is not None:
                _current_call["direction"] = _ringing.get("direction")
                _current_call["caller"] = _ringing.get("caller")
            _ringing = None
            connected_call = _current_call
        elif tag == "AGENT":
            # Bridge announces which business answered, right after "arrived:"
            if _current_call is not None:
                _current_call["company"] = text
        elif tag == "CALL" and text.startswith("ended:"):
            if _current_call is not None:
                _current_call["ended_at"] = time.time()
                ended_call = _current_call
                _current_call = None
                _dialed_by = None
        elif _current_call is not None:
            at_sec = round(time.time() - _current_call["started_at"], 1)
            if tag == "STT final":
                _current_call["turns"].append(
                    {"role": "customer", "text": text, "at_sec": at_sec}
                )
                turn_at_sec = at_sec
            elif tag == "LLM reply":
                _current_call["turns"].append(
                    {"role": "agent", "text": text, "at_sec": at_sec}
                )
                turn_at_sec = at_sec

    payload = {"tag": tag, "text": text, "ms": ms, "raw": raw_line}
    if turn_at_sec is not None:
        payload["at_sec"] = turn_at_sec
    broadcast("pipeline_event", payload)

    if connected_call is not None:
        broadcast("call_connected", {"call": connected_call})

    if ended_call is not None:
        _save_call(ended_call)
        # Post-call analysis is NOT run automatically -- it is a paid LLM call
        # and the sales user triggers it on demand via POST /api/analyze/<id>.
        broadcast("call_ended", {"call": ended_call})


# ---------------------------------------------------------------------------
# Post-call analysis -- ported from ai-pipeline/lib/llm.ts (sales-coach
# prompt + schema). Two adaptations for the live SIP loop: speakers are
# already known (Customer = caller, Agent = the AI sales rep), and JSON mode
# replaces LangChain's withStructuredOutput.
# ---------------------------------------------------------------------------

ANALYSIS_SYSTEM_PROMPT = """You are a sales coach reviewing a recorded sales call to give specific, actionable feedback.

Each transcript line is formatted as:
[seconds] Speaker: utterance

Speakers are pre-labeled: "Agent" is the sales representative, "Client" is the customer.

Rules:
- timestamp: use the exact number from the [Xs] label at the start of the relevant line. Do not interpolate between lines.
- exact_quote: copy character-for-character from the transcript, including filler words. Do not paraphrase, summarize, or truncate.
- objections: flag moments where the customer expresses budget concern, timeline pressure, trust doubts, need for internal approval, competitor preference, or any hesitation that could prevent or delay closing.
- what_went_well: flag specific behaviors -- active listening, handling objections with concrete solutions, building rapport, advancing the deal. Do not flag generic politeness.
- suggestion: must be specific and actionable. Reference the customer's actual words where possible. Do not write generic advice such as "be more confident" or "follow up more".
- Return an empty array [] if no genuine objections or notable moments exist -- do not invent entries.

- caller_name / caller_phone: the agent asks for these when it cannot answer a question. Copy them exactly as the client gave them. Use null if the client never states them -- never guess a name or a number.

Respond with JSON only, exactly this shape:
{
  "summary": "2-3 sentence overview of the call",
  "caller_name": "the client's name if they state it, else null",
  "caller_phone": "the client's phone number if they state it, else null",
  "key_topics": [{"name": "...", "start_time": 0, "end_time": 0}],
  "objections": [{"timestamp": 0, "speaker": "...", "exact_quote": "...", "reason": "...", "suggestion": "..."}],
  "what_went_well": [{"timestamp": 0, "speaker": "...", "exact_quote": "...", "reason": "..."}]
}"""


def run_analysis(call):
    if not call["turns"]:
        return
    transcript = "\n".join(
        f"[{t['at_sec']}s] {'Agent' if t['role'] == 'agent' else 'Client'}: {t['text']}"
        for t in call["turns"]
    )
    business = call.get("company") or "the business"
    try:
        resp = groq_client.chat.completions.create(
            model=ANALYSIS_MODEL,
            messages=[
                {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"The AI agent was answering calls for {business}. "
                        f"Analyze the following call transcript:\n\n{transcript}"
                    ),
                },
            ],
            response_format={"type": "json_object"},
        )
        call["analysis"] = json.loads(resp.choices[0].message.content)
    except Exception as e:
        call["analysis_error"] = f"{type(e).__name__}: {e}"
    _save_call(call)
    # Analysis is coaching for the sales side only -- never sent to the client.
    broadcast("analysis_ready", {"call": call}, roles={"sales"})


# ---------------------------------------------------------------------------
# Dial via ARI originate
# ---------------------------------------------------------------------------


def dial_extension(extension, company):
    """Ring the softphone; on answer, run <extension>@sip-mvp -> Stasis, which
    the dialplan routes to the right company. Returns (ok, message, channel_id)
    -- channel_id lets a later hangup/decline cancel this exact call."""
    # Verify the bridge script is connected first -- without it, the Stasis
    # app isn't registered and the call would drop as soon as it's answered.
    try:
        r = requests.get(
            f"http://{ARI_HOST}/ari/applications/{APP_NAME}",
            auth=(ARI_USER, ARI_PASSWORD),
            timeout=2,
        )
    except requests.RequestException:
        return False, "Asterisk is not reachable. Is the asterisk-mvp container running?", None
    if r.status_code == 404:
        return False, "Bridge script is not running (Stasis app not registered). Start step2_stt_bridge.py first.", None

    try:
        r = requests.post(
            f"http://{ARI_HOST}/ari/channels",
            params={
                "endpoint": SOFTPHONE_ENDPOINT,
                "extension": extension,
                "context": DIAL_CONTEXT,
                "priority": 1,
                "callerId": "Demo Console",
                "timeout": 30,
            },
            auth=(ARI_USER, ARI_PASSWORD),
            timeout=5,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        return False, f"Originate failed: {e}", None
    channel_id = None
    try:
        channel_id = r.json().get("id")
    except (ValueError, AttributeError):
        pass
    return True, "Ringing the softphone. Answer it to connect the call.", channel_id


def hangup_channel(channel_id):
    """Best-effort ARI hangup -- used to cancel a ring or end a live call."""
    if not channel_id:
        return
    try:
        requests.delete(
            f"http://{ARI_HOST}/ari/channels/{channel_id}",
            auth=(ARI_USER, ARI_PASSWORD),
            timeout=3,
        )
    except requests.RequestException:
        pass


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet; the interesting stream is in the UI

    # --- helpers -----------------------------------------------------------

    def _send_json(self, obj, status=200, set_cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, name, status=200):
        path = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(path):
            self._send_json({"error": "not found"}, 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(status)
        self.send_header(
            "Content-Type", CONTENT_TYPES.get(os.path.splitext(name)[1], "text/plain")
        )
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return {}

    # --- GET ---------------------------------------------------------------

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        user = _session_user(self)

        if path == "/":
            self._redirect("/home.html" if user else "/login.html")
        elif path == "/login.html":
            self._send_file("login.html")
        elif path == "/app.html":
            self._redirect("/sales.html")  # legacy alias
        elif path in ("/home.html", "/sales.html", "/client.html"):
            if user is None:
                self._redirect("/login.html")
            else:
                self._send_file(path.lstrip("/"))
        elif path in ("/style.css", "/sales.js", "/client.js", "/home.js"):
            self._send_file(path.lstrip("/"))
        elif path == "/api/me":
            if user is None:
                self._send_json({"error": "not logged in"}, 401)
            else:
                self._send_json(_me_payload(user))
        elif path == "/api/companies":
            if user is None:
                self._send_json({"error": "not logged in"}, 401)
            else:
                self._send_json(
                    {"companies": [_company_public(k) for k in COMPANIES]}
                )
        elif path.startswith("/api/knowledge-base/"):
            if user is None:
                self._send_json({"error": "not logged in"}, 401)
                return
            key = os.path.basename(path)
            if key not in COMPANIES:
                self._send_json({"error": "unknown company"}, 404)
                return
            kb_file = COMPANIES[key].get("kb_file")
            try:
                with open(os.path.join(KB_DIR, kb_file)) as kb:
                    markdown = kb.read()
            except (TypeError, FileNotFoundError):
                # No KB connected: the agent runs on the fallback prompt
                # (see step2_stt_bridge.py _build_fallback_prompt).
                markdown = (
                    "# No knowledge base connected yet\n\n"
                    "The agent answers detail questions with the fallback line "
                    "and collects the caller's name and phone number."
                )
            self._send_json(
                {"company": COMPANIES[key]["display_name"], "markdown": markdown}
            )
        elif path == "/api/calls":
            if user is None:
                self._send_json({"error": "not logged in"}, 401)
                return
            calls = _load_calls()
            self._send_json(
                {
                    "calls": [
                        {
                            "id": c["id"],
                            "started_at": c["started_at"],
                            "ended_at": c["ended_at"],
                            "turns": len(c["turns"]),
                            "has_analysis": c.get("analysis") is not None,
                            "dialed_by": c.get("dialed_by"),
                            "company": c.get("company"),
                        }
                        for c in calls
                    ]
                }
            )
        elif path.startswith("/api/calls/"):
            if user is None:
                self._send_json({"error": "not logged in"}, 401)
                return
            call_id = os.path.basename(path)
            record_path = os.path.join(HISTORY_DIR, f"{call_id}.json")
            if not os.path.isfile(record_path):
                self._send_json({"error": "call not found"}, 404)
                return
            with open(record_path) as f:
                self._send_json({"call": json.load(f)})
        elif path == "/api/events":
            if user is None:
                self._send_json({"error": "not logged in"}, 401)
                return
            self._serve_sse()
        else:
            self._send_json({"error": "not found"}, 404)

    def _serve_sse(self):
        role = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query
        ).get("role", ["sales"])[0]
        if role not in ("sales", "client"):
            role = "sales"
        client = {"q": queue.Queue(), "role": role}
        with _sse_lock:
            _sse_clients.append(client)
        q = client["q"]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        # Snapshot so a freshly opened browser isn't blank: current call
        # (if one is live), any active ring, and recent raw log lines.
        with _state_lock:
            snapshot = {
                "type": "snapshot",
                "current_call": _current_call,
                "ringing": _ringing,
                "recent_log": list(_recent_log),
            }
        try:
            self.wfile.write(f"data: {json.dumps(snapshot)}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")  # SSE comment
                    self.wfile.flush()
                    continue
                self.wfile.write(f"data: {msg}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _sse_lock:
                if client in _sse_clients:
                    _sse_clients.remove(client)

    # --- POST --------------------------------------------------------------

    def do_POST(self):
        global _dialed_by, _ringing
        path = urllib.parse.urlparse(self.path).path

        if path == "/internal/events":
            # Bridge hook only -- refuse anything not from this machine
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                self._send_json({"error": "forbidden"}, 403)
                return
            handle_bridge_event(self._read_json_body())
            self._send_json({"ok": True})
            return

        if path == "/api/login":
            body = self._read_json_body()
            user = USERS.get(body.get("email", "").strip().lower())
            if user is None or user["password"] != body.get("password", ""):
                self._send_json({"error": "Wrong email or password."}, 401)
                return
            token = secrets.token_hex(16)
            with _sessions_lock:
                _sessions[token] = user
            self._send_json(
                _me_payload(user),
                set_cookie=f"demo_session={token}; Path=/; HttpOnly; SameSite=Lax",
            )
            return

        user = _session_user(self)
        if user is None:
            self._send_json({"error": "not logged in"}, 401)
            return

        if path == "/api/logout":
            cookie_header = self.headers.get("Cookie", "")
            jar = http_cookies.SimpleCookie(cookie_header)
            morsel = jar.get("demo_session")
            if morsel is not None:
                with _sessions_lock:
                    _sessions.pop(morsel.value, None)
            self._send_json(
                {"ok": True},
                set_cookie="demo_session=; Path=/; Max-Age=0",
            )
        elif path == "/api/call":
            body = self._read_json_body()
            direction = body.get("direction")
            if direction not in ("sales_to_client", "client_to_sales"):
                self._send_json({"error": "Unknown call direction."}, 400)
                return
            # True liveness check: the bridge heartbeats every 10s. If we
            # haven't heard from it, DON'T ring the softphone -- the call would
            # enter a Stasis app with no handler and drop the moment it's
            # answered (the "instant disconnect" bug). Tell the user instead.
            if _bridge_last_seen is None or (time.time() - _bridge_last_seen) > BRIDGE_ALIVE_WINDOW:
                self._send_json(
                    {"error": "Bridge script isn't running. Start it: venv/bin/python -u sip/scripts/step2_stt_bridge.py"},
                    502,
                )
                return

            company = COMPANIES[user["company_key"]]
            if direction == "sales_to_client":
                caller, target_role = company["display_name"], "client"
            else:
                caller, target_role = "Client", "sales"

            ok, message, channel_id = dial_extension(company["extension"], company)
            if not ok:
                self._send_json({"error": message}, 502)
                return

            with _state_lock:
                _dialed_by = f"{user['name']} ({company['display_name']})"
                _ringing = {
                    "direction": direction,
                    "caller": caller,
                    "target_role": target_role,
                    "company": company["display_name"],
                    "channel_id": channel_id,
                }
            # Ring the receiving interface; the initiator's page shows "calling".
            broadcast(
                "incoming_call",
                {
                    "direction": direction,
                    "caller": caller,
                    "target_role": target_role,
                    "company": company["display_name"],
                },
            )
            self._send_json({"message": message})
        elif path == "/api/hangup":
            with _state_lock:
                channel_id = (_ringing or {}).get("channel_id")
                if channel_id is None and _current_call is not None:
                    channel_id = _current_call.get("channel_id")
                was_ringing = _ringing is not None
                _ringing = None
            hangup_channel(channel_id)
            if was_ringing:
                # No live call to emit an "ended" event, so tell the UIs directly.
                broadcast("call_cancelled", {})
            self._send_json({"ok": True})
        elif path.startswith("/api/analyze/"):
            # On-demand post-call analysis -- runs only when the sales user
            # clicks "Run analysis", never automatically.
            call_id = os.path.basename(path)
            record_path = os.path.join(HISTORY_DIR, f"{call_id}.json")
            if not os.path.isfile(record_path):
                self._send_json({"error": "Call not found."}, 404)
                return
            with open(record_path) as f:
                call = json.load(f)
            if not call.get("turns"):
                self._send_json({"error": "No transcript to analyze for this call."}, 400)
                return
            run_analysis(call)  # mutates call in place, saves, broadcasts to sales
            self._send_json({"call": call})
        else:
            self._send_json({"error": "not found"}, 404)


# ---------------------------------------------------------------------------


def main():
    os.makedirs(HISTORY_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Demo UI running at http://localhost:{PORT}")
    print(f"Waiting for bridge events on POST /internal/events (from step2_stt_bridge.py)")
    print(
        "Supabase mirror: " + (f"ON -> {SUPABASE_SIP_URL}" if SUPABASE_ENABLED
        else "OFF (set SUPABASE_SIP_URL + SUPABASE_SIP_SERVICE_ROLE_KEY in .env.local to enable)")
    )
    if SUPABASE_ENABLED:
        threading.Thread(target=backfill_unsynced_calls, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")


if __name__ == "__main__":
    main()
