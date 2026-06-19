# AI Agent — Technology Research Plan
**Author:** Shuyang Zhang (AI Intern)  
**Last updated:** 2026-06-12  
**Status:** Research 1 in progress — script written, Deepgram results collected

---

## Overview

The product decisions in the pipeline design are settled. What remains open is the **technology stack** for the real-time call loop. The research below must be completed before any implementation begins. The output of each item is a concrete recommendation with evidence — not a general survey.

**Execution order matters.** Each research item produces a fixed output that the next one depends on. Do not run them in parallel.

```
Research 1: Pick TTS provider           → fixes the TTS layer
Research 2: Pick LLM                    → fixes the LLM layer  (uses TTS result)
Research 3: Final architecture shootout → standalone (R1+R2) vs. integrated
Research 4: Multi-use verification      → confirm same LLM handles email too
```

This eliminates the n×m combination problem: instead of testing all LLM × TTS combinations together, each layer is evaluated and fixed independently. By the time Research 3 runs, there is only one standalone stack to compare against the integrated option.

---

## Research 1: TTS Provider

**Status:** Script written (`scripts/research1-tts-test.ts`). Deepgram results collected. ElevenLabs and Azure keys needed to complete the comparison.

**The question:** Which TTS provider should handle voice output in the standalone pipeline?

**Why first:** TTS is the least understood layer and the most variable in latency. Its result feeds directly into Research 2 (the LLM latency budget) and Research 3 (the final shootout). Locking it in early prevents it from being a confound.

**Candidates:**

| Provider | Expected latency (first audio byte) | Voice quality | Cost | Notes |
|---|---|---|---|---|
| **ElevenLabs** | ~300–500ms | Highest | ~$0.30/1k chars | Danish's working example; best naturalness |
| **Azure Neural TTS** | ~200–300ms | High | ~$16/1M chars | Low-latency streaming; enterprise-grade |
| **Deepgram Aura** | ~100–200ms | Good | Lowest | Same vendor as STT — simplifies integration |
| **OpenAI TTS** | ~300–400ms | High | ~$15/1M chars | Familiar API; ties us further to OpenAI |

### Step 1 — Prepare test phrases

Write 5 short sales responses covering different response types (1–2 sentences each). These represent what the AI agent would actually say, not placeholder text.

Examples:
- Handling an objection: *"That's a fair point — most teams we work with already have a tool in place. The difference is usually in how DialForge handles live call coaching alongside it."*
- Answering a question: *"Pricing is usage-based, so you only pay for the calls your team makes. I can walk you through the tiers if that helps."*
- Closing a turn: *"Got it. Would it make sense to schedule a quick demo so you can see it live with your team's data?"*

Store these as plain text strings in the test script — no audio input needed for this step.

### Step 2 — Write the TTS test script

Script: `scripts/research1-tts-test.ts`

For each provider, send all 5 phrases and measure:

```
t0 = now
→ send text to TTS API
→ receive first audio chunk                    → log time-to-first-byte = t1 - t0
→ receive complete audio                       → log total generation time = t2 - t0
→ play audio and rate naturalness (1–5)        → log quality score
```

Run each phrase 3 times per provider. Record median latency. Flag outliers.

Usage:
```bash
npx tsx scripts/research1-tts-test.ts
npx tsx scripts/research1-tts-test.ts --providers=deepgram,openai
```

Required env vars (add to `.env.local`):
- `DEEPGRAM_API_KEY` — already present
- `OPENAI_API_KEY` — already present
- `ELEVENLABS_API_KEY` — add for ElevenLabs (free tier available at elevenlabs.io)
- `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` — add for Azure (free tier at portal.azure.com)

### Step 3 — Score and pick

Fill in the results table with real numbers. Audio files saved to `scripts/tts-research-output/` for quality review.

| Provider | TTFB median (ms) | Quality (1–5) | Cost / 5-min call | Pass 300ms target? |
|---|---|---|---|---|
| ElevenLabs | _ | _ | $_ | Y/N |
| Azure Neural TTS | _ | _ | $_ | Y/N |
| Deepgram Aura | **76ms** | _ | $0.045 | **YES** |
| OpenAI TTS | _ | _ | $_ | Y/N |

**Decision rule:** Choose the provider with the lowest latency that scores ≥4 on voice quality. If no provider clears 300ms at quality ≥4, choose the fastest and note the quality trade-off for Danish.

**Output:** One selected TTS provider. Update `scripts/tts-research-output/r1-results.json` (`selectedTtsProvider`, `qualityScore`). This is now fixed for Research 2 and 3.

---

## Research 2: LLM Selection

**Status:** Blocked on Research 1 completion.

**The question:** Which LLM should power the AI agent's responses?

**Why second:** With TTS fixed from Research 1, we know the TTS latency budget. The LLM must fit within the remaining budget: `1500ms - STT (~200ms) - TTS (from R1) - network (~100ms)`. That gives a concrete LLM latency ceiling to test against.

**Candidates:**

| Model | Access | Expected inference latency | Notes |
|---|---|---|---|
| **Mistral (via Groq)** | Already set up | ~200–400ms (streaming) | Fast inference on Groq's hardware |
| **Llama 3.3 70B (via Groq)** | Already set up | ~300–600ms (streaming) | Currently used for post-call analysis |
| **Qwen (via API)** | New signup needed | ~300–500ms | Strong multilingual; worth evaluating |

Do not include AirLLM in this round — self-hosted GPU is not available yet. AirLLM is the cost-reduction upgrade path once a stack is proven.

### Step 1 — Define the LLM latency ceiling

Using Research 1's TTS result, calculate the remaining budget:

