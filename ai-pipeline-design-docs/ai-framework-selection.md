# AI Framework Selection — LangChain vs LangGraph vs LangFlow

**Project:** GlobiFYE Sales Call System (AI Pipeline)  
**Stack:** Next.js + Vercel + Supabase + TypeScript  
**Question:** Which framework, if any, should we adopt for the AI pipeline given the current scope and anticipated future growth?

---

## How the Three Are Related

Before comparing them as if they were equals, it's important to understand the relationship between the three:

```
LangChain          ← Core framework (available in both JS/TS and Python)
    └── LangGraph  ← Built on top of LangChain; handles stateful, multi-actor agent workflows

LangFlow           ← Separate product; visual drag-and-drop interface; outputs Python; uses LangChain under the hood
```

LangGraph is not an alternative to LangChain — it is an extension of it, designed for a more specific and advanced use case. LangFlow targets a different audience entirely (non-technical users, rapid visual prototyping). This distinction matters when making a selection.

---

## Analysis Against the Current Project

### LangFlow — Ruled Out

| Issue | Reason |
|---|---|
| Python-only output | The project uses TypeScript and Next.js. LangFlow generates Python code that cannot be used directly in this stack. |
| Visual interface is not production code | Pipelines built in LangFlow are visual graphs, not version-controllable TypeScript. Collaboration and maintenance become difficult as the codebase grows. |
| Requires a separate Python deployment | LangFlow needs its own server. This conflicts with the goal of keeping everything within Vercel + Supabase — no extra infrastructure. |

LangFlow is a useful tool for demonstrating pipeline logic to non-technical stakeholders or for rapid prototyping by a solo developer. It is not suitable for a production TypeScript codebase being built collaboratively.

---

### LangGraph — Premature for Current Scope

LangGraph is designed to solve a specific problem: **multi-actor, stateful agent workflows** where the pipeline is non-linear, involves decision branches, requires human-in-the-loop steps, or has multiple agents collaborating.

**Example of a use case that warrants LangGraph:**

```
Agent 1: Analyzes call transcript → decides if more context is needed
    → If yes: calls CRM API to fetch customer history → re-analyzes
    → If no: produces final output directly
Agent 2: Reviews Agent 1's output → rejects and retries if quality threshold not met
```

**Our current Phase 2 pipeline:**

```
Full transcript → Single LLM call → Structured JSON output → Write to DB
```

This is a linear, single-step invocation. There is no branching logic, no state to maintain between steps, and no agent collaboration. Introducing LangGraph at this stage would add significant architectural complexity without providing any tangible benefit.

**When to reconsider LangGraph:** If the pipeline evolves to include multi-step reasoning, tool-using agents that make decisions across multiple turns, or a supervisor agent that coordinates sub-agents (e.g., one for objection analysis, one for CRM enrichment, one for quality scoring), LangGraph becomes the right tool. That point has not been reached yet.

---

### LangChain.js — Recommended

LangChain has a fully supported JavaScript/TypeScript package (`langchain`, `@langchain/core`, `@langchain/anthropic`, etc.) that integrates directly with Next.js and runs inside Vercel serverless API routes without any additional infrastructure.

#### Why It Fits This Project

**1. LLM provider is not yet finalized**

The team is still evaluating LLM candidates (OpenAI GPT-4o, Anthropic Claude Sonnet, MiniMax, etc.). LangChain abstracts the provider interface — swapping from Anthropic to OpenAI requires changing only the model initialization line. The prompt, output parser, and DB write logic remain identical.

```typescript
// Swap provider with one line change — everything else stays the same
const model = new ChatAnthropic({ model: "claude-sonnet-4-6" })
// const model = new ChatOpenAI({ model: "gpt-4o" })
// const model = new ChatMiniMax({ model: "..." })
```

**2. More reliable structured JSON output**

LangChain's `.withStructuredOutput()` method accepts a Zod schema and enforces the output shape at the framework level — no manual `JSON.parse()` with a surrounding try/catch. If the LLM returns malformed output, the error is descriptive and handled consistently.

