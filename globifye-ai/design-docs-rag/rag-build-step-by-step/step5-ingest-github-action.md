# RAG Build, Step 5 - Ingest as a GitHub Action

**Parent doc:** [`../rag-per-company-kb-design-doc.md`](../rag-per-company-kb-design-doc.md) (section 5, building the vector DB)
**Builds on:** [Step 2 - the ingest job](./step2-ingest-job.md) ([`rag/ingest.py`](../../rag/ingest.py)); pairs with [Step 4](./step4-retrieval-eval.md)'s eval
**Status: code + workflow written and verified locally, 2026-07-16.** Pending, in order: the host-repo decision, committing the code + corpus, adding secrets, the first run (see Prerequisites).
**Goal:** stop running the ingest by hand. It runs automatically - daily on a schedule, immediately when a KB file is pushed, and on demand - so the vector DB stays fresh without anyone remembering to refresh it.
**Non-goals:** not changing what the ingest does - only automating when it runs.

## 1. Why this step

Today the vectors are only as fresh as the last time someone remembered to run the script. That is fine for a week; it is not a system. The KB files already live in this repo, which makes GitHub's own automation the natural place to run the job: CI already has the files on every run, so there is nothing to upload and no new machine to maintain.

Three triggers, each covering a different need:

- **Daily schedule** - the safety net; guarantees the DB is never more than a day stale no matter what.
- **On push to the KB folder** - a KB edit goes live in minutes instead of waiting for tomorrow's run.
- **Manual button** - for "re-run it now" moments without touching git.

Repeat runs stay nearly free because the ingest already skips unchanged files (Step 2's fingerprint check) - the daily run on an unchanged KB embeds nothing.

## 2. The technical decisions, and why

### A. The script must also read its keys from the environment (one small code change)

The ingest currently reads its keys only from a local, gitignored env file - which by definition does not exist on GitHub's machines, so as-is the job would start and immediately fail. The fix is to let the script fall back to environment variables, which is how CI injects secrets. Same script, two homes: on a laptop it reads the local file; in CI it reads what the workflow hands it. This is the only code change this step requires.

### B. Secrets live in GitHub's secret store, scoped as tightly as possible

The job needs the database key and the OpenAI key. They go into the repo's encrypted secrets (never in the workflow file, never in git), and the design doc's open question applies: confirm the database key can only write the chunks table, nothing broader - a leaked CI secret should have the smallest possible blast radius.

### C. Failure is safe by construction

If a run fails, nothing happens to live calls: the previous vectors simply stay in place, and the next successful run catches up. That is the payoff of ingest being fully off the call path - the automation can fail without paging anyone at night.

### D. Pair it with the eval, so a bad KB edit is caught in CI

Once [Step 4](./step4-retrieval-eval.md)'s eval exists, the Action runs it right after each ingest and fails the build if the retrieval hit rate drops. That turns "someone edited the KB and quietly broke retrieval" from a live-call surprise into a red X on a pull request.

## Prerequisites - two gates, discovered 2026-07-16

| Gate | Why it matters | Owner |
|---|---|---|
| **The RAG code and corpus must be committed and pushed first** | The Action checks out the repo's *committed* tree - and today `rag/`, the corpus folders under `sip/knowledge-base/`, this workflow file, and the RAG docs are all still untracked in git. As-is, a run would find nothing to ingest | you (git) |
| **Which repo hosts the Action and its secrets** | The repo pushes to two remotes: the company repo (`GlobiFYE-USA/dial-forge`) and a personal one. The secrets are production credentials (the database key, the OpenAI key), so where they live is a team decision. Recommendation: the company repo - company data, company automation, company-managed access | you / team |

## 3. What to change, and where

| Where | What | New / change | Status |
|---|---|---|---|
| GitHub repo settings (Secrets) | Add the database key and the OpenAI key as encrypted repo secrets | **New** | pending (needs the host-repo decision) |
| `rag/ingest.py` | Accept keys from the environment when the local env file is absent (Decision A); local behavior unchanged | Change | **done 2026-07-16** - verified: env fallback fires, the local file still wins |
| `.github/workflows/rag-ingest.yml` (new file) | The workflow: three triggers (daily / KB-path push / manual), install the one dependency, run the ingest - later also the eval (Decision D) | **New** | **written 2026-07-16** - unproven until the first CI run |
| Verification | Trigger a manual run and confirm it is green; re-run to confirm the "nothing changed, nothing embedded" path; push a KB edit to confirm the push trigger fires | - | pending |

## Deliverable for this step

A green Action that ingests on all three triggers, with a no-change re-run confirming the incremental path (everything skipped, nothing re-embedded).

## Failures log (fill in during build)

| Symptom | Cause | Fix |
|---|---|---|
| _(none yet)_ | | |

Likely one to watch: the run fails with "missing keys" even though secrets are set - check that the script's environment fallback (Decision A) is in place and that the secret names in the workflow match the names the script expects.

## Appendix - build-time specifics (skip on a first read)

- Secret names, matching what the script already reads locally: `SUPABASE_SERVICE_ROLE_KEY` (or the SIP-specific variant), `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_SIP_URL`), `OPENAI_API_KEY`.
- Workflow shape: `on: schedule` (daily cron) + `push` filtered to `sip/knowledge-base/**` + `workflow_dispatch`; set up Python 3.12 (the script needs only stdlib + `requests`, so any modern 3.x works); `pip install requests` (add `pypdf` / `python-docx` only if PDF/Word files join the corpus); run `python -u rag/ingest.py` with the three secrets passed as environment variables.
- Expected log: first-ever CI run embeds everything; steady-state daily runs report all files skipped.

## Next

With Steps 1, 2, 4, and 5 done, the write side of RAG is automated and measured. The remaining piece is [Step 3 - call-time retrieval](./step3-call-time-retrieval.md), which lands with the TTS-streaming work.
