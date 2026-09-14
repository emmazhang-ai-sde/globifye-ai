"""
Step 2/3 -- Wire call audio into STT, and wire TTS output back into the call.

This file is a copy of Amy's `amy/llm-testing/agent-test6.py` (Modulate STT ->
Groq LLM -> Deepgram Aura TTS pipeline), adapted per
`design-docs-sip/sip-loop-mvp-step-by-step-guidence/step2-wire-call-audio-into-stt.md`
and `.../step3-wire-tts-output-into-call.md`. Two structural changes from
Amy's original, everything else (Modulate connection, transcript queue, Groq)
untouched:

- **Audio in (Step 2):** instead of a PyAudio mic stream, audio arrives as RTP
  from an Asterisk `externalMedia` channel (via verify_ari.py's ARI
  answer/Stasis pattern), gets stripped of its RTP header, and is queued for
  the same Modulate streaming connection Amy's original script already used.
- **Audio out (Step 3):** instead of playing Deepgram Aura's reply locally via
  `sounddevice`, the generated audio is written to a WAV file, downsampled for
  Asterisk with `ffmpeg`, copied into the `asterisk-mvp` container, and played
  into the live call via ARI's `/channels/{id}/play`.

Original attribution: Amy, amy/llm-testing/agent-test6.py.
"""

import array
import os
import queue
import subprocess
import threading
import wave
from deepgram import DeepgramClient
from groq import Groq
from websockets.sync.client import connect as ws_connect
import json
import time

# --- STEP 2 ADDITION: ARI + RTP bridge imports (not in original agent-test6.py) ---
import socket as udp_socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import requests
from websocket import create_connection

from agent_registry import AgentRegistry
from call_session import CallSession
from capability_registry import CapabilityRegistry
from capability_executor import execute_capability_call
from knowledge_base_registry import KnowledgeBaseRegistry
from runtime_context_builder import build_runtime_context
from runtime_capability_policy import (
    DEFAULT_MAX_TOOL_RESULT_CHARS,
    CapabilityCallBudgetExceeded,
    RuntimeCapabilityCallBudget,
    serialize_tool_result,
)

# set up timer for timestamps
_START = time.time()
def _ms():
    return int((time.time() - _START) * 1000)


_log_lock = threading.Lock()
SHOW_LLM_STREAM = os.environ.get("SHOW_LLM_STREAM") == "1"
ENABLE_RUNTIME_CAPABILITY_TOOLS = (
    os.environ.get("ENABLE_RUNTIME_CAPABILITY_TOOLS", "").strip().lower()
    in {"1", "true", "yes", "on"}
)
MAX_RUNTIME_TOOL_RESULT_CHARS = int(
    os.environ.get("MAX_RUNTIME_TOOL_RESULT_CHARS") or DEFAULT_MAX_TOOL_RESULT_CHARS
)


def log(tag, text="", ms=None, blank_before=0, blank_after=0, payload=None):
    """Thread-safe, single-line logger. Every worker must call this instead
    of print() -- concurrent bare prints (esp. groq_worker's raw token
    stream) is what caused interleaved garbage like
    "Yes, I hear you.TTS: Yes, I hear you." (see step3.3 doc). blank_before
    (int, also accepts True/False) marks the three headline latency
    checkpoints (STT final, LLM first-token, TTS audio) so a turn's phases
    are visually separated, and the end-of-call divider. blank_after
    separates the one-time call-setup block from the STT partial stream
    that follows it."""
    stamp = f" +{ms}ms" if ms is not None else ""
    line = f"[{tag}{stamp}] {text}" if text else f"[{tag}{stamp}]"
    with _log_lock:
        for _ in range(int(blank_before)):
            print()
        print(line, flush=True)
        for _ in range(int(blank_after)):
            print()
    event = {"tag": tag, "text": text, "ms": ms}
    if payload is not None:
        event["payload"] = payload
    _ui_queue.put(event)


# --- DEMO UI ADDITION (2026-07-10): mirror every log() line to the demo UI
# server (sip/demo-ui/demo_ui_server.py) so the browser renders the same
# event stream the terminal shows. Decoupled by a queue + daemon sender
# thread: if the UI server isn't running, each POST fails fast and the event
# is dropped -- the call loop never blocks or slows down because of the UI. ---
UI_EVENTS_URL = "http://localhost:8400/internal/events"
CONTROL_HOST = "127.0.0.1"
CONTROL_PORT = 8500
_ui_queue = queue.Queue()


def _ui_sender():
    while True:
        event = _ui_queue.get()
        try:
            requests.post(UI_EVENTS_URL, json=event, timeout=0.5)
        except Exception:
            pass  # UI server down -- drop silently, never touch the pipeline


# --- DEMO UI ADDITION (2026-07-13): heartbeat so the UI can honestly tell
# "bridge running" from "bridge dead". Asterisk's ARI app registration lingers
# even after the bridge exits, so the UI can't rely on it -- a dead bridge
# looked "up" and the UI rang the softphone into a Stasis app with no handler,
# which Asterisk hangs up the instant the call is answered. A fresh heartbeat
# is the true liveness signal; the UI server refuses to place a call without one. ---
def _ui_heartbeat():
    while True:
        _ui_queue.put({"tag": "BRIDGE", "text": "online", "ms": None})
        time.sleep(10)


threading.Thread(target=_ui_sender, daemon=True).start()
threading.Thread(target=_ui_heartbeat, daemon=True).start()


# --- STEP 2 CHANGE: load API keys from ai-pipeline/.env.local instead of
# hardcoding them (agent-test6.py had them as blank string literals). Small
# zero-dependency parser -- avoids adding python-dotenv to the venv. Path is
# resolved relative to this file so it works regardless of the cwd. ---
def _load_env_local():
    env_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "ai-pipeline", ".env.local",
    )
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
        print(f"WARNING: {env_path} not found -- API keys will be empty")
    return env


_env = _load_env_local()

# api keys
DEEPGRAM_KEY = _env.get("DEEPGRAM_API_KEY", "")
GROQ_KEY = _env.get("GROQ_API_KEY", "")
MODULATE_KEY = _env.get("MODULATE_API_KEY", "")

# fail loud if a required key is missing, rather than hitting a confusing
# 4003 (Modulate auth reject) or 401 deep inside a worker thread
_missing = [n for n, v in
            (("DEEPGRAM_API_KEY", DEEPGRAM_KEY),
             ("GROQ_API_KEY", GROQ_KEY),
             ("MODULATE_API_KEY", MODULATE_KEY)) if not v]
if _missing:
    print("WARNING: missing keys in .env.local:", ", ".join(_missing))

# setup parameters
RATE = 16000
CHANNELS = 1

# --- STEP 2 ADDITION: ARI config (same as verify_ari.py) ---
ARI_HOST = "localhost:8088"
ARI_USER = "sip-mvp-user"
ARI_PASSWORD = "changeme_use_a_real_secret"
APP_NAME = "sip-mvp-app"

