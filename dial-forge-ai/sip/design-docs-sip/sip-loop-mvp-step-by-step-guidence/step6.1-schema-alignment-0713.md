# Step 6.1 - Merged-Backend Schema Alignment -0713

**Parent doc:** [Step 6 - Supabase Data Sync](./step6-supabase-sync.md)
**Date:** 2026-07-13
**Outcome: sync is live.** 14 calls, 46 transcript rows, 9 analyses, 2 organizations, 2 agent configs, 1 contact are in the merged project.

## 1. Why nothing was writing

Three separate faults, found by connecting to the database directly.

| Fault | Cause | Fix |
|---|---|---|
| Sync silently OFF | The key existed under `SUPABASE_SERVICE_ROLE_KEY`; the code only looked for `SUPABASE_SIP_SERVICE_ROLE_KEY`. No write was ever attempted, so re-running the schema could not have helped | The two Supabase projects are now one, so the server falls back to `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. No new key needed |
| `recordings` insert rejected | The code was written against `ai-pipeline/supabase/migrations/001_schema.sql`. The merged project's `recordings` is different: `id` is `bigint` (not uuid), there is **no `call_metadata`** column, and duration is `duration_seconds` | Rewrote the insert against the live schema (introspected via the PostgREST OpenAPI spec) |
| `recordings_call_mode_check` violation | `call_mode` rejects `ai`, `human`, `outbound`. Probed 34 values: **only `inbound` and NULL pass** | Left `call_mode` null. Direction is recorded precisely in `sip_calls.direction`, so nothing is lost. **Open question for the backend team** (section 5) |

**Lesson:** the live database is the source of truth, not the migration file. The backend team's `recordings` had already diverged.

## 2. The merged `recordings` table is already SIP-aware

It has the columns this pipeline needs, so no jsonb blob was necessary:

| Column | SIP writes |
|---|---|
| `did_number` | The extension dialled (1000 / 2000) |
| `sip_session_id` | Asterisk channel id (UNIQUE -- this is what makes the sync idempotent) |
| `sip_provider` | `asterisk` |
| `duration_seconds`, `status` | Call length; `completed` |
| `organization_id`, `agent_config_id`, `contact_id` | Links to the three tables below |
| `audio_url` | **null** -- call audio capture is not built (see step 7) |
| `call_mode` | **null** -- see section 5 |

## 3. Schema changes

`sip/demo-ui/supabase-schema.sql`, run in the SQL editor:

- **v2:** dropped `sip_turns` and `sip_analysis` (they duplicated `transcript` / `analysis`). Kept only `sip_calls`, now linked to `recordings` by `bigint recording_id`.
- **v3:** three columns on `transcript` so each row says *who* is speaking, not just "Client"/"Agent":

```sql
alter table transcript add column if not exists speaker_role    text;    -- client | agent
alter table transcript add column if not exists speaker_name    text;    -- agent's configured name, or the caller's
alter table transcript add column if not exists organization_id integer references organizations(id) on delete set null;
```

## 4. Identities: organizations, agents, contacts

The backend already had the right tables; all three were empty. Seeded and linked:

| Table | Rows created |
|---|---|
| `organizations` | id 2 and id 3, one per demo business (currently `Pacific Beef Trading` / `GlobiFYE`; the demo tenants have been renamed a few times, see step 5) |
| `agent_configs` | One AI agent per business (name, objective, tone, persona, TTS voice). `account_type` accepts only `sales` or `support`; used `sales` |
| `contacts` | The caller, created when their name/phone is captured (below) |

**The client's name.** We never had it: no caller ID, and no call had captured one. Instead of inventing one, the agent's own fallback line already asks for it, so the **on-demand analysis now also extracts `caller_name` / `caller_phone`** from the conversation (no extra LLM cost -- same call). When found it writes a `contacts` row, sets `recordings.contact_id` + `caller_number`, and stamps the name onto that caller's transcript turns. If the caller never says their name, nothing is written.

A transcript row now reads (illustrative):

```
client | Jordan Patel              | Pacific Beef Trading | Which cuts do you carry, and can you do Halal?
agent  | Pacific Beef Trading AI Agent | Pacific Beef Trading | Chuck, brisket, loin, round, and more; Halal programs are available...
```

The 13 calls made before this change keep showing no client name -- accurate, since none of those callers gave one.

## 5. Open question for the backend team

**What should `recordings.call_mode` hold for an AI voice call?** The check constraint accepts only `inbound` (and null); `ai`, `human`, and `outbound` are all rejected. Left null until they answer.

## 6. Verified (2026-07-13)

- Backfill pushed all local calls; zero sync warnings.
- 14 `recordings` from SIP, each linked to its organization and agent config; 46 `transcript` rows all carrying `speaker_role`, `speaker_name`, `organization_id`.
- Caller extraction end-to-end: a call where the caller states a name and phone number ("Jordan Patel", "555-0142") produced a `contacts` row, a linked `recordings.contact_id`, and both of that caller's transcript turns named.
- Sync is idempotent: re-running reuses the existing recording by `sip_session_id` instead of duplicating. `analysis` has exactly one row per recording.
