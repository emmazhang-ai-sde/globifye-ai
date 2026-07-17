# Full-Loop Test Report (streaming STT)

**Date:** 2026-06-25T19:51:49.944Z
**Stack:** Deepgram Nova-3 streaming STT → Groq `llama-3.1-8b-instant` → ElevenLabs `eleven_turbo_v2_5` TTS
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

**Loop to first byte:** **✗ FAIL** — 4/5 turns exceeded 1500ms to first audio byte (max 3499ms).

**Loop full clip ready:** **✗ FAIL** — 4/5 turns exceeded 1500ms for full response (max 3499ms).

### Parallel

**Loop to first byte:** **✗ FAIL** — 2/5 turns exceeded 1500ms to first audio byte in parallel (max 3194ms).

**Loop full clip ready:** **✗ FAIL** — 2/5 turns exceeded 1500ms for full parallel response (max 3194ms).

## Aggregate timings

| Stage | Mean | Min | Max |
|---|---|---|---|
| STT endpointing | 1399ms | 717ms | 2682ms |
| LLM | 322ms | 213ms | 663ms |
| TTS TTFB (sequential) | 774ms | 491ms | 1552ms |
| TTS total (sequential) | 774ms | 491ms | 1552ms |
| **Sequential loop TTFB** | **2494ms** | **1435ms** | **3499ms** |
| **Sequential loop total** | **2494ms** | **1435ms** | **3499ms** |
| **Parallel loop TTFB** | **1886ms** | **1177ms** | **3194ms** |
| **Parallel loop total** | **1886ms** | **1177ms** | **3194ms** |
## Per-turn breakdown

| # | STT endpoint | LLM (ttft, chars) | TTS TTFB | TTS total | **Seq TTFB** | **Seq total** | **Par TTFB** | **Par total** | Sentences |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 717ms | 227ms (ttft 188ms, 98c) | 491ms | 491ms | ✓ **1435ms** | ✓ **1435ms** | ✓ **1177ms** | ✓ **1177ms** | 1 |
| 2 | 979ms | 286ms (ttft 239ms, 88c) | 1552ms | 1552ms | ✗ **2816ms** | ✗ **2816ms** | ✓ **1429ms** | ✓ **1429ms** | 1 |
| 3 | 1814ms | 213ms (ttft 181ms, 78c) | 732ms | 732ms | ✗ **2759ms** | ✗ **2759ms** | ✗ **2391ms** | ✗ **2391ms** | 1 |
| 4 | 802ms | 663ms (ttft 332ms, 101c) | 497ms | 497ms | ✗ **1962ms** | ✗ **1962ms** | ✓ **1238ms** | ✓ **1238ms** | 1 |
| 5 | 2682ms | 220ms (ttft 181ms, 104c) | 598ms | 598ms | ✗ **3499ms** | ✗ **3499ms** | ✗ **3194ms** | ✗ **3194ms** | 1 |


See `transcripts.md` for the full conversation and `audio/turn-N-response.mp3` for the agent's spoken replies.

## Notes

- **Cold start excluded.** First-call LLM and TTS warmup costs are paid in a discarded warmup pass.
- **Single conversation.** Rerun for statistical confidence.
- **Endpointing param** is set to 300ms; raising it reduces false-positive end-of-speech detection but adds latency.
- **LLM reply length** drives TTS total. If "first byte" passes but "full clip ready" fails, the fixes are (a) tighten the system prompt for shorter replies, or (b) stream audio out of the route so the user starts hearing it after TTFB instead of after the full clip.