# --- STEP 2 ADDITION: externalMedia / RTP bridge config ---
# --- BUGFIX (2026-07-07): "127.0.0.1" here is resolved INSIDE the asterisk-mvp
# container (bridge network mode), so it pointed at the container's own
# loopback -- not this host, where rtp_listener() actually binds. Asterisk was
# sending RTP into its own void; zero packets ever reached UDP 9000 on the
# host, even with the caller speaking for 30+ seconds. host.docker.internal
# is Docker Desktop's DNS name for reaching the host from inside a container
# (confirmed resolvable from asterisk-mvp: `docker exec asterisk-mvp getent
# hosts host.docker.internal`).
#
# NOTE (2026-07-21): on some Docker Desktop setups host.docker.internal
# resolves IPv6-first to an unreachable address (fdc4:...::254) and Asterisk
# 500s the externalMedia create with "Could not get our address for sending
# media". If that happens, verify with:
#     docker exec asterisk-mvp getent ahostsv4 host.docker.internal
# and either hardcode the IPv4 it prints (typically 192.168.65.254) or fix
# the container's resolution. ---
EXTERNAL_MEDIA_HOST = "192.168.65.254:9000"
UDP_LISTEN_PORT = 9000
RTP_HEADER_LEN = 12

# --- STEP 3 ADDITION: TTS playback-into-call config ---
ASTERISK_CONTAINER = "asterisk-mvp"
SOUNDS_DIR_IN_CONTAINER = "/var/lib/asterisk/sounds/custom"
TTS_STAGING_DIR = "/tmp/sip-tts-staging"

# Set from StasisStart / cleared on StasisEnd -- single active call only,
# concurrency is explicitly out of scope for this MVP (step7-agent-roadmap.md, section 3)
current_channel_id = None

# --- MULTI-COMPANY ADDITION (2026-07-10): every business GlobiFYE serves has
# its own knowledge base + TTS voice, chosen per call by the number the caller
# dialed. The dialplan passes the company key as a Stasis() argument
# (Stasis(sip-mvp-app,pacificbeef) for 1000, ...,globifye for 2000); see
# extensions.conf [sip-mvp] and the step 5 demo-console doc. sip/knowledge-base/
# companies.json is the shared source of truth -- the demo UI server reads the
# same file. ---
_KB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "knowledge-base")

# Behavior rules shared by every company's agent -- only the identity line and
# the knowledge base below it change per company.
AGENT_RULES = (
    "Respond to the customer in a natural, spoken manner as if on a phone call. "
    "Keep answers as short as possible. If the customer raises concerns, acknowledge them "
    "politely and address them in a business-appropriate way. Be concise and conversational. "
    "Do not use any markdown formatting, bullet points, asterisks, or emojis. Do not output "
    "thinking, only the final answer (conversational response). Use plain natural language "
    "only, without filler openers, as your response will be read aloud by text-to-speech."
)


# Said whenever the agent has no grounded answer: KB/RAG doesn't cover the
# question, or the company has no knowledge base connected at all. Exact
# wording is a product decision (Shuyang, 2026-07-13) -- keep verbatim.
FALLBACK_LINE = (
    "I'm not sure I have the details you're looking for, but I can have a "
    "team member follow up with you. May I have your name and a phone number, please?"
)


# The agent is a sales rep. Each company's KB describes its product, pricing,
# and a five-stage sales pipeline (Prospect, Contact, Demo, Proposal, Closing);
# the prompt tells the agent to figure out the prospect's stage and move them
# to the next one. (Making that stage a tracked field on the contact + a
# post-call analysis output is a proposed follow-up: see step7 roadmap.)
SALES_PROCESS = (
    "Work the sales pipeline: figure out where the prospect is (Prospect, Contact, "
    "Demo, Proposal, Closing) and guide the conversation toward the next stage, using "
    "the playbook in the knowledge base. Ask the qualifying questions, handle objections "
    "with the responses provided, and always end with a clear next step."
)


def _build_system_prompt(display_name, kb_text):
    return {
        "role": "system",
        "content": (
            f"You are an AI sales representative for {display_name}, speaking with a prospect on a sales call. "
            f"{AGENT_RULES} {SALES_PROCESS} "
            f"Everything you know about {display_name}'s product, pricing, and process is in the knowledge "
            f"base below. Answer only from it -- never invent prices, product details, or terms. "
            f"If the prospect asks something the knowledge base does not cover, reply exactly: "
            f"\"{FALLBACK_LINE}\" and then collect their name and phone number.\n\n"
            f"--- {display_name} KNOWLEDGE BASE ---\n{kb_text}"
        ),
    }


def _build_fallback_prompt(display_name):
    """Used when a company has no knowledge base connected yet (no kb_file, or
    the file is missing/empty). The agent can greet and qualify at a high level,
    but every detail question gets the fallback line + contact capture.
    Once a KB (or later the RAG library) exists for the company, the loader
    below picks it up automatically and this prompt is not used."""
    return {
        "role": "system",
        "content": (
            f"You are an AI sales representative for {display_name}, speaking with a prospect on a sales call. "
            f"{AGENT_RULES} "
            f"You do not yet have a knowledge base for {display_name}, so you cannot answer any "
            f"question about the product, pricing, or terms. "
            f"For any such question, reply exactly: \"{FALLBACK_LINE}\" "
            f"Then collect the prospect's name and phone number, confirm them back, and let them "
            f"know a team member will follow up. Never invent details."
        ),
    }


def _load_companies():
    with open(os.path.join(_KB_DIR, "companies.json")) as f:
        companies = json.load(f)
    for c in companies.values():
        kb_text = ""
        kb_file = c.get("kb_file")
        if kb_file:
            try:
                with open(os.path.join(_KB_DIR, kb_file)) as kb:
                    kb_text = kb.read().strip()
            except FileNotFoundError:
                pass
        if kb_text:
            c["system_prompt"] = _build_system_prompt(c["display_name"], kb_text)
            c["kb_available"] = True
        else:
            c["system_prompt"] = _build_fallback_prompt(c["display_name"])
            c["kb_available"] = False
    return companies


COMPANIES = _load_companies()
DEFAULT_COMPANY = "pacificbeef"
AGENT_REGISTRY = AgentRegistry.from_legacy_company_data(COMPANIES)
KNOWLEDGE_BASE_REGISTRY = KnowledgeBaseRegistry.from_path(
    os.path.join(_KB_DIR, "knowledge_profiles.json")
)
CAPABILITY_REGISTRY = CapabilityRegistry.default()

# Set per call from StasisStart (single active call only, per MVP scope).
current_company = DEFAULT_COMPANY
current_voice = COMPANIES[DEFAULT_COMPANY]["voice"]
current_agent_config = AGENT_REGISTRY.get(DEFAULT_COMPANY)

MAX_HISTORY = 10
MAX_RUNTIME_TOOL_ROUNDS = 2

