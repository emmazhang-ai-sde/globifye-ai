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

The playbook has to be present on every turn to drive the conversation, so it can never be dropped. The facts, by contrast, should track the current question. So the design keeps the playbook constant and swaps only the facts portion per turn. In practice this is a small change, because the agent's context is already rebuilt cleanly on each turn - we are only changing what goes into the facts slot. (Since 2026-07-21 that fixed playbook is a real per-company artifact: each company's `sales-playbook.md`, ingested in Step 2 as `core` chunks, fetched whole at call start by `kind='core'` — see Step 2, Decision 1.)

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

High-level; the exact query, request shape, and thresholds are pinned in section 5 and the appendix.

| Where | What to do | New / change |
|---|---|---|
| The Supabase database (SQL) | Add a search function so the vector lookup runs inside the database, on its index, in one round-trip | **New** |
| A new retrieval helper (`sip/scripts/rag_retrieval.py`) | Embed the question, run the database search, keep only matches within the floor, fetch the playbook, and build the follow-up query - one place, off the eval prototype's pattern | **New** |
| The live call loop (`step2_stt_bridge.py`) | Refresh the agent's context each turn - keep the playbook, put the relevant pieces in the facts slot - instead of loading the whole KB once at call start | Change |
| The live call loop (same file) | Gate the search: skip it on non-questions; and gate the whole feature behind an off-by-default switch until it ships with TTS streaming | Change |
| The live call loop (same file) | Wire the three fallbacks from Decision D so a call never breaks | Change |

## 5. Build spec (2026-07-21): specified here, wired in with the TTS-streaming work

