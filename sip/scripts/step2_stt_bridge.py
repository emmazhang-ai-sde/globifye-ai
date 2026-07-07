"""
Step 2 -- Wire call audio into STT.

This file is a copy of Amy's `amy/llm-testing/agent-test6.py` (Modulate STT ->
Groq LLM -> Deepgram Aura TTS pipeline), adapted per
`design-docs-sip/sip-loop-mvp-step-by-step-guidence/step2-wire-call-audio-into-stt.md`:
the only structural change is the audio *source*. Instead of a PyAudio mic
stream, audio now arrives as RTP from an Asterisk `externalMedia` channel
(via verify_ari.py's ARI answer/Stasis pattern), gets stripped of its RTP
header, and is queued for the same Modulate streaming connection Amy's
original script already used. Everything downstream of that queue --
Modulate, Groq, Deepgram Aura TTS -- is untouched from agent-test6.py.

Original attribution: Amy, amy/llm-testing/agent-test6.py.
"""

import queue
import threading
import sounddevice as sd
import numpy as np
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

# api keys
DEEPGRAM_KEY = ""
GROQ_KEY = ""
MODULATE_KEY = ""

# setup parameters
RATE = 16000
CHANNELS = 1

# --- STEP 2 ADDITION: ARI config (same as verify_ari.py) ---
ARI_HOST = "localhost:8088"
ARI_USER = "sip-mvp-user"
ARI_PASSWORD = "changeme_use_a_real_secret"
APP_NAME = "sip-mvp-app"

# --- STEP 2 ADDITION: externalMedia / RTP bridge config ---
EXTERNAL_MEDIA_HOST = "127.0.0.1:9000"
UDP_LISTEN_PORT = 9000
RTP_HEADER_LEN = 12

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
    while True:
        packet, _ = sock.recvfrom(2048)
        pcm = packet[RTP_HEADER_LEN:]
        audio_queue.put(pcm)


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


# TTS helper function
def play_deepgram(text):
    stream = sd.OutputStream(samplerate=24000, channels=1, dtype="int16")
    stream.start()

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
        samples = np.frombuffer(chunk, dtype=np.int16)
        stream.write(samples)

    stream.stop()
    stream.close()
    z = _ms()
    print(f"[t4 +{z}ms]")

# TTS worker - Deepgram Aura
def tts_worker():
    while True:
        text = tts_queue.get()

        print("TTS:", text)
        play_deepgram(text)

# STT worker - Modulate.ai
def modulate_worker():
    url = (
        f"wss://platform.modulate.ai/api/velma-2-stt-streaming"
        f"?api_key={MODULATE_KEY}"
        f"&audio_format=s16le"
        f"&sample_rate={RATE}"
        f"&num_channels={CHANNELS}"
        f"&speaker_diarization=false"
        f"&partial_results=true"
    )

    with ws_connect(url) as ws:
        def send_audio():
            # --- STEP 2 CHANGE: was `chunk = mic_stream.read(CHUNK, exception_on_overflow=False)`.
            # Audio now comes from rtp_listener() via audio_queue instead of a local mic. ---
            while True:
                chunk = audio_queue.get()
                ws.send(chunk)

        send_thread = threading.Thread(target=send_audio, daemon=True)
        send_thread.start()

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
    ari_post(f"/bridges/{bridge_id}/addChannel", channel=ext_channel["id"])
    print(
        f"Bridged caller {caller_channel_id} + externalMedia "
        f"{ext_channel['id']} into bridge {bridge_id}"
    )


def ari_event_loop():
    ws_url = f"ws://{ARI_HOST}/ari/events?api_key={ARI_USER}:{ARI_PASSWORD}&app={APP_NAME}"
    print(f"Connecting to {ws_url} ...")
    ari_ws = create_connection(ws_url)
    print("Connected. Waiting for calls into", APP_NAME, "(Ctrl+C to stop)")

    while True:
        message = ari_ws.recv()
        event = json.loads(message)

        if event.get("type") == "StasisStart":
            channel_id = event["channel"]["id"]
            print(f"Call arrived: channel {channel_id}")
            requests.post(
                f"http://{ARI_HOST}/ari/channels/{channel_id}/answer",
                auth=(ARI_USER, ARI_PASSWORD),
            )
            bridge_call_to_external_media(channel_id)


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
