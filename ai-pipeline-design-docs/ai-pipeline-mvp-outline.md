# AI Pipeline MVP — Step-by-Step Outline

**Project:** GlobiFYE Sales Call System
**Goal:** End-to-end working demo — audio file in → transcript stored → analysis out
**Stack:** Next.js + Vercel + Supabase + Deepgram Nova-3 + LangChain.js + LLM (provider TBD — Anthropic Claude Sonnet or OpenAI GPT-4o)
**Demo deadline:** Monday, May 27, 2026

---

## Context

The PM (Danish Parray) asked for a working end-to-end AI pipeline prototype to demo. The pipeline must cover two phases from the pipeline diagram:
- **Phase 1 (During Call):** Audio → Deepgram STT → Partial Results (UI captions) + Final Results (DB writes)
- **Phase 2 (Post-call):** Button-triggered → single LLM call → structured JSON → DB + UI

No code exists yet — only architecture docs. This plan builds the MVP step by step without writing code directly.

---

## MVP Scope

For the Monday demo: **audio file in → transcript stored → analysis out**. A minimal working proof-of-concept, not a polished UI. Real-time WebSocket streaming can be layered in after the core pipeline validates.

---

## Step-by-Step Outline

### Step 1 — Project Setup

→ See [ai-pipeline-mvp-step1-project-setup.md](ai-pipeline-mvp-step1-project-setup.md)

---

### Step 2 — Supabase Database Schema

→ See [ai-pipeline-mvp-step2-supabase-schema.md](ai-pipeline-mvp-step2-supabase-schema.md)

---

### Step 3 — LLM Selection

→ See [ai-pipeline-mvp-step3-llm-selection.md](ai-pipeline-mvp-step3-llm-selection.md)

---

### Step 4 — Deepgram Integration *(batch mode first, streaming later)*

→ See [ai-pipeline-mvp-step4-deepgram-integration.md](ai-pipeline-mvp-step4-deepgram-integration.md)

---

### Step 5 — Phase 1: Transcript Parsing & DB Write

→ See [ai-pipeline-mvp-step5-transcript-parsing-db-write.md](ai-pipeline-mvp-step5-transcript-parsing-db-write.md)

---

### Step 6 — Phase 2: LLM Analysis Prompt

→ See [ai-pipeline-mvp-step6-llm-analysis-prompt.md](ai-pipeline-mvp-step6-llm-analysis-prompt.md)

---

### Step 7 — Phase 2: LLM Call & DB Write

→ See [ai-pipeline-mvp-step7-llm-call-db-write.md](ai-pipeline-mvp-step7-llm-call-db-write.md)

---

### Step 8 — Next.js API Routes

→ See [ai-pipeline-mvp-step8-api-routes.md](ai-pipeline-mvp-step8-api-routes.md)

---

### Step 9 — Basic UI *(Next.js page)*

→ See [ai-pipeline-mvp-step9-basic-ui.md](ai-pipeline-mvp-step9-basic-ui.md)

---

### Step 10 — Real-time WebSocket Layer *(post-demo, if time)*

→ See [ai-pipeline-mvp-step10-websocket-layer.md](ai-pipeline-mvp-step10-websocket-layer.md)

---

## Key Files to Create

| File | Purpose |
|---|---|
| `scripts/run-pipeline.js` or `.ts` | MVP end-to-end script |
| `lib/deepgram.ts` | Deepgram client + transcript parsing |
| `lib/supabase.ts` | Supabase client + DB write helpers |
| `lib/llm.ts` | LLM client + analysis prompt |
| `app/api/transcribe/route.ts` | API route for Phase 1 |
| `app/api/analyze/route.ts` | API route for Phase 2 |
| `supabase/migrations/001_schema.sql` | Supabase table definitions |

---

## Pending Decisions *(clarify before building)*

1. **MVP delivery format:** Standalone script (fastest) vs full Next.js app with UI?
2. **LLM provider:** ✅ Framework decided (LangChain.js). Provider still pending Amy's evaluation — Anthropic Claude Sonnet or OpenAI GPT-4o. Once decided, change one import line and one `model` initialization in `lib/llm.ts`.
3. **Sample audio:** Need a test `.mp3`/`.wav` of a sales call (real or synthetic) to validate the pipeline end-to-end

---

## Verification *(end-to-end test)*

1. Run the pipeline on a sample audio file
2. Check Supabase: `transcript` rows appear with speaker labels, `content_raw`, `content_clean`, `sentence_start_sec`
3. Check Supabase: `analysis` row appears with valid JSON in all four fields
4. Review LLM output: objections have `timestamps`, `exact_quotes`, `reasons`, `suggestions`
5. Confirm `what_went_well` and `summary` are populated
