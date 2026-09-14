# Supabase Current Database Inventory

**Project URL:** `https://rjhjveatqnwxbnfrthsr.supabase.co`  
**Project ID:** `rjhjveatqnwxbnfrthsr`  
**How this was verified:** Supabase REST OpenAPI + table count checks using the
server-side service role key from `dial-forge-ai/ai-pipeline/.env.local`.  
**Secret handling:** keys were used locally only and are not copied into this
document.

This document is the current live inventory for the shared Supabase project we
are using for the frontend login/SIP/AI pipeline integration. It complements the
older shared database migration analysis:

- `ai-pipeline-shared-db-migration-analysis-0708.md`
- `step6-supabase-sync.md`

## High-Level Summary

| Area | Current state |
|---|---|
| Project reachable from local code | Yes |
| Browser Dashboard access for Shuyang | Not confirmed; user reports no dashboard permission |
| Local service role access | Yes |
| Public tables exposed through REST | 22 |
| Supabase Auth users visible through admin API | 7 |
| Product login source | Supabase Auth first, local JSON fallback only for dev |
| Company table name | `organizations` |
| User table name | `users` |
| Agent config table name | `agent_configs` |
| SIP-specific call table | `sip_calls` |
| RAG vector table | `sip_kb_chunks` |

## Public Tables

| Table | Rows | Main columns | Current role / notes |
|---|---:|---|---|
| `agent_configs` | 2 | `id`, `organization_id`, `created_by`, `name`, `objective`, `tone`, `persona`, `account_type`, `is_active`, `created_at` | One AI agent config per seeded organization. Current SIP routing should eventually read from here instead of `companies.json`. |
| `analysis` | 19 | `id`, `recording_id`, `summary`, `key_topics`, `objection_analysis`, `what_went_well`, `created_at` | Post-call analysis output. Linked to `recordings`. |
| `api_keys` | 0 | `id`, `organization_id`, `created_by`, `key_hash`, `label`, `last_used_at`, `is_active`, `created_at` | Backend/product API key table exists but has no rows. |
| `call_queue` | 7 | `id`, `organization_id`, `contact_id`, `scheduled_at`, `priority`, `status`, `call_mode`, `created_at` | Seeded GlobiFYE power dialer queue. DB status uses `queued`; product API maps it to UI `waiting`. |
| `contacts` | 14 | `id`, `organization_id`, `apollo_id`, `hubspot_id`, `name`, `email`, `phone`, `company` | CRM/contact cache table. Includes the seeded GlobiFYE power dialer demo contacts. |
| `crm_integrations` | 0 | `id`, `organization_id`, `provider`, `access_token`, `refresh_token`, `token_expires_at`, `is_active` | CRM integration credentials table exists but is empty. |
| `crm_sync_log` | 0 | `id`, `recording_id`, `organization_id`, `provider`, `external_record_id`, `sync_type`, `status`, `error_message`, `synced_at` | CRM sync audit table exists but is empty. |
| `gpu_jobs` | 2 | `id`, `organization_id`, `recording_id`, `job_type`, `status`, `compute_units`, `cost`, `started_at`, `completed_at` | AI/batch processing job tracking. |
| `idempotency_keys` | 0 | `id`, `idempotency_key`, `user_id`, `request_hash`, `status`, `response_body`, `response_code`, `created_at` | Request idempotency table exists but is empty. |
| `invites` | 1 | `id`, `organization_id`, `invited_by`, `email`, `role`, `token`, `status`, `created_at` | Team invite table. Existing role value observed: `admin`. |
| `organizations` | 3 | `id`, `name`, `created_at` | Source of truth for company/tenant records. |
| `payment_logs` | 0 | `id`, `transaction_key`, `organization_id`, `event_type`, `raw_payload` | Billing event table exists but is empty. |
| `phone_numbers` | 0 | `id`, `organization_id`, `did_number`, `is_active`, `assigned_at` | DID/phone-number ownership table exists but is empty. |
| `recordings` | 37 | `id`, `organization_id`, `recorded_by`, `contact_id`, `did_number`, `caller_number`, `audio_url`, `status`, `duration_seconds`, `sip_provider`, `sip_session_id`, `agent_config_id`, `call_mode` | Main call recording/session metadata table. 33 rows are `completed`; 4 rows have null status. |
| `sip_calls` | 32 | `id`, `recording_id`, `started_at`, `ended_at`, `company`, `direction`, `caller`, `dialed_by`, `channel_id` | SIP-specific telephony metadata linked to `recordings`. |
| `sip_kb_chunks` | 109 | `id`, `company_key`, `source_file`, `chunk_index`, `kind`, `section`, `content`, `content_hash`, `embedding_model`, `embedding`, `updated_at` | RAG vector chunks for SIP voice agents. Current distribution: `globifye` 58, `pacificbeef` 51. |
| `subscriptions` | 0 | `id`, `organization_id`, `plan_type`, `status`, `gpu_quota`, `renewal_date`, `started_at`, `cancelled_at` | Billing subscription table exists but is empty. |
| `topics` | 23 | `id`, `recording_id`, `analysis_id`, `name`, `start_time`, `sequence_index`, `created_at` | Normalized topic rows from post-call analysis. |
| `transactions` | 0 | `id`, `transaction_key`, `organization_id`, `amount`, `currency`, `status`, `subscription_id`, `description` | Billing transactions table exists but is empty. |
| `transcript` | 173 | `id`, `recording_id`, `speaker`, `content_raw`, `content_clean`, `sentence_start_sec`, `sequence_index`, `created_at`, `speaker_role`, `speaker_name`, `organization_id` | Transcript rows. SIP sync writes one row per final utterance. |
| `users` | 7 | `id`, `organization_id`, `email`, `role`, `is_active`, `created_at` | Product user rows linked to Supabase Auth users. Display name/job title currently live in Auth metadata. |
| `webhooks` | 0 | `id`, `organization_id`, `event_type`, `target_url`, `secret`, `is_active` | Webhook config table exists but is empty. |