# Position 0 is always the active company's system prompt; the trim in
# groq_worker preserves it, so it survives regardless of which company is live.
conversation_history = [COMPANIES[DEFAULT_COMPANY]["system_prompt"]]
current_session = CallSession.from_agent(
    current_agent_config,
    call_session_id="legacy-single-call",
    conversation_history=conversation_history,
)

# clients
dg = DeepgramClient(api_key=DEEPGRAM_KEY)
client = Groq(api_key=GROQ_KEY)

# queues
transcript_queue = queue.Queue()
tts_queue = queue.Queue()

# --- STEP 2 CHANGE: audio now arrives via RTP from Asterisk's externalMedia
# channel instead of a PyAudio mic stream. rtp_listener() (below) populates
# this queue; modulate_worker()'s send_audio reads from it. ---
audio_queue = queue.Queue()


# concurrent workers
# --- STEP 2 CHANGE: was mic_worker(socket) reading a PyAudio mic_stream
# (dead code in agent-test6.py -- modulate_worker had its own inline mic read
# instead of calling this). Repurposed as the RTP ingestion side: listens on
# UDP for the externalMedia stream, strips the 12-byte RTP header, and queues
# the raw PCM payload for modulate_worker's send_audio. ---
def rtp_listener():
    sock = udp_socket.socket(udp_socket.AF_INET, udp_socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", UDP_LISTEN_PORT))
    log("RTP", f"listening on UDP {UDP_LISTEN_PORT}")
    first = True
    while True:
        packet, _ = sock.recvfrom(2048)
        if first:
            log("RTP", f"first packet received ({len(packet)} bytes)")
            first = False
        raw = packet[RTP_HEADER_LEN:]
        # --- BUGFIX (2026-07-07): Asterisk externalMedia slin16 is BIG-endian
        # (RTP network byte order), but Modulate's stream is configured s16le
        # (little-endian). Feeding it as-is delivered byte-swapped noise
        # (verified: little-endian read of the RTP gave peak 32768 / rms 18221 =
        # full-scale garbage; byte-swapped gave clean speech ~peak 5000 / rms
        # 400). Swap each 16-bit sample so audio_queue holds valid s16le. ---
        samples = array.array("h")
        samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
        samples.byteswap()  # big-endian slin16 -> native little-endian s16le
        audio_queue.put(samples.tobytes())


# LLM worker - Groq [GPT OSS 120B]
def groq_worker():
    global conversation_history

    while True:
        transcript = transcript_queue.get()

        # --- TRANSFER: human is live -- transcript still logged upstream, but
        # don't feed the LLM or generate a reply. ---
        if holder == "human":
            current_session.skip_ai_turn(transcript, source="groq_worker")
            log("SKIP_TURN", "owner is HUMAN; AI is listening but not responding", payload=current_session.room_debug_payload())
            continue

        turn_epoch = epoch  # stamp this turn; drop it if holder switches mid-turn

        conversation_history.append({
            "role": "user",
            "content": transcript
        })
        current_session.conversation_history = conversation_history
        runtime_context = _record_runtime_context(source="llm_turn")
        model_kwargs = _runtime_capability_model_kwargs(runtime_context)
        tool_budget = _runtime_capability_call_budget(runtime_context)
        defer_tts_until_tool_decision = bool(model_kwargs)

        for tool_round in range(MAX_RUNTIME_TOOL_ROUNDS + 1):
            response = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=conversation_history,
                stream=True,
                **model_kwargs,
            )

            sentence = ""
            full_response = ""
            first_token = True
            tool_calls = {}

            for chunk in response:
                delta = chunk.choices[0].delta

                if getattr(delta, "tool_calls", None):
                    for tool_call in delta.tool_calls:
                        function_call = getattr(tool_call, "function", None)
                        entry = tool_calls.setdefault(
                            tool_call.index,
                            {"id": "", "name": "", "arguments": ""},
                        )
                        if tool_call.id:
                            entry["id"] = tool_call.id
                        if function_call and function_call.name:
                            entry["name"] = function_call.name
                        if function_call and function_call.arguments:
                            entry["arguments"] += function_call.arguments
                    continue

                token = delta.content

                if token is None:
                    continue

                if first_token:
                    log("LLM first-token", ms=_ms(), blank_before=True)
                    first_token = False

                sentence += token
                full_response += token

                if SHOW_LLM_STREAM:
                    print(token, end="", flush=True)

                if sentence.endswith(
                    (".", "!", "?")
                ):
                    if turn_epoch != epoch:   # holder switched -- abandon this turn
                        break
                    if not defer_tts_until_tool_decision:
                        tts_queue.put((sentence, turn_epoch))
                    sentence = ""

            if SHOW_LLM_STREAM:
                print()

            if tool_calls:
                _dispatch_runtime_tool_calls(
                    runtime_context=runtime_context,
                    tool_calls=tool_calls,
                    tool_budget=tool_budget,
                    assistant_content=full_response,
                )
                current_session.conversation_history = conversation_history
                if tool_round >= MAX_RUNTIME_TOOL_ROUNDS:
                    fallback_response = (
                        "I’m sorry, I’m having trouble completing that action right now. "
                        "Let me continue with what I can confirm."
                    )
                    log(
                        "CAPABILITY_TOOLS",
                        "tool round limit reached; skipping additional model call",
                    )
                    if turn_epoch == epoch:
                        tts_queue.put((fallback_response, turn_epoch))
                    conversation_history.append({
                        "role": "assistant",
                        "content": fallback_response,
                    })
                    current_session.conversation_history = conversation_history
                    break
                continue

            if turn_epoch == epoch:
                if defer_tts_until_tool_decision and full_response:
                    tts_queue.put((full_response, turn_epoch))
                elif sentence:
                    tts_queue.put((sentence, turn_epoch))

            log("LLM reply", full_response, ms=_ms())

            conversation_history.append({
                "role": "assistant",
                "content": full_response
            })
            current_session.conversation_history = conversation_history
            break

        if len(conversation_history) > MAX_HISTORY + 1:
            conversation_history = (
                [conversation_history[0]] + conversation_history[-(MAX_HISTORY):]
            )
            current_session.conversation_history = conversation_history


# --- STEP 3 CHANGE: was local playback via sounddevice
# (`stream = sd.OutputStream(...); stream.write(samples)`). Reply audio is
# now written to a file, downsampled for Asterisk, copied into the
# asterisk-mvp container, and played into the live call via ARI. ---
_reply_counter = 0


