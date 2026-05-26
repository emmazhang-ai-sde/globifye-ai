# Step 2 — Supabase Database Schema

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

#### 2.1 Create a Supabase account and project

1. Go to [https://supabase.com](https://supabase.com) and sign up (or log in)
2. Click **"New Project"**
3. Fill in:
   - **Name:** `globifye-ai-pipeline` (or any name you like)
   - **Database Password:** set a strong password and save it somewhere safe
   - **Region:** pick the one closest to you (e.g. US East)
4. Under **Security**, configure as follows:

   | Option | Recommended | Reason |
   |---|---|---|
   | **Enable Data API** | ✅ On | Required by `supabase-js` to read/write the database |
   | **Automatically expose new tables** | ❌ Off | Safer — manually control which tables are accessible |
   | **Enable automatic RLS** | ✅ On | Automatically enables Row Level Security on new tables, preventing data leaks |

   > ⚠️ With RLS enabled, all table data is locked down by default. Using `supabaseAdmin` (Secret key) bypasses RLS, so development is unaffected during the MVP phase.

5. Click **"Create new project"** and wait ~1 minute for it to initialize

---

#### 2.2 Get your Supabase API keys

1. In your Supabase project, go to **Settings** (gear icon on the left sidebar) → **API**
2. Copy these three values into your `.env.local` file:

| `.env.local` variable | Where to find it in Supabase |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Project URL** (e.g. `https://xxxx.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Publishable key** under "Project API keys" |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret key** under "Project API keys" |

Your `.env.local` should now look like:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

> ⚠️ Never commit `.env.local` — double-check `.gitignore` includes it.

---

#### 2.3 Write the SQL schema

Open `supabase/migrations/001_schema.sql` and paste in the following:

```sql
-- =====================
-- Table 1: recordings
-- =====================
-- Written when: call starts (row created) and call ends (duration updated)
CREATE TABLE IF NOT EXISTS recordings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     TEXT,            -- customer identifier for cross-call history retrieval
  call_metadata   JSONB,           -- e.g. { "rep": "Alice", "client": "Acme Corp" }
  audio_url       TEXT,            -- cloud storage URL (S3/GCS) — raw audio is never stored in DB
  duration        NUMERIC,         -- total call duration in seconds, updated when call ends
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recordings_customer_id_idx ON recordings(customer_id);

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

-- =====================
-- Grants
-- =====================
-- Required because "Automatically expose new tables" is OFF.
-- Without these, PostgREST will return "permission denied" even with the service role key.
GRANT ALL ON recordings TO service_role;
GRANT ALL ON transcript TO service_role;
GRANT ALL ON analysis TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
```

**Why are GRANT statements needed?**

Two separate Supabase security mechanisms are in play:

- **RLS (Row Level Security)** controls which *rows* a user can read or write within a table. When RLS is enabled, all rows are locked by default. The `service_role` key bypasses RLS entirely — it always has full row-level access.

- **"Automatically expose new tables"** controls whether new tables are *visible to the PostgREST Data API at all*. When this is turned OFF, new tables are not granted to any API role by default — meaning PostgREST cannot access them, even with the `service_role` key, because the underlying database-level permission (`GRANT`) was never issued.

This is why turning off "Automatically expose new tables" still causes `permission denied` even when using the `service_role` key — it's a different layer of access control.
```bash
◇ injected env (5) from .env.local // tip: ◈ secrets for agents [www.dotenvx.com]
❌ Error: permission denied for table recordings
```
The `GRANT` statements above fix this by explicitly giving `service_role` permission to access each table.

---

#### 2.4 Run the SQL in Supabase

1. In your Supabase project, click **"SQL Editor"** in the left sidebar
2. Click **"New query"**
3. Paste the entire SQL from `001_schema.sql` into the editor
4. Click **"Run"** (or press `Cmd + Enter`)
5. You should see: `Success. No rows returned`

---

#### 2.5 Verify the tables were created

1. Go to **"Table Editor"** in the left sidebar
2. You should see three tables: `recordings`, `transcript`, `analysis`
3. Click into each one to confirm the columns match the schema above

---

#### 2.6 Set up the Supabase client in code

Open `lib/supabase.ts` and add:

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Browser-safe client (limited permissions)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server-only client (full permissions — only use in API routes)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
```

> ✅ Use `supabase` in client components, `supabaseAdmin` in server-side API routes only.

---

#### 2.7 Test the connection

In your terminal, make sure you are inside the project ai-pipeline folder, then run:

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
client.from('recordings').select('*').limit(1).then(({ data, error }) => {
  if (error) console.error('❌ Error:', error.message);
  else console.log('✅ Connected to Supabase! Rows:', data.length);
});
"
```

> ⚠️ We use `SUPABASE_SERVICE_ROLE_KEY` here instead of `NEXT_PUBLIC_SUPABASE_ANON_KEY` because `RLS` is enabled — the anon key has no table permissions by default and will return `permission denied`. The service role key bypasses RLS and is the correct key to use for server-side testing.

If `dotenv` is not installed yet, run `npm install dotenv` first.

You should see:
```bash
◇ injected env (5) from .env.local // tip: ⌘ enable debugging { debug: true }
✅ Connected to Supabase! Rows: 0
```

> ✅ If it works, **Step 2 is complete.** Move on to [Step 3 — LLM Selection](ai-pipeline-mvp-outline.md#step-3--llm-selection).