## Organizations

| ID | Name | Notes |
|---:|---|---|
| 1 | `Test Startup Inc.` | Existing test/backend org. |
| 2 | `Pacific Beef Trading` | Has an active AI agent config and RAG chunks. |
| 3 | `GlobiFYE` | Has an active AI agent config, RAG chunks, and the seeded frontend demo users. |

## Agent Configs

| ID | Organization ID | Name | Account type | Active | Notes |
|---:|---:|---|---|---|---|
| 1 | 2 | `Pacific Beef Trading AI Agent` | `sales` | Yes | Uses Pacific Beef Trading KB/persona. |
| 2 | 3 | `GlobiFYE AI Agent` | `sales` | Yes | Uses GlobiFYE KB/persona. |

## Product Users

`public.users` contains 7 rows. It stores auth linkage, tenant membership, and
permission role. It does not currently store display names or job titles; the
frontend login chain reads those from Supabase Auth `user_metadata`.

| Email | Organization ID | Active | Notes |
|---|---:|---|---|
| `alex.rivera@globifye.com` | 3 | Yes | Seeded GlobiFYE demo user. Display role in Auth metadata: `Enterprise AE`. |
| `sophia.patel@globifye.com` | 3 | Yes | Seeded GlobiFYE demo user. Display role in Auth metadata: `Sales Manager`. |
| `marcus.reed@globifye.com` | 3 | Yes | Seeded GlobiFYE demo user. Display role in Auth metadata: `Account Executive`. |
| `elena.morales@globifye.com` | 3 | Yes | Seeded GlobiFYE demo user. Display role in Auth metadata: `SDR Lead`. |
| `daniel.kim@globifye.com` | 3 | Yes | Seeded GlobiFYE demo user. Display role in Auth metadata: `Customer Success Manager`. |
| `maya.chen@acmehealth.com` | 2 | Yes | Seeded demo user currently mapped to `Pacific Beef Trading` for local testing. |
| `test1@example.com` | null | Yes | Older test user. Not part of the current frontend login demo path. |

## Product Contacts

