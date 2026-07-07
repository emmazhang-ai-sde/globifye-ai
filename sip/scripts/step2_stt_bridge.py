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
from deepgram.core.events import EventType
from deepgram.listen.v1.types import ListenV1Results
from groq import Groq
from websockets.sync.client import connect as ws_connect
import json
import time

# --- STEP 2 ADDITION: ARI + RTP bridge imports (not in original agent-test6.py) ---
import socket as udp_socket
import requests
from websocket import create_connection

# set up timer for timestamps
_START = time.time()
def _ms():
    return int((time.time() - _START) * 1000)


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
# hosts host.docker.internal`). ---
EXTERNAL_MEDIA_HOST = "host.docker.internal:9000"
UDP_LISTEN_PORT = 9000
RTP_HEADER_LEN = 12

# --- STEP 3 ADDITION: TTS playback-into-call config ---
ASTERISK_CONTAINER = "asterisk-mvp"
SOUNDS_DIR_IN_CONTAINER = "/var/lib/asterisk/sounds/custom"
TTS_STAGING_DIR = "/tmp/sip-tts-staging"

# Set from StasisStart / cleared on StasisEnd -- single active call only,
# concurrency is explicitly out of scope for this MVP (step5-scope-guardrails.md)
current_channel_id = None

SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You are a professional, conversational sales representative. "
        "Respond to the customer in a natural, spoken manner as if on a phone call. Keep answers as short as possible."
        "If the customer raises concerns, acknowledge them politely and address them "
        "in a business-appropriate way. Be concise and conversational. "
        "Do not use any markdown formatting, bullet points, asterisks, or emojis. Do not output thinking, only the final answer (conversational response)."
        "Use plain natural language only, without filler openers, as your response will be read aloud by text-to-speech."
    )
}

MAX_HISTORY = 10

conversation_history = [SYSTEM_PROMPT]

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
def on_transcript(data):
    if not isinstance(data, ListenV1Results):
        return

    sentence = data.channel.alternatives[0].transcript.strip()

    if not sentence:
        return

    print("STT:", sentence)

    if data.is_final:
        transcript_queue.put(sentence)
        x = _ms()
        print(f"[t0 +{x}ms]")


# --- STEP 2 CHANGE: was mic_worker(socket) reading a PyAudio mic_stream
# (dead code in agent-test6.py -- modulate_worker had its own inline mic read
# instead of calling this). Repurposed as the RTP ingestion side: listens on
# UDP for the externalMedia stream, strips the 12-byte RTP header, and queues
# the raw PCM payload for modulate_worker's send_audio. ---
def rtp_listener():
    sock = udp_socket.socket(udp_socket.AF_INET, udp_socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", UDP_LISTEN_PORT))
    print(f"Listening for RTP on UDP {UDP_LISTEN_PORT}")
    first = True
    while True:
        packet, _ = sock.recvfrom(2048)
        if first:
            print(f"First RTP packet received ({len(packet)} bytes)")
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

        print("USER:", transcript)

        conversation_history.append({
            "role": "user",
            "content": transcript
        })

        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=conversation_history,
            stream=True
        )

        sentence = ""
        full_response = ""
        first_token = True

        for chunk in response:
            token = chunk.choices[0].delta.content

            if token is None:
                continue

            if first_token:
                b = _ms()
                print(f"[t1 +{b}ms]")
                first_token = False

            sentence += token
            full_response += token

            print(token, end="", flush=True)

            if sentence.endswith(
                (".", "!", "?")
            ):
                tts_queue.put(sentence)
                sentence = ""

        if sentence:
            tts_queue.put(sentence)

        a = _ms()
        print(f"[t2 +{a}ms]")
        print()

        conversation_history.append({
            "role": "assistant",
            "content": full_response
        })

        if len(conversation_history) > MAX_HISTORY + 1:
            conversation_history = (
                [SYSTEM_PROMPT] + conversation_history[-(MAX_HISTORY):]
            )


# --- STEP 3 CHANGE: was local playback via sounddevice
# (`stream = sd.OutputStream(...); stream.write(samples)`). Reply audio is
# now written to a file, downsampled for Asterisk, copied into the
# asterisk-mvp container, and played into the live call via ARI. ---
_reply_counter = 0


