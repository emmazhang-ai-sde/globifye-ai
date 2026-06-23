# Full-Loop Test Report (streaming STT)

**Date:** 2026-06-23T21:05:30.166Z
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

**Loop to first byte:** **✗ FAIL** — 4/5 turns exceeded 1500ms to first audio byte (max 3520ms).

**Loop full clip ready:** **✗ FAIL** — 5/5 turns exceeded 1500ms for full response (max 6204ms).

## Aggregate timings

| Stage | Mean | Min | Max |
|---|---|---|---|
| STT endpointing | 1408ms | 770ms | 2633ms |
| LLM | 323ms | 206ms | 444ms |
| TTS TTFB (sequential) | 442ms | 348ms | 535ms |
| TTS total (sequential) | 2799ms | 2248ms | 3219ms |
| **Sequential loop TTFB** | **2173ms** | **1362ms** | **3520ms** |
| **Sequential loop total** | **4530ms** | **3223ms** | **6204ms** |
| **Parallel loop TTFB** | **1853ms** | **1206ms** | **2996ms** |
| **Parallel loop total** | **4024ms** | **3254ms** | **5364ms** |
## Per-turn breakdown

| # | STT endpoint | LLM (ttft, chars) | TTS TTFB | TTS total | **Seq TTFB** | **Seq total** | **Par TTFB** | **Par total** | Sentences |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 770ms | 206ms (ttft 144ms, 98c) | 387ms | 2248ms | ✓ **1362ms** | ✗ **3223ms** | ✓ **1206ms** | ✗ **3254ms** | 1 |
| 2 | 959ms | 352ms (ttft 273ms, 88c) | 514ms | 3047ms | ✗ **1824ms** | ✗ **4358ms** | ✓ **1458ms** | ✗ **3521ms** | 1 |
| 3 | 1818ms | 260ms (ttft 222ms, 104c) | 348ms | 2912ms | ✗ **2426ms** | ✗ **4989ms** | ✗ **2201ms** | ✗ **4312ms** | 1 |
| 4 | 861ms | 444ms (ttft 444ms, 81c) | 428ms | 2571ms | ✗ **1733ms** | ✗ **3876ms** | ✓ **1404ms** | ✗ **3669ms** | 1 |
| 5 | 2633ms | 352ms (ttft 297ms, 92c) | 535ms | 3219ms | ✗ **3520ms** | ✗ **6204ms** | ✗ **2996ms** | ✗ **5364ms** | 1 |


See `transcripts.md` for the full conversation and `audio/turn-N-response.mp3` for the agent's spoken replies.

## Notes

- **Cold start excluded.** First-call LLM and TTS warmup costs are paid in a discarded warmup pass.
- **Single conversation.** Rerun for statistical confidence.
- **Endpointing param** is set to 300ms; raising it reduces false-positive end-of-speech detection but adds latency.
- **LLM reply length** drives TTS total. If "first byte" passes but "full clip ready" fails, the fixes are (a) tighten the system prompt for shorter replies, or (b) stream audio out of the route so the user starts hearing it after TTFB instead of after the full clip.
