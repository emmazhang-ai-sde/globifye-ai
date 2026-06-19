# AI Agent Architecture Options
**Author:** Shuyang Zhang (AI)  
**Last updated:** 2026-06-18  

---

There are two fundamentally different ways to build the real-time call loop. This decision affects latency, cost, control, and how much we can reuse the existing Deepgram setup.

---

## Option A: STT + LLM + TTS Pipeline (modular)

```
┌─────────────────────────────┐
│       Prospect speaks       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│      Deepgram Nova-3        │
│      (STT, streaming)       │
└──────────────┬──────────────┘
               │ partial transcript (real-time)
               ▼
┌─────────────────────────────┐
│             LLM             │
│  (starts while prospect is  │
│       still talking)        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│             TTS             │
│     (converts to audio)     │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│   Audio sent back via SIP   │
└─────────────────────────────┘
```

| Pros | Cons |
|---|---|
| Reuses existing Deepgram integration — low-risk | Three components in series — latency compounds |
| Partial transcript fed to LLM while prospect is still talking — hides latency | TTS adds another ~200–400ms |
| Latency can approach Option B's level with streaming | More moving parts to maintain |
| Full control over each layer | Requires careful streaming orchestration |
| Transcript available in DB for analysis | If end-to-end latency exceeds ~2.5s in testing, revisit Option B |
| Can swap LLM or TTS independently (e.g. Groq → OpenAI) without touching STT | |

### Industry-Standard Stack for Option A


Across voice AI agent platforms (Vapi, Retell, Bland.ai), the dominant Option A combination as of 2025–2026 is:

**Groq + ElevenLabs Turbo v2.5**

| Layer | Choice | Why |
|---|---|---|
| **LLM** | Groq-hosted Llama 3.x or Mistral | Lowest inference latency of any hosted provider (~150–300ms TTFB); fast enough that the LLM is no longer the bottleneck — TTS becomes the slow leg |
| **TTS** | ElevenLabs `eleven_turbo_v2_5` | Best quality-to-latency tradeoff; ~300–400ms TTFB; built specifically for real-time use |

**Runner-up:** Groq + Deepgram Aura — chosen when latency is the absolute priority over voice quality (e.g., high-volume outbound). Deepgram Aura is ~75–150ms TTFB but noticeably more robotic.

**Relevance to this project:** Groq is already set up for post-call analysis, so the LLM layer is low-effort to reuse. The open question is whether ElevenLabs voice quality justifies its ~300ms TTFB vs. Deepgram Aura's ~76ms — Research 1 and 2 in [`ai-agent-research-plan.md`](./ai-agent-research-plan.md) will settle this with measured data.

### Final Decision

| Layer | Current | Planned |
|---|---|---|
| **TTS** | ElevenLabs `eleven_turbo_v2_5` | — |
| **LLM** | Groq (local version) | OpenAI API |
| **STT** | Deepgram Nova-2 | Possibly Modulate.ai (PM suggestion — pending clarification; Modulate.ai is primarily a voice intelligence/compliance platform, not a dedicated STT provider) |

**LLM note:** The same LLM should handle both voice call responses and email drafts via LangChain — a key reason for choosing standalone over integrated (OpenAI Realtime locks you into one use case).

---

## Option B: Speech-to-Speech (single model)

```
┌─────────────────────────────┐
│       Prospect speaks       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│     OpenAI Realtime API     │
│  (audio in → audio out,     │
│       end-to-end)           │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│   Audio sent back via SIP   │
└─────────────────────────────┘
```

**Example:** OpenAI Realtime API handles STT + reasoning + TTS as one unified model call.

| Pros | Cons |
|---|---|
| Lowest possible latency (no pipeline overhead) | Full OpenAI vendor lock-in |
| Simplest architecture | More expensive per minute |
| No orchestration needed | Less control over voice/style/behavior |
| | Transcript harder to extract for DB writes |

---

## Modulate.ai — Post-Call Compliance Layer

Modulate.ai is a voice intelligence/moderation platform that fits into the **post-call analysis** part of the pipeline, not the real-time call loop.