```
Total target:          1500ms
STT (Deepgram):        ~200ms   (already measured from existing integration)
TTS (from Research 1): ___ms    (fill in from R1 results)
Network overhead:      ~100ms
─────────────────────────────
LLM budget:            1500 - 200 - ___ - 100 = ___ms
```

This is the hard ceiling. Any LLM that consistently exceeds it is disqualified.

### Step 2 — Prepare test inputs

Use the same 5 prospect phrases from Research 1 (now as text, since STT is already fixed). These are the inputs the LLM will receive and respond to.

Add a minimal system prompt:

```
You are a sales AI agent for DialForge. Respond in 1–2 sentences.
Be direct and natural. No filler openers like "Great question!"
```

### Step 3 — Write the LLM test script

Write `scripts/research2-llm-test.ts`. For each model, send all 5 inputs and measure:

```
t0 = now
→ send prompt to LLM (streaming enabled)
→ receive first token                          → log time-to-first-token = t1 - t0
→ receive complete response                    → log total generation time = t2 - t0
→ record response text                         → log for quality review
```

Run each input 3 times per model. Record median. Flag outliers.

Also run a **partial streaming test**: simulate feeding partial transcript mid-phrase to the LLM (before the full sentence is complete). Measure how much earlier the first token arrives — this is the key latency lever for Option A.

### Step 4 — Score and pick

| Model | Time-to-first-token (ms) | Total generation (ms) | Within budget? | Response quality (1–5) |
|---|---|---|---|---|
| Mistral (Groq) | _ | _ | Y/N | _ |
| Llama 3.3 70B (Groq) | _ | _ | Y/N | _ |
| Qwen | _ | _ | Y/N | _ |

**Decision rule:** Among models that fit within the LLM budget, choose the one with the highest quality score. If two are tied on quality, prefer the faster one.

**Output:** One selected LLM. The standalone stack is now fully defined: Deepgram + [LLM from R2] + [TTS from R1].

---

## Research 3: Final Architecture Shootout

**Status:** Blocked on Research 1 and 2.

**The question:** Does the standalone stack (Deepgram + best LLM + best TTS) beat the integrated voice model (OpenAI Realtime) on the dimensions that matter?

By this point the standalone stack is fully assembled. This research runs one comparison: the winner of R1+R2 against OpenAI Realtime.

### Step 1 — Prepare the test inputs

Use the 5 audio clips recorded from real prospect speech (the same phrases as before, but as audio files this time). Place them in `/test-audio`.

### Step 2 — Write the shootout script

Write `scripts/research3-shootout.ts`. Run both approaches against every clip:

```
For each audio clip:

  Standalone (R1+R2 winners):
    t0 = now
    → Deepgram STT (streaming, wait for speech_final)        → log t_stt
    → LLM call (streaming, first token)                      → log t_llm
    → TTS call (first audio byte)                            → log t_tts
    → End-to-end total = t_tts - t0

  Integrated (OpenAI Realtime):
    t0 = now
    → OpenAI Realtime API (audio in → first audio byte out)  → log t_realtime
    → End-to-end total = t_realtime - t0

  Run each 3 times, record median.
```

Also run a second standalone pass with **partial transcript streaming** enabled (feed partial results to LLM before speech_final).

### Step 3 — Evaluate transcript availability

| Question | Standalone | Integrated (OpenAI Realtime) |
|---|---|---|
| Text transcript available natively? | Yes — Deepgram speech_final | Check Realtime API docs |
| Format ready for Supabase write? | Yes | May need parsing |
| Extra cost or API calls to extract? | No | TBD |

### Step 4 — Evaluate cost

Build a cost model for a 5-minute call with ~30 conversation turns:

- **Standalone:** Deepgram (per minute) + LLM (per token, estimated turns) + TTS (per character, estimated speech)
- **Integrated:** OpenAI Realtime (per minute audio in + audio out — check current pricing)

### Step 5 — Fill in the final comparison table

| Dimension | Standalone (R1+R2 winners) | Integrated (OpenAI Realtime) |
|---|---|---|
| End-to-end latency, no streaming (ms) | _ | _ |
| End-to-end latency, with partial streaming (ms) | _ | N/A |
| Cost per 5-min call | $_ | $_ |
| Transcript extraction | Easy | Easy / Hard / TBD |
| Multi-use (calls + email) | Yes (to verify in R4) | No |
| Vendor lock-in | Low | High |

### Step 6 — Write the recommendation

One paragraph: which architecture to proceed with, what the deciding factor was, and any risks to surface for Danish.

---

## Research 4: Multi-Use LLM Verification

**Status:** Blocked on Research 2.

**The question:** Can the same LLM selected in Research 2 handle AI email responses through the same LangChain setup — without a separate model or chain?

This is Danish's core argument for choosing standalone over integrated. Research 3 validates latency and cost; this validates flexibility.

**What to prototype:**

```typescript
const chain = new LangChain(selectedLLM, systemPrompt)

// Calling mode — output goes to TTS
const spokenResponse = await chain.invoke(callTranscript)
await tts.speak(spokenResponse)

// Email mode — same chain, output goes to SMTP
const emailDraft = await chain.invoke(emailContext)
await smtp.draft(emailDraft)
```

**What to confirm:**
- The same model produces acceptable quality for both short spoken responses (1–2 sentences, conversational) and structured email drafts (3–5 sentences, written tone)
- No architectural changes are needed — only the output handler changes
- A single server instance handles both modes without doubling infrastructure

**Decision criterion:** If both modes work with the same chain and the response quality is acceptable for each, the standalone architecture is confirmed as the long-term direction. If the model quality degrades noticeably for email, flag it — it means we may need separate prompting strategies or a second model for email, which changes the cost model.
