# Step 8 — Next.js API Routes

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step wires the pipeline functions from Steps 4–7 into Next.js API routes that the UI (Step 9) will call. Each route is a thin wrapper — it validates the request, calls one or two existing functions, and returns the result as JSON.

---

## What you will do in this step

**8.2** — Understand the route layout and what each route calls  
**8.3** — Create `app/api/recordings/create/route.ts`  
**8.4** — Create `app/api/transcribe/route.ts`  
**8.5** — Create `app/api/analyze/route.ts`  
**8.6** — Create `app/api/analysis/[id]/route.ts`  
**8.7** — Start the dev server and test each route with curl  
**8.8** — Common errors and fixes

---

#### 8.2 Understand the route layout

**Directory structure you'll create:**

```
app/api/
  recordings/
    create/
      route.ts          ← POST /api/recordings/create
  transcribe/
    route.ts            ← POST /api/transcribe
  analyze/
    route.ts            ← POST /api/analyze
  analysis/
    [id]/
      route.ts          ← GET  /api/analysis/:id
```

> The directories `app/api/recordings/`, `app/api/transcribe/`, and `app/api/analyze/` were created as empty placeholders in Step 1. You'll add `route.ts` files inside them (and create `recordings/create/` and `analysis/[id]/` as new subdirectories).

**What each route calls:**

| Route | Method | Calls | Returns |
|---|---|---|---|
| `/api/recordings/create` | POST | `createRecording()` from `lib/supabase.ts` | `{ recording_id }` |
| `/api/transcribe` | POST | `transcribeFile()` from `lib/deepgram.ts` → `createRecording()` + `writeTranscript()` from `lib/supabase.ts` | `{ recording_id, utterances }` |
| `/api/analyze` | POST | `writeAnalysis()` from `lib/llm.ts` | full analysis row from DB |
| `/api/analysis/:id` | GET | direct Supabase query | full analysis row from DB |

All four routes use `supabaseAdmin` (the service role client) either directly or via the helper functions — never the browser-safe `supabase` client. API routes run server-side and need the service role key to bypass RLS.

> **MVP vs. production note on `supabaseAdmin` and RLS:**
> Using the service role key bypasses all RLS policies, which is fine for the demo where there is no auth yet. In production, this changes significantly.
>
> From the May 28 team meeting, Abraham and Kim own the Supabase Auth, RBAC, and RLS design. The platform will have two separate permission matrices:
> - **DialForge internal:** Super Admin → Admin → Team Member
> - **Client-side:** Account Owner → Admin → Team Member
>
> Once that auth layer is in place, these API routes will need to verify the caller's role before executing DB operations — either by adding application-level permission checks before calling `supabaseAdmin`, or by switching to a user-scoped Supabase client and letting RLS enforce access automatically. Using `supabaseAdmin` in production without auth checks means any caller can read or write any row, which is a security gap. Coordinate with Abraham/Kim before wiring these routes into the production frontend.

---

#### 8.3 Create `app/api/recordings/create/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { createRecording } from '@/lib/supabase'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const recordingId = await createRecording(body.call_metadata ?? {})
    return NextResponse.json({ recording_id: recordingId })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
```

**What this does:** Creates a new row in the `recordings` table and returns its UUID. The `call_metadata` body field is optional — if omitted, it defaults to `{}`.

**When this gets called:** From the Step 9 UI, when the user clicks "Start" before uploading an audio file. The returned `recording_id` is passed to subsequent calls.

> **Why a dedicated `/create` route and not just `POST /api/recordings`?**
> The `recordings` directory already exists and will later get other routes (e.g. `GET /api/recordings/[id]` for fetching call history). Nesting under `create/` keeps the intent explicit and avoids a conflict with future `[id]` dynamic routes under the same parent.

---

#### 8.4 Create `app/api/transcribe/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { transcribeFile } from '@/lib/deepgram'
import { createRecording, writeTranscript } from '@/lib/supabase'

export async function POST(req: Request) {
  const formData = await req.formData()
  const file = formData.get('audio') as File | null

  if (!file) {
    return NextResponse.json(
      { error: 'No audio file provided. Send the file as form field name: audio' },
      { status: 400 }
    )
  }

  const ext = file.name.split('.').pop() ?? 'wav'
  const tmpPath = join(tmpdir(), `${randomUUID()}.${ext}`)

  try {
    // Write the uploaded file to /tmp so transcribeFile() can read it by path
    await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()))

    const utterances = await transcribeFile(tmpPath)
    const recordingId = await createRecording({ filename: file.name })
    await writeTranscript(recordingId, utterances)

    return NextResponse.json({ recording_id: recordingId, utterances })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  } finally {
    // Clean up the temp file whether the request succeeded or failed
    await unlink(tmpPath).catch(() => {})
  }
}
```

**Key decisions in this code:**

**Temp file in `/tmp`** — `transcribeFile()` in `lib/deepgram.ts` accepts a file path, not a Buffer. The uploaded `File` object from FormData is an in-memory blob. Writing it to `tmpdir()` (which is `/tmp` on Vercel's serverless environment) bridges the gap without changing `transcribeFile`. The `finally` block deletes it whether the request succeeds or fails.

**`randomUUID()` in the filename** — Prevents filename collisions if two uploads happen concurrently on the same serverless instance.

**`createRecording` after `transcribeFile`** — Deepgram is the most likely failure point (wrong file format, API key issue, network timeout). Creating the DB row only after a successful transcription avoids leaving orphaned recording rows if Deepgram fails.

**`utterances` in the response** — Returned alongside `recording_id` so the UI can display the transcript immediately from the response without a second DB fetch.

---

#### 8.5 Create `app/api/analyze/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { writeAnalysis } from '@/lib/llm'

