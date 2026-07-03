# Step 4 — End-to-End MVP Verification

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) — section 4, Step 4
**Goal of this step:** confirm the full loop closes on one test call. No stability, concurrency, or error-handling requirements yet.

---

## 1. What "done" looks like

Danish's own framing from the 6/30 meeting is the bar to clear here — nothing more:

> "we just need to test SIP... take any SIP platform... test it out how it will integrate within our current setup"

Concretely:

```
Softphone dials in (Step 1)
  → Asterisk answers, routes to ARI Stasis app
  → externalMedia streams call audio to bridge script (Step 2)
  → Bridge script feeds audio to Deepgram STT → transcript
  → Transcript → LLM (can be a stub for this pass — see below)
  → LLM reply → TTS → WAV file → ARI playback (Step 3)
  → Reply is audible on the same call
```

One successful pass through this whole chain is the deliverable. It does not need to work twice in a row, handle a dropped call gracefully, or perform well.

## 2. The LLM step can be a stub

Steps 1–3 already prove the parts that are genuinely new (telephony ↔ pipeline audio routing). The LLM step itself (`callAgent()` in `ai-pipeline/lib/agent-llm.ts`, or the equivalent in `sts-test.py`'s `gpt_worker()`) is already working and tested elsewhere in the project — it doesn't need to be re-proven here. For the first end-to-end pass, it's fine to either:
- Call the real LLM (simplest if it's already wired up from Step 2/3's work), or
- Stub it with a fixed canned reply (e.g. `"Thanks, I heard you say: {transcript}"`) to isolate whether any failure is in the telephony plumbing vs. the LLM call itself

If something breaks during the first full-loop attempt, stubbing the LLM is a fast way to narrow down whether the issue is upstream (STT/audio routing) or downstream (LLM/TTS).

## 3. Suggested test protocol

1. Start the bridge script (Steps 2+3's combined logic) and confirm it's listening
2. Dial in from the softphone (Step 1)
3. Say a short, clear test phrase — e.g. "Hello, can you hear me?"
4. Watch for: transcript printed → LLM reply generated → TTS file written → ARI play call fires → audio heard on the call
5. Log the outcome of each stage explicitly (even a `print()`/`console.log()` per stage is enough) — this makes it obvious which stage failed if the loop doesn't close on the first try

## 4. Worth capturing even though optimization isn't required yet

Danish's direction is "prove it works," not "prove it's fast" — but since latency will matter eventually (product spec target: 1.5s response time, per the 6/10 meeting notes), it costs nothing to log rough timestamps at each stage while testing anyway:

- Time audio arrives at the bridge script → time transcript is produced
- Time transcript is sent to LLM → time reply text comes back
- Time TTS starts → time playback fires

This isn't a deliverable for this MVP, but it's a natural byproduct of testing and gives a real baseline (vs. guessing) for when latency optimization does become the goal — similar in spirit to the timing instrumentation already built into `yunxi/sts_tests/test-loop-audio.ts`.

## 5. Deliverable

A short log (or screen recording) showing one full pass: caller speaks → transcript appears → reply is generated → reply audio plays back on the call. Share this with Danish as the "SIP loop proven" checkpoint.

## Next

Once this passes, see [Step 5 — Explicitly not doing yet](./step5-scope-guardrails.md) for what to deliberately defer, and update the parent design doc's status from "Draft — not yet started" to reflect progress.
