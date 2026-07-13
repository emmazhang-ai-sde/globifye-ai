# SIP Loop MVP — Task Split

**Parent doc:** [`sip-loop-mvp-design-doc.md`](./sip-loop-mvp-design-doc.md)

---

## Proposed Split

| Step | What it involves | Teammates |
|---|---|---|
| [Step 1 — Environment setup](./sip-loop-mvp-step-by-step-guidence/step1-environment-setup.md) | Docker/Asterisk install, ARI config, dialplan, getting a test call to connect | **Shuyang** does the initial setup and fills in the necessary details; **Yunxi & Amy** follow up afterward |
| [Step 2 — Wire call audio into STT](./sip-loop-mvp-step-by-step-guidence/step2-wire-call-audio-into-stt.md) | RTP bridge script, feeding audio into the existing Modulate streaming connection | **Shuyang — ✅ DONE (2026-07-07).** `sip/scripts/step2_stt_bridge.py` transcribes live call audio via Modulate. See Step 2 doc's checkpoint log for the 7-bug fix chain. |
| [Step 3 — Wire TTS output back into the call](./sip-loop-mvp-step-by-step-guidence/step3-wire-tts-output-into-call.md) | File-based ARI playback, format conversion (ElevenLabs-vs-Aura discrepancy moot — `agent-test6.py` base already uses Aura) | **Shuyang — ✅ DONE (2026-07-07).** Same script; Aura reply audio played back into the call, audible on the softphone. |
| [Step 4 — End-to-end MVP verification](./sip-loop-mvp-step-by-step-guidence/step4-end-to-end-mvp-verification.md) | Running the full test protocol, logging results, producing the "loop proven" deliverable | **✅ DONE (2026-07-07), concludes the MVP.** Full loop proven in one call: spoke a sentence → transcribed → Groq reply → Aura TTS heard back. ~1.8s end-of-speech to audible reply (~0.9s compute); latency breakdown in `step3.2-sip-loop-latency-analysis.md`. |
| [Step 5 — PM demo console](./sip-loop-mvp-step-by-step-guidence/step5-pm-demo-ui.md) | Web console over the loop: two synced interfaces, multi-company routing + per-company KB/voice, on-demand analysis | **Shuyang — ✅ DONE (2026-07-10 to 07-13).** |
| [Step 6 — Supabase data sync](./sip-loop-mvp-step-by-step-guidence/step6-supabase-sync.md) | Sync calls/transcripts/analyses into the merged backend project, reusing the ai-pipeline tables | **Shuyang — ✅ DONE (2026-07-13).** Live and verified. Schema alignment log: [Step 6.1](./sip-loop-mvp-step-by-step-guidence/step6.1-schema-alignment-0713.md). Open: `recordings.call_mode` vocabulary (backend team). |
| [Step 7 — Agent roadmap](./sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md) | RAG evolution (see `rag-per-company-knowledge-base-design-doc.md`), AI/salesperson switching, deferred-scope list | **Designs only — nothing implemented.** Awaiting PM review. |

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