def play_deepgram(text):
    global _reply_counter

    if current_channel_id is None:
        print("No active call channel -- skipping playback for:", text)
        return

    os.makedirs(TTS_STAGING_DIR, exist_ok=True)

    pcm_chunks = []
    first = True
    for chunk in dg.speak.v1.audio.generate(
        text=text,
        model="aura-2-arcas-en",
        encoding="linear16",
        sample_rate=24000,
        container="none",
    ):
        if first:
            t = _ms()
            print(f"[t3 +{t}ms]")
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

    ari_post(f"/channels/{current_channel_id}/play", media=f"sound:custom/{sound_name}")

    z = _ms()
    print(f"[t4 +{z}ms]")

# TTS worker - Deepgram Aura
def tts_worker():
    while True:
        text = tts_queue.get()

        print("TTS:", text)
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
        try:
            for message in ws:
                if isinstance(message, bytes):
                    continue
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "partial_utterance":
                    partial_text = data.get("partial_utterance", {}).get("text", "").strip()
                    if partial_text:
                        print("STT (partial):", partial_text)

                elif msg_type == "utterance":
                    text = data.get("utterance", {}).get("text", "").strip()
                    if text:
                        print("STT:", text)
                        transcript_queue.put(text)
                        x = _ms()
                        print(f"[t0 +{x}ms]")
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
            print(f"[Modulate] session ended ({type(e).__name__}); "
                  f"will reconnect when the next call starts")


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


# --- BUGFIX (2026-07-07): externalMedia channels join the same Stasis app
# (`app=APP_NAME`) a real caller does, so creating one fires its own
# StasisStart. Without this set, ari_event_loop treated every externalMedia
# channel as a brand-new call and bridged it to *another* externalMedia
# channel -- cascading indefinitely (.43 -> .44 -> .45 -> ...) until Asterisk
# rejected an addChannel call with a 422, leaving dozens of orphaned
# channels/bridges. Track our own externalMedia channel IDs so their
# StasisStart is recognized and skipped, not treated as a new call. ---
_external_media_channel_ids = set()


def bridge_call_to_external_media(caller_channel_id):
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
    print(
        f"Bridged caller {caller_channel_id} + externalMedia "
        f"{ext_channel['id']} into bridge {bridge_id}"
    )


# --- STEP 3 ADDITION: the container's sounds dir may not exist yet --
# create it once at startup so play_deepgram's docker cp doesn't fail. ---
def ensure_sounds_dir():
    subprocess.run(
        ["docker", "exec", ASTERISK_CONTAINER, "mkdir", "-p", SOUNDS_DIR_IN_CONTAINER],
        check=True,
    )


def ari_event_loop():
    global current_channel_id

    ws_url = f"ws://{ARI_HOST}/ari/events?api_key={ARI_USER}:{ARI_PASSWORD}&app={APP_NAME}"
    print(f"Connecting to {ws_url} ...")
    ari_ws = create_connection(ws_url)
    print("Connected. Waiting for calls into", APP_NAME, "(Ctrl+C to stop)")

    while True:
        message = ari_ws.recv()
        event = json.loads(message)
        event_type = event.get("type")

        if event_type == "StasisStart":
            channel_id = event["channel"]["id"]

            if channel_id in _external_media_channel_ids:
                # Our own externalMedia channel entering Stasis, not a new
                # call -- already bridged inside bridge_call_to_external_media().
                continue

            print(f"Call arrived: channel {channel_id}")
            requests.post(
                f"http://{ARI_HOST}/ari/channels/{channel_id}/answer",
                auth=(ARI_USER, ARI_PASSWORD),
            )
            bridge_call_to_external_media(channel_id)
            # --- STEP 3 ADDITION: remember the channel so play_deepgram can target it ---
            current_channel_id = channel_id

        elif event_type == "StasisEnd":
            channel_id = event["channel"]["id"]
            if channel_id == current_channel_id:
                print(f"Call ended: channel {channel_id}")
                current_channel_id = None


# --- STEP 3 ADDITION: make sure the container has somewhere to receive played-back files ---
ensure_sounds_dir()

# begin concurrent threads
# --- STEP 2 CHANGE: added rtp_listener + ari_event_loop; removed the old
# mic-based deepgram_worker (agent-test6.py had already moved STT to
# modulate_worker, so deepgram is TTS-only here, called directly from
# tts_worker). ---
threads = [
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
