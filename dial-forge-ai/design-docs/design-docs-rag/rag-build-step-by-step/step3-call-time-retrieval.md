# RAG Build, Step 3 - Call-Time Retrieval

**Parent doc:** [`../rag-per-company-kb-design-doc.md`](../rag-per-company-kb-design-doc.md) (sections 6 and 6.1)
**Builds on:** [Step 2 - the ingest job](./step2-ingest-job.md) (the vectors this step reads) and the read-side prototype [`../../rag/retrieve.py`](../../rag/retrieve.py)
**Touches:** [`sip/scripts/step2_stt_bridge.py`](../../sip/scripts/step2_stt_bridge.py) - the live call loop
**Goal:** make a live phone call actually use the KB vectors we built. During the call, the agent pulls only the KB pieces relevant to what the caller just asked, instead of carrying the entire KB for the whole conversation.
**Non-goals:** not the ingest ([Step 2](./step2-ingest-job.md), done), not the eval ([Step 4](./step4-retrieval-eval.md)), not the GitHub Action ([Step 5](./step5-ingest-github-action.md)).

> **Sequencing - this is the one RAG step on the live call path.** It adds a little latency to each turn, so it ships with (or after) the TTS-streaming work, and it goes last. Build Step 4 and Step 5 first (both are off the call path), then Step 3, using the relevance threshold that Step 4's eval produces.

## 1. Why this step

The vectors are sitting in the database (Step 2), but the phone agent still does not touch them. Today, when a call starts, the agent is handed the **entire** knowledge base up front and carries that same block for the whole conversation.

That works while the KB is small, but it has two problems: the agent's context is mostly filled with things the caller never asked about, and it does not scale once a catalog grows to thousands of lines. Step 3 flips it around. Instead of one fixed KB block for the whole call, the agent's context is refreshed each time the caller speaks: the part that tells the agent *how to run the sale* (the playbook) stays constant, and the part that holds *facts* (products, prices, specs) is swapped for just the pieces relevant to the current question.

```
   Caller says something
        |
        v
   Is it a real question?  ---- no ----> answer from the always-present context (no search)
        | yes
        v
   If it is a follow-up, rewrite it into a standalone question
        |
        v
   Search the KB for the few relevant pieces
        |
        v
   Refresh the agent's context  =  fixed playbook  +  those pieces
        |
        v
   Agent answers
```

## 2. The technical decisions, and why

### A. Do the search inside the database, not in the app

Our test script pulls every vector back into Python and ranks them there. That is fine for a one-off test over ~50 chunks, but on a live call it re-downloads a company's whole set of vectors every single turn and ignores the database's built-in search index. The right shape on the call path is to let the database do the search and hand back only the few matches: far less data moved, and it stays fast as the catalog grows. (The prototype stays useful for eval and debugging; the live call uses the database-side search.)

### B. Do not search on every utterance - search only when it is worth it

The search adds latency to a turn, and most of what a caller says is not a question (hellos, "okay", "let me think"). So the default is *not* to search. The always-present playbook, plus a small block of the most common answers, handles the routine case; a live search runs only for a genuine question the routine block does not already cover. (This is the "when to retrieve" strategy in design doc section 6.1.)

### C. Refresh the context each turn, keep the playbook fixed

The playbook has to be present on every turn to drive the conversation, so it can never be dropped. The facts, by contrast, should track the current question. So the design keeps the playbook constant and swaps only the facts portion per turn. In practice this is a small change, because the agent's context is already rebuilt cleanly on each turn - we are only changing what goes into the facts slot.

### D. Decide what happens when there is no good match or the search fails

This is the first RAG piece running on a live call, so it can never leave the caller hanging. Three cases, each with a defined fallback:

| Situation | What the agent does |
|---|---|
| Nothing in the KB is relevant enough | Fall back to the existing "I don't have those details, may I take your name and number?" line |
| The embedding service is slow or down | Hand the agent the whole KB for that one turn (it is local and small), so grounding is not lost |
| A company has no data ingested yet | The existing no-KB behavior (greet, qualify, capture contact) |

"How relevant is relevant enough" is a threshold we do not guess: it comes from [Step 4](./step4-retrieval-eval.md)'s eval. (First real data point: a correct match was only moderately close, so the threshold has to be set from real examples, not by intuition.)

## 3. Latency, in one line

Each *searched* turn adds a bit of delay - rewriting a follow-up, embedding the question, and the lookup - on the order of a few tenths of a second. That is the whole reason this step is gated (Decision B) and ships alongside the TTS-streaming work rather than ahead of it. The full budget breakdown is in design doc section 7.

## 4. What to change, and where

High-level; the exact query, request shape, and thresholds are pinned when we build (see the appendix).

| Where | What to do | New / change |
|---|---|---|
| The Supabase database (SQL) | Add a search function so the vector lookup runs inside the database, on its index, in one round-trip | **New** |
| The live call loop (`step2_stt_bridge.py`) | Refresh the agent's context each turn - keep the playbook, put the relevant pieces in the facts slot - instead of loading the whole KB once at call start | Change |
| The live call loop (same file) | Gate the search: skip it on non-questions, answer routine ones from the always-present block, search only for genuine uncovered questions | Change |
| Follow-up handling (same file, or a small helper) | Turn a follow-up ("how much is that?") into a standalone question before searching | **New** |
| Failure handling (same file) | Wire the three fallbacks from Decision D so a call never breaks | **New** |

## Deliverable for this step

A live call where a product question is answered from the relevant KB pieces (not the whole KB), an out-of-KB question triggers the fallback line, and the added delay fits the budget once TTS streaming is in place.

### How to verify (do not skip)

Place a call and check from the call itself plus the logs: an in-KB product question is answered from the matched pieces; an out-of-KB question triggers the fallback line; the delay from end-of-sentence to the first spoken word stays within budget.

## Failures log (fill in during build)

| Symptom | Cause | Fix |
|---|---|---|
| _(none yet)_ | | |

## Appendix - build-time specifics (skip on a first read)

The concrete bits, kept out of the explanation above so the main read stays clean. Confirm or adjust these when we actually build the step.

**The database search function** - one indexed round-trip, called over the same Supabase REST path the rest of the SIP demo uses:

```sql
create or replace function match_kb_chunks(
  p_company_key text, p_query_embedding vector(1536), p_match_count int default 3
)
returns table (section text, content text, distance float)
language sql stable as $$
  select section, content, embedding <=> p_query_embedding as distance
  from sip_kb_chunks
  where company_key = p_company_key and kind = 'detail'
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;
grant execute on function match_kb_chunks(text, vector, int) to service_role;
```

- **Relevance threshold:** taken from Step 4's eval, not hardcoded now.
- **Follow-up detection + rewrite:** a short rule first (very short utterance, or opens with "and / what about / how much / that"), then a fast model does the rewrite; the no-model "prepend the previous turn" method is the latency fallback.

## Next

This closes the RAG loop on the call path. Beyond RAG: RLS hardening (design doc section 4) and the future UI-upload ingest path (design doc section 9).
