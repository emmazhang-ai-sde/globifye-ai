# Step 6 — Phase 2: LLM Analysis Prompt

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

Build a single structured prompt containing:

- **Step 0 (Second-pass correction):** Fix homophones, jargon, company names using full context. Corrected text feeds all subsequent steps.
- **Step 1:** Summary
- **Step 2:** Key topics (name + start_time)
- **Step 3:** Objection analysis (timestamp, exact_quote from corrected text, reason, suggestion)
- **Step 4:** What went well (timestamp, exact_quote from corrected text, reason)

Expected LLM JSON output shape (from `sales-call-system-pipeline-0520-v1.1.md`):

```json
{
  "summary": "...",
  "key_topics": [
    { "name": "...", "start_time": 0.0 }
  ],
  "analysis": {
    "objections": [
      {
        "timestamp": 142.5,
        "speaker": "Customer",
        "exact_quote": "...",
        "reason": "...",
        "suggestion": "..."
      }
    ],
    "what_went_well": [
      {
        "timestamp": 60.0,
        "speaker": "Sales Rep",
        "exact_quote": "...",
        "reason": "..."
      }
    ]
  }
}
```
