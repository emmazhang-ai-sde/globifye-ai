# Step 3 — LLM Selection

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

## Decision status

| Decision | Status | Detail |
|---|---|---|
| Integration framework | ✅ LangChain.js | See `ai-framework-selection.md` for full analysis |
| LLM provider (demo) | ✅ Groq — Llama 3.3 70B | Free tier, no credit card, fastest inference. See 3.6 for setup. |
| LLM provider (production) | ⏳ Pending Amy's evaluation | Claude Sonnet 4.6 vs GPT-4o vs DeepSeek V3 once demo validates the pipeline |

---

## 3.1 Framework: LangChain.js

LangChain.js is the chosen integration layer. It wraps the LLM provider so that switching providers is a single import-line and model-initialization change in `lib/llm.ts` — the Zod schema, prompt, and DB write logic are provider-agnostic and require no changes.

---

## 3.2 Model comparison

> ⚠️ Pricing changes frequently. Verify the latest rates on each provider's pricing page before finalizing. The figures below are approximate and based on available data at the time of writing.

### Specs and pricing

| Model | Provider | Context window | Input (per 1M tokens) | Output (per 1M tokens) | Free credits (new account) | LangChain package |
|---|---|---|---|---|---|---|
| **Llama 3.3 70B** ⭐ demo | Groq (hosted) | 128K | Free on free tier | Free on free tier | ✅ Free tier, no credit card — sign up at console.groq.com | `@langchain/groq` |
| **Llama 3.2 / Mistral** | Ollama (local) | varies | Free (runs on your machine) | Free | ✅ No account needed — install from ollama.ai | `@langchain/ollama` |
| **Claude Sonnet 4.6** | Anthropic | 200K | ~$3.00 | ~$15.00 | ❌ None — payment required upfront. Free usage possible via AWS Bedrock or Google Vertex AI if you have cloud startup credits. | `@langchain/anthropic` |
| **GPT-4o** | OpenAI | 128K | ~$2.50 | ~$10.00 | ❌ None — automatic $5 new-account credit was discontinued in late 2024. Payment required upfront. Free usage possible via Azure OpenAI if you have Microsoft for Startups credits. | `@langchain/openai` |
| **GPT-4o mini** | OpenAI | 128K | ~$0.15 | ~$0.60 | ❌ Same as GPT-4o above. | `@langchain/openai` |
| **DeepSeek V3** | DeepSeek | 128K | ~$0.14 | ~$0.28 | ✅ Free credits on signup (verify current amount at platform.deepseek.com) | `@langchain/openai`* |
| **MiniMax-Text-01** | MiniMax | 1M | ~$0.70 | ~$0.70 | ✅ Free credits on signup (verify current amount at intl.minimaxi.com) | Custom / no first-class support |

\* DeepSeek exposes an OpenAI-compatible API endpoint — use `@langchain/openai` with a custom `baseURL` of `https://api.deepseek.com`.

### Structured output support

