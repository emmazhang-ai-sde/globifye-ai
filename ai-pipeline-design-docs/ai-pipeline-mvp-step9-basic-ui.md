# Step 9 — Basic UI (Next.js page)

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step replaces the default Next.js starter page with a single-page UI that drives the full pipeline end-to-end: upload audio → view transcript → click Analyze → view results.

---

## What you will do in this step

**9.2** — Understand the page state and data flow  
**9.3** — Replace `app/page.tsx` with the pipeline UI  
**9.4** — Test end-to-end in the browser  
**9.5** — Common errors and fixes

---

#### 9.2 Understand the page state and data flow

The page holds all pipeline state in React `useState` hooks — no external state library needed for the MVP.

```
User picks a file
    ↓
clicks "Start Transcription"
    ↓
POST /api/transcribe  →  { recording_id, utterances[] }
    ↓
utterances displayed in Transcript panel
recording_id stored in state
    ↓
clicks "Analyze Call"
    ↓
POST /api/analyze  →  full analysis row
    ↓
Summary / Key Topics / Objection Analysis / What Went Well panels rendered
```

**Why transcript comes from the API response, not a DB fetch:**
`/api/transcribe` returns the utterances directly in its response. The UI stores them in state immediately — no second round-trip to fetch from the DB. This matches the pipeline spec ("transcript passed directly from frontend state").

**Key state variables:**

| Variable | Type | Set by |
|---|---|---|
| `file` | `File \| null` | file input |
| `recordingId` | `string \| null` | transcribe response |
| `utterances` | `Utterance[]` | transcribe response |
| `analysis` | `Analysis \| null` | analyze response |
| `isTranscribing` | `boolean` | loading flag |
| `isAnalyzing` | `boolean` | loading flag |
| `error` | `string \| null` | any failed request |

---

#### 9.3 Replace `app/page.tsx`

Open `app/page.tsx` and replace the entire contents with the code below. Design decisions:

- **Dark header** with DialForge branding and recording ID indicator
- **3-step progress bar** — highlights the current step (Upload → Transcript → Analysis), turns green when a step is done
- **Styled file upload zone** — dashed border, shows filename and file size when selected
- **Color-coded speaker badges** — each speaker gets a distinct color (blue / violet / amber / emerald)
- **Red cards** for objections, **green cards** for what went well — visually distinct at a glance
- **Disabled state styling** on buttons — grey out instead of hiding when loading

