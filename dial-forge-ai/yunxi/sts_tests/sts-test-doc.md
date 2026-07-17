# STS Benchmark Test — Full-Loop Latency

**Date:** June 23, 2026  
**Author:** Yunxi

## What this is

A full end-to-end latency benchmark for the AI voice pipeline. It simulates 5 turns of a live phone call and measures how long the complete loop takes — from the moment the caller finishes speaking to when audio is ready to play back.

**Pipeline under test:**  
Deepgram Nova-3 (streaming STT) → Groq `llama-3.1-8b-instant` (LLM) → Deepgram Aura(I still have issue with ElevenLabs's api)(TTS)

## How it works

Five short audio clips (`test-audio/test-audio-1.wav` … `test-audio-5.wav`) simulate a caller speaking across multiple turns. Each clip is streamed to Deepgram's WebSocket at real-time pace — the same way a live microphone would — so the measured STT endpointing latency is production-accurate.

Per turn, the script:
1. Decodes the audio to raw PCM via ffmpeg and streams it to Deepgram
2. Waits for `speech_final`, measuring the **endpointing latency** (gap between the last word ending and Deepgram firing `speech_final`)
3. Feeds the transcript + conversation history to the LLM, streaming the reply
4. Sends the reply to TTS, measuring time-to-first-byte (TTFB) and total duration

It runs two pipeline variants per turn:
- **Sequential** — full LLM reply first, then TTS
- **Parallel** — TTS starts on each sentence as the LLM streams, reducing TTFB significantly

## Outputs

Each run writes to `benchmark-results/full-loop-<timestamp>/`:
- `report.md` — human-readable summary with pass/fail against 1500ms budget
- `data.json` — raw per-turn numbers (STT, LLM, TTS, loop totals)
- `transcripts.md` — full conversation log
- `audio/turn-N-sequential.mp3` and `audio/turn-N-parallel.mp3` — actual agent audio responses

## Run instructions

```bash
# From ai-pipeline/ directory
# Add 5 audio files to ai-pipeline/test-audio/ named test-audio-1.mp3 … test-audio-5.mp3
# also add test-loop-audio.ts to ai-pipeline/scripts to run it
```

## Need to add
- Have not add customer history data yet, will add it later 
- Will try other LLMs and STT to see which one is better