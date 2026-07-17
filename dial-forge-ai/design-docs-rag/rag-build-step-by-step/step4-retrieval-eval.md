# RAG Build, Step 4 - Retrieval Eval

**Parent doc:** [`../rag-per-company-kb-design-doc.md`](../rag-per-company-kb-design-doc.md) (section 9: retrieval eval, no-match floor)
**Builds on:** [Step 2 - the ingest job](./step2-ingest-job.md) (the live vectors) and [`../../rag/retrieve.py`](../../rag/retrieve.py) (the read path this reuses)
**Goal:** a repeatable test that answers two questions with numbers instead of anecdotes: *does the search return the right sections?* and *where is the line between "a real match" and "nothing relevant"?* Entirely off the call path.
**Non-goals:** not changing how retrieval works - only measuring it. Not wiring retrieval into the call ([Step 3](./step3-call-time-retrieval.md)).

> **Sequencing:** do this **before** Step 3. It measures quality on the live vectors and produces the relevance threshold Step 3 needs. It is also the natural check to run inside the [Step 5](./step5-ingest-github-action.md) Action later.

## 1. Why this step

Right now we have exactly one data point: one test question found the right document. That is an anecdote, not evidence - and it already carries a warning sign, because even that *correct* match scored only moderately close. Before retrieval goes anywhere near a live call, two things need to be measured, not guessed:

1. **Hit rate.** Across a realistic spread of caller questions - including spoken paraphrases, which are the whole reason we use meaning-based search - how often does the right section actually show up in the results?
2. **The no-match line.** Step 3 must recognize "the KB does not cover this" and fall back gracefully. That requires a threshold, and a threshold picked by intuition fails in one of two ways: too strict and it rejects good answers; too loose and weak matches slip through and invite made-up answers.

The KB is also finally big enough for this test to mean something: with the catalog-sized corpus, retrieval genuinely narrows - and can genuinely miss.

## 2. The technical decisions, and why

### A. The score: "is the right section in the top 3?"

Retrieval hands the agent its 3 best matches, so the natural pass/fail per test question is whether the expected section is among those 3. The overall score is the share of questions that pass (the standard name for this is *recall@3*). One number, directly tied to what the agent actually sees.

### B. The test set: real-sounding questions, including ones the KB cannot answer

A small file of hand-written test cases per company, each pairing *a question a caller would plausibly ask* with *the section that should answer it*. Two kinds matter, and the second is not optional:

- **Paraphrases** - the caller says "what cuts do you carry", the KB says "chuck, brisket, loin". No shared words; this is exactly what meaning-based search is supposed to handle, so it is what we test.
- **Out-of-KB questions** - things the KB genuinely does not cover, where the *correct* result is "no match". These exist to draw the no-match line.

Roughly 10-15 per company: enough to be meaningful, small enough that someone actually maintains it. A teammate who knows the KB should sanity-check the expected answers.

### C. The threshold comes from the gap between "answerable" and "not answerable"

Run both kinds of questions and look at the scores. Real questions should land noticeably closer than out-of-KB ones; the threshold goes in the gap between the two groups. If there *is* no clean gap - real and out-of-KB scores overlap - that is not a tuning problem, it is a finding: the corpus or the chunking needs work before any threshold can be trusted.

### D. One retrieval implementation, reused - and later run in CI

The eval calls the same search code the smoke test uses, so there is exactly one implementation being measured. Once [Step 5](./step5-ingest-github-action.md)'s Action exists, the eval runs after every ingest and fails the build if the hit rate drops - so a KB edit that quietly breaks retrieval is caught in CI, not on a live call.

## 3. What to build, and where

| Where | What | New / change |
|---|---|---|
| `rag/eval-set.yaml` (new file) | The test set: per-company questions + expected section, including out-of-KB cases | **New** |
| `rag/eval.py` (new file) | Runs every question through the real retrieval, reports the hit rate per company and the score distribution split by answerable vs out-of-KB | **New** |
| This doc | Record the baseline hit rate and the chosen threshold in the results table below | fill in |
| [Step 3](./step3-call-time-retrieval.md) | Consumes the chosen threshold as its no-match floor | later |
| [Step 5](./step5-ingest-github-action.md) | Runs the eval after each ingest; a hit-rate regression fails the build | later |

## Deliverable for this step

The eval script + test set exist; a baseline hit rate per company and a chosen no-match threshold are recorded below.

## Results log (fill in on first run)

| Company | hit rate (top-3) | worst real-match score | best out-of-KB score | chosen threshold |
|---|---|---|---|---|
| pacificbeef | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| globifye | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

## Appendix - build-time specifics (skip on a first read)

- Run: `venv/bin/python3 -u rag/eval.py` from `globifye-ai/`.
- Scores are cosine distances (smaller = closer), the same measure the live lookup uses; known reference point from Step 2's checkpoint: one correct match sat at ~0.60 distance, so expect the threshold above that.
- The eval imports the embed + ranking from `rag/retrieve.py` rather than duplicating them.

## Next

[Step 5](./step5-ingest-github-action.md) automates ingest (and this eval) in CI. [Step 3](./step3-call-time-retrieval.md) consumes the threshold this step produces.