`contacts` contains 14 rows across the shared project. GlobiFYE currently has 8
contacts: 1 older test/demo contact plus 7 contacts seeded from the hardcoded
`powerDialer.html` dial queue.

The current `contacts` table only stores shared CRM basics. UI-only power dialer
fields such as title, queue status, priority, and avatar URL are retained in
`dial-forge-front-end/localHost/product_demo_contacts.json` until the product
API has a first-class queue/prospect model.

| Name | Organization ID | Company | Phone | Email | Source |
|---|---:|---|---|---|---|
| `Priya Nair` | 3 | `Sentinel Security` | `555-0199` | null | Existing contact row. |
| `Jordan Peterson` | 3 | `Nexus AI` | `(415) 555-0100` | `jordan.peterson@nexusai.example` | Seeded from `powerDialer.html`. |
| `Sarah Jenkins` | 3 | `CloudScale` | `(415) 555-0101` | `sarah.jenkins@cloudscale.example` | Seeded from `powerDialer.html`. |
| `Michael Chen` | 3 | `Quantum Dynamics` | `(415) 555-0102` | `michael.chen@quantumdynamics.example` | Seeded from `powerDialer.html`. |
| `Elena Morales` | 3 | `Skynet Systems` | `(415) 555-0103` | `elena.morales@skynetsystems.example` | Seeded from `powerDialer.html`. |
| `Alex Rivera` | 3 | `InnovateX Global` | `(415) 555-0104` | `alex.rivera@innovatexglobal.example` | Seeded from `powerDialer.html`. |
| `Emily Carter` | 3 | `Vertex Solutions` | `(415) 555-0105` | `emily.carter@vertexsolutions.example` | Seeded from `powerDialer.html`. |
| `David Morgan` | 3 | `Horizon Analytics` | `(415) 555-0106` | `david.morgan@horizonanalytics.example` | Seeded from `powerDialer.html`. |

## Product Call Queue

`call_queue` contains 7 rows, all under GlobiFYE organization ID 3. The seed
source is `dial-forge-front-end/localHost/product_demo_contacts.json`, and the
writer is `dial-forge-front-end/localHost/sync_product_demo_call_queue_to_supabase.py`.

The database accepts `queued`, `completed`, and `failed` for `call_queue.status`.
The product API maps `queued` to the Power Dialer UI's existing `waiting` state.

| Contact | Organization ID | DB status | UI status | Priority | Call mode |
|---|---:|---|---|---:|---|
| `Jordan Peterson` | 3 | `queued` | `waiting` | 3 | `auto_dialer` |
| `Sarah Jenkins` | 3 | `queued` | `waiting` | 3 | `auto_dialer` |
| `Emily Carter` | 3 | `queued` | `waiting` | 3 | `auto_dialer` |
| `Michael Chen` | 3 | `queued` | `waiting` | 2 | `auto_dialer` |
| `Elena Morales` | 3 | `queued` | `waiting` | 2 | `auto_dialer` |
| `David Morgan` | 3 | `queued` | `waiting` | 2 | `auto_dialer` |
| `Alex Rivera` | 3 | `queued` | `waiting` | 1 | `auto_dialer` |

## Supabase Auth Users

Auth admin API reports 7 Auth users.

| User group | Count | Notes |
|---|---:|---|
| GlobiFYE demo users | 5 | Seeded by `dial-forge-front-end/localHost/sync_product_demo_users_to_supabase.py`. |
| Pacific Beef Trading demo user | 1 | `maya.chen@acmehealth.com`, used to prove company display is not hardcoded. |
| Legacy/test user | 1 | Existing test account, not used by the current product login flow. |

## Important Current Relationships

