# Step 2 — Wire Call Audio into STT

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) — section 4, Step 2
**Goal of this step:** words spoken on the test call (from Step 1) show up as transcribed text.

---

## 1. Important context: two existing STT integration patterns already in the repo — neither is "plug and play" for SIP

Before building anything new, know what already exists so this step adapts it instead of duplicating it from scratch:

| File | Pattern | Relevant to SIP? |
|---|---|---|
| `ai-pipeline/` live UI (per project architecture) | **Browser → Deepgram WebSocket directly.** The browser holds the persistent connection; Vercel only mints a short-lived token. | **No** — there is no browser in a phone call. This pattern doesn't apply; SIP audio needs a server-side WebSocket connection to Deepgram instead. |
| `yunxi/sts_tests/test-loop-audio.ts` | **Server-side (Node) → Deepgram WebSocket**, streaming pre-recorded PCM at real-time pace to simulate a live mic. Config: `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, listens for `speech_final`. | **A valid pattern**, but Deepgram-as-STT is no longer the confirmed choice (see below). |
| `amy/llm-testing/agent-test6.py` (supersedes the earlier `sts-test.py` reference) | **Python, PyAudio mic → Modulate (STT) → Groq (LLM) → Deepgram Aura (TTS)**, raw queues/threads. Matches the confirmed production stack (`sip-loop-mvp-design-doc.md` section 3) and the "hardcoded Python, queues/threads" pipeline from the 6/30 meeting. | **This is the base.** Swap `modulate_worker()`'s inline mic read for a function that reads from Asterisk's audio channel instead — everything downstream (Modulate connection, transcript queue, Groq, Deepgram Aura TTS) stays the same. |

**Decision:** Python, following `agent-test6.py`'s existing pattern — no third parallel implementation. `sts-test.py` was the original reference in this doc, but it's Deepgram-STT-only and predates the 6/30 stack confirmation (Modulate for STT); `agent-test6.py` is the more recent version of the same script and already matches the confirmed stack, so it's the correct base now.

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

## 3. Implementation: [`sip/scripts/step2_stt_bridge.py`](../../../../sip/scripts/step2_stt_bridge.py)

This is a full copy of Amy's `amy/llm-testing/agent-test6.py`, with the audio *source* swapped and an ARI control layer added on top — everything downstream of the audio queue (Modulate connection, transcript queue, Groq, Deepgram Aura TTS) is untouched from Amy's original:

1. **ARI event loop** (mirrors `verify_ari.py`'s `StasisStart`/answer pattern): on a call arriving, answers it, then creates a `mixing` bridge and adds both the caller channel and a new `externalMedia` channel to it — this is what makes Asterisk start forwarding the call's RTP audio.
2. **`rtp_listener()`** (was `mic_worker()`, dead code in `agent-test6.py` — the PyAudio mic read had actually been inlined into `modulate_worker`'s `send_audio`): listens on UDP 9000 for the `externalMedia` RTP stream, strips the 12-byte RTP header, and puts raw PCM onto `audio_queue`.
3. **`modulate_worker()`**: unchanged except `send_audio` now does `audio_queue.get()` instead of `mic_stream.read(...)`. Same Modulate streaming connection, same `RATE=16000`/`CHANNELS=1` config.

`externalMedia` is requested with `format=slin16` (16-bit PCM). Confirm the actual sample rate Asterisk sends — `slin16` should be 16kHz to match `RATE=16000` already hardcoded in the Modulate connection; if Asterisk is actually sending 8kHz, either force `slin16` explicitly or resample before queuing (`ffmpeg`/`sox`/`audioop`).

## 4. STT provider note

Unlike the original version of this doc (which pointed at Deepgram-only reference scripts), this step now uses **Modulate** directly, since that's the confirmed production STT choice (6/30 meeting) and `agent-test6.py` already implements it — no separate "swap to Modulate later" step needed.

---

## Deliverable for this step

Speak into the softphone from Step 1 → `step2_stt_bridge.py`'s Modulate connection prints `STT (partial): ...` / `STT: ...` lines for what was said.

## Common Pitfalls

| Symptom | Likely cause |
|---|---|
| No RTP packets arriving on UDP 9000 | `externalMedia` channel not actually bridged to the call — confirm `bridge_call_to_external_media()` added both channels to the same ARI bridge, not just created the `externalMedia` channel standalone |
| Garbled/static transcript | Sample rate mismatch (8kHz vs 16kHz) between what Asterisk sends and what Modulate is told to expect (`sample_rate=RATE` in the connection URL) — this is the most likely first bug |
| Transcript is silent even though audio "looks" like it's flowing | RTP header stripping is off — RTP headers are usually 12 bytes but can be longer with extensions; log raw packet length and content type to confirm |
| `ModuleNotFoundError: websockets` / `groq` / `deepgram` | `sip/scripts` currently only has `requests` + `websocket-client` installed (used by `verify_ari.py`); `step2_stt_bridge.py` additionally needs `websockets`, `groq`, `deepgram-sdk`, `sounddevice`, `numpy` — install into whichever venv runs this script |

## Next

Once spoken words on the test call reliably produce transcripts, move to [Step 3 — Wire TTS output back into the call](./step3-wire-tts-output-into-call.md).
