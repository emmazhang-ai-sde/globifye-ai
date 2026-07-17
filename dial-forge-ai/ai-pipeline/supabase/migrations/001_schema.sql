-- =====================
-- Table 1: recordings
-- =====================
-- Written when: call starts (row created) and call ends (duration updated)
CREATE TABLE IF NOT EXISTS recordings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_metadata   JSONB,           -- e.g. { "rep": "Alice", "client": "Acme Corp" }
  audio_url       TEXT,            -- cloud storage URL (S3/GCS) — raw audio is never stored in DB
  duration        NUMERIC,         -- total call duration in seconds, updated when call ends
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================
-- Table 2: transcript
-- =====================
-- Written when: real-time, one row per final sentence during call (not partial results)
CREATE TABLE IF NOT EXISTS transcript (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id        UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  speaker             TEXT,         -- Deepgram speaker label, e.g. "Speaker 0", "Speaker 1"
  content_raw         TEXT,         -- Deepgram output with filler words kept (um, uh, like) — sent to LLM
  content_clean       TEXT,         -- filler words stripped — displayed in UI only
  sentence_start_sec  NUMERIC,      -- sentence-level timestamp in seconds — used for transcript jumping, not shown in UI
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcript_recording_id_idx ON transcript(recording_id);

-- =====================
-- Table 3: analysis
-- =====================
-- Written when: user clicks "Analyze" button (never auto-triggered)
CREATE TABLE IF NOT EXISTS analysis (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id        UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  summary             TEXT,
  key_topics          JSONB,        -- [{ "name": "Pricing Discussion", "start_time": 45.0 }]
                                    -- UI navigation index — clicking a topic jumps to that transcript position
  objection_analysis  JSONB,        -- [{ "timestamp": 142.5, "speaker": "Customer", "exact_quote": "...", "reason": "...", "suggestion": "..." }]
  what_went_well      JSONB,        -- [{ "timestamp": 60.0, "speaker": "Sales Rep", "exact_quote": "...", "reason": "..." }]
  raw_llm_output      TEXT,         -- full raw LLM response string — for debugging only
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_recording_id_idx ON analysis(recording_id);