def play_deepgram(text):
    global _reply_counter, current_playback_id

    if current_channel_id is None:
        log("TTS", f"no active call channel, skipping playback for: {text}")
        return

    os.makedirs(TTS_STAGING_DIR, exist_ok=True)

    pcm_chunks = []
    first = True
    for chunk in dg.speak.v1.audio.generate(
        text=text,
        model=current_voice,  # MULTI-COMPANY: per-call voice set on StasisStart
        encoding="linear16",
        sample_rate=24000,
        container="none",
    ):
        if first:
            log("TTS audio", ms=_ms(), blank_before=True)
            first = False
        pcm_chunks.append(chunk)

    _reply_counter += 1
    sound_name = f"reply_{_reply_counter}"
    raw_wav_path = os.path.join(TTS_STAGING_DIR, f"{sound_name}_24k.wav")
    asterisk_wav_path = os.path.join(TTS_STAGING_DIR, f"{sound_name}.wav")

    # Aura returns headerless linear16 PCM (container="none") -- wrap it in a
    # WAV header at its native 24kHz before ffmpeg downsamples it.
    with wave.open(raw_wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(b"".join(pcm_chunks))

    # Asterisk plays back most reliably at 8kHz/16kHz mono WAV (step3 doc, section 3)
    subprocess.run(
        ["ffmpeg", "-y", "-i", raw_wav_path, "-ar", "8000", "-ac", "1", "-f", "wav", asterisk_wav_path],
        check=True,
        capture_output=True,
    )

    subprocess.run(
        [
            "docker", "cp", asterisk_wav_path,
            f"{ASTERISK_CONTAINER}:{SOUNDS_DIR_IN_CONTAINER}/{sound_name}.wav",
        ],
        check=True,
    )

    # --- TRANSFER (step 2): capture the playback id so set_holder("human") can
    # DELETE /playbacks/{id} and cut the AI off mid-sentence. ---
    result = ari_post(f"/channels/{current_channel_id}/play", media=f"sound:custom/{sound_name}")
    current_playback_id = result["id"] if result else None
    current_session.set_playback(current_playback_id)
    log("TTS played", sound_name, ms=_ms())

# TTS worker - Deepgram Aura
def tts_worker():
    while True:
        # --- TRANSFER (step 2): tts_queue items are (text, turn_epoch) tuples,
        # so a switch mid-turn drops stale audio at the last moment before playback. ---
        text, turn_epoch = tts_queue.get()
        if turn_epoch != epoch or holder == "human":
            continue  # stale turn or human took over -- drop silently
        log("TTS gen", text)
        play_deepgram(text)

# STT worker - Modulate.ai
def _modulate_url():
    # General streaming endpoint — matches what Amy validated in agent-test6.py
    # (her accuracy/latency testing was all on this endpoint). The English-only
    # `velma-2-stt-streaming-english-v2` is a later optimization to A/B test
    # once the loop is proven; don't diverge from Amy's tested config for the MVP.
    return (
        f"wss://platform.modulate.ai/api/velma-2-stt-streaming"
        f"?api_key={MODULATE_KEY}"
        f"&audio_format=s16le"
        f"&sample_rate={RATE}"
        f"&num_channels={CHANNELS}"
        f"&speaker_diarization=false"
        f"&partial_results=true"
    )


def _modulate_session(first_chunk):
    """One Modulate streaming connection: send audio + read transcripts until
    the socket closes. Raises on close/error so modulate_worker can reconnect."""
    with ws_connect(_modulate_url()) as ws:
        ws.send(first_chunk)
        stop = threading.Event()

        def send_audio():
            while not stop.is_set():
                try:
                    chunk = audio_queue.get(timeout=0.5)
                except queue.Empty:
                    continue  # wake periodically to re-check stop
                try:
                    ws.send(chunk)
                except Exception:
                    stop.set()
                    return

        send_thread = threading.Thread(target=send_audio, daemon=True)
        send_thread.start()
        # starts True so the first partial of the call also gets its blank
        # line; reset to True after each STT final so the next utterance's
        # partial stream starts with a gap too (see step3.3 doc, Decision 8)
        first_partial_of_utterance = True
        try:
            for message in ws:
                if isinstance(message, bytes):
                    continue
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "partial_utterance":
                    partial_text = data.get("partial_utterance", {}).get("text", "").strip()
                    if partial_text:
                        log("STT partial", partial_text, blank_before=first_partial_of_utterance)
                        first_partial_of_utterance = False

                elif msg_type == "utterance":
                    text = data.get("utterance", {}).get("text", "").strip()
                    if text:
                        transcript_queue.put(text)
                        log("STT final", text, ms=_ms(), blank_before=True)
                        first_partial_of_utterance = True
        finally:
            stop.set()
            send_thread.join(timeout=1)


def modulate_worker():
    # --- BUGFIX (2026-07-07): the connection was opened once at startup and
    # then sat idle until a call arrived. Modulate closes idle streaming
    # connections (observed: ConnectionClosedOK code 1000), so the first call's
    # audio hit a dead socket and nothing ever reconnected. Instead: block until
    # audio actually starts (a call is live), connect *then*, and reconnect for
    # each subsequent call. No idle socket to time out. ---
    while True:
        first_chunk = audio_queue.get()  # blocks until a call streams audio
        try:
            _modulate_session(first_chunk)
        except Exception as e:
            log("STT", f"session ended ({type(e).__name__}); reconnecting on next call")


# --- STEP 2 ADDITION: ARI control -- answers the call and bridges it with a
# new externalMedia channel so Asterisk starts forwarding RTP to
# UDP_LISTEN_PORT. Mirrors verify_ari.py's StasisStart/answer pattern. ---
def ari_post(path, **params):
    resp = requests.post(
        f"http://{ARI_HOST}/ari{path}",
        params=params,
        auth=(ARI_USER, ARI_PASSWORD),
    )
    resp.raise_for_status()
    return resp.json() if resp.text else None


def ari_delete(path):
    """Best-effort ARI delete -- used to tear down the bridge + externalMedia
    channel when a call ends, so they don't leak (see StasisEnd cleanup)."""
    try:
        requests.delete(
            f"http://{ARI_HOST}/ari{path}",
            auth=(ARI_USER, ARI_PASSWORD),
            timeout=3,
        )
    except requests.RequestException:
        pass


# --- BUGFIX (2026-07-13): every call used to leak its mixing bridge + its
# externalMedia channel -- StasisEnd only cleared current_channel_id and never
# tore them down, so orphaned UnicastRTP channels/bridges piled up in the
# Stasis app for days (16 found). Track this call's bridge + externalMedia
# channel so StasisEnd can delete them. ---
current_bridge_id = None
current_ext_channel_id = None


# --- BUGFIX (2026-07-07): externalMedia channels join the same Stasis app
# (`app=APP_NAME`) a real caller does, so creating one fires its own
# StasisStart. Without this set, ari_event_loop treated every externalMedia
# channel as a brand-new call and bridged it to *another* externalMedia
# channel -- cascading indefinitely (.43 -> .44 -> .45 -> ...) until Asterisk
# rejected an addChannel call with a 422, leaving dozens of orphaned
# channels/bridges. Track our own externalMedia channel IDs so their
# StasisStart is recognized and skipped, not treated as a new call. ---
_external_media_channel_ids = set()

# --- TRANSFER (step 1): same idea for the salesperson leg -- we originate it
# ourselves into the same mixing bridge, muted. Its StasisStart must be
# recognized and NOT treated as a new inbound call, so track its channel id
# in _sales_channel_ids. `current_sales_channel_id` is what set_holder()
# targets for mute/unmute. ---
_sales_channel_ids = set()
_human_channel_hangup_causes = {}
current_sales_channel_id = None
DEFAULT_HUMAN_ENDPOINT = "PJSIP/sales-endpoint"
DEFAULT_HUMAN_CALLER_ID = "Sales"

# --- TRANSFER (step 2): holder switch. `holder` decides who is audible;
# everything (sales mute, LLM gating, TTS suppression) derives from it. `epoch`
# is bumped on every switch so an in-flight turn started under the old holder
# is discarded rather than played. `current_playback_id` lets a switch cut off
# the AI mid-sentence via DELETE /playbacks/{id}. ---
holder = "ai"                  # "ai" | "human"
epoch = 0
current_playback_id = None
_call_control_lock = threading.RLock()


def _build_active_runtime_context():
    """Build the new runtime vocabulary from the currently active call."""
    return build_runtime_context(
        agent=current_agent_config,
        session=current_session,
        knowledge_base_registry=KNOWLEDGE_BASE_REGISTRY,
        default_human_endpoint=DEFAULT_HUMAN_ENDPOINT,
        human_caller_id=DEFAULT_HUMAN_CALLER_ID,
    )


def _runtime_context_debug_payload(runtime_context):
    return {
        "agent_config_id": runtime_context.agent_config_id,
        "company_key": runtime_context.company_key,
        "call_session_id": runtime_context.call_session_id,
        "owner": runtime_context.owner,
        "current_stage": runtime_context.current_stage,
        "stage_transitions": [
            transition.name for transition in runtime_context.stage_transitions
        ],
        "knowledge_profiles": [
            knowledge_base.knowledge_profile_id
            for knowledge_base in runtime_context.knowledge_bases
        ],
        "human_handoff_enabled": bool(
            runtime_context.session_state.get("human_handoff_enabled")
        ),
        "default_human_endpoint": runtime_context.session_state.get(
            "default_human_endpoint"
        ),
    }


def _record_runtime_context(*, source):
    """Record RuntimeContext without changing the current LLM/tool behavior."""
    try:
        runtime_context = _build_active_runtime_context()
    except Exception as exc:
        log(
            "RUNTIME_CONTEXT",
            f"failed to build from active call: {type(exc).__name__}: {exc}",
        )
        return None

    payload = _runtime_context_debug_payload(runtime_context)
    current_session.append_event(
        "runtime_context.built",
        source=source,
        **payload,
    )
    return runtime_context


def _runtime_capability_model_kwargs(runtime_context):
    """Return model kwargs for capability tools when the rollout flag is on."""
    if not ENABLE_RUNTIME_CAPABILITY_TOOLS or runtime_context is None:
        return {}

    try:
        tools = CAPABILITY_REGISTRY.to_llm_tools(runtime_context)
    except Exception as exc:
        current_session.append_event(
            "runtime_capability_tools.failed",
            error=f"{type(exc).__name__}: {exc}",
        )
        log(
            "CAPABILITY_TOOLS",
            f"failed to expose tools: {type(exc).__name__}: {exc}",
        )
        return {}

    tool_names = [
        tool.get("function", {}).get("name")
        for tool in tools
        if tool.get("function", {}).get("name")
    ]
    current_session.append_event(
        "runtime_capability_tools.exposed",
        enabled=True,
        tool_names=tool_names,
        agent_config_id=runtime_context.agent_config_id,
        company_key=runtime_context.company_key,
        call_session_id=runtime_context.call_session_id,
        owner=runtime_context.owner,
    )
    log(
        "CAPABILITY_TOOLS",
        f"exposed {len(tool_names)} tool(s)",
        payload={"tool_names": tool_names},
    )

    if not tools:
        return {}
    return {"tools": tools}


def _runtime_capability_call_budget(runtime_context):
    if not ENABLE_RUNTIME_CAPABILITY_TOOLS or runtime_context is None:
        return None
    try:
        return RuntimeCapabilityCallBudget.from_capabilities(
            CAPABILITY_REGISTRY.allowed_for(runtime_context)
        )
    except Exception as exc:
        current_session.append_event(
            "runtime_capability_policy.failed",
            error=f"{type(exc).__name__}: {exc}",
        )
        log(
            "CAPABILITY_TOOLS",
            f"failed to build call budget: {type(exc).__name__}: {exc}",
        )
        return None


def _dispatch_runtime_tool_calls(
    *,
    runtime_context,
    tool_calls,
    tool_budget=None,
    assistant_content="",
):
    global conversation_history
    pending_tool_calls = _normalized_tool_calls(tool_calls)
    current_session.append_event(
        "runtime_capability_tool_calls.dispatching",
        tool_calls=pending_tool_calls,
        call_session_id=getattr(runtime_context, "call_session_id", None),
        company_key=getattr(runtime_context, "company_key", None),
    )
    log(
        "CAPABILITY_TOOLS",
        f"dispatching {len(pending_tool_calls)} tool call(s)",
        payload={
            "tool_calls": [
                {
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "arguments": call.get("arguments"),
                }
                for call in pending_tool_calls
            ]
        },
    )

    assistant_message = {
        "role": "assistant",
        "tool_calls": [
            {
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": call["arguments"],
                },
            }
            for call in pending_tool_calls
        ],
    }
    if assistant_content:
        assistant_message["content"] = assistant_content
    conversation_history.append(assistant_message)

    for call in pending_tool_calls:
        result = _execute_runtime_tool_call(runtime_context, call, tool_budget=tool_budget)
        content, truncated, original_char_count = serialize_tool_result(
            result,
            max_chars=MAX_RUNTIME_TOOL_RESULT_CHARS,
        )
        if truncated:
            current_session.append_event(
                "runtime_capability_tool_result.truncated",
                tool_call_id=call["id"],
                capability=call["name"],
                original_char_count=original_char_count,
                max_char_count=MAX_RUNTIME_TOOL_RESULT_CHARS,
                serialized_char_count=len(content),
            )
        conversation_history.append({
            "role": "tool",
            "tool_call_id": call["id"],
            "content": content,
        })
    current_session.conversation_history = conversation_history


