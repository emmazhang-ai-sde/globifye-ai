# Step 2 — Wire Call Audio into STT

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) — section 4, Step 2
**Goal of this step:** words spoken on the test call (from Step 1) show up as transcribed text.

---

## 1. Important context: two existing STT integration patterns already in the repo — neither is "plug and play" for SIP

Before building anything new, know what already exists so this step adapts it instead of duplicating it from scratch:

| File | Pattern | Relevant to SIP? |
|---|---|---|
| `ai-pipeline/` live UI (per project architecture) | **Browser → Deepgram WebSocket directly.** The browser holds the persistent connection; Vercel only mints a short-lived token. | **No** — there is no browser in a phone call. This pattern doesn't apply; SIP audio needs a server-side WebSocket connection to Deepgram instead. |
| `yunxi/sts_tests/test-loop-audio.ts` | **Server-side (Node) → Deepgram WebSocket**, streaming pre-recorded PCM at real-time pace to simulate a live mic. Config: `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, listens for `speech_final`. | **Yes — this is the closer pattern.** It already proves a Node process can hold a live Deepgram WebSocket connection server-side. The only missing piece is where the PCM comes from (currently a test file; for SIP it needs to come from Asterisk instead). |
| `amy/llm-testing/sts-test.py` | **Python, PyAudio mic → Deepgram nova-3 → Groq → ElevenLabs**, using raw queues/threads (`RATE=16000`, `paInt16`, `socket.send_media(chunk)`). Matches the "hardcoded Python, queues/threads" pipeline described in the 6/30 meeting. | **Also a valid base** — same idea, just swap `mic_worker()`'s `pyaudio` mic read for a function that reads from Asterisk's audio channel instead. Everything downstream (`socket.send_media(chunk)`) stays the same. |

**Decision needed before starting:** pick one language track (Python via `sts-test.py`'s pattern, or Node via `test-loop-audio.ts`'s pattern) — don't build a third parallel implementation. Since `ai-pipeline` (the real Next.js app) is TypeScript, and ARI has a solid Node client (`ari-client`), the Node path likely has less glue code overall — but either works for an MVP. Flag this choice with Amy/Yunxi before starting, since they own the pipeline code.

## 2. Getting audio out of Asterisk: `externalMedia`

Asterisk ARI has three ways to get at a channel's audio; only one fits a real-time streaming STT use case:

| ARI feature | What it does | Fits this use case? |
|---|---|---|
| `channels/{id}/record` | Records the channel to a file | No — file-based, not live |
| Snoop channel | Spy on another channel's audio without joining the call | Only if you want to listen without answering — not needed here, we already answer the call in Step 1 |
| **`externalMedia`** | Creates a channel that forwards the call's live RTP audio to a UDP endpoint you control | **Yes — this is the one** |

Create an external media channel via the ARI REST API (or the equivalent client library call):

```
POST /ari/channels/externalMedia
{
  "app": "sip-mvp-app",
  "external_host": "127.0.0.1:9000",
  "format": "slin16"
}
```

This tells Asterisk: "send this channel's audio as raw RTP to UDP port 9000 on localhost, encoded as `slin16`" (signed linear 16-bit PCM — conveniently, this is close to what Deepgram already expects).

## 3. Bridge script: RTP in → Deepgram WebSocket out

Write a small script that:

1. **Listens on UDP 9000** for incoming RTP packets from the `externalMedia` channel
2. **Strips the 12-byte RTP header** from each packet, leaving raw PCM audio payload
3. **Feeds that PCM directly into the existing Deepgram streaming connection pattern** from `test-loop-audio.ts` (Node) or `sts-test.py` (Python) — same `encoding=linear16`, but confirm sample rate: `externalMedia`'s `slin16` format is 16-bit PCM at whatever rate you request (commonly 8kHz for telephony `slin` vs 16kHz for `slin16` — **verify which Asterisk actually sends**, since the existing pipeline is built around `sample_rate=16000`; if Asterisk sends 8kHz, either request `slin16` explicitly in the `externalMedia` call or resample before forwarding, e.g. with `ffmpeg`/`sox` or Python's `audioop`)

Minimal Python sketch (adapting `sts-test.py`'s existing `mic_worker` → `socket.send_media()` pattern, just swapping the audio source):

```python
import socket as udp_socket

def asterisk_audio_worker(dg_socket):
    sock = udp_socket.socket(udp_socket.AF_INET, udp_socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', 9000))
    while True:
        packet, _ = sock.recvfrom(2048)
        pcm = packet[12:]  # strip RTP header
        dg_socket.send_media(pcm)  # same call sts-test.py already makes from mic_worker
```

This replaces `mic_worker()`'s `mic_stream.read(...)` with `sock.recvfrom(...)` — everything downstream (`deepgram_worker`, `on_transcript`, the transcript queue) stays exactly as it already is in `sts-test.py`.

## 4. Confirm which STT provider is actually being tested here

The 6/30 meeting confirmed **Modulate** as the production STT choice (cheaper + more accurate than Deepgram per Amy's testing), but both existing reference scripts (`sts-test.py`, `test-loop-audio.ts`) are wired to **Deepgram**, not Modulate. For this MVP step, using Deepgram is fine — the goal is proving the *audio routing* works, not re-validating the STT vendor choice. Swapping to Modulate's client library is a separate, later task once the loop itself is proven.

---

## Deliverable for this step

Speak into the softphone from Step 1 → the bridge script's Deepgram connection prints a transcript of what was said.

## Common Pitfalls

| Symptom | Likely cause |
|---|---|
| No RTP packets arriving on UDP 9000 | `externalMedia` channel not actually bridged to the call — confirm it's added to the same ARI bridge as the original channel, not just created standalone |
| Garbled/static transcript | Sample rate mismatch (8kHz vs 16kHz) between what Asterisk sends and what Deepgram is told to expect — this is the most likely first bug |
| Transcript is silent even though audio "looks" like it's flowing | RTP header stripping is off — RTP headers are usually 12 bytes but can be longer with extensions; log raw packet length and content type to confirm |

## Next

Once spoken words on the test call reliably produce transcripts, move to [Step 3 — Wire TTS output back into the call](./step3-wire-tts-output-into-call.md).