Structured output (LangChain's `.withStructuredOutput()`) is a hard requirement — the pipeline depends on it to produce valid JSON matching `AnalysisSchema` without manual parsing.

| Model | Structured output via `.withStructuredOutput()` | Notes |
|---|---|---|
| Llama 3.3 70B (Groq) | ✅ Reliable | Groq's tool calling + LangChain `.withStructuredOutput()` confirmed working |
| Llama 3.2 / Mistral (Ollama) | ✅ Reliable | Native structured output in `@langchain/ollama` v0.2.0+ — no extra config needed |
| Claude Sonnet 4.6 | ✅ Reliable | Uses tool use / function calling |
| GPT-4o | ✅ Reliable | Uses function calling |
| GPT-4o mini | ✅ Reliable | Same mechanism as GPT-4o, cheaper |
| DeepSeek V3 | ✅ Mostly reliable | OpenAI-compatible function calling — untested for complex nested schemas |
| MiniMax-Text-01 | ❌ Unreliable | Amy's test returned Markdown, not JSON — incompatible with `.withStructuredOutput()` without prompt workarounds |

---

## 3.3 Estimated cost per call

A typical 30-minute sales call transcript is roughly 4,500–6,000 words ≈ **6,000–8,000 tokens** of input. With system prompt overhead and ~800 tokens of structured JSON output, per-call cost is approximately:

| Model | Input (7,000 tokens) | Output (800 tokens) | **Approx. cost/call** |
|---|---|---|---|
| Claude Sonnet 4.6 | $0.021 | $0.012 | **~$0.033** |
| GPT-4o | $0.018 | $0.008 | **~$0.026** |
| GPT-4o mini | $0.0011 | $0.0005 | **~$0.002** |
| DeepSeek V3 | $0.001 | $0.0002 | **~$0.001** |
| MiniMax-Text-01 | $0.005 | $0.0006 | **~$0.006** |

For the MVP demo (a 2–3 minute sample audio ≈ 1,000–2,000 tokens input), all models cost less than $0.01 per run — cost is not a differentiator for testing.

---

## 3.4 Amy's test results

Amy tested three models using the same two prompts (`amy/llm-testing/LLM-prompt1.txt`, `LLM-prompt2.txt`). Results are saved as JSON/markdown in `amy/llm-testing/`.

### Output quality summary

| Criterion | Claude Sonnet 4.6 (API) | Claude Sonnet 4.6 (free) | GPT-4o | MiniMax-Text-01 |
|---|---|---|---|---|
| Summary quality | ✅ Detailed, 3 sentences | ✅ Detailed, 3 sentences | ⚠️ Shallow, 2 sentences | ✅ Verbose but thorough |
| Key topics count | 8 (comprehensive) | 8 (comprehensive) | 6 (covers key ones) | 13 (over-granular) |
| Objections detected | 3/3 | 3/3 | 2/3 (missed one) | 2/3 |
| Exact quotes verbatim | ✅ | ✅ | ✅ | ✅ |
| Suggestion quality | ✅ Specific, strategic | ✅ Specific, strategic | ⚠️ Generic ("provide references") | ✅ Reasonable |
| `what_went_well` depth | 7 entries, detailed | 5 entries, detailed | 3 entries, brief | 5 entries |
| Output format | ✅ Valid JSON | ✅ Valid JSON | ✅ Valid JSON | ❌ Markdown (not JSON) |
| Schema compliance | ✅ Perfect | ✅ Perfect | ✅ Perfect | ❌ Fails `.withStructuredOutput()` |

**Key observations from Amy's tests:**

- **Claude Sonnet 4.6** (both API and free tier) consistently produced the most detailed `what_went_well` entries and the most actionable `suggestion` fields in objections. Free-tier output was nearly identical to API output in quality.
- **GPT-4o** produced valid JSON and detected most objections, but tended to write fewer `what_went_well` items and the suggestions were less specific (e.g. "provide strong references" vs. Claude's "offer a contractual milestone structure with a penalty clause and share a comparable case study").
- **MiniMax-Text-01** returned formatted Markdown instead of JSON, making it incompatible with `.withStructuredOutput()` without significant prompt engineering. Key topics were over-granular (13 entries vs. 6–8 for others). **Not recommended for this pipeline without workarounds.**
- **DeepSeek V3** — listed in Amy's candidate notes (`amy/llm-testing/notes.md`) but not yet tested. Worth evaluating given its dramatically lower cost.

---

## 3.5 Getting an API key

| Provider | Signup URL | Notes |
|---|---|---|
| Anthropic | console.anthropic.com | No free credits — payment required upfront. MVP test run costs ~$0.01–$0.03. Alternatively, access Claude via AWS Bedrock or Google Vertex AI if GlobiFYE has startup cloud credits. |
| OpenAI | platform.openai.com | No free credits — the automatic $5 new-account credit was discontinued in late 2024. Alternatively, access GPT-4o via Azure OpenAI if GlobiFYE has Microsoft for Startups / Azure credits. |
| DeepSeek | platform.deepseek.com | Free credits on signup — verify current amount before signing up. |
| MiniMax | intl.minimaxi.com | Free credits on signup — verify current amount. Note: not recommended for this pipeline (see 3.4). |

Once you have a key, add it to `ai-pipeline/.env.local`:

```env
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...

# — OR — OpenAI
# OPENAI_API_KEY=sk-...

# — OR — DeepSeek (uses @langchain/openai with custom baseURL)
# DEEPSEEK_API_KEY=sk-...
```

---

## 3.6 Recommendation

**For the demo: Groq (Option A) — free, no credit card, fastest output.**

Groq hosts Llama 3.3 70B on specialized LPU hardware at 700+ tokens/second. Free tier requires no credit card and rate limits are well above what a demo needs. `.withStructuredOutput()` is confirmed working with LangChain.js.

**Fallback: Ollama (Option B)** — if you want zero external dependencies or need to run offline. Requires local installation and ~4GB RAM but is completely free with no account.

**MiniMax-Text-01 is not recommended** — Amy's test showed it returns Markdown, not JSON, and it has no first-class LangChain support. It will break `.withStructuredOutput()`.

**For production** (after the demo): revisit Claude Sonnet 4.6 or GPT-4o based on Amy's evaluation. Both produced higher quality analysis output than Llama in Amy's tests.

---

## 3.7 Demo setup — Option A: Groq (recommended)

**Step 1 — Create a Groq account**

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up with email or Google — no credit card required
3. You land on the Groq Console dashboard

**Step 2 — Create an API key**

1. In the left sidebar, click **API Keys**
2. Click **Create API Key**
3. Give it a name (e.g. `globifye-demo`)
4. Copy the key — it starts with `gsk_...` and is only shown once

**Step 3 — Add the key to `.env.local`**

Open `ai-pipeline/.env.local` and add:

```env
GROQ_API_KEY=gsk_...
```

**Step 4 — Install the LangChain Groq package**

```bash
npm install @langchain/groq
```

**Step 5 — Update `lib/llm.ts`**

Replace the two provider lines at the top of the file:

```typescript
// Before (Anthropic placeholder from Step 7 template):
import { ChatAnthropic } from '@langchain/anthropic'
const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY! })

// After (Groq):
import { ChatGroq } from '@langchain/groq'
const model = new ChatGroq({ model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY! })
```

Everything else in `lib/llm.ts` — `AnalysisSchema`, `SYSTEM_PROMPT`, `buildTranscriptText()`, `analyzeTranscript()`, `writeAnalysis()` — stays exactly the same.

**Step 6 — Verify it works**

Run the Step 7 test script:

```bash
npx tsx --env-file=.env.local scripts/test-analysis.ts
```

Expected: the same JSON output shape as Step 7 — `summary`, `key_topics`, `objection_analysis`, `what_went_well` all populated.

> **Groq free tier rate limits** (verify current limits at [console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits)):
> - Requests per minute: ~30 RPM on free tier
> - Tokens per minute: ~6,000 TPM on free tier
> - A single analysis call uses ~7,000–8,000 tokens, so you may hit the TPM limit on the first call if the transcript is long — wait 60 seconds and retry.

---

## 3.8 Demo setup — Option B: Ollama (fully local)

Use this if you want no external API, no account, and no internet dependency.

**Step 1 — Install Ollama**

```bash
# macOS
brew install ollama

# — OR — download the installer from:
# https://ollama.ai
```

Verify installation:

```bash
ollama --version
```

**Step 2 — Pull a model**

```bash
ollama pull llama3.2
```

This downloads the model (~2GB for the 3B variant, ~4GB for the 7B variant). Run once; the model is cached locally after that.

> **Which model to use?** `llama3.2` (3B) is fast on most laptops. If you have 16GB+ RAM or Apple Silicon, `llama3.2:7b` gives noticeably better analysis quality. Check available models at [ollama.ai/library](https://ollama.ai/library).

**Step 3 — Start the Ollama server**

Ollama runs as a background service. On macOS it starts automatically after install. To start it manually:

```bash
ollama serve
```

Leave this running in a separate terminal. The server listens on `http://localhost:11434`.

**Step 4 — Install the LangChain Ollama package**

```bash
npm install @langchain/ollama
```

**Step 5 — Update `lib/llm.ts`**

```typescript
// Before (Anthropic placeholder):
import { ChatAnthropic } from '@langchain/anthropic'
const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY! })

// After (Ollama — no API key needed):
import { ChatOllama } from '@langchain/ollama'
const model = new ChatOllama({ model: 'llama3.2' })
```

No changes needed in `.env.local` — Ollama has no API key.

**Step 6 — Verify it works**

```bash
npx tsx --env-file=.env.local scripts/test-analysis.ts
```

> **Ollama is slower than Groq.** On a typical laptop, expect 10–30 seconds for a full analysis response vs. 2–5 seconds on Groq. The output shape will be identical; only the speed differs.

---

## 3.9 Switching to a production provider later

Once the demo validates the pipeline, switching to Claude or GPT-4o for production is still just a two-line change:

```typescript
// Claude Sonnet 4.6
import { ChatAnthropic } from '@langchain/anthropic'
const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY! })

// GPT-4o
import { ChatOpenAI } from '@langchain/openai'
const model = new ChatOpenAI({ model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! })

// DeepSeek V3 (OpenAI-compatible endpoint)
import { ChatOpenAI } from '@langchain/openai'
const model = new ChatOpenAI({
  model: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY!,
  configuration: { baseURL: 'https://api.deepseek.com' },
})
```

Also run the matching install command and add the API key to `.env.local`.
