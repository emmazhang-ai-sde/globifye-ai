# AI Agent for the GlobiFYE Sales Call Pipeline
**Author:** Shuyang Zhang (AI Intern) — drafted for PM review by Danish Parray  
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

**Reference products:**
- **OmniDim** (`omnidim.io`) — Autonomous voice AI agent platform: AI makes/receives real phone calls, handles objections, books appointments, no human in the loop
- **Sim.ai** (`sim.ai`) — Multi-step agent orchestration: visual workflow builder, tool-use, multi-model LLM routing
- **GitReverse** (`gitreverse.com`) — Dev utility: converts a GitHub repo into an AI-readable prompt to accelerate development

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

### Our System (AI Pipeline — Shuyang)
Owned by: Shuyang + AI team

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
┌─────────────────────────────────────────────────────────────────┐
│                    ABRAHAM'S SYSTEM (SIP Layer)                  │
│                                                                   │
│  Call Scheduler → SIP Server → Prospect's Phone                  │
│        │               │                                         │
│  Abraham's DB     Audio Stream (RTP/WebSocket)                   │
│  - contact info        │                                         │
│  - call queue          │                                         │
│  - session state       │                                         │
└────────────────────────┼────────────────────────────────────────┘
                         │  audio in/out
┌────────────────────────┼────────────────────────────────────────┐
│                    OUR SYSTEM (AI Pipeline)                      │
│                                                                   │
│         ┌─────────────▼─────────────┐                           │
│         │     AI Agent Orchestrator  │                           │
│         │  (real-time control loop)  │                           │
│         └──────┬──────────┬─────────┘                           │
│                │          │                                       │
│    ┌───────────▼──┐  ┌────▼──────────────────┐                  │
│    │  STT Layer   │  │   LLM Response Engine  │                  │
│    │  (Deepgram   │  │   (Groq / Claude)      │                  │
│    │  Nova-3)     │  │                        │                  │
│    └──────┬───────┘  └────────┬───────────────┘                 │
│           │                   │                                   │
│    ┌──────▼───────┐    ┌──────▼───────┐                         │
│    │  Transcript  │    │  TTS Layer   │ → audio back to SIP      │
│    │  DB Write    │    │  (voice out) │                          │
│    └──────────────┘    └──────────────┘                         │
│                                                                   │
│    ┌──────────────────────────────────────┐                      │
│    │        Post-Call Agent Loop          │                      │
│    │  transcript → analysis → CRM update  │                      │
│    └──────────────────────────────────────┘                      │
│                                                                   │
│    Supabase DB: recordings | transcript | analysis               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Real-Time Agent Loop (During the Call)

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

---

## 5. Post-Call Agent Loop (After the Call)

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

## 6. AI Agent Architecture Options

*Amy — preparing comparative tests for the options below.*

There are two fundamentally different ways to build the real-time call loop. This decision affects latency, cost, control, and how much we can reuse the existing Deepgram setup.

### Option A: STT + LLM + TTS Pipeline (modular)

```
Prospect speaks
  → Deepgram Nova-3 (STT, streaming)
  → Partial transcript fed to LLM while prospect is still talking
  → LLM generates response
  → TTS converts to audio
  → Audio sent back via SIP
```