def _normalized_tool_calls(tool_calls):
    normalized = []
    for index, call in sorted(tool_calls.items()):
        name = (call.get("name") or "").strip() or "unknown_capability"
        normalized.append({
            "id": call.get("id") or f"runtime_tool_call_{index}",
            "name": name,
            "arguments": call.get("arguments") or "{}",
        })
    return normalized


def _execute_runtime_tool_call(runtime_context, call, *, tool_budget=None):
    if runtime_context is None:
        return {
            "ok": False,
            "capability": call.get("name"),
            "error": "RuntimeContext is not available for this tool call.",
        }

    budget_payload = None
    try:
        if tool_budget is not None:
            budget_payload = tool_budget.reserve(call.get("name"))
        arguments = _parse_tool_arguments(call.get("arguments"))
        result = execute_capability_call(
            runtime_context,
            call.get("name"),
            arguments,
            registry=CAPABILITY_REGISTRY,
            human_handoff_handler=_runtime_human_handoff_handler,
        )
        current_session.append_event(
            "runtime_capability_tool_call.executed",
            tool_call_id=call.get("id"),
            capability=call.get("name"),
            ok=True,
            budget=budget_payload,
        )
        return result
    except CapabilityCallBudgetExceeded as exc:
        error = f"{type(exc).__name__}: {exc}"
        current_session.append_event(
            "runtime_capability_tool_call.failed",
            tool_call_id=call.get("id"),
            capability=call.get("name"),
            error=error,
            policy="max_calls_per_turn",
            budget=budget_payload,
        )
        log(
            "CAPABILITY_TOOLS",
            f"tool call blocked by policy: {error}",
            payload={"tool_call_id": call.get("id"), "name": call.get("name")},
        )
        return {
            "ok": False,
            "capability": call.get("name"),
            "error": error,
            "policy": "max_calls_per_turn",
        }
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        current_session.append_event(
            "runtime_capability_tool_call.failed",
            tool_call_id=call.get("id"),
            capability=call.get("name"),
            error=error,
            budget=budget_payload,
        )
        log(
            "CAPABILITY_TOOLS",
            f"tool call failed: {error}",
            payload={"tool_call_id": call.get("id"), "name": call.get("name")},
        )
        return {
            "ok": False,
            "capability": call.get("name"),
            "error": error,
        }


