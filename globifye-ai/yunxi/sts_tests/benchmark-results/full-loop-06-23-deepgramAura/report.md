# Full-Loop Test Report (streaming STT)

**Date:** 2026-06-23T21:25:52.117Z
**Stack:** Deepgram Nova-3 streaming STT → Groq `llama-3.1-8b-instant` → Deepgram Aura 2 TTS
**Turns:** 5
**Budget:** 1500ms, from end of caller's speech to AI audio response
**Deepgram endpointing param:** 300ms

## What "STT endpointing" measures

The audio files are streamed to Deepgram at real-time pace, mimicking a live phone call. The reported STT number is the **endpointing latency** — the wall-clock gap between the moment the prospect's last word ends (in audio time) and the moment Deepgram fires `speech_final`. This is the exact STT contribution to user-perceived latency that a real caller would experience.

## The two loop numbers

- **Loop to first byte** = STT endpointing + LLM + TTS-TTFB. Production-realistic if the agent's audio response is streamed to the browser.
- **Loop full clip ready** = STT endpointing + LLM + TTS-total. Today's reality, with the route buffering the full body before returning.

## Verdict against 1500ms budget

### Sequential

**Loop to first byte:** **✗ FAIL** — 2/5 turns exceeded 1500ms to first audio byte (max 3198ms).

**Loop full clip ready:** **✗ FAIL** — 5/5 turns exceeded 1500ms for full response (max 7332ms).

### Parallel

**Loop to first byte:** **✗ FAIL** — 2/5 turns exceeded 1500ms to first audio byte in parallel (max 3152ms).

**Loop full clip ready:** **✗ FAIL** — 5/5 turns exceeded 1500ms for full parallel response (max 5920ms).

## Aggregate timings

| Stage | Mean | Min | Max |
|---|---|---|---|
| STT endpointing | 1366ms | 696ms | 2601ms |
| LLM | 210ms | 173ms | 297ms |
| TTS TTFB (sequential) | 347ms | 279ms | 413ms |
| TTS total (sequential) | 3366ms | 2706ms | 4529ms |
| **Sequential loop TTFB** | **1923ms** | **1272ms** | **3198ms** |
| **Sequential loop total** | **4942ms** | **3699ms** | **7332ms** |
| **Parallel loop TTFB** | **1735ms** | **1064ms** | **3152ms** |
| **Parallel loop total** | **4257ms** | **3288ms** | **5920ms** |
## Per-turn breakdown

| # | STT endpoint | LLM (ttft, chars) | TTS TTFB | TTS total | **Seq TTFB** | **Seq total** | **Par TTFB** | **Par total** | Sentences |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 696ms | 297ms (ttft 161ms, 103c) | 279ms | 2706ms | ✓ **1272ms** | ✗ **3699ms** | ✓ **1064ms** | ✗ **3288ms** | 1 |
| 2 | 891ms | 173ms (ttft 132ms, 93c) | 294ms | 3044ms | ✓ **1358ms** | ✗ **4109ms** | ✓ **1172ms** | ✗ **3937ms** | 1 |
| 3 | 1841ms | 181ms (ttft 153ms, 95c) | 413ms | 2801ms | ✗ **2435ms** | ✗ **4823ms** | ✗ **2153ms** | ✗ **4402ms** | 1 |
| 4 | 798ms | 198ms (ttft 147ms, 120c) | 357ms | 3749ms | ✓ **1353ms** | ✗ **4745ms** | ✓ **1132ms** | ✗ **3738ms** | 1 |
| 5 | 2601ms | 202ms (ttft 161ms, 151c) | 395ms | 4529ms | ✗ **3198ms** | ✗ **7332ms** | ✗ **3152ms** | ✗ **5920ms** | 2 |


See `transcripts.md` for the full conversation and `audio/turn-N-response.mp3` for the agent's spoken replies.

## Notes

- **Cold start excluded.** First-call LLM and TTS warmup costs are paid in a discarded warmup pass.
- **Single conversation.** Rerun for statistical confidence.
- **Endpointing param** is set to 300ms; raising it reduces false-positive end-of-speech detection but adds latency.
- **LLM reply length** drives TTS total. If "first byte" passes but "full clip ready" fails, the fixes are (a) tighten the system prompt for shorter replies, or (b) stream audio out of the route so the user starts hearing it after TTFB instead of after the full clip.
