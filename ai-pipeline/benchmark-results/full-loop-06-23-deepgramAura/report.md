# Full-Loop Test Report (streaming STT)

**Date:** 2026-06-23T20:28:47.857Z
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

**Loop to first byte:** **✗ FAIL** — 5/5 turns exceeded 1500ms to first audio byte (max 3266ms).

**Loop full clip ready:** **✗ FAIL** — 5/5 turns exceeded 1500ms for full response (max 6055ms).

## Aggregate timings

| Stage | Mean | Min | Max |
|---|---|---|---|
| STT endpointing | 1414ms | 804ms | 2658ms |
| LLM | 245ms | 174ms | 436ms |
| TTS TTFB | 428ms | 342ms | 525ms |
| TTS total | 2815ms | 2382ms | 3209ms |
| **Loop to first byte** | **2088ms** | **1579ms** | **3266ms** |
| **Loop full clip ready** | **4475ms** | **3623ms** | **6055ms** |

## Per-turn breakdown

| # | STT endpoint | LLM (ttft, chars) | TTS TTFB | TTS total | **Loop TTFB** | **Loop total** |
|---|---|---|---|---|---|---|
| 1 | 804ms | 436ms (ttft 314ms, 114c) | 342ms | 2382ms | ✗ **1583ms** | ✗ **3623ms** |
| 2 | 953ms | 187ms (ttft 136ms, 104c) | 449ms | 2771ms | ✗ **1589ms** | ✗ **3911ms** |
| 3 | 1843ms | 174ms (ttft 142ms, 90c) | 405ms | 2533ms | ✗ **2422ms** | ✗ **4550ms** |
| 4 | 813ms | 241ms (ttft 141ms, 92c) | 525ms | 3180ms | ✗ **1579ms** | ✗ **4234ms** |
| 5 | 2658ms | 188ms (ttft 147ms, 119c) | 420ms | 3209ms | ✗ **3266ms** | ✗ **6055ms** |


See `transcripts.md` for the full conversation and `audio/turn-N-response.mp3` for the agent's spoken replies.

## Notes

- **Cold start excluded.** First-call LLM and TTS warmup costs are paid in a discarded warmup pass.
- **Single conversation.** Rerun for statistical confidence.
- **Endpointing param** is set to 300ms; raising it reduces false-positive end-of-speech detection but adds latency.
- **LLM reply length** drives TTS total. If "first byte" passes but "full clip ready" fails, the fixes are (a) tighten the system prompt for shorter replies, or (b) stream audio out of the route so the user starts hearing it after TTFB instead of after the full clip.