```tsx
'use client'

import { useState } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Utterance = {
  speaker: number
  transcript: string
  start: number
  end: number
}

type Analysis = {
  id: string
  recording_id: string
  summary: string
  key_topics: { name: string; start_time: number }[]
  objection_analysis: {
    timestamp: number
    speaker: string
    exact_quote: string
    reason: string
    suggestion: string
  }[]
  what_went_well: {
    timestamp: number
    speaker: string
    exact_quote: string
    reason: string
  }[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [utterances, setUtterances] = useState<Utterance[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleTranscribe() {
    if (!file) return
    setIsTranscribing(true)
    setError(null)
    setUtterances([])
    setAnalysis(null)

    const formData = new FormData()
    formData.append('audio', file)

    const res = await fetch('/api/transcribe', { method: 'POST', body: formData })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Transcription failed')
      setIsTranscribing(false)
      return
    }

    setRecordingId(data.recording_id)
    setUtterances(data.utterances)
    setIsTranscribing(false)
  }

  async function handleAnalyze() {
    if (!recordingId) return
    setIsAnalyzing(true)
    setError(null)

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recording_id: recordingId }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Analysis failed')
      setIsAnalyzing(false)
      return
    }

    setAnalysis(data)
    setIsAnalyzing(false)
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <main className="max-w-4xl mx-auto p-8 font-sans">
      <h1 className="text-2xl font-bold mb-8">Sales Call Pipeline — Demo</h1>

      {/* ---- Upload ---- */}
      <section className="mb-8">
        <input
          type="file"
          accept="audio/*"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="block mb-4"
        />
        <button
          onClick={handleTranscribe}
          disabled={!file || isTranscribing}
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        >
          {isTranscribing ? 'Transcribing...' : 'Start Transcription'}
        </button>
      </section>

      {error && (
        <p className="text-red-600 mb-6 text-sm">{error}</p>
      )}

      {/* ---- Transcript panel ---- */}
      {utterances.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Transcript</h2>
          <div className="border rounded p-4 max-h-80 overflow-y-auto space-y-2 bg-gray-50">
            {utterances.map((u, i) => (
              <div key={i} className="text-sm">
                <span className="font-medium text-gray-500 mr-2">
                  Speaker {u.speaker} [{formatTime(u.start)}]
                </span>
                {u.transcript}
              </div>
            ))}
          </div>
          <button
            onClick={handleAnalyze}
            disabled={isAnalyzing}
            className="mt-4 px-4 py-2 bg-green-600 text-white rounded disabled:opacity-50"
          >
            {isAnalyzing ? 'Analyzing...' : 'Analyze Call'}
          </button>
        </section>
      )}

      {/* ---- Analysis results ---- */}
      {analysis && (
        <section className="space-y-8">

          {/* Summary */}
          <div>
            <h2 className="text-xl font-semibold mb-2">Summary</h2>
            <p className="text-gray-700 text-sm leading-relaxed">{analysis.summary}</p>
          </div>

          {/* Key Topics */}
          <div>
            <h2 className="text-xl font-semibold mb-2">Key Topics</h2>
            <ul className="space-y-1">
              {analysis.key_topics.map((t, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  <span className="text-gray-400 font-mono w-10">{formatTime(t.start_time)}</span>
                  <span>{t.name}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Objection Analysis */}
          <div>
            <h2 className="text-xl font-semibold mb-2">Objection Analysis</h2>
            {analysis.objection_analysis.length === 0 ? (
              <p className="text-gray-400 text-sm">No objections detected.</p>
            ) : (
              <div className="space-y-4">
                {analysis.objection_analysis.map((o, i) => (
                  <div key={i} className="border rounded p-4 bg-red-50">
                    <div className="text-xs text-gray-400 mb-2">
                      {o.speaker} · {formatTime(o.timestamp)}
                    </div>
                    <blockquote className="italic text-sm text-gray-600 mb-2 border-l-2 border-red-300 pl-3">
                      "{o.exact_quote}"
                    </blockquote>
                    <p className="text-sm"><span className="font-medium">Why: </span>{o.reason}</p>
                    <p className="text-sm mt-1"><span className="font-medium">Suggestion: </span>{o.suggestion}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* What Went Well */}
          <div>
            <h2 className="text-xl font-semibold mb-2">What Went Well</h2>
            {analysis.what_went_well.length === 0 ? (
              <p className="text-gray-400 text-sm">Nothing notable detected.</p>
            ) : (
              <div className="space-y-4">
                {analysis.what_went_well.map((w, i) => (
                  <div key={i} className="border rounded p-4 bg-green-50">
                    <div className="text-xs text-gray-400 mb-2">
                      {w.speaker} · {formatTime(w.timestamp)}
                    </div>
                    <blockquote className="italic text-sm text-gray-600 mb-2 border-l-2 border-green-300 pl-3">
                      "{w.exact_quote}"
                    </blockquote>
                    <p className="text-sm"><span className="font-medium">Why: </span>{w.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

        </section>
      )}
    </main>
  )
}
```

---

#### 9.4 Test end-to-end in the browser

**Step 1 — Start the dev server** (if not already running):

```bash
cd ai-pipeline
npm run dev
```

**Step 2 — Open the page**

Go to `http://localhost:3000` in the browser.

**Step 3 — Upload and transcribe**

1. Click "Choose File" and select `sample-audio/sample-audio-1.mp3`
2. Click **Start Transcription**
3. Wait ~10–20 seconds for Deepgram to process
4. The transcript should appear with speaker labels and timestamps

**Step 4 — Analyze**

1. Click **Analyze Call**
2. Wait ~5–10 seconds for the LLM call
3. All four result sections should appear below the transcript

**What a successful result looks like:**

| Section | Expected |
|---|---|
| Summary | 2–3 sentence paragraph |
| Key Topics | List with timestamps |
| Objection Analysis | One or more cards (or "No objections detected" for clean calls) |
| What Went Well | One or more cards |

---

#### 9.5 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| Blank page / no button | `'use client'` missing from top of `page.tsx` | Add `'use client'` as the very first line |
| "Transcription failed" | Deepgram API key missing or audio file too short | Check `DEEPGRAM_API_KEY` in `.env.local`; use a file with audible speech |
| Transcript appears but Analyze button does nothing | `recordingId` is null | Check browser console — transcribe response may have errored silently |
| "Analysis failed" | Groq rate limit or `GROQ_API_KEY` missing | Check `.env.local`; wait 60 seconds and retry if rate limited |
| Styles not applying | Tailwind not configured | Confirm `tailwind.config.ts` includes `'./app/**/*.{ts,tsx}'` in content paths |
| Results show but layout broken | CSS class conflicts with existing globals | Check `app/globals.css` — remove conflicting base styles if needed |

---

> ✅ When all four result sections render after clicking Analyze, **Step 9 is complete** and the end-to-end pipeline is working in the browser.

→ Next: Step 10 — Real-time WebSocket Layer *(post-demo)*