def _parse_tool_arguments(raw_arguments):
    if raw_arguments is None or raw_arguments == "":
        return {}
    try:
        arguments = json.loads(raw_arguments)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid tool arguments JSON: {exc}") from exc
    if not isinstance(arguments, dict):
        raise ValueError("tool arguments must decode to an object")
    return arguments


def _runtime_human_handoff_handler(
    *,
    context,
    reason,
    urgency,
    preferred_team,
    endpoint,
    caller_id,
):
    endpoint = endpoint or DEFAULT_HUMAN_ENDPOINT
    caller_id = caller_id or DEFAULT_HUMAN_CALLER_ID

    if current_sales_channel_id or current_session.human_invite_status:
        return {
            "invite_status": current_session.human_invite_status,
            "channel_id": current_sales_channel_id or current_session.human_channel_id,
            "already_invited": True,
            "endpoint": current_session.human_endpoint or endpoint,
            "caller_id": current_session.human_caller_id or caller_id,
            "reason": reason,
            "urgency": urgency,
            "preferred_team": preferred_team,
        }

    channel_id = invite_human_to_room(endpoint, caller_id=caller_id)
    return {
        "invite_status": current_session.human_invite_status,
        "channel_id": channel_id,
        "already_invited": False,
        "endpoint": endpoint,
        "caller_id": caller_id,
        "reason": reason,
        "urgency": urgency,
        "preferred_team": preferred_team,
    }


def create_asterisk_room(caller_channel_id):
    """Create the Asterisk equivalent of a Telnyx room for this call."""
    global current_bridge_id, current_ext_channel_id
    bridge = ari_post("/bridges", type="mixing")
    bridge_id = bridge["id"]
    ari_post(f"/bridges/{bridge_id}/addChannel", channel=caller_channel_id)

    ext_channel = ari_post(
        "/channels/externalMedia",
        app=APP_NAME,
        external_host=EXTERNAL_MEDIA_HOST,
        format="slin16",
    )
    _external_media_channel_ids.add(ext_channel["id"])
    ari_post(f"/bridges/{bridge_id}/addChannel", channel=ext_channel["id"])
    # Remember them so StasisEnd can tear them down instead of leaking.
    current_bridge_id = bridge_id
    current_ext_channel_id = ext_channel["id"]
    current_session.set_room(bridge_id=bridge_id, ai_media_channel_id=ext_channel["id"])
    log("ROOM", "created", payload=current_session.room_debug_payload())
    log("CALL", f"bridged {caller_channel_id} + externalMedia {ext_channel['id']} into bridge {bridge_id}")
    return bridge_id, ext_channel["id"]


def invite_human_to_room(endpoint, *, caller_id=DEFAULT_HUMAN_CALLER_ID):
    """Invite a human participant into the active Asterisk room."""
    global current_sales_channel_id
    # --- TRANSFER (step 1): originate the salesperson leg into the SAME bridge,
    # muted. Ringing/answer is async -- the actual addChannel + mute happen when
    # this channel's StasisStart fires (handled in ari_event_loop). Tracked in
    # _sales_channel_ids so its StasisStart is NOT treated as a new inbound call. ---
    try:
        sales = ari_post(
            "/channels",
            endpoint=endpoint,
            app=APP_NAME,
            callerId=caller_id,
        )
    except requests.RequestException as e:
        mark_handoff_failure(
            status="failed",
            reason=f"human originate failed: {type(e).__name__}: {e}",
            source="invite_human_to_room",
        )
        return None
    _sales_channel_ids.add(sales["id"])
    current_sales_channel_id = sales["id"]
    current_session.invite_human(
        endpoint=endpoint,
        caller_id=caller_id,
        channel_id=sales["id"],
    )
    log("HUMAN_INVITE", "ringing", payload=current_session.room_debug_payload())
    log("SALES", f"originating human leg {sales['id']} to {endpoint} (ringing, will join muted)")
    return sales["id"]


def invite_default_human_to_room():
    invite_human_to_room(DEFAULT_HUMAN_ENDPOINT, caller_id=DEFAULT_HUMAN_CALLER_ID)


def bridge_call_to_external_media(caller_channel_id):
    """Compatibility wrapper: create the room, then attach the default human leg."""
    create_asterisk_room(caller_channel_id)
    invite_default_human_to_room()


def _apply_owner_side_effects():
    global holder, epoch, current_playback_id
    holder = current_session.owner
    epoch = current_session.epoch  # invalidate any in-flight turn (checked in groq_worker/tts_worker)

    if current_sales_channel_id:
        action = "unmute" if holder == "human" else "mute"
        requests.post(
            f"http://{ARI_HOST}/ari/channels/{current_sales_channel_id}/{action}",
            params={"direction": "in"},
            auth=(ARI_USER, ARI_PASSWORD),
        )

    if holder == "human" and current_playback_id:
        ari_delete(f"/playbacks/{current_playback_id}")  # cut AI off mid-sentence
        current_playback_id = None
        current_session.clear_playback()

    log("HOLDER", holder)


def set_call_owner(owner, *, reason=None, source="internal"):
    """Switch the product owner of the call while preserving the legacy globals."""
    with _call_control_lock:
        if not current_session.set_owner(owner, reason=reason, source=source):
            return False
        _apply_owner_side_effects()
        return True