**Key advantage (Amy's insight):** Because Deepgram streams partial results in real-time, we can start feeding the in-progress transcript to the LLM *before the prospect finishes speaking*. This hides a large chunk of the latency — the LLM is already thinking while the person is still talking.

| Pros | Cons |
|---|---|
| Reuses existing Deepgram integration | Three components in series — latency compounds |
| Full control over each layer | More moving parts to maintain |
| Transcript available in DB for analysis | TTS adds another ~200–400ms |
| Can swap LLM or TTS independently | Requires careful streaming orchestration |

### Option B: Speech-to-Speech (single model)

```
Prospect speaks
  → OpenAI Realtime API (audio in → audio out, end-to-end)
  → Audio sent back via SIP
```

**Example:** OpenAI Realtime API handles STT + reasoning + TTS as one unified model call.

| Pros | Cons |
|---|---|
| Lowest possible latency (no pipeline overhead) | Full OpenAI vendor lock-in |
| Simplest architecture | More expensive per minute |
| No orchestration needed | Less control over voice/style/behavior |
| | Transcript harder to extract for DB writes |

### Recommendation (pending Amy's tests)

Start with **Option A** for the following reasons:
- We already have Deepgram live STT working — reuse is low-risk
- Transcript in DB is required for our analysis pipeline; Option B makes this harder
- Amy's streaming-to-LLM approach can bring latency close to Option B's level
- We can always swap the LLM (Groq → Claude) without touching STT or TTS

**Decision gate:** Amy's test results will confirm whether Option A latency is acceptable. If end-to-end response time exceeds ~2.5s in testing, revisit Option B.

---

## 7. Tool Belt

| Tool | Used when | Integration |
|---|---|---|
| `read_transcript` | Post-call analysis | Supabase |
| `search_knowledge_base` | During call (objection handling) + post-call | Supabase pgvector or Pinecone |
| `lookup_crm_prospect` | Start of call + post-call | HubSpot / Salesforce API |
| `write_crm_notes` | Post-call | HubSpot / Salesforce API |
| `draft_followup_email` | Post-call | LLM sub-call |
| `get_call_sentiment` | Post-call | Deepgram or LLM |

---

## 8. Interface Between Abraham's System and Ours

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

## 9. Integration with the Existing AI Pipeline

| Existing piece | Change required |
|---|---|
| `app/page.tsx` | Becomes a monitoring dashboard (view live calls, not initiate them). Audio source changes from browser mic to SIP stream. |
| `app/api/deepgram-token` | No longer needed for browser — Deepgram connection is now server-side, initiated by the agent |
| `app/api/transcribe/live` | Stays but called by agent server, not browser |
| `app/api/analyze` | Replace with post-call agent loop (auto-triggered, not button-triggered) |
| `lib/llm.ts` | Add response-generation prompt (what should AI say next) + keep analysis prompt |
| `lib/supabase.ts` | Add `linkSipSession` to store Abraham's session ID in `recordings` |
| New: `lib/tts.ts` | TTS integration (e.g., ElevenLabs, Azure, or Deepgram TTS) |
| New: `lib/agent.ts` | Real-time agent loop + post-call agent loop |

The `/batch` route stays unchanged for testing.

---

## 10. Open Questions

### For Amy (architecture — tests in progress):

1. **Agent architecture:** STT + LLM + TTS pipeline (Option A) vs. OpenAI Realtime speech-to-speech (Option B)? Amy is preparing comparative tests. Decision gate: if Option A end-to-end latency exceeds ~2.5s, switch to Option B.

2. **SIP provider:** Has the backend or API team already researched a SIP provider? Need to confirm with Abraham before Amy's architecture tests assume a specific audio delivery format.

### For Danish (product decisions):

3. **Autonomous vs. human-in-the-loop:** Is the AI fully autonomous (no human monitors the call), or does a human supervisor watch live and can intervene?

4. **Call initiation:** Does the AI make outbound calls (dial prospects), receive inbound calls, or both?

5. **Objective per call:** What is the AI's goal? Book a meeting? Qualify a lead? Close a deal? This shapes the LLM prompt and termination logic.

6. **Latency budget:** Under 1.5s response time is very hard. Is 2–3s acceptable if it means higher quality responses?

7. **TTS voice:** Which voice/provider? OmniDim uses natural-sounding voices. Options: ElevenLabs (highest quality), Azure Neural TTS, Deepgram Aura (lowest latency).

8. **CRM target:** HubSpot, Salesforce, or something else?

9. **GitReverse intended use:** Is the plan to use it as a dev tool during building, or is there a product pattern we're replicating?

### For Abraham (integration decisions):

10. **Audio format:** How will Abraham's SIP layer deliver audio to our system? WebSocket stream? RTP? HTTP chunked?

11. **Event system:** How will call-started and call-ended events be communicated? Webhook to our API? Shared message queue (e.g., Redis, Supabase Realtime)?

12. **Prospect data:** Will Abraham's DB push prospect metadata at call-start, or do we pull from his API?

13. **Shared DB vs. separate DBs:** Do we write the AI's analysis back into Abraham's DB, or does he read from ours?

14. **Session ID format:** What identifier links Abraham's call record to our transcript/analysis rows?

---

## 11. Suggested Phasing

| Phase | Scope | Who | Effort |
|---|---|---|---|
| **Phase A** | Align with Abraham on audio interface + event contract. Define shared session ID. | Shuyang + Abraham | ~2–3 days alignment |
| **Phase B** | Post-call agent loop (server-side, auto-triggered on call-end). No real-time response yet. | Shuyang | ~1 week |
| **Phase C** | Real-time agent loop: STT → LLM → TTS response during call. Basic conversation flow. | Shuyang | ~1.5–2 weeks |
| **Phase D** | CRM tool integration (read prospect history, write call notes). | Shuyang | ~1 week |
| **Phase E** | Monitoring dashboard UI (live call viewer, post-call analysis display). | Shuyang + Frontend | ~1 week |

---

## 12. Out of Scope (for Now)

- Multi-language support — not needed for current customer base
- Building on Sim.ai's platform directly — we build our own orchestrator
- Human rep co-pilot mode — original design; deprioritized in favor of full autonomy
