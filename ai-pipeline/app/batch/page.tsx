'use client'

import { useState } from 'react'

// =====================================================================
// Types — match what /api/transcribe and /api/analyze return
// =====================================================================

type Utterance = {
  speaker: string             // "Speaker 0"
  transcript: string          // content_clean from API
  content_raw: string
  start: number               // sentence_start_sec
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

// =====================================================================
// Helpers
// =====================================================================

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// =====================================================================
// Page
// =====================================================================

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [utterances, setUtterances] = useState<Utterance[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  async function handleTranscribe() {
    if (!file) return
    setIsTranscribing(true)
    setError(null)
    setUtterances([])
    setAnalysis(null)

    try {
      const formData = new FormData()
      formData.append('audio', file)

      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Transcription failed')
        return
      }

      setRecordingId(data.recording_id)
      setUtterances(data.utterances)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsTranscribing(false)
    }
  }

  async function handleAnalyze() {
    if (!recordingId) return
    setIsAnalyzing(true)
    setError(null)

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recording_id: recordingId }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Analysis failed')
        return
      }

      setAnalysis(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsAnalyzing(false)
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <main className="max-w-4xl mx-auto p-8 font-sans">
      <h1 className="text-2xl font-bold mb-2">Sales Call Pipeline</h1>
      <p className="text-sm text-gray-500 mb-8">
        Upload a sales call recording → get a transcript → analyze for objections and coaching insights.
      </p>

      {/* ============ Upload ============ */}
      <section className="mb-8">
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block mb-4 text-sm"
        />
        <button
          onClick={handleTranscribe}
          disabled={!file || isTranscribing}
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        >
          {isTranscribing ? 'Transcribing…' : 'Start Transcription'}
        </button>
        {file && !isTranscribing && (
          <p className="mt-2 text-xs text-gray-500">
            Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
          </p>
        )}
      </section>

      {/* ============ Error ============ */}
      {error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* ============ Transcript ============ */}
      {utterances.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Transcript</h2>
          <div className="border rounded p-4 max-h-80 overflow-y-auto space-y-2 bg-gray-50">
            {utterances.map((u, i) => (
              <div key={i} className="text-sm">
                <span className="font-medium text-gray-500 mr-2">
                  {u.speaker} [{formatTime(u.start)}]
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
            {isAnalyzing ? 'Analyzing…' : 'Analyze Call'}
          </button>
        </section>
      )}

      {/* ============ Analysis ============ */}
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
            {analysis.key_topics.length === 0 ? (
              <p className="text-gray-400 text-sm">No key topics identified.</p>
            ) : (
              <ul className="space-y-1">
                {analysis.key_topics.map((t, i) => (
                  <li key={i} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-400 font-mono w-12">{formatTime(t.start_time)}</span>
                    <span>{t.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Objections */}
          <div>
            <h2 className="text-xl font-semibold mb-2">Objection Analysis</h2>
            {analysis.objection_analysis.length === 0 ? (
              <p className="text-gray-400 text-sm">No objections detected.</p>
            ) : (
              <div className="space-y-4">
                {analysis.objection_analysis.map((o, i) => (
                  <div key={i} className="border rounded p-4 bg-red-50">
                    <div className="text-xs text-gray-500 mb-2">
                      {o.speaker} · {formatTime(o.timestamp)}
                    </div>
                    <blockquote className="italic text-sm text-gray-700 mb-2 border-l-2 border-red-400 pl-3">
                      &ldquo;{o.exact_quote}&rdquo;
                    </blockquote>
                    <p className="text-sm">
                      <span className="font-medium">Why: </span>
                      {o.reason}
                    </p>
                    <p className="text-sm mt-1">
                      <span className="font-medium">Suggestion: </span>
                      {o.suggestion}
                    </p>
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
                    <div className="text-xs text-gray-500 mb-2">
                      {w.speaker} · {formatTime(w.timestamp)}
                    </div>
                    <blockquote className="italic text-sm text-gray-700 mb-2 border-l-2 border-green-400 pl-3">
                      &ldquo;{w.exact_quote}&rdquo;
                    </blockquote>
                    <p className="text-sm">
                      <span className="font-medium">Why: </span>
                      {w.reason}
                    </p>
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