| Relationship | Current status |
|---|---|
| `users.organization_id` -> `organizations.id` | Active for seeded demo users. |
| `agent_configs.organization_id` -> `organizations.id` | Active for Pacific Beef Trading and GlobiFYE. |
| `recordings.organization_id` -> `organizations.id` | Present in schema; rows may still have nulls depending on when they were written. |
| `recordings.agent_config_id` -> `agent_configs.id` | Present in schema; used by SIP sync when available. |
| `transcript.recording_id` -> `recordings.id` | Active for transcript rows. |
| `analysis.recording_id` -> `recordings.id` | Active for post-call analysis rows. |
| `topics.analysis_id` -> `analysis.id` | Active for normalized analysis topics. |
| `sip_calls.recording_id` -> `recordings.id` | Active for SIP call metadata. |
| `sip_kb_chunks.company_key` | String key, currently `globifye` and `pacificbeef`; not yet normalized to `organizations.id`. |

## Tables Mentioned In Plans But Not Present

| Planned table | Current status | Recommendation |
|---|---|---|
| `profiles` | Not present | Do not create separately yet; current backend uses `users` plus Supabase Auth metadata. Revisit if profile fields need first-class querying. |
| `companies` | Not present | Do not create; use `organizations` as the canonical company/tenant table. |
| `call_sessions` | Not present | Add when we persist live bridge room state beyond `recordings`/`sip_calls`. |
| `call_events` | Not present | Add when we persist handoff state transitions and debug history. |
| `call_queue_events` | Migration prepared, not yet live | SQL exists at `dial-forge-ai/ai-pipeline/supabase/migrations/002_call_queue_events.sql`. Apply it to persist Power Dialer outcomes such as `connected`, `voicemail`, `skipped`, and `hungup`. |

## Current Product Login Integration

The frontend local server now uses this order:

1. `POST /api/auth/login` attempts Supabase Auth password login.
2. On success, the browser stores the returned Supabase access token in
   `dialforgeAuthToken`.
3. `GET /api/me` validates the token through Supabase Auth and hydrates:
   - Auth `user_metadata` for display name, job title, avatar URL.
   - `public.users` for active state and organization membership.
   - `public.organizations` for company name.
4. `currentUserAPI.js` normalizes the result for `login.html`, `profile.html`,
   `Dashboard.html`, and `activeCall.html`.

Local fallback still exists for development:

- `dial-forge-front-end/localHost/product_demo_users.json`
- `dial-forge-front-end/localHost/sync_product_demo_users_to_supabase.py`

## Maintenance Notes

| Topic | Note |
|---|---|
| Service role key | Server-side only. Do not expose in frontend JS. |
| Browser Supabase Dashboard access | Separate from service-key access. The project can be reachable from code even if a human account lacks Dashboard permissions. |
| Role field | `public.users.role` appears constrained; existing accepted value observed in `invites` is `admin`, while demo `users.role` rows are currently null. Display job titles should remain in Auth metadata until the backend defines profile fields. |
| Organization IDs | `organizations.id` is integer, not UUID. Keep this in mind when adding `call_sessions`, KB ownership, or Customer Registration Dashboard writes. |
| RAG ownership | `sip_kb_chunks` still uses string `company_key`. Future migration should align KB ownership with `organizations.id` or maintain a clear mapping table. |
| SIP demo retirement | Existing SIP writes rely on `recordings`, `transcript`, `analysis`, `topics`, and `sip_calls`. Product UI should call product API endpoints, not SIP demo UI endpoints. |
| Power Dialer event migration | Current local environment has Supabase REST/Auth keys, but no direct SQL execution path (`psql`, Supabase CLI, or DB URL). The migration file is ready but must be applied through Supabase SQL editor/CLI by someone with project access. |

## Quick Verification Commands

Run from repo root:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge
python3 dial-forge-front-end/localHost/sync_product_demo_users_to_supabase.py
```

Check login through the local product API:

```bash
cd /Users/shuyangzhang/GlobiFYE/dial-forge/dial-forge-front-end
python3 localHost/dial_forge_front_end_server.py
```

Then open:

```text
http://localhost:8000/login.html
```

Seeded demo credentials:

```text
alex.rivera@globifye.com / demo1234
sophia.patel@globifye.com / demo1234
marcus.reed@globifye.com / demo1234
elena.morales@globifye.com / demo1234
daniel.kim@globifye.com / demo1234
maya.chen@acmehealth.com / demo1234
```