def takeover_by_human(*, reason=None, source="internal"):
    return set_call_owner("human", reason=reason, source=source)


def accept_handoff(*, accepted_by=None, source="internal"):
    with _call_control_lock:
        holder_changed = current_session.accept_handoff(accepted_by=accepted_by, source=source)
        if not holder_changed:
            return False
        _apply_owner_side_effects()
        log("HANDOFF", "accepted", payload=current_session.room_debug_payload())
        return True


def resume_ai(*, handback_note=None, resumed_by=None, source="internal"):
    with _call_control_lock:
        holder_changed = current_session.resume_ai(
            handback_note=handback_note,
            resumed_by=resumed_by,
            source=source,
        )
        if not holder_changed:
            return False
        _append_handback_context()
        _apply_owner_side_effects()
        log("HANDOFF", "resumed", payload=current_session.room_debug_payload())
        return True


def _append_handback_context():
    global conversation_history
    conversation_history.append(current_session.handback_context_message())
    if len(conversation_history) > MAX_HISTORY + 1:
        conversation_history = (
            [conversation_history[0]] + conversation_history[-(MAX_HISTORY):]
        )
    current_session.conversation_history = conversation_history


def _handoff_failure_payload(recovery_action):
    payload = current_session.room_debug_payload()
    payload["recovery_action"] = recovery_action
    return payload


def mark_handoff_failure(
    *,
    status,
    reason,
    source="internal",
    channel_id=None,
):
    """Record a human handoff failure and keep the caller in a valid owner state."""
    global current_sales_channel_id
    with _call_control_lock:
        owner_before = current_session.owner
        tracked_channel_id = channel_id or current_sales_channel_id
        current_session.mark_handoff_failure(
            status=status,
            reason=reason,
            source=source,
        )
        if tracked_channel_id:
            ari_delete(f"/channels/{tracked_channel_id}")
            _sales_channel_ids.discard(tracked_channel_id)
            _human_channel_hangup_causes.pop(tracked_channel_id, None)
        if current_sales_channel_id == tracked_channel_id:
            current_sales_channel_id = None

        recovery_action = "ai_remained_owner"
        if owner_before == "human":
            current_session.resume_ai(
                handback_note=f"Human handoff ended unexpectedly: {reason}",
                resumed_by="system",
                source=source,
                reason="handoff_failure_recovery",
            )
            _append_handback_context()
            _apply_owner_side_effects()
            recovery_action = "returned_to_ai"
        else:
            _apply_owner_side_effects()

        log(
            "HANDOFF_FAILURE",
            status,
            payload=_handoff_failure_payload(recovery_action),
        )
        return recovery_action


def _human_failure_status_from_hangup(channel_id):
    hangup = _human_channel_hangup_causes.pop(channel_id, {}) or {}
    cause = hangup.get("cause")
    cause_txt = str(hangup.get("cause_txt") or "").lower()
    if cause == 17 or "busy" in cause_txt:
        return "busy"
    if cause in (21, 603) or "reject" in cause_txt or "declin" in cause_txt:
        return "declined"
    if cause in (18, 19) or "no answer" in cause_txt or "no user response" in cause_txt:
        return "no_answer"
    if current_session.owner == "human" or current_session.handoff_accept_status == "accepted":
        return "dropped"
    if current_session.human_invite_status == "ringing":
        return "no_answer"
    return "dropped"


def toggle_call_owner(*, source="internal"):
    if holder == "ai":
        return accept_handoff(accepted_by=DEFAULT_HUMAN_CALLER_ID, source=source)
    return resume_ai(
        handback_note="manual_toggle",
        resumed_by=DEFAULT_HUMAN_CALLER_ID,
        source=source,
    )


def set_holder(value):
    """Compatibility alias for older scripts/docs that still say holder."""
    return set_call_owner(value, source="legacy_set_holder")


class ControlHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _send_json(self, body, status=200):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path not in (
            "/internal/handoff/accept",
            "/internal/handoff/resume-ai",
            "/internal/handoff/failure",
        ):
            self._send_json({"error": "not found"}, 404)
            return
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._send_json({"error": "forbidden"}, 403)
            return

        body = self._read_json_body()
        actor = body.get("accepted_by") or body.get("resumed_by") or DEFAULT_HUMAN_CALLER_ID
        try:
            if current_session.status != "active":
                self._send_json(
                    {"error": "no active call", **current_session.room_debug_payload()},
                    409,
                )
                return
            recovery_action = None
            if self.path == "/internal/handoff/accept":
                changed = accept_handoff(accepted_by=actor, source="control_api")
            elif self.path == "/internal/handoff/resume-ai":
                changed = resume_ai(
                    handback_note=body.get("handback_note"),
                    resumed_by=actor,
                    source="control_api",
                )
            else:
                recovery_action = mark_handoff_failure(
                    status=body.get("status") or "failed",
                    reason=body.get("reason") or "handoff failure reported by control API",
                    source="control_api",
                )
                changed = recovery_action == "returned_to_ai"
            response = {
                "ok": True,
                "changed": changed,
                **current_session.room_debug_payload(),
            }
            if recovery_action:
                response["recovery_action"] = recovery_action
            self._send_json(response)
        except RuntimeError as e:
            self._send_json(
                {"error": str(e), **current_session.room_debug_payload()},
                409,
            )
        except ValueError as e:
            self._send_json({"error": str(e)}, 400)


def control_server():
    server = ThreadingHTTPServer((CONTROL_HOST, CONTROL_PORT), ControlHandler)
    log("CONTROL", f"listening on http://{CONTROL_HOST}:{CONTROL_PORT}")
    server.serve_forever()