export async function POST(req: Request) {
  try {
    const { recording_id } = await req.json()

    if (!recording_id) {
      return NextResponse.json({ error: 'recording_id is required' }, { status: 400 })
    }

    const data = await writeAnalysis(recording_id)
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
```

**What this does:** Accepts a `recording_id`, fetches the transcript rows from Supabase, calls the LLM, writes the analysis row, and returns the full analysis object. All that logic lives in `writeAnalysis()` from Step 7 — this route is purely the HTTP wrapper.

---

#### 8.6 Create `app/api/analysis/[id]/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params  // Next.js 15+ requires params to be awaited
  const { data, error } = await supabaseAdmin
    .from('analysis')
    .select('*')
    .eq('recording_id', id)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 })
  }

  return NextResponse.json(data)
}
```

**What this does:** Fetches a stored analysis row by `recording_id`. Used by the Step 9 UI when loading a past call's results rather than triggering a fresh analysis.

**`[id]` in the directory name** — Next.js App Router treats square-bracket folder names as dynamic segments. The value at that URL position is passed to the handler as `params.id`. So `GET /api/analysis/abc-123` sets `params.id = "abc-123"`.

> **Shell note:** When creating the directory manually, escape the brackets — `mkdir -p app/api/analysis/\[id\]` — or your shell will try to interpret them as a glob.

---

#### 8.7 Start the dev server and test with curl

**Step 1 — Start the dev server**

```bash
cd ai-pipeline
npm run dev
```

The server starts on `http://localhost:3000`. Leave this terminal running and open a second terminal for the curl commands below.

> All curl commands below assume you are in the `ai-pipeline/` directory. Run `cd ai-pipeline` in the second terminal before proceeding.

**Step 2 — Test `POST /api/recordings/create`**

```bash
curl -s -X POST http://localhost:3000/api/recordings/create \
  -H "Content-Type: application/json" \
  -d '{"call_metadata": {"rep": "Test Rep", "client": "Test Client"}}' | jq
```

Expected response:
```json
{ "recording_id": "a1b2c3d4-e5f6-..." }
```

**Step 3 — Test `POST /api/transcribe`**

Use the same sample audio file from Step 4:

```bash
curl -s -X POST http://localhost:3000/api/transcribe \
  -F "audio=@./sample-audio/sample-audio-1.mp3" | jq
```

Expected response (abbreviated):
```json
{
  "recording_id": "b2c3d4e5-...",
  "utterances": [
    { "speaker": 0, "transcript": "Hi, thanks for calling GlobiFYE.", "start": 1.0, "end": 3.2 },
    { "speaker": 1, "transcript": "Yeah, um, I had a question about pricing.", "start": 5.2, "end": 8.0 }
  ]
}
```

> ⚠️ Copy the `recording_id` from this response — you'll need it for Steps 4 and 5.

**Step 4 — Test `POST /api/analyze`**

⚠️ Paste the `recording_id` from the transcribe response:

```bash
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"recording_id": "paste-uuid-here"}' | jq
```

✅ Expected response (abbreviated):
```json
{
  "id": "c3d4e5f6-...",
  "recording_id": "b2c3d4e5-...",
  "summary": "The sales rep discussed pricing and feature fit...",
  "key_topics": [...],
  "objection_analysis": [...],
  "what_went_well": [...],
  "raw_llm_output": "..."
}
```

**Step 5 — Test `GET /api/analysis/[id]`**

**Use the same `recording_id`**:

```bash
curl -s http://localhost:3000/api/analysis/paste-uuid-here | jq
```

Expected response: 
⚠️ same shape as the analyze response above — the stored row fetched from Supabase.

> If you don't have `jq` installed, remove `| jq` from the commands. The response will still print, just without formatting.

---

#### 8.8 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `404 Not Found` on any route | `route.ts` is in the wrong directory, or the export function name is wrong | Next.js App Router requires the file to be named exactly `route.ts` and the exported function to match the HTTP method (`GET`, `POST`, etc.) |
| `No audio file provided` from `/api/transcribe` | curl `-F` field name doesn't match | The field name must be `audio` — change `-F "file=@..."` to `-F "audio=@..."` |
| `ENOENT` writing to `/tmp` | Unlikely on Vercel/macOS; possible if `tmpdir()` returns an unexpected path | `console.log(tmpPath)` in the handler to confirm the path is writable |
| `Deepgram returned no utterances` | Audio file format unsupported or audio is silent | Test with the same `.wav` that worked in Step 4's `scripts/test-deepgram.ts` |
| `No transcript rows found` from `/api/analyze` | `/api/transcribe` was not called first for this `recording_id` | Run Step 3 (transcribe) before Step 4 (analyze) |
| `Cannot find module '@/lib/supabase'` | `@/*` path alias not resolving | Confirm `tsconfig.json` has `"paths": { "@/*": ["./*"] }` and you're running `npm run dev` (not `ts-node` directly) |
| `supabaseUrl is required` | Env vars not loaded | Next.js dev server loads `.env.local` automatically — confirm the file exists at `ai-pipeline/.env.local` |
| `mkdir: [id]: no such file or directory` | Shell globbing the brackets | Use `mkdir -p app/api/analysis/\[id\]` with escaped brackets |

---

> ✅ When all four curl commands return expected JSON and Supabase shows the rows, **Step 8 is complete.**

→ [Next: Step 9 — Basic UI]()
