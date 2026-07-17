# AI Pipeline vs. AI Agent — Engineering Distinction

**Author:** Shuyang Zhang (AI)
**Date:** 2026-07-03
**Source:** `design-docs/ai-agent/ai-agent-design.md`, Section 1 & 2

---

## AI Pipeline (current system)

- A human sales rep drives the call — the person uses the browser mic to place the call; AI is purely a support role
- AI's job is to **observe and process after the fact**:
  - Real-time: Deepgram converts the call to text and writes it to the `transcript` table (pure record-keeping, doesn't participate in the conversation)
  - After the call ends, a button click triggers a single LLM call that produces the summary / objection analysis / key topics
- Audio source: browser microphone
- AI never "speaks" — it only listens and summarizes

### The MVP is the Pipeline

Everything built so far in `design-docs/ai-pipeline/` (Steps 1–13 — Deepgram integration, Supabase schema, LLM analysis prompt, API routes, the live WebSocket layer, the basic UI) **is the Pipeline, not the Agent.** The MVP was never a partial or early version of the Agent — it's a separate, complete system in its own right: human drives the call, AI transcribes and summarizes afterward. Every table currently populated (`recordings`, `transcript`, `analysis`, `topics`) was designed around this observer role.

This matters for how to read the design docs: `design-docs/ai-pipeline/` describes what is actually built and running today. `design-docs/ai-agent/` describes a proposed *next* system that reuses pieces of the Pipeline (Deepgram STT, the Groq LLM call, the Supabase tables) but adds an entirely new responsibility — generating and speaking a response — that the Pipeline was never built to do. The Agent is not "Pipeline v2"; it's a different mode of operation layered on top of the same underlying components.

## AI Agent (Danish's proposed new direction)

- The AI itself is the one making the call — it replaces the human sales rep and handles the entire call autonomously, end to end
- Audio source shifts to the SIP phone line (routed through Abraham's telephony layer), no longer the browser
- One thing gets added that a human role never needed: the AI has to generate a response and "say" it
  - STT (listen) → LLM (decide what to say) → TTS (say it) → sent back through SIP to the phone line
  - This is a continuously running real-time loop (`WHILE call is active`), targeting under 1.5 seconds of latency
- The post-call analysis loop also changes from "button-triggered" to "automatically triggered by the call-ended event"

## One-line summary of the distinction

**Pipeline is "AI working for a human"** (listen + summarize). **Agent is "AI making the call itself"** (listen + decide + speak). In the former, the AI is an observer; in the latter, the AI is the party on the call.

This is also why Section 2 of `ai-agent-design.md` specifically stresses drawing a clear line between "Abraham's telephony layer" and "our AI system" as two separate databases/ownership boundaries — because in Agent mode, the AI has to talk directly to the telephony system for the first time, rather than just consuming an audio recording that's already been captured.
