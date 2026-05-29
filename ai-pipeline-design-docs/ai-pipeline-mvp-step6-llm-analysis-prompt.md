# Step 6 — Phase 2: LLM Analysis Prompt

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step designs the two pieces that drive the LLM call in Step 7: the `SYSTEM_PROMPT` constant and the `buildTranscriptText()` helper. No files are edited yet — the goal is to finalize the exact text before Step 7 wires it into `lib/llm.ts`.

---

## What you will do in this step

**6.2** — Understand how LangChain structured output changes what goes in the prompt  
**6.3** — Decide on the transcript format the LLM will receive  
**6.4** — Write the `SYSTEM_PROMPT`  
**6.5** — Write `buildTranscriptText()`  
**6.6** — Test the prompt manually (recommended before Step 7)  
**6.7** — Why Step 0 (second-pass correction) is deferred to post-MVP

---

#### 6.2 How LangChain structured output changes the prompt

In a plain LLM call, you would include a JSON template in the system prompt — something like:

```
Return your output in this exact JSON format:
{
  "summary": "...",
  "key_topics": [{ "name": "...", "start_time": 0.0 }],
  ...
}
```

With LangChain's `.withStructuredOutput(AnalysisSchema)`, **you no longer write that template.** LangChain converts the Zod schema into a function/tool-use spec that it sends to the LLM behind the scenes. The LLM is constrained to return data matching that schema — no JSON template in the prompt, no `JSON.parse()`, no `?? null` fallbacks needed.

This means the `SYSTEM_PROMPT` only needs to:
1. Tell the LLM its role
2. State the rules for filling in fields (what counts as a valid timestamp, quote, etc.)

It does **not** need to describe the JSON shape — the Zod schema handles that.

---

#### 6.3 Transcript format

The transcript rows fetched from Supabase look like this (written in Step 5):

```
speaker:            "Speaker 0"
content_raw:        "Yeah um I think the price is a bit high"
sentence_start_sec: 45.2
```

The LLM needs all three fields. The format `buildTranscriptText()` produces is:

```
[45.2s] Speaker 0: Yeah um I think the price is a bit high
```

**Why this format:**

| Choice | Reason |
|---|---|
| `[45.2s]` brackets | Makes the timestamp visually distinct from the speaker label; the LLM reliably parses it back |
| `.toFixed(1)` | Keeps the number compact — one decimal place, not raw float precision (`45.19999...`) |
| `Speaker 0:` as-is | Matches exactly what is stored in the DB, so the LLM can echo it back in the `speaker` field without guessing a format |
| One line per utterance | Keeps token count manageable; the LLM can scan by line |

Note: `content_raw` is used here, not `content_clean`. The LLM receives filler words because they signal hesitation — useful for objection detection (see pipeline spec).

---

#### 6.4 The `SYSTEM_PROMPT`

**Create `SYSTEM_PROMPT` in `lib/llm.ts`**

**What changed from the original and why:**