# --- STEP 3 ADDITION: the container's sounds dir may not exist yet --
# create it once at startup so play_deepgram's docker cp doesn't fail. ---
def ensure_sounds_dir():
    try:
        subprocess.run(
            ["docker", "exec", ASTERISK_CONTAINER, "mkdir", "-p", SOUNDS_DIR_IN_CONTAINER],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        log("SETUP", "Docker CLI was not found. Install Docker Desktop before starting the bridge.")
        raise SystemExit(1)
    except subprocess.CalledProcessError as e:
        detail = (e.stderr or e.stdout or "").strip()
        if detail:
            detail = f" Detail: {detail}"
        log(
            "SETUP",
            (
                f"Cannot prepare Asterisk sounds dir in container '{ASTERISK_CONTAINER}'. "
                "Start Docker Desktop and make sure the Asterisk container is running, "
                f"then retry.{detail}"
            ),
        )
        raise SystemExit(1)


def ari_event_loop():
    global current_channel_id, current_company, current_voice, conversation_history
    global current_bridge_id, current_ext_channel_id, current_sales_channel_id
    global current_agent_config
    global holder, epoch, current_playback_id

    ws_url = f"ws://{ARI_HOST}/ari/events?api_key={ARI_USER}:{ARI_PASSWORD}&app={APP_NAME}"
    log("ARI", f"connecting to ws://{ARI_HOST}/ari/events?api_key=***:***&app={APP_NAME}")
    ari_ws = create_connection(ws_url)
    log("ARI", f"connected, waiting for calls into {APP_NAME} (Ctrl+C to stop)")

    while True:
        message = ari_ws.recv()
        # --- BUGFIX (2026-07-13): handle each event inside try/except so one
        # bad call (e.g. an ARI 422 while bridging) can't kill the whole loop.
        # Previously an exception here bubbled out of ari_event_loop and the
        # bridge PROCESS EXITED, silently -- then every later call rang into a
        # Stasis app with no handler and dropped on answer. Now the bridge
        # logs the error and stays up for the next call. ---
        try:
            event = json.loads(message)
            event_type = event.get("type")

            if event_type == "StasisStart":
                channel_id = event["channel"]["id"]

                if channel_id in _external_media_channel_ids:
                    # Our own externalMedia channel entering Stasis, not a new
                    # call -- already bridged inside bridge_call_to_external_media().
                    continue

                # --- TRANSFER (step 1): our own salesperson leg answered --
                # add to the active bridge, muted. Not a new inbound call. ---
                if channel_id in _sales_channel_ids or channel_id == current_sales_channel_id:
                    ari_post(f"/bridges/{current_bridge_id}/addChannel", channel=channel_id)
                    current_session.set_human_channel(channel_id)
                    requests.post(
                        f"http://{ARI_HOST}/ari/channels/{channel_id}/mute",
                        params={"direction": "in"},
                        auth=(ARI_USER, ARI_PASSWORD),
                    )
                    log("HUMAN_INVITE", "joined", payload=current_session.room_debug_payload())
                    log("SALES", f"joined bridge muted: {channel_id}")
                    continue

                # --- AGENT REGISTRY: resolve the call into a voice-agent config.
                # Today the registry is backed by companies.json; later this is
                # where Customer Registration / Dashboard data plugs in.
                resolution = AGENT_REGISTRY.resolve(
                    stasis_args=event.get("args") or [],
                    dialed_extension=event.get("channel", {}).get("dialplan", {}).get("exten"),
                    default_agent_id=DEFAULT_COMPANY,
                )
                company_key = resolution.agent.company_key
                company = COMPANIES[company_key]
                current_company = company_key
                current_voice = company["voice"]
                current_agent_config = resolution.agent
                conversation_history = [company["system_prompt"]]
                current_session.start_call(
                    caller_channel_id=channel_id,
                    agent=resolution.agent,
                    conversation_history=conversation_history,
                )
                holder = current_session.owner
                epoch = current_session.epoch
                current_playback_id = current_session.current_playback_id
                runtime_context = _record_runtime_context(source="call_start")

                log("CALL", f"arrived: {channel_id}")
                log("AGENT", company["display_name"])
                if runtime_context:
                    log(
                        "RUNTIME_CONTEXT",
                        "built for active call",
                        payload=_runtime_context_debug_payload(runtime_context),
                    )
                requests.post(
                    f"http://{ARI_HOST}/ari/channels/{channel_id}/answer",
                    auth=(ARI_USER, ARI_PASSWORD),
                )
                bridge_call_to_external_media(channel_id)
                # --- STEP 3 ADDITION: remember the channel so play_deepgram can target it ---
                current_channel_id = channel_id

            elif event_type == "StasisEnd":
                channel_id = event["channel"]["id"]

                # --- TRANSFER: our own human leg ending should never strand
                # the caller. If human already owned the call, return control
                # to AI; otherwise keep AI as-is and expose the failure.
                if channel_id in _sales_channel_ids:
                    failure_status = _human_failure_status_from_hangup(channel_id)
                    mark_handoff_failure(
                        status=failure_status,
                        reason=f"human channel ended: {channel_id}",
                        source="ari_stasis_end",
                        channel_id=channel_id,
                    )
                    continue

                if channel_id == current_channel_id:
                    log("CALL", f"ended: {channel_id}", blank_before=2)
                    current_channel_id = None
                    # --- BUGFIX (2026-07-13): tear down this call's bridge +
                    # externalMedia channel so they don't leak into the Stasis app. ---
                    if current_ext_channel_id:
                        ari_delete(f"/channels/{current_ext_channel_id}")
                    if current_bridge_id:
                        ari_delete(f"/bridges/{current_bridge_id}")
                    # --- TRANSFER (step 1): also hang up + untrack the sales leg. ---
                    if current_sales_channel_id:
                        ari_delete(f"/channels/{current_sales_channel_id}")
                        _sales_channel_ids.discard(current_sales_channel_id)
                        _human_channel_hangup_causes.pop(current_sales_channel_id, None)
                    _external_media_channel_ids.discard(current_ext_channel_id)
                    current_ext_channel_id = None
                    current_bridge_id = None
                    current_sales_channel_id = None
                    current_session.end_call()
                    holder = current_session.owner
                    epoch = current_session.epoch
                    current_playback_id = current_session.current_playback_id

            elif event_type == "ChannelHangupRequest":
                channel_id = event.get("channel", {}).get("id")
                if channel_id in _sales_channel_ids or channel_id == current_sales_channel_id:
                    _human_channel_hangup_causes[channel_id] = {
                        "cause": event.get("cause"),
                        "cause_txt": event.get("cause_txt"),
                    }

            # --- TRANSFER (step 2): DTMF-triggered owner toggle. The salesperson
            # presses `1` on their softphone to take the call over or hand it back.
            # This now goes through the same product-level call-control functions
            # that a dashboard/API endpoint can call in a later increment. ---
            elif event_type == "ChannelDtmfReceived":
                digit = event.get("digit")
                ch = event.get("channel", {}).get("id")
                log("DTMF", f"{digit} from {ch}")
                if ch == current_sales_channel_id and digit == "1":
                    toggle_call_owner(source="dtmf")

        except Exception as e:
            log("ARI", f"error handling event ({type(e).__name__}: {e}); call skipped, bridge still up")


# --- STEP 3 ADDITION: make sure the container has somewhere to receive played-back files ---
ensure_sounds_dir()

# begin concurrent threads
# --- STEP 2 CHANGE: added rtp_listener + ari_event_loop; removed the old
# mic-based deepgram_worker (agent-test6.py had already moved STT to
# modulate_worker, so deepgram is TTS-only here, called directly from
# tts_worker). ---
threads = [
    threading.Thread(target=control_server, daemon=True),
    threading.Thread(target=rtp_listener, daemon=True),
    threading.Thread(target=modulate_worker, daemon=True),
    threading.Thread(target=groq_worker, daemon=True),
    threading.Thread(target=tts_worker, daemon=True),
]

for t in threads:
    t.start()

try:
    ari_event_loop()
except KeyboardInterrupt:
    print("\nShutting down...")