| Feature | What it does | Relevance |
|---|---|---|
| **PII/PHI Redaction** | Strips sensitive data (card numbers, SSNs, health info) from transcripts before DB write | High — if the product moves into regulated industries |
| **Deepfake Detection** | Flags synthetic voices on inbound calls | Medium — fraud prevention for inbound support calls |
| **Compliance monitoring (Velma)** | Detects risky behaviors (fraud signals, regulatory violations) across call audio | Medium — enterprise compliance use case |
| **Speech-to-Text** | Alternative transcription API (see pricing breakdown below) | Medium — significantly cheaper than Deepgram for streaming; post-call batch even more so |

**Status:** Not in scope for MVP. Pending clarification from Danish on intended use — Modulate.ai is a post-call compliance tool, not a dedicated real-time STT provider.

---

## STT Pricing Comparison: Deepgram vs. Modulate.ai

*Prices as of June 2026. Both offer free credits on signup: Deepgram $200, Modulate 400 hours.*

### Deepgram

| Mode | Model | Pay-As-You-Go | Growth Plan (annual) |
|---|---|---|---|
| **Streaming** | Nova-3 Monolingual | $0.0048/min ($0.288/hr) | $0.0042/min ($0.252/hr) |
| **Streaming** | Nova-3 Multilingual | $0.0058/min ($0.348/hr) | $0.0050/min ($0.300/hr) |
| **Streaming** | Flux English | $0.0065/min ($0.390/hr) | $0.0057/min ($0.342/hr) |
| **Pre-recorded** | Nova-3 Monolingual | $0.0077/hr | $0.0065/hr |
| **Pre-recorded** | Nova-3 Multilingual | $0.0092/hr | $0.0078/hr |
| **Pre-recorded** | Flux English | $0.0077/hr | $0.0065/hr |

Add-ons: Speaker Diarization +$0.0020/min, Redaction +$0.0020/min, Keyterm Prompting +$0.0017/min. Smart Formatting included free.  
Concurrency: REST up to 50 concurrent; WebSocket streaming up to 225.

### Modulate.ai (Velma Transcribe)

| Mode | Model | Price | Notes |
|---|---|---|---|
| **Streaming** | Velma Transcribe Streaming | $0.06/hr | Diarization, emotion detection, accent ID, 57 languages included |
| **Batch** | Velma Transcribe Batch | $0.03/hr | Same features as streaming; multilingual |
| **Batch** | Velma Transcribe Batch English Fast | $0.025/hr | English-only; up to 200x realtime factor |
| **Batch** | Velma PII/PHI Redact Batch | $0.05/hr | PII/PHI detection + redaction built in |
| **Streaming** | Velma PII/PHI Redact Streaming | $0.08/hr | Real-time PII/PHI redaction |

Add-ons: PII/PHI Tagging +$0.02/hr, Deepfake Detection +$0.25/hr.

### Head-to-Head for Our Use Case

| Scenario | Deepgram | Modulate.ai | Winner |
|---|---|---|---|
| **Real-time call STT (streaming)** | $0.0048/min = **$0.288/hr** | **$0.06/hr** | Modulate ~4.8× cheaper |
| **Post-call batch transcription** | $0.0077/hr | $0.03/hr | Deepgram cheaper for batch |
| **Streaming + diarization** | $0.288 + $0.12 = **$0.408/hr** | **$0.06/hr** (included) | Modulate ~6.8× cheaper |
| **Streaming + PII redaction** | $0.288 + $0.12 = **$0.408/hr** | **$0.08/hr** | Modulate ~5× cheaper |
| **Latency (real-time calls)** | ~Lower (purpose-built STT) | Higher (voice intelligence platform) | Deepgram |

**Recommendation:** For our real-time voice AI loop, **Deepgram Nova-3 remains the right choice** — it is purpose-built for low-latency streaming and integrates directly with our existing setup. Modulate.ai's streaming price is lower, but Deepgram's latency advantage matters more in live calls. Modulate.ai becomes compelling only if we add compliance features (PII redaction, deepfake detection) post-call, where the $0.03–$0.05/hr batch rate is a genuine saving over running a second Deepgram pass.
