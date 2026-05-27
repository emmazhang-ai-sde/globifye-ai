# Step 3 — LLM Selection

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

**Framework decision: ✅ LangChain.js** (see `ai-framework-selection.md` for full analysis)

`LangChain.js` is the chosen integration layer. It wraps the LLM provider — switching from Anthropic to OpenAI is a single line change in `lib/llm.ts`, with no impact on the prompt, Zod schema, or DB write logic.

**LLM provider: ⏳ Pending (Amy is running evaluations)**

Compare `MiniMax` vs `OpenAI GPT-4o` vs `Anthropic Claude Sonnet` for the analytics task:
- Must produce output that satisfies the Zod schema (LangChain enforces this via `withStructuredOutput`)
- Must handle ~2,000–5,000 token transcripts reliably
- Evaluate: output quality, latency, cost per call

**Recommended for MVP:** Anthropic Claude Sonnet or OpenAI GPT-4o — both are fully supported by LangChain.js. The code in Step 7 uses `@langchain/anthropic` as a placeholder; swap to `@langchain/openai` once Amy's evaluation concludes.

> ⚠️ Do not finalize Step 7 code until the provider is decided — the install command and import differ between the two.