```typescript
import { z } from "zod"

const AnalysisSchema = z.object({
  summary: z.string(),
  key_topics: z.array(z.object({ name: z.string(), start_time: z.number() })),
  analysis: z.object({
    objections: z.array(z.object({
      timestamp: z.number(),
      speaker: z.string(),
      exact_quote: z.string(),
      reason: z.string(),
      suggestion: z.string(),
    })),
    what_went_well: z.array(z.object({
      timestamp: z.number(),
      speaker: z.string(),
      exact_quote: z.string(),
      reason: z.string(),
    })),
  }),
})

const result = await model.withStructuredOutput(AnalysisSchema).invoke(prompt)
// result is fully typed — no casting, no manual validation
```

**3. Future scope — everything on the roadmap is already supported**

| Anticipated future requirement | LangChain support |
|---|---|
| CRM API integrations (HubSpot, Apollo, Zapier, Zendesk) | Wrap each as a LangChain `Tool` — the LLM can call them dynamically |
| Cross-call historical analysis (RAG) | Native vector store integrations, including Supabase `pgvector` |
| Second-pass transcription correction (noted in `stt-selection-guideline.md`) | Two-step chain: Step 0 corrects transcript, Step 1–4 runs analysis on corrected text |
| Prompt versioning and call tracing | LangSmith (LangChain's observability tool) traces every invocation with inputs, outputs, latency, and token usage |
| Switching or A/B testing LLM providers | Change one line — rest of pipeline is unaffected |

**4. Runs on Vercel without extra infrastructure**

Each LangChain invocation is stateless and completes within a single function call, making it fully compatible with Vercel serverless API routes. No persistent server, no Docker, no extra deployment.

---

## Recommendation

| Framework | Verdict | Rationale |
|---|---|---|
| **LangFlow** | ❌ Not suitable | Python-only; incompatible with TypeScript stack; not production-ready for this codebase |
| **LangGraph** | ⏳ Not yet | Designed for multi-agent stateful workflows; current pipeline is single-step linear; revisit when pipeline complexity grows |
| **LangChain.js** | ✅ Adopt | TypeScript-native; LLM-provider-agnostic; handles structured output reliably; supports all anticipated future extensions without requiring infrastructure changes |

---

## Migration Path

The current `lib/llm.ts` does not need to be rewritten. LangChain can be introduced incrementally after the MVP demo. The interface change is minimal:

**Before (direct SDK call):**

```typescript
import Anthropic from "@anthropic-ai/sdk"
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const message = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 2048,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: transcriptText }],
})
const rawOutput = message.content[0].type === "text" ? message.content[0].text : ""
const parsed = JSON.parse(rawOutput)
```

**After (LangChain.js):**

```typescript
import { ChatAnthropic } from "@langchain/anthropic"
const model = new ChatAnthropic({ model: "claude-sonnet-4-6" })

const parsed = await model
  .withStructuredOutput(AnalysisSchema)
  .invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: transcriptText },
  ])
// parsed is fully typed — JSON.parse and try/catch are gone
```

Install:

```bash
npm install langchain @langchain/core @langchain/anthropic zod
```

---

## Decision

**For the MVP (current phase):** Direct LLM SDK is sufficient and faster to ship. No change needed.

**Post-MVP:** Migrate `lib/llm.ts` to LangChain.js. The migration cost is low (one file, minimal interface change), and it positions the pipeline to handle every anticipated expansion — provider switching, RAG, CRM tool use, and multi-step chains — without architectural rewrites.

---

## Addendum — Do We Actually Need RAG for Customer History?

### The Short Answer: No. Filtered Retrieval Is Better for This Use Case.

RAG (Retrieval-Augmented Generation) is commonly proposed as the solution for giving the LLM access to external knowledge — such as a customer's call history. However, for this project's specific use case, RAG is the wrong tool. A simpler approach works better.

### What RAG Actually Does

RAG uses **semantic similarity search**: data is vector-embedded, and at query time the system retrieves the chunks most similar to the current query. This is the right approach when:
- The knowledge base is too large to fit in the context window
- You need to search across a large corpus and relevance is fuzzy

### What We Actually Need

For customer call history, the retrieval condition is exact, not fuzzy:

```sql
SELECT * FROM transcript
WHERE customer_id = 'xxx'
ORDER BY created_at ASC
```

This is **filtered retrieval** — fetch all records matching a specific customer ID and include the full history in the LLM context. No vector embeddings, no similarity scoring, no RAG infrastructure required.

This approach is not only simpler — it is more reliable. RAG's semantic search can miss historically important calls that are not semantically similar to the current one. Filtered retrieval misses nothing.

### Will the Context Get Too Large?

For a typical sales customer lifecycle, this is not a problem. The math:

| Parameter | Estimate |
|---|---|
| Average call duration | ~30 minutes |
| Deepgram transcription rate | ~130 words/minute |
| Tokens per call | ~5,000–6,000 tokens |
| Claude Sonnet context window | 200,000 tokens |
| GPT-4o context window | 128,000 tokens |

This means the full call history for a customer fits comfortably within the context window until approximately:
- **~33 calls** with Claude Sonnet
- **~20 calls** with GPT-4o

For the vast majority of customers in a sales pipeline, this ceiling will never be reached.

### When RAG Is Actually the Right Choice

| Scenario | Right approach |
|---|---|
| Same customer, normal call history (< 20 calls) | ✅ Filter by `customer_id`, pass full history in context |
| Same customer, very large call history (20–30+ calls) | RAG — semantic search over that customer's history |
| Cross-customer search: *"all calls where pricing was objected"* | RAG — semantic search across all customers |
| Internal product knowledge base / sales playbook (large docs) | RAG — documents too large to include in every prompt |

### Implementation

Add a `customer_id` field to the `recordings` table:

```sql
ALTER TABLE recordings ADD COLUMN customer_id TEXT;
CREATE INDEX IF NOT EXISTS recordings_customer_id_idx ON recordings(customer_id);
```

Then in Phase 2, before calling the LLM, fetch the full customer history:

```typescript
// 1. Get customer_id for the current recording
const { data: recording } = await supabaseAdmin
  .from('recordings')
  .select('customer_id')
  .eq('id', recordingId)
  .single()

// 2. Fetch all previous calls for this customer (excluding current)
const { data: historicalRows } = await supabaseAdmin
  .from('transcript')
  .select('speaker, sentence_start_sec, content_raw, recordings!inner(customer_id, created_at)')
  .eq('recordings.customer_id', recording.customer_id)
  .neq('recordings.id', recordingId)
  .order('created_at', { ascending: true })

// 3. Build prompt with history first, current call second
const historyText = buildTranscriptText(historicalRows)
const currentText = buildTranscriptText(currentRows)

const prompt = `
## Customer's Previous Calls
${historyText || "(No previous calls on record)"}

## Current Call (to analyze)
${currentText}
`
```

With this context, the LLM can produce analysis like:

> *"This customer raised a pricing objection in their second call as well. The rep's response at that time focused on feature parity — this time the approach was more effective because it reframed around ROI directly."*

### Summary

| | RAG (vector search) | Filtered retrieval (customer_id) |
|---|---|---|
| Implementation complexity | High — requires vector embeddings, vector store | Low — one SQL query |
| Risk of missing history | Yes — semantic mismatch can drop relevant calls | None — full history always included |
| Infrastructure needed | Vector database (or pgvector extension) | None — existing Supabase tables |
| Right for this use case? | ❌ Overkill for per-customer history | ✅ Simpler and more complete |

**Action item:** Add `customer_id` to the `recordings` table schema in `supabase/migrations/001_schema.sql`. No other changes needed until a customer's call count approaches the context window limit.
