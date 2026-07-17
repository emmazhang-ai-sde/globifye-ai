# Full-Loop Test Report

**Date:** 2026-06-23T19:36:14.088Z
**Stack:** Deepgram Nova-3 batch STT → Groq `llama-3.1-8b-instant` → Kokoro-82M (local CPU, kokoro-js)
**Turns:** 5

## Verdict against 1500ms budget (LLM + TTS)

**✗ FAIL** — at least one turn exceeded the 1500ms target (max 21242ms). This is the trigger to graduate Kokoro to a GPU FastAPI sidecar.

## Aggregate timings

| Stage | Mean | Min | Max |
|---|---|---|---|
| STT (batch) | 1849ms | 806ms | 3255ms |
| LLM | 307ms | 239ms | 471ms |
| TTS | 16564ms | 11525ms | 20771ms |
| **Budget (LLM+TTS)** | **16871ms** | **11792ms** | **21242ms** |
| Full loop (STT+LLM+TTS) | 18719ms | 12599ms | 22900ms |

**TTS real-time factor (mean):** 1.11 — generation time ÷ audio duration. Below 1.0 means Kokoro generates faster than the clip plays.
**WAV integrity:** All response WAVs valid.

## Per-turn breakdown

| # | STT | LLM (ttft) | TTS | Budget (LLM+TTS) | Full loop | RTF |
|---|---|---|---|---|---|---|
| 1 | 3255ms | 239ms (145ms) | 12161ms | ✗ 12400ms | 15655ms | 1.23 |
| 2 | 1825ms | 280ms (181ms) | 19116ms | ✗ 19396ms | 21221ms | 1.07 |
| 3 | 806ms | 268ms (159ms) | 11525ms | ✗ 11792ms | 12599ms | 1.06 |
| 4 | 1699ms | 276ms (156ms) | 19247ms | ✗ 19523ms | 21222ms | 1.05 |
| 5 | 1659ms | 471ms (337ms) | 20771ms | ✗ 21242ms | 22900ms | 1.13 |


See `transcripts.md` for the full conversation and `audio/turn-N-response.wav` for the agent's spoken replies.

## Important caveats

- **STT here is batch, not streaming.** Production uses Deepgram's streaming WebSocket, where the latency-relevant moment is `speech_final` after a silence pause. That moment cannot be reproduced from a static file. The batch STT time above measures *processing only* — what the model takes to transcribe — not the *streaming endpointing* delay (~700–1500ms of trailing silence) that exists on top of it in real calls. The Budget (LLM+TTS) figure is the apples-to-apples comparison against the 1.5s target, since that's what `/api/agent/respond` runs after `speech_final` fires.
- **Cold start excluded.** First-call Kokoro model load is paid in warmup. Pre-warm at server boot in production.
- **Single conversation.** This is one 5-turn run. For statistical confidence, rerun several times.
- **Hardware-bound.** Kokoro runs on CPU. A GPU sidecar would materially lower TTS if the budget is missed.