The runnable build is in the appendix (the new helper's full source, the bridge diff, the SQL). Four decisions shaped it; each is here for the reader, with the code left below.

**It lands behind an off-by-default switch.** The change touches the live call loop, and the loop is already over its latency budget (Decision B, and design doc section 7), so turning retrieval on before the TTS-streaming work would regress the demo. The build therefore ships as code that stays inert until a single environment switch is set: with the switch off, the call path is byte-for-byte what it is today (the whole KB injected once at call start); with it on, the per-turn retrieval described above runs. This lets the code land and be reviewed now, and be turned on the day TTS streaming makes room for it, with no second editing pass on the call-path file under time pressure.

**The playbook now comes from the database, not the code.** As of Step 2's revised Decision 1, each company's playbook lives in the corpus as its own document and is ingested as the always-present `core`. So the fixed part of the prompt is fetched once at call start from the database (nine rows today: five for Pacific Beef, four for GlobiFYE), not read from a constant in the script. If that fetch fails, the call degrades to injecting the whole single-file KB, so it is never left without a playbook.

**Follow-ups are handled without a model, for now.** Turning "how much is that?" into a searchable question needs the previous turn's topic. The MVP does this the cheap way: when an utterance looks like a follow-up (very short, or opening with a word that points back), it is prefixed with the previous caller turn before embedding - no extra model call, no added latency. A model-based rewrite is a later upgrade, measured against the latency budget before it ships (appendix, and design doc section 6).

**The relevance floors are pinned from Step 4's eval, per company.** Step 4 found no single clean cutoff, so the floor is a coarse per-company value (in the appendix) with the agent's grounded-answer instruction adjudicating the ambiguous band. A match closer than the floor is used; nothing closer means the fallback line.

> **Status:** specified in this doc; not yet applied to the code tree. When applied, the switch is off, so live calls stay on today's whole-KB injection until it ships with the TTS-streaming work.

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

Apply the function above in the Supabase SQL editor (idempotent, safe to re-run) **before** turning the switch on; with it missing, retrieval fails and each turn falls back to whole-KB injection.

- **Relevance floors (cosine distance), from Step 4's eval:** Pacific Beef `~0.625`, GlobiFYE `~0.677`; a chunk counts only if its distance is at or below its company's floor. Clearly off-topic questions sit at `~0.73`+ for both. The band just under the floor is left to the agent's grounded-answer instruction, not the gate alone. (`match_kb_chunks` returns cosine *distance* = 1 - similarity; lower is closer.)
- **Follow-up handling (MVP, no model):** an utterance is treated as a follow-up if it is very short (<= 4 words) or opens with a back-pointing word (`and` / `what about` / `how much` / `that` / `it` / `those` ...); it is then prefixed with the previous caller turn before embedding. The model-based rewrite is a later upgrade, kept out of the MVP for latency.
- **The feature switch:** the whole path is off unless the environment variable `USE_RAG=1` is set. Off = today's whole-KB injection, unchanged; on = per-turn retrieval. The keys the bridge already loads (OpenAI + Supabase, from `ai-pipeline/.env.local`) are reused through the ingest job's helpers; no new secrets.

**New file - `sip/scripts/rag_retrieval.py`** (full source):

```python
#!/usr/bin/env python3
"""RAG Step 3 -- call-time retrieval for the live SIP bridge.

Each turn, the bridge (step2_stt_bridge.py) uses this to refresh the agent's
"facts" slot: embed the caller's question, ask Postgres for the few nearest
`detail` chunks (via the match_kb_chunks RPC, on the HNSW index), and keep the
ones close enough to trust. The always-present playbook (`core`) is fetched once
per call by fetch_core().

Reuses rag/ingest.py for embed() + the Supabase auth helpers, so there is one
embedding + auth implementation. Unlike rag/retrieve.py (the eval/debug prototype
that pulls every vector back and ranks in Python), this pushes the top-k into the
database -- the right shape on the call path.

Follow-up handling is the MVP zero-model method: if an utterance looks like a
follow-up, prepend the previous caller turn to give it an antecedent. A model
rewrite is a later upgrade (design doc section 6; step3 doc appendix).
"""
import sys
from pathlib import Path

import requests

# one embedding + auth implementation: reuse the ingest job's helpers
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "rag"))
import ingest  # noqa: E402

# Cosine-DISTANCE floors from RAG Step 4's eval. A match counts only if its
# distance is <= its company's floor; clearly off-topic questions sit >= ~0.73
# for both. The band just under the floor is adjudicated by the agent's
# grounded-answer instruction, not by this gate alone.
NO_MATCH_FLOOR = {"pacificbeef": 0.625, "globifye": 0.677}
DEFAULT_FLOOR = 0.65

# Zero-model follow-up detection: a very short utterance, or one opening with a
# word that points back at the previous turn.
_FOLLOWUP_OPENERS = (
    "and ", "what about", "how about", "how much", "how many",
    "what's that", "that one", "that ", "those ", "it ", "is it",
)


def should_retrieve(text: str) -> bool:
    """Skip the search on non-questions (greetings, acks) -- Decision B. Cheap
    gate: anything shorter than two words is not a real question."""
    return len(text.strip().split()) >= 2


def is_followup(text: str) -> bool:
    t = text.strip().lower()
    return len(t.split()) <= 4 or t.startswith(_FOLLOWUP_OPENERS)


def build_query(text: str, prev_user: str) -> str:
    """MVP zero-model rewrite: for a follow-up, prepend the previous caller turn
    so the embedding carries the topic ('how much is that' -> '<prev> how much is
    that'). A self-contained question is used as-is."""
    if prev_user and is_followup(text):
        return f"{prev_user.strip()} {text.strip()}"
    return text.strip()


def fetch_core(company_key: str) -> str:
    """The always-injected playbook: every kind='core' chunk for a company, in
    document order. Fetched once per call by the bridge (core changes only on
    ingest). '' if the company has no core rows."""
    r = requests.get(
        f"{ingest._sb_base()}/sip_kb_chunks",
        headers=ingest._sb_headers(),
        params={
            "company_key": f"eq.{company_key}",
            "kind": "eq.core",
            "select": "section,content,chunk_index",
            "order": "chunk_index",
        },
        timeout=10,
    )
    r.raise_for_status()
    return "\n\n".join(row["content"] for row in r.json())


def match_detail(company_key: str, query: str, k: int = 3) -> list:
    """Top-k nearest `detail` chunks within the company's no-match floor. Runs the
    search inside Postgres via the match_kb_chunks RPC (HNSW index); returns
    [{section, content, distance}]. Raises on an embed/DB error so the caller can
    apply its own whole-KB fallback."""
    if not ingest.OPENAI_KEY:
        raise RuntimeError("OPENAI_API_KEY missing -- cannot embed the query")
    qvec = ingest.embed([query])[0]
    r = requests.post(
        f"{ingest._sb_base()}/rpc/match_kb_chunks",
        headers=ingest._sb_headers(),
        json={
            "p_company_key": company_key,
            "p_query_embedding": ingest.vec_to_pg(qvec),
            "p_match_count": k,
        },
        timeout=10,
    )
    r.raise_for_status()
    floor = NO_MATCH_FLOOR.get(company_key, DEFAULT_FLOOR)
    return [row for row in r.json() if row.get("distance", 1.0) <= floor]


def render(chunks: list) -> str:
    """The retrieved detail chunks as one block for the system prompt (each chunk
    already carries its 'doc > section' header from ingest)."""
    return "\n\n".join(c["content"] for c in chunks)
```

**Bridge changes - `sip/scripts/step2_stt_bridge.py`**, six hunks, every one guarded by `USE_RAG` so the off path is untouched:

*(1) The switch + conditional import, right after `_KB_DIR` is defined:*

```diff
 _KB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "knowledge-base")
+
+# --- RAG Step 3 (call-time retrieval), gated behind USE_RAG so the live path is
+# byte-for-byte unchanged until it ships with the TTS-streaming work. Off =
+# today's whole-KB injection; on = per-turn retrieval. See rag_retrieval.py. ---
+USE_RAG = os.environ.get("USE_RAG") == "1"
+if USE_RAG:
+    import sys
+    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
+    import rag_retrieval
```

*(2) A RAG prompt builder, added next to the existing one (the playbook stays fixed, only the facts slot changes):*

```diff
+def _build_rag_system_prompt(display_name, core_text, detail_text):
+    """RAG Step 3 prompt: the playbook (core) is always present; the knowledge-
+    base slot holds only what was retrieved for the current question, refreshed
+    each turn. Empty detail => the playbook's own rule drives the FALLBACK_LINE."""
+    facts = detail_text.strip() or "(no matching entries for the current question)"
+    return {
+        "role": "system",
+        "content": (
+            f"You are an AI sales representative for {display_name}, speaking with a prospect on a sales call. "
+            f"{AGENT_RULES} {SALES_PROCESS} "
+            f"Answer only from the knowledge base below -- never invent prices, product details, or terms. "
+            f"If the relevant details are not in the knowledge base, reply exactly: "
+            f"\"{FALLBACK_LINE}\" and then collect their name and phone number.\n\n"
+            f"--- {display_name} SALES PLAYBOOK ---\n{core_text}\n\n"
+            f"--- {display_name} KNOWLEDGE BASE (relevant to the current question) ---\n{facts}"
+        ),
+    }
+
+
 def _build_fallback_prompt(display_name):
```

*(3) Company loader: keep the raw KB for the fallback, and (when on) fetch the playbook core once:*

```diff
-    for c in companies.values():
+    for key, c in companies.items():
         kb_text = ""
         kb_file = c.get("kb_file")
         if kb_file:
             try:
                 with open(os.path.join(_KB_DIR, kb_file)) as kb:
                     kb_text = kb.read().strip()
             except FileNotFoundError:
                 pass
         if kb_text:
             c["system_prompt"] = _build_system_prompt(c["display_name"], kb_text)
             c["kb_available"] = True
         else:
             c["system_prompt"] = _build_fallback_prompt(c["display_name"])
             c["kb_available"] = False
+
+        # RAG Step 3: keep the raw KB for the retrieval-failure fallback; and when
+        # enabled + available, fetch the playbook core once and swap in the RAG
+        # prompt. With USE_RAG off, nothing below runs and behavior is unchanged.
+        c["kb_text"] = kb_text
+        c["core_text"] = ""
+        if USE_RAG and c["kb_available"]:
+            try:
+                c["core_text"] = rag_retrieval.fetch_core(key)
+            except Exception as e:
+                print(f"WARNING: RAG core fetch failed for {key} "
+                      f"({type(e).__name__}); using whole-KB injection for it")
+            core = c["core_text"] or kb_text        # DB down => degrade to full KB as core
+            c["system_prompt"] = _build_rag_system_prompt(c["display_name"], core, "")
     return companies
```

*(4) The active company's core + raw-KB fallback, set per call. Module-level defaults next to `current_voice`:*

```diff
 current_company = DEFAULT_COMPANY
 current_voice = COMPANIES[DEFAULT_COMPANY]["voice"]
+# RAG Step 3: the active company's playbook (core) and raw KB (retrieval-failure
+# fallback), set per call at StasisStart alongside current_company/current_voice.
+current_core_text = COMPANIES[DEFAULT_COMPANY].get("core_text") or COMPANIES[DEFAULT_COMPANY].get("kb_text", "")
+current_full_kb = COMPANIES[DEFAULT_COMPANY].get("kb_text", "")
```

*(5) The LLM worker: refresh only the facts slot each turn (gated, and skipped for no-KB companies + non-questions):*

```diff
     while True:
         transcript = transcript_queue.get()
+
+        # --- RAG Step 3: refresh only the retrieved-detail slot for this turn.
+        # Off unless USE_RAG; skipped for no-KB companies and non-questions.
+        if USE_RAG and COMPANIES[current_company].get("kb_available") \
+                and rag_retrieval.should_retrieve(transcript):
+            prev_user = next(
+                (m["content"] for m in reversed(conversation_history) if m["role"] == "user"),
+                "",
+            )
+            query = rag_retrieval.build_query(transcript, prev_user)
+            try:
+                chunks = rag_retrieval.match_detail(current_company, query, k=3)
+                detail_text = rag_retrieval.render(chunks)   # '' => core-only => FALLBACK_LINE
+            except Exception as e:
+                log("RAG", f"retrieval failed ({type(e).__name__}); injecting whole KB this turn")
+                detail_text = current_full_kb
+            conversation_history[0] = _build_rag_system_prompt(
+                COMPANIES[current_company]["display_name"], current_core_text, detail_text
+            )

         conversation_history.append({
             "role": "user",
             "content": transcript
         })
```

*(6) Event loop: declare the two new globals, and set them on each StasisStart:*

```diff
     global current_channel_id, current_company, current_voice, conversation_history
     global current_bridge_id, current_ext_channel_id
+    global current_core_text, current_full_kb
```

```diff
                 company = COMPANIES[company_key]
                 current_company = company_key
                 current_voice = company["voice"]
                 conversation_history = [company["system_prompt"]]
+                # RAG Step 3: playbook + raw-KB fallback for the active company.
+                current_core_text = company.get("core_text") or company.get("kb_text", "")
+                current_full_kb = company.get("kb_text", "")
```

**To turn it on (when TTS streaming is in):** apply the RPC, confirm the core rows are present (`kind='core'`, nine today), then start the bridge with `USE_RAG=1`. Place a call: an in-KB question is answered from the matched pieces, an out-of-KB question hits the fallback line. To turn it off, unset the variable; nothing else changes.

## Next

This closes the RAG loop on the call path. Beyond RAG: RLS hardening (design doc section 4) and the future UI-upload ingest path (design doc section 9).
