# SIP Loop MVP — Task Split

**Parent doc:** [`sip-loop-mvp-design-doc.md`](./sip-loop-mvp-design-doc.md)

---

## Proposed Split

| Step | What it involves | Teammates |
|---|---|---|
| [Step 1 — Environment setup](./sip-loop-mvp-step-by-step-guidence/step1-environment-setup.md) | Docker/Asterisk install, ARI config, dialplan, getting a test call to connect | **Shuyang** does the initial setup and fills in the necessary details; **Yunxi & Amy** follow up afterward |
| [Step 2 — Wire call audio into STT](./sip-loop-mvp-step-by-step-guidence/step2-wire-call-audio-into-stt.md) | RTP bridge script, feeding audio into the existing Modulate streaming connection | **Shuyang** — implementation drafted (`sip/scripts/step2_stt_bridge.py`, based on Amy's `agent-test6.py`), not yet tested against a live call |
| Step 3 — Wire TTS output back into the call | File-based ARI playback, format conversion, resolving the ElevenLabs-vs-Aura discrepancy flagged in the design doc | TBD — not assigned yet |
| [Step 4 — End-to-end MVP verification](./sip-loop-mvp-step-by-step-guidence/step4-end-to-end-mvp-verification.md) | Running the full test protocol, logging results, producing the "loop proven" deliverable | Whoever did Steps 2+3, jointly |
| [Step 5 — Scope guardrails](./sip-loop-mvp-step-by-step-guidence/step5-scope-guardrails.md) | Already written | Shuyang (done) |

**Backend/infra dependency (all steps, especially Step 1):** **Abraham** — Asterisk is his research area; may need his input on where the server actually runs (see design doc section 5, "ops burden of self-hosting Asterisk" — unresolved).

---

## While Step 1 is in progress: parallel model-testing work for Amy / Yunxi

Two open model-testing items are already sitting unresolved in the notes — good candidates to run in parallel while Shuyang builds the Asterisk/ARI environment, rather than have Amy/Yunxi blocked waiting on Step 1 to land:

| Task | Owner | Why them | Source |
|---|---|---|---|
| **Root-cause OpenAI TTS latency** — is it a code issue or inherent to the API? (OpenAI TTS is half the cost of Deepgram Aura — worth resolving if fixable) | **Yunxi** | She's the one who originally ran the TTS comparison and found Deepgram Aura ahead on latency (6/29 meeting) | Personal notes 7/1, "what to ask Danish" item 1; personal notes, Monday 6/29 recap |
| **Deepgram-only (STT+TTS bundled) vs. Modulate+Aura — pricing and feasibility comparison** | **Amy** | Danish asked this directly in the 6/30 meeting (why not drop Modulate if Deepgram covers both?) — Amy answered in the moment (Modulate is cheaper/more accurate) but nobody's actually run the numbers | `step2-meeting-transcript/GlobiFYE-0630-Tuesday-meeting-transcript.md`, ~`[2:28]`–`[3:33]`; design doc section 3 open items |

Both are genuinely unresolved (not busy-work) — good use of their time while the SIP environment work is single-threaded on Shuyang.

---