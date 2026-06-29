import queue
import threading
import pyaudio
import sounddevice as sd
import numpy as np
from deepgram import DeepgramClient
from deepgram.core.events import EventType
from deepgram.listen.v1.types import ListenV1Results
from groq import Groq
from websockets.sync.client import connect as ws_connect
import json
import time

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
CHUNK = 1024

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

# audio and mic setup
audio = pyaudio.PyAudio()

mic_stream = audio.open(
    format=pyaudio.paInt16,
    channels=CHANNELS,
    rate=RATE,
    input=True,
    frames_per_buffer=CHUNK,
)

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


def mic_worker(socket):
    while True:
        chunk = mic_stream.read(CHUNK, exception_on_overflow=False)
        socket.send_media(chunk)

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
            while True:
                chunk = mic_stream.read(CHUNK, exception_on_overflow=False)
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

# begin concurrent threads
threads = [
    threading.Thread(target=modulate_worker, daemon=True),
    threading.Thread(target=groq_worker, daemon=True),
    threading.Thread(target=tts_worker, daemon=True),
]

for t in threads:
    t.start()

try:
    threads[0].join()
except KeyboardInterrupt:
    print("\nShutting down...")
