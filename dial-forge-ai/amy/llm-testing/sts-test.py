import queue
import threading
import pyaudio
import sounddevice as sd
import numpy as np
from deepgram import DeepgramClient
from deepgram.core.events import EventType
from deepgram.listen.v1.types import ListenV1Results
from groq import Groq
from elevenlabs import ElevenLabs

# api keys
DEEPGRAM_KEY = "..."
GROQ_KEY = "..."
ELEVEN_KEY = "..."

# setup parameters
RATE = 16000
CHANNELS = 1
CHUNK = 1024

# clients
dg = DeepgramClient(api_key=DEEPGRAM_KEY)

client = Groq(api_key=GROQ_KEY)

eleven = ElevenLabs(api_key=ELEVEN_KEY)

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

    sentence = data.channel.alternatives[0].transcript

    if not sentence:
        return

    print("STT:", sentence)

    if data.is_final:
        transcript_queue.put(sentence)


def mic_worker(socket):
    while True:
        chunk = mic_stream.read(CHUNK, exception_on_overflow=False)
        socket.send_media(chunk)


SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You are a professional, conversational sales representative. "
        "Respond to the customer in a natural, spoken manner as if on a phone call. "
        "If the customer raises concerns, acknowledge them politely and address them "
        "in a business-appropriate way. Be concise and conversational. "
        "Do not use any markdown formatting, bullet points, asterisks, or emojis. Do not output thinking, only the final answer (conversational response)."
        "Use plain natural language only, without filler openers, as your response will be read aloud by text-to-speech."
    )
}

MAX_HISTORY = 10

conversation_history = [SYSTEM_PROMPT]


def gpt_worker():
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

        for chunk in response:
            token = chunk.choices[0].delta.content

            if token is None:
                continue

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

        print()

        conversation_history.append({
            "role": "assistant",
            "content": full_response
        })

        if len(conversation_history) > MAX_HISTORY + 1:
            conversation_history = (
                [SYSTEM_PROMPT] + conversation_history[-(MAX_HISTORY):]
            )


def play_elevenlabs(text):
    audio_stream = eleven.text_to_speech.convert(
        text=text,
        voice_id="21m00Tcm4TlvDq8ikWAM",
        model_id="eleven_turbo_v2_5",
        output_format="pcm_24000",
    )

    audio_bytes = b"".join(audio_stream)
    audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    sd.play(audio, 24000)
    sd.wait()


def tts_worker():
    while True:
        text = tts_queue.get()

        print("TTS:", text)
        play_elevenlabs(text)


def deepgram_worker():
    with dg.listen.v1.connect(
        model="nova-3",
        encoding="linear16",
        sample_rate=RATE,
        language="en-US",
        punctuate=True,
        smart_format=True,
        interim_results=True,
    ) as socket:
        socket.on(EventType.MESSAGE, on_transcript)

        listen_thread = threading.Thread(
            target=socket.start_listening,
            daemon=True
        )
        listen_thread.start()

        mic_worker(socket)

# begin concurrent threads
threads = [
    threading.Thread(target=deepgram_worker, daemon=True),
    threading.Thread(target=gpt_worker, daemon=True),
    threading.Thread(target=tts_worker, daemon=True),
]

for t in threads:
    t.start()

try:
    threads[0].join()
except KeyboardInterrupt:
    print("\nShutting down...")