| Change | Reason |
|---|---|
| "sales coach" + "actionable feedback" instead of "sales call analyst" | Frames the purpose as coaching the rep — shapes suggestions to be growth-oriented rather than flat observations |
| Transcript format explained (`[seconds] Speaker_Label: utterance`) | The LLM receives `[45.2s] Speaker 0: ...` but the original prompt never explained the format — smaller models like Llama may not infer it reliably |
| Speaker disambiguation instruction | "Speaker 0" / "Speaker 1" give the LLM no signal about roles — it needs to infer which is the rep and which is the customer |
| Timestamp rule: "exact number from the [Xs] label" | "Corresponds to real lines" allowed interpolation; this version is unambiguous |
| exact_quote: "copy character-for-character including filler words" | "Verbatim" sounds like it permits slight paraphrasing — character-for-character leaves no room for interpretation |
| Objections explicitly defined | Without a definition, models vary on what they flag — listing budget, timeline, trust, approval blockers, competitor gives a concrete checklist (GPT-4o missed an objection in Amy's test) |
| what_went_well: "do not flag generic politeness" | Without this, LLMs flag moments like "said hello professionally" — this rule focuses it on meaningful sales behaviors |
| Suggestion: "do not write generic advice" with examples | Claude's suggestions were specific; GPT-4o's were generic ("provide references") — the negative example teaches by contrast |
| "do not invent entries" added to empty array rule | Strengthens the original rule — some models pad with low-confidence entries rather than returning `[]` |

**What is intentionally not in the prompt:**

- **No JSON template** — LangChain's Zod schema provides this automatically via `.withStructuredOutput()`
- **No field-by-field instructions** — the `.describe()` hints in `AnalysisSchema` (Step 7) guide the LLM per field
- **No count constraints** (e.g. "return 2–4 things") — left open so the LLM returns as many entries as genuinely exist in the call, not a padded or truncated list
- **No elaborate roleplay** (e.g. "you are a 10-year veteran sales trainer...") — consistent structured output benefits more from clear rules than from persona framing

---

#### 6.5 The `buildTranscriptText()` helper

This function converts DB rows into the transcript string the LLM receives. It will be added to `lib/llm.ts` in Step 7. The full implementation:

```typescript
type TranscriptRow = {
  speaker: string
  sentence_start_sec: number
  content_raw: string
}

function buildTranscriptText(rows: TranscriptRow[]): string {
  return rows
    .map(r => `[${Number(r.sentence_start_sec).toFixed(1)}s] ${r.speaker}: ${r.content_raw}`)
    .join('\n')
}
```

> `Number(r.sentence_start_sec)` is there because Supabase can return numeric columns as strings depending on the client version. Wrapping with `Number()` before calling `.toFixed(1)` prevents a "toFixed is not a function" runtime error.

**Example input and output:**

Input (3 DB rows):
```
{ speaker: "Speaker 0", sentence_start_sec: 1.0,  content_raw: "Hi, thanks for calling GlobiFYE." }
{ speaker: "Speaker 1", sentence_start_sec: 5.2,  content_raw: "Yeah, um, I had a question about pricing." }
{ speaker: "Speaker 0", sentence_start_sec: 9.8,  content_raw: "Of course, happy to help." }
```

Output string (what the LLM receives):
```
[1.0s] Speaker 0: Hi, thanks for calling GlobiFYE.
[5.2s] Speaker 1: Yeah, um, I had a question about pricing.
[9.8s] Speaker 0: Of course, happy to help.
```

---

#### 6.6 Test the prompt manually

Before wiring the prompt into LangChain in Step 7, verify it produces sensible output by sending it directly to any LLM interface (Claude.ai, ChatGPT, etc.).

**Step 1 — Use Amy's test transcript**

Amy's transcripts in `amy/llm-testing/` are already in a ready-to-paste format and have verified LLM output. Use `LLM-prompt2.txt` as the sample input — it includes a complete sales conversation with natural objections.

Alternatively, format rows from `sample-transcripts/sample-audio-1.json` manually using the `[Xs] Speaker N: ...` format from section 6.3 above.

**Step 2 — Compose the test message**

Paste this into the LLM interface, substituting the transcript below `[User]`:

```
[System]:
You are a sales call analyst. Analyze the provided timestamped sales call transcript.

Rules:
- All timestamps must correspond to real lines in the transcript.
- exact_quote must be verbatim text from the transcript.
- If there are no objections or nothing notable, return an empty array [].

[User]:
Analyze the following sales call transcript:

[1.0s] Speaker 0: Hi, thanks for calling GlobiFYE. How can I help you today?
[5.2s] Speaker 1: Yeah, um, I was looking at your pricing page and had some questions.
... (paste all rows)
```

**Step 3 — Check the output**

The LLM should return JSON matching the expected shape. Verify each field:

| Field | What to check |
|---|---|
| `summary` | 2–3 sentences, coherent overview of the call |
| `key_topics[].start_time` | Each value matches a `[Xs]` timestamp from the transcript exactly |
| `objections[].exact_quote` | Text appears verbatim (word-for-word) in the transcript |
| `objections[].suggestion` | Concrete and actionable, not generic ("try harder") |
| `what_went_well[].exact_quote` | Text appears verbatim in the transcript |

If the LLM invents timestamps or paraphrases quotes, add a stricter rule to `SYSTEM_PROMPT` before moving to Step 7. For example:

```
- Each timestamp must be copied exactly from a [Xs] label in the input.
- Do not paraphrase or summarize exact_quote — copy the text character-for-character.
```

---

#### 6.7 Why Step 0 (second-pass correction) is deferred

The original pipeline design included a "Step 0" in the prompt:

> **Step 0 (Second-pass correction):** Fix homophones, jargon, and company names using the full transcript context before running analysis. Corrected text feeds all subsequent steps.

This is dropped for the MVP for a practical reason: LangChain's `.withStructuredOutput()` enforces a strict output schema. Adding an intermediate correction step would require either a separate LLM call (extra cost and latency) or a multi-step chain (beyond MVP scope).

The MVP accepts that `content_raw` may contain minor STT transcription errors. For the post-MVP, the correction pass can be re-introduced as a lightweight pre-processing call that runs before the main analysis call — or by having the LLM write corrected text back to `content_clean` after the analysis.

---

> ✅ When you have the exact text of `SYSTEM_PROMPT` and understand what `buildTranscriptText()` produces, **Step 6 is complete.**

→ Next: [Step 7 — LLM Call & DB Write](ai-pipeline-mvp-step7-llm-call-db-write.md)
