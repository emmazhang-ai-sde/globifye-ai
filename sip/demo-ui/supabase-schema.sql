-- GlobiFYE SIP demo -- schema for the MERGED backend project:
--   https://supabase.com/dashboard/project/rjhjveatqnwxbnfrthsr/sql/new
--
-- SIP calls reuse the existing pipeline tables (recordings, transcript,
-- analysis, topics) and the backend's own tables (organizations, agent_configs,
-- contacts). Only sip_calls is SIP-specific.
--
-- Per call the demo server writes:
--   recordings   1 row   (org + agent_config linked; did_number, sip_session_id, duration)
--   transcript   N rows  (speaker_role, speaker_name, organization_id -- see v3 below)
--   sip_calls    1 row   (telephony metadata -> recording_id)
--   analysis     1 row   } only after "Run analysis" is clicked
--   topics       N rows  }
--   contacts     1 row   (the caller, once analysis extracts their name/phone)
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- v2
-- recordings.id is BIGINT in this project (not the UUID the ai-pipeline's
-- 001_schema.sql declares). The merged project is the source of truth.

drop table if exists sip_turns;
drop table if exists sip_analysis;

create table if not exists sip_calls (
  id            text primary key,   -- the demo's call id (timestamp + channel)
  recording_id  bigint references recordings(id) on delete set null,
  started_at    double precision,   -- epoch seconds
  ended_at      double precision,
  company       text,               -- business the call was for
  direction     text,               -- sales_to_client | client_to_sales
  caller        text,               -- who initiated (business name or "Client")
  dialed_by     text,               -- the signed-in user who placed it
  channel_id    text                -- Asterisk channel id
);

grant all on sip_calls to service_role;

-- ---------------------------------------------------------------- v3 (2026-07-13)
-- Make each transcript row say WHO is speaking, not just "Client"/"Agent":
--   speaker_role     client | agent   (normalized; `speaker` stays for the batch pipeline)
--   speaker_name     the AI agent's name, or the caller's name once known
--   organization_id  which business this turn belongs to

alter table transcript add column if not exists speaker_role    text;
alter table transcript add column if not exists speaker_name    text;
alter table transcript add column if not exists organization_id integer references organizations(id) on delete set null;

create index if not exists transcript_organization_id_idx on transcript(organization_id);
