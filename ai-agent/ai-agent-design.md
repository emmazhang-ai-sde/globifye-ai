# AI Agent for the GlobiFYE Sales Call Pipeline
**Author:** AI Zhang (AI Intern) — drafted for PM review by Danish Parray  
**Date:** 2026-06-08  
**Status:** Draft — open questions flagged throughout; needs Danish's input before implementation

---

## 1. Overview

The current pipeline assumes a **human sales rep** uses a browser to make calls, with AI providing post-call analysis. Danish has requested an AI agent that **replaces the human rep** — the AI itself conducts the sales call autonomously, end-to-end.

This is a fundamentally different model from the current MVP:

| | Current MVP | AI Agent (proposed) |
|---|---|---|
| Who makes the call | Human rep (browser mic) | AI agent (via SIP/telephony) |
| Audio source | Browser microphone | SIP audio stream (Abraham's layer) |
| Transcript | Deepgram WebSocket → DB | Same, but audio comes from SIP |
| Response generation | N/A (human talks) | LLM → TTS → back through SIP |
| Post-call analysis | Single LLM call, button-triggered | Multi-step agent loop, automatic |

See [`technical-reference.md`](./technical-reference.md) for reference products and background on key technologies.

---

## 2. Two Systems, Two Databases

This feature sits at the intersection of **two separate backend systems**. It is critical to define the boundary clearly.

### Abraham's System (SIP / Telephony Layer)
Owned by: Abraham & Kim

**Responsibility:** Everything to do with the phone call itself.

| What it manages | Examples |
|---|---|
| Call initiation & routing | Dial a prospect's number, receive inbound calls |
| SIP session state | Active, ringing, on-hold, ended |
| Raw audio stream | Real-time audio in/out over the phone line |
| Telephony metadata | Phone numbers, call duration, DTMF tones |

**Abraham's DB stores:**
- Prospect contact info (name, phone number, company)
- Call records (SIP session ID, start/end time, status)
- Call queue / scheduling (which prospects to call, when)

### Our System (AI Pipeline — AI)
Owned by: AI + AI

**Responsibility:** Everything to do with understanding and acting on what was said.

| What it manages | Examples |
|---|---|
| Real-time transcript | Per-utterance text, speaker labels, timestamps |
| AI response generation | LLM decides what the AI should say next |
| TTS output | Text → speech sent back through SIP |
| Post-call analysis | Summary, objections, key topics, next steps |

**Our DB (Supabase) stores:**
- `recordings` — links to Abraham's SIP session ID
- `transcript` — per-utterance rows (speaker, content, timestamp)
- `analysis` — LLM-generated structured output

---

## 3. Full System Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                    ABRAHAM'S SYSTEM (SIP Layer)                   │
│                                                                   │
│  Call trigger — 3 modes (classified by account type):             │
│  ① Auto-dialer      [Sales / outbound] → dials contact list       │
│  ② Human transfer   [any account]      → rep hands off live call  │
│  ③ Inbound receiver [Support / inbound]← prospect calls in        │
│        │                                                          │
│  SIP Server ↔ Prospect's Phone (via DID)                          │
│        │               │                                          │
│  Abraham's DB     Audio Stream (RTP/WebSocket)                    │
│  - contact info        │                                          │
│  - call queue          │                                          │
│  - session state       │                                          │
└────────────────────────┼──────────────────────────────────────────┘
                         │  audio in/out
┌────────────────────────┼─────────────────────────────────────────┐
│                    OUR SYSTEM (AI Pipeline)                      │
│                                                                  │
│  User-defined objective ──┐                                      │
│  (goal / tone / persona)  │                                      │
│  set from frontend        ▼                                      │
│                 ┌─────────────────────┐                          │
│                 │  AI Agent           │                          │
│                 │  Orchestrator       │                          │
│                 │  (real-time loop    │                          │
│                 │   or voicemail drop)│                          │
│                 └──────┬──────┬───────┘                          │
│                        │      │                                  │
│    ┌───────────────┐   │  ┌───▼─────────────────────┐            │
│    │  STT Layer    │◄──┘  │  LLM Response Engine    │            │
│    │  (Deepgram    │      │  (Groq — current        │            │
│    │   Nova-2)     │      │   OpenAI API — planned) │            │
│    └──────┬────────┘      └────────┬────────────────┘            │
│           │                        │                             │
│    ┌──────▼───────┐    ┌───────────▼──┐                          │
│    │  Transcript  │    │  TTS Layer   │ → audio back to SIP      │
│    │  DB Write    │    │  (ElevenLabs eleven_turbo_v2_5)         │
│    └──────────────┘    └──────────────┘                          │
│                                                                  │
│    ┌──────────────────────────────────────┐                      │
│    │        Post-Call Agent Loop          │                      │
│    │  transcript → analysis               │                      │
│    │  → Apollo + HubSpot CRM update       │                      │
│    └──────────────────────────────────────┘                      │
│                                                                  │
│    Supabase DB: recordings | transcript | analysis               │
└──────────────────────────────────────────────────────────────────┘
```

**Note on voicemail mode (③ variant):** When the AI drops a voicemail rather than holding a live conversation, the Orchestrator skips the real-time STT → LLM loop and instead plays a short user-scripted TTS message through the SIP layer. No transcript is generated; a minimal call record is written to the DB.

### 3.1 Real-Time Agent Loop (During the Call)

This is the core of what makes the AI an autonomous caller. It runs continuously while the call is active.

```
WHILE call is active:
  1. Receive audio chunk from SIP (Abraham's layer)
  2. Send to Deepgram → get transcript (speech_final)
  3. Write utterance to transcript DB
  4. Send transcript to LLM with full conversation history
  5. LLM generates next response (what the AI should say)
  6. [Optional tools]:
       - search_knowledge_base (product info, objection scripts)
       - lookup_crm_prospect (who is this person, deal history)
  7. Send LLM response to TTS → generate audio
  8. Send audio back to SIP → prospect hears AI response
  9. Repeat
```

**Latency target:** The full loop (step 1 → step 8) should complete in **under 1.5 seconds** to feel like a natural conversation. This is aggressive — see Open Questions #4.

### 3.2 Post-Call Agent Loop (After the Call)

Runs automatically when the call ends (triggered by Abraham's SIP layer signaling call termination). Replaces the current button-triggered single LLM call.

```
1. Receive call-ended event from SIP layer
2. Fetch full transcript from Supabase
3. [Tool: search_knowledge_base] — contextualize discussion against product docs
4. [Tool: lookup_crm_prospect] — pull deal history, previous calls
5. LLM generates structured analysis:
     - Summary
     - Objections raised + how AI handled them
     - Sentiment arc
     - Key topics with timestamps
     - Recommended next steps
6. Write analysis to Supabase (analysis table)
7. [Tool: write_crm_notes] — update prospect record in CRM
8. [Tool: draft_followup_email] — stage follow-up email for human review
```

---

## 4. AI Agent Architecture Options

See [`ai-agent-architecture-design-doc.md`](./ai-agent-architecture-design-doc.md) for the full comparison.

Two options were evaluated:

| | Option A — Modular Pipeline | Option B — Speech-to-Speech |
|---|---|---|
| **Approach** | STT + LLM + TTS as separate components | OpenAI Realtime API, end-to-end |
| **Status** | **Selected** | Not chosen |

**Selected stack (Option A):**

| Layer | Provider |
|---|---|
| STT | Deepgram Nova-2 |
| LLM | Groq (current) → OpenAI API (planned) |
| TTS | ElevenLabs `eleven_turbo_v2_5` |

**Decision gate:** If Amy's end-to-end latency tests exceed ~2.5s, revisit Option B.

---

## 5. Tool Belt

| Tool | Used when | Integration |
|---|---|---|
| `read_transcript` | Post-call analysis | Supabase |
| `search_knowledge_base` | During call (objection handling) + post-call | Supabase pgvector or Pinecone |
| `lookup_crm_prospect` | Start of call + post-call | Apollo / HubSpot API |
| `write_crm_notes` | Post-call | Apollo / HubSpot API |
| `draft_followup_email` | Post-call | LLM sub-call |
| `get_call_sentiment` | Post-call | Deepgram or LLM |

---

## 6. Interface Between Abraham's System and Ours

This is the most critical integration point and needs to be agreed on with Abraham.

**What we need from Abraham:**

| Need | Details |
|---|---|
| **Audio stream** | Real-time audio in (prospect speaking) delivered to our STT layer. Format TBD — WebSocket, RTP, or HTTP chunked stream. |
| **Call-started event** | Webhook or event when a call connects — so we can create a `recording` row and start the agent loop |
| **Call-ended event** | Webhook or event when a call terminates — so we trigger the post-call agent |
| **Session ID** | A unique call ID from Abraham's DB that we store in our `recordings` table to link the two systems |
| **Prospect metadata** | Name, phone number, company, deal context — either pushed at call-start or pulled via API |

**What we give back to Abraham:**

| Output | Details |
|---|---|
| **TTS audio** | AI's spoken response sent back to his SIP layer in real-time |
| **Call summary** | Post-call analysis results (can write to a shared DB table or call his API) |
| **Call status** | Whether the AI completed its objective (booked meeting, got rejection, etc.) |

---

## 7. Integration with the Existing AI Pipeline

| Existing piece | Change required |
|---|---|
| `app/page.tsx` | Becomes a monitoring dashboard (view live calls, not initiate them). Audio source changes from browser mic to SIP stream. |
| `app/api/deepgram-token` | No longer needed for browser — Deepgram connection is now server-side, initiated by the agent |
| `app/api/transcribe/live` | Stays but called by agent server, not browser |
| `app/api/analyze` | Replace with post-call agent loop (auto-triggered, not button-triggered) |
| `lib/llm.ts` | Add response-generation prompt (what should AI say next) + keep analysis prompt |
| `lib/supabase.ts` | Add `linkSipSession` to store Abraham's session ID in `recordings` |
| New: `lib/tts.ts` | TTS integration — ElevenLabs `eleven_turbo_v2_5` |
| New: `lib/agent.ts` | Real-time agent loop + post-call agent loop |

The `/batch` route stays unchanged for testing.

---

## 8. Open Questions

### For Amy (architecture — tests in progress):

1. **Agent architecture:** STT + LLM + TTS pipeline (Option A) vs. OpenAI Realtime speech-to-speech (Option B)? Amy is preparing comparative tests. Decision gate: if Option A end-to-end latency exceeds ~2.5s, switch to Option B.

   **Update (Jun 10):** Danish's lean is toward **Option A (standalone LLM + TTS)** — the key reason is flexibility: the same LLM can be reused for both calls (LangChain + TTS → SIP) and email (LangChain + SMTP). An integrated system like OpenAI Realtime locks you in and can't easily serve both use cases. Amy's tests are still the decision gate, but Option A is now the preferred direction.

2. **SIP provider:** Has the backend or API team already researched a SIP provider? Need to confirm with Abraham before Amy's architecture tests assume a specific audio delivery format.

   **Update (Jun 10):** Abraham has been tasked with researching this. Criteria: open-source, self-hostable, free SIP protocol providers — not Twilio or similar platforms (those are software on top of SIP, not actual protocol providers). DID pricing is a separate decision. Still pending Abraham's research.

### For Danish (product decisions): ✅ Answered on June 11's meeting

3. **Autonomous vs. human-in-the-loop**

   Three modes:
   - **Fully autonomous** — AI dials from a contact list with no human supervision
   - **Transfer to AI** — human rep transfers a live call to AI when they're occupied
   - **AI voicemail** — AI drops a short scripted voicemail message when no one can take the call

   Transfer destination is flexible: can go to a human (if someone is available) or to AI (if no one is). Both are supported.

4. **Call initiation**

   - Sales account = **outbound only**
   - Support account = **inbound only**
   - Classified automatically by account type. Practically covers both directions.

5. **Objective per call**

   **User-defined custom field.** The user inputs the agent's goal, tone, and persona from the frontend — same concept as ChatGPT's custom instructions. That input feeds directly into the LLM configuration via LangChain. We do not hardcode the objective; the user defines it per agent. This is just another input field in the agent setup flow.

6. **Latency budget**

   **1.5s target.** Danish's reasoning:
   - 1s: barely noticeable in conversation
   - 1.5s: acceptable — people don't detect it easily
   - 2s: already sounds like a machine. People notice.
   - 2–3s: immediately detectable as AI — people hang up.

   Hold the line at 1.5s. Do not accept 2–3s as a fallback.

7. **TTS voice:** ✅ **Decided — ElevenLabs `eleven_turbo_v2_5`.** Research 1 script run; Deepgram Aura measured at 76ms median TTFB. ElevenLabs selected for voice quality. See [`ai-agent-research-plan.md`](./ai-agent-research-plan.md) for full results.

8. **CRM target**

   - **Apollo** — primary source of contact data (prospect name, phone, company)
   - **HubSpot** — primary CRM
   - **Salesforce** — to be configured later, not in scope now
   - These are where the agent pulls prospect details before and during a call.

9. **GitReverse intended use**

   Both a planning reference and a build reference. During planning: understand how existing implementations were structured. During building: decide whether to reuse the same technology in a different format or build from scratch. Danish's framing: "you don't reinvent the Internet — you use it. GitReverse tells you how something was built so you can decide what to borrow and what to build."

### For Abraham (integration decisions):

10. **Audio format:** How will Abraham's SIP layer deliver audio to our system? WebSocket stream? RTP? HTTP chunked?

11. **Event system:** How will call-started and call-ended events be communicated? Webhook to our API? Shared message queue (e.g., Redis, Supabase Realtime)?

12. **Prospect data:** Will Abraham's DB push prospect metadata at call-start, or do we pull from his API?

13. **Shared DB vs. separate DBs:** Do we write the AI's analysis back into Abraham's DB, or does he read from ours?

14. **Session ID format:** What identifier links Abraham's call record to our transcript/analysis rows?

---

## 9. AI Team Research Plan

See [`ai-agent-research-plan.md`](./ai-agent-research-plan.md) for the full research plan with step-by-step instructions, test scripts, and results tables.

**Sequence (do not run in parallel):**

```
Research 1: Pick TTS provider           → fixes the TTS layer
Research 2: Pick LLM                    → fixes the LLM layer  (uses TTS result)
Research 3: Final architecture shootout → standalone (R1+R2) vs. integrated
Research 4: Multi-use verification      → confirm same LLM handles email too
```

**Current status:** Research 1 script written (`scripts/research1-tts-test.ts`). Deepgram Aura results collected (76ms median TTFB). ElevenLabs and Azure keys needed to complete the comparison.

---

## 10. Suggested Phasing

| Phase | Scope | Who | Effort |
|---|---|---|---|
| **Phase A** | Align with Abraham on audio interface + event contract. Define shared session ID. | AI + Abraham | ~2–3 days alignment |
| **Phase B** | Post-call agent loop (server-side, auto-triggered on call-end). No real-time response yet. | AI | ~1 week |
| **Phase C** | Real-time agent loop: STT → LLM → TTS response during call. Basic conversation flow. | AI | ~1.5–2 weeks |
| **Phase D** | CRM tool integration (read prospect history, write call notes). | AI | ~1 week |
| **Phase E** | Monitoring dashboard UI (live call viewer, post-call analysis display). | AI + Frontend | ~1 week |

---

## 11. Out of Scope (for Now)

- Multi-language support — not needed for current customer base
- Building on Sim.ai's platform directly — we build our own orchestrator
- Human rep co-pilot mode — original design; deprioritized in favor of full autonomy

---

## 12. Technical Reference

See [`technical-reference.md`](./technical-reference.md) for background on the key technologies referenced in this document: SIP/RTP, and AirLLM.
