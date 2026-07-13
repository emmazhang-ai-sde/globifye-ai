# Step 6 - Supabase Data Sync

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md), section 4, Step 6
**Builds on:** [Step 5, the demo console](./step5-pm-demo-ui.md)
**Status: live and verified (2026-07-13).** Schema alignment log: [Step 6.1](./step6.1-schema-alignment-0713.md).

## 1. Design

Target: the **merged backend project** `https://rjhjveatqnwxbnfrthsr.supabase.co`, which holds both the ai-pipeline MVP tables and the backend's own. SIP calls reuse those tables rather than parallel copies, so recordings, transcripts, and post-call analysis share one storage model. Only `sip_calls` is SIP-specific.

The local JSON files in `sip/demo-ui/call-history/` remain what the UI reads, so the demo never depends on the database: the sync is best-effort, runs off the hot path, and logs a warning on failure. On startup the server backfills any local call that never reached the database.

```
call ends                              "Run analysis" clicked
    |                                          |
    v                                          v
recordings   1 row  (org + agent linked)   analysis  1 row
transcript   N rows (speaker named)        topics    N rows
sip_calls    1 row  (-> recording_id)      contacts  1 row (if the caller gave a name)
```

## 2. Tables

| Table | SIP writes |
|---|---|
| `recordings` | 1 row per call: `did_number`, `sip_session_id` (unique -> idempotency), `sip_provider`, `duration_seconds`, `status`, and links to `organization_id` / `agent_config_id` / `contact_id`. `audio_url` and `call_mode` stay null (see 6.1) |
| `transcript` | 1 row per final sentence: `speaker_role` (client/agent), `speaker_name`, `organization_id`, `content_raw`, `sentence_start_sec`, `sequence_index` |
| `analysis` + `topics` | 1 analysis row + its topics, written only when **Run analysis** is clicked |
| `organizations` / `agent_configs` | One row per business and its AI agent, seeded once |
| `contacts` | The caller, created when analysis extracts their name/phone |
| `sip_calls` | Telephony metadata: call id, `recording_id`, start/end, company, direction, caller, dialed_by, channel_id |

Not written: `gpu_jobs` (the batch pipeline's own job queue; SIP analysis runs in-process).

Schema: [`sip/demo-ui/supabase-schema.sql`](../../../../sip/demo-ui/supabase-schema.sql). Writes use the service key, which bypasses RLS.

## 3. Configuration

`ai-pipeline/.env.local` (gitignored). The ai-pipeline project and the SIP project are now the same project, so the server falls back to the main names and **no separate SIP key is needed**:

```
SUPABASE_SIP_URL              (optional; falls back to NEXT_PUBLIC_SUPABASE_URL)
SUPABASE_SIP_SERVICE_ROLE_KEY (optional; falls back to SUPABASE_SERVICE_ROLE_KEY)
```

On startup the server prints `Supabase mirror: ON -> <url>` or `OFF`. Both legacy JWT and new `sb_secret_...` key formats work.

## 4. Verification

1. Restart the demo UI server; confirm `Supabase mirror: ON` and any `Supabase backfill: syncing ...` lines.
2. Place a call and hang up. Confirm 1 new `recordings` row (linked to its organization and agent), its `transcript` rows with named speakers, and 1 `sip_calls` row.
3. Click **Run analysis**. Confirm 1 `analysis` row + `topics`, and -- if the caller gave their name -- a `contacts` row with `recordings.contact_id` set.

## Next

[Step 7 - Agent roadmap and deferred scope](./step7-agent-roadmap.md): RAG, AI/salesperson switching, and everything else deliberately not built yet.
