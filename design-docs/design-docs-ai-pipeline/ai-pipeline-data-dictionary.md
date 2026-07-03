# AI Pipeline — Database Schema & Data Dictionary
**Author:** Shuyang Zhang (AI)
**Date:** 2026-07-03
**Scope:** Full platform schema (17 tables, from Abraham/Kim's backend doc) + plain-English column meanings for every table the AI writes to. Originally written in response to a question from the API/CRM team about `call_mode` and `contact_id` vs. `contact_number`; merged with the backend team's `2026-06-06-backend-db-schema.md` so there's one source of truth instead of two overlapping docs.

Source of truth cross-checked against:
- `design-docs/ai-pipeline/ai-pipeline-mvp-step11-schema-migration.md` (the actual migration SQL)
- `design-docs/ai-pipeline/ai-pipeline-mvp-step12-frontend-ui-milestone2.md` (which fields are actually populated today vs. still NULL)
- Live Supabase table list (screenshot, 2026-07-03) — confirms which of the 17 designed tables actually exist in the DB right now

---

## Live vs. not-yet-created tables

Per the current Supabase dashboard, only **8 of the 17** designed tables exist so far:

| Status | Tables |
|---|---|
| ✅ Live now | `organizations`, `users`, `contacts`, `recordings`, `transcript`, `analysis`, `topics`, `gpu_jobs` |
| ⏳ Designed, not yet created | `invites`, `phone_numbers`, `crm_integrations`, `crm_sync_log`, `webhooks`, `subscriptions`, `transactions`, `payment_logs`, `api_keys` |

The 9 not-yet-created tables are mostly billing/auth/CRM-integration plumbing (backend-owned) — none of them block the AI's current work.

---

## How the Tables Connect

**1. Tenant tree** — every table hangs off `organizations` via `organization_id`. This is the multi-tenancy anchor (Danish's June 1 requirement: one shared table per entity, never per-tenant tables):

```
organizations
  │   (organization_id — tenant anchor for every table below)
  │
  ├── users
  ├── contacts
  ├── recordings
  ├── gpu_jobs
  │
  ├── invites             ⏳ not created
  ├── phone_numbers       ⏳ not created
  ├── crm_integrations    ⏳ not created
  ├── crm_sync_log        ⏳ not created
  ├── webhooks            ⏳ not created
  ├── subscriptions       ⏳ not created
  ├── transactions        ⏳ not created
  └── api_keys            ⏳ not created
```

**2. Call lifecycle** — `recordings` is the hub. `users` and `contacts` feed *into* it (who made the call, who it was with); `transcript`, `analysis`, `topics`, and `gpu_jobs` all hang *off* it via `recording_id` (what happened during/after the call):

```
   users.id                      contacts.id
      │                               │
      │ recorded_by (FK, NULL today)  │ contact_id (FK, NULL today)
      └───────────────┬───────────────┘
                       ▼
               ┌───────────────┐
               │  recordings   │   ← one row per call, the hub table
               └───────┬───────┘
                       │ recording_id
   ┌───────────────────┼───────────────────┬───────────────────┐
   ▼                   ▼                   ▼                   ▼
┌───────────┐    ┌────────────┐      ┌───────────┐       ┌───────────┐
│ transcript│    │  analysis  │      │  gpu_jobs │       │crm_sync_log│  ⏳
│ real-time,│    │ post-call, │      │ usage log,│       │(not created│
│per sentence│   │  button-   │      │ per AI job│       │    yet)   │
└───────────┘    │ triggered  │      └───────────┘       └───────────┘
                  └─────┬──────┘
                        │ analysis_id
                        ▼
                  ┌───────────┐
                  │  topics   │   (normalized copy of analysis.key_topics)
                  └───────────┘
```

**Reading order for a single call:** `recordings` row is created first (call start) → `transcript` rows stream in throughout the call → once the call ends and the analysis button is clicked, `analysis` is written, then `topics` is derived from it, and a `gpu_jobs` row logs the job for usage tracking.

---

## Full Schema Table (all 17, platform-wide)

*✅ next to a table name = already exists in our AI team's Supabase.*

| Table | Key Fields | Written When | Owner |
|---|---|---|---|
| `organizations` ✅ | `id`, `name`, `created_at` | On SuperAdmin signup | Backend |
| `users` ✅ | `id` (UUID), `organization_id`, `email`, `role`, `is_active` | On signup / invite accepted | Backend |
| `invites` | `organization_id`, `invited_by`, `email`, `role`, `token`, `status` | When admin sends invite | Backend |
| `phone_numbers` | `organization_id`, `did_number`, `is_active`, `assigned_at` | When org is created | Backend |
| `contacts` ✅ | `organization_id`, `apollo_id`, `hubspot_id`, `name`, `email`, `phone`, `company` | When call is initiated | Backend |
| `recordings` ✅ | `id`, `organization_id`, `recorded_by`, `contact_id`, `did_number`, `caller_number`, `audio_url`, `status`, `duration_seconds`, `sip_provider` | Call starts / ends | **AI** |
| `transcript` ✅ | `recording_id`, `speaker`, `content_raw`, `content_clean`, `sentence_start_sec`, `sequence_index` | Real-time, per sentence during call | **AI** |
| `analysis` ✅ | `recording_id`, `summary`, `key_topics` (JSON), `objection_analysis` (JSON), `what_went_well` (JSON) | After button click | **AI** |
| `topics` ✅ | `recording_id`, `analysis_id`, `name`, `start_time`, `sequence_index` | After button click | **AI** |
| `gpu_jobs` ✅ | `organization_id`, `recording_id`, `job_type`, `status`, `compute_units`, `cost` | After each AI job completes | **AI** |
| `crm_integrations` | `organization_id`, `provider`, `access_token`, `refresh_token`, `token_expires_at`, `is_active` | When SuperAdmin connects a CRM | Backend / API team |
| `crm_sync_log` | `recording_id`, `organization_id`, `provider`, `external_record_id`, `sync_type`, `status`, `error_message`, `synced_at` | After each CRM push attempt | Backend / API team |
| `webhooks` | `organization_id`, `event_type`, `target_url`, `secret`, `is_active` | When org configures Zapier | Backend / API team |
| `subscriptions` | `organization_id`, `plan_type`, `status`, `gpu_quota`, `renewal_date` | On org signup / plan change | Backend |
| `transactions` | `transaction_key` (unique), `organization_id`, `amount`, `currency`, `status` | Payment gateway webhook | Backend |
| `payment_logs` | `transaction_key`, `organization_id`, `event_type`, `raw_payload` (JSON) | Every gateway event received | Backend |
| `api_keys` | `organization_id`, `created_by`, `key_hash`, `label`, `is_active` | When SuperAdmin generates key | Backend |

**Ownership split:** `organizations`, `users`, `contacts`, and everything in the "not yet created" list are backend-owned. The AI owns `recordings`, `transcript`, `analysis`, `topics`, `gpu_jobs` — those five get the full column-level breakdown below.

---

## Two fields that don't actually exist — flagged upfront

**`call_mode`** — there is no column with this name anywhere in the schema. Two things it's probably being confused with:
- `recordings.status` (`in_progress` / `completed` / `failed`) — this is a *lifecycle state*, not a mode.
- The product-level "three call-trigger modes" from the AI agent design doc — **autonomous dialer**, **human transfer**, **inbound receiver**. This is a Danish/product decision that exists only in `design-docs/ai-agent/ai-agent-design.md`; it has never been turned into a DB column. If the agent-calling feature needs to query "which mode was this call," that's a follow-up schema change, not something already stored.

**`contact_number`** — also doesn't exist. There are two *different* fields that are easy to mix up:
- `recordings.caller_number` — the raw phone number string of whoever was on the call, captured at call time (currently populated from the `?phone=` URL param in the dialer UI).
- `contacts.phone` — the phone number stored on a CRM contact's profile, synced in from Apollo/HubSpot.

`contact_id` is a third, distinct thing — see below.

---

## `recordings` — one row per call

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | Primary key for the call. |
| `organization_id` | uuid, FK → `organizations` | Which company/tenant this call belongs to. **Currently always NULL** — no org has completed signup yet (backend-owned dependency). |
| `recorded_by` | uuid, FK → `users` | Which sales rep made/took the call. **Currently always NULL** — no user rows exist yet (backend-owned dependency). |
| `contact_id` | uuid, FK → `contacts` | Points at the CRM contact record (name, email, company, apollo/hubspot IDs) this call was with — a *reference*, not the phone number itself. **Currently always NULL** — depends on CRM sync, which hasn't run (see chain below). |
| `did_number` | varchar | The organization's own phone number that the call came in on/went out from. |
| `caller_number` | varchar | The other party's raw phone number for this specific call. This is what's actually populated today. |
| `status` | varchar | Call lifecycle: `in_progress`, `completed`, or `failed`. |
| `duration_seconds` | numeric | Call length. Renamed from the old `duration` field. |
| `sip_provider` | varchar | Which SIP/telephony provider handled the call (e.g. Asterisk). |
| `audio_url` | text | Link to the stored audio file. |
| `created_at` | timestamptz | Row creation time. |

**Why `organization_id` / `recorded_by` / `contact_id` are all still NULL:** each depends on a backend step that hasn't happened yet — no company has finished SuperAdmin signup, no sales rep has been invited, and no CRM integration has synced contacts in. Once those three exist, our pipeline fills these in on every new call. Full chain is in `ai-pipeline-mvp-step12-frontend-ui-milestone2.md` if useful.

---

## `transcript` — one row per spoken utterance

| Column | Meaning |
|---|---|
| `recording_id` | Which call this utterance belongs to. |
| `speaker` | Who said it (speaker label from diarization). |
| `content_raw` | Exact words including filler words ("um," "uh") — fed to the LLM, since hesitation signals matter for objection analysis. |
| `content_clean` | Same text with filler words stripped — what's shown in the UI. |
| `sentence_start_sec` | Timestamp (seconds into the call) this utterance started. |
| `sequence_index` | Order counter, so utterances can be replayed in order. |

---

## `analysis` — one row per call, written after the LLM analysis step

| Column | Meaning |
|---|---|
| `recording_id` | Which call this analysis is for. |
| `summary` | LLM-generated call summary. |
| `key_topics` | JSON array of topics discussed with timestamps (also normalized into the `topics` table below). |
| `objection_analysis` | JSON: objections the prospect raised, and how the rep/AI handled them. |
| `what_went_well` | JSON: positive moments in the call, for coaching. |

(`raw_llm_output` used to exist here for debugging but was dropped to match the backend schema — if raw LLM output logging is needed again, it belongs in `gpu_jobs`, not here.)

---

## `topics` — normalized version of `analysis.key_topics`

| Column | Meaning |
|---|---|
| `recording_id` / `analysis_id` | Which call/analysis this topic came from. |
| `name` | Topic label. |
| `start_time` | Timestamp in the call. |
| `sequence_index` | Order counter. |

---

## `gpu_jobs` — one row per AI job run, for usage/billing tracking

| Column | Meaning |
|---|---|
| `organization_id` / `recording_id` | Which tenant/call this job was for. |
| `job_type` | `transcription` or `analysis`. |
| `status` | `completed` or `failed`. |
| `compute_units` / `cost` | Nullable for now — will be filled in once usage-based billing is built. |
