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

const SPEAKER_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-violet-100 text-violet-700',
  'bg-amber-100 text-amber-700',
  'bg-emerald-100 text-emerald-700',
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BatchPage() {
  const [file, setFile] = useState<File | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [utterances, setUtterances] = useState<Utterance[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const step = !utterances.length ? 1 : !analysis ? 2 : 3

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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <header className="bg-slate-900 text-white px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-md bg-blue-500 flex items-center justify-center text-sm font-bold">D</div>
          <span className="font-semibold tracking-tight">DialForge</span>
          <span className="text-slate-400 text-sm ml-1">· Batch Analysis</span>
        </div>
        <div className="flex items-center gap-4">
          {recordingId && (
            <span className="text-xs text-slate-400 font-mono">
              ID: {recordingId.slice(0, 8)}…
            </span>
          )}
          <a href="/" className="text-xs text-slate-400 hover:text-white transition-colors">
            ← Live Mode
          </a>
        </div>
      </header>

      {/* Progress bar */}
      <div className="bg-white border-b border-slate-200 px-8 py-3">
        <div className="max-w-4xl mx-auto flex items-center gap-2 text-sm">
          {['Upload & Transcribe', 'Review Transcript', 'Analysis'].map((label, i) => {
            const s = i + 1
            const done = step > s
            const active = step === s
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && <div className="w-8 h-px bg-slate-200" />}
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  done    ? 'bg-emerald-100 text-emerald-700' :
                  active  ? 'bg-blue-100 text-blue-700' :
                            'text-slate-400'
                }`}>
                  <span>{done ? '✓' : s}</span>
                  <span>{label}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-8 py-8 space-y-5">

        {/* Error banner */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-start gap-2">
            <span className="mt-0.5">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* Upload card */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">
            Audio File
          </h2>
          <label htmlFor="audio-upload" className="cursor-pointer block">
            <div className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
              file
                ? 'border-blue-300 bg-blue-50'
                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
            }`}>
              <input
                type="file"
                accept="audio/*"
                id="audio-upload"
                className="hidden"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="text-blue-700">
                  <p className="font-medium text-sm">{file.name}</p>
                  <p className="text-xs text-blue-400 mt-1">
                    {(file.size / 1024 / 1024).toFixed(2)} MB · click to change
                  </p>
                </div>
              ) : (
                <div className="text-slate-400">
                  <p className="font-medium text-sm text-slate-600">Click to upload audio</p>
                  <p className="text-xs mt-1">MP3, WAV, M4A supported</p>
                </div>
              )}
            </div>
          </label>
          <button
            onClick={handleTranscribe}
            disabled={!file || isTranscribing}
            className="mt-4 w-full py-2.5 rounded-lg text-sm font-medium transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:bg-slate-100 disabled:text-slate-400"
          >
            {isTranscribing ? 'Transcribing — this may take 10–20 seconds…' : 'Start Transcription'}
          </button>
        </div>

        {/* Transcript card */}
        {utterances.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Transcript
              </h2>
              <span className="text-xs text-slate-400">
                {utterances.length} segments · {formatTime(utterances.at(-1)?.end ?? 0)}
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {utterances.map((u, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <span className="font-mono text-xs text-slate-400 pt-0.5 w-10 shrink-0">
                    {formatTime(u.start)}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${
                    SPEAKER_COLORS[u.speaker % SPEAKER_COLORS.length]
                  }`}>
                    S{u.speaker}
                  </span>
                  <span className="text-slate-700 leading-relaxed">{u.transcript}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100">
              <button
                onClick={handleAnalyze}
                disabled={isAnalyzing}
                className="w-full py-2.5 rounded-lg text-sm font-medium transition-colors bg-emerald-600 hover:bg-emerald-700 text-white disabled:bg-slate-100 disabled:text-slate-400"
              >
                {isAnalyzing ? 'Analyzing — calling LLM…' : 'Analyze Call'}
              </button>
            </div>
          </div>
        )}

        {/* Analysis results */}
        {analysis && (
          <div className="space-y-5">

            {/* Summary */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Summary
              </h2>
              <p className="text-slate-700 text-sm leading-relaxed">{analysis.summary}</p>
            </div>

            {/* Key Topics */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Key Topics
              </h2>
              <div className="space-y-0">
                {analysis.key_topics.map((t, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
                    <span className="font-mono text-xs text-slate-400 w-10 shrink-0">
                      {formatTime(t.start_time)}
                    </span>
                    <span className="text-sm text-slate-700">{t.name}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Objection Analysis */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-baseline gap-2 mb-4">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Objection Analysis
                </h2>
                <span className="text-xs text-slate-400">
                  {analysis.objection_analysis.length} detected
                </span>
              </div>
              {analysis.objection_analysis.length === 0 ? (
                <p className="text-slate-400 text-sm">No objections detected in this call.</p>
              ) : (
                <div className="space-y-4">
                  {analysis.objection_analysis.map((o, i) => (
                    <div key={i} className="rounded-lg border border-red-100 bg-red-50 p-4">
                      <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                        <span>{o.speaker}</span>
                        <span>·</span>
                        <span className="font-mono">{formatTime(o.timestamp)}</span>
                      </div>
                      <blockquote className="text-sm italic text-slate-600 border-l-2 border-red-300 pl-3 mb-3">
                        "{o.exact_quote}"
                      </blockquote>
                      <p className="text-sm text-slate-700">
                        <span className="font-medium text-red-700">Why: </span>{o.reason}
                      </p>
                      <p className="text-sm text-slate-700 mt-1">
                        <span className="font-medium text-slate-600">Suggestion: </span>{o.suggestion}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* What Went Well */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-baseline gap-2 mb-4">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  What Went Well
                </h2>
                <span className="text-xs text-slate-400">
                  {analysis.what_went_well.length} moments
                </span>
              </div>
              {analysis.what_went_well.length === 0 ? (
                <p className="text-slate-400 text-sm">Nothing notable detected.</p>
              ) : (
                <div className="space-y-4">
                  {analysis.what_went_well.map((w, i) => (
                    <div key={i} className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
                      <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                        <span>{w.speaker}</span>
                        <span>·</span>
                        <span className="font-mono">{formatTime(w.timestamp)}</span>
                      </div>
                      <blockquote className="text-sm italic text-slate-600 border-l-2 border-emerald-300 pl-3 mb-3">
                        "{w.exact_quote}"
                      </blockquote>
                      <p className="text-sm text-slate-700">
                        <span className="font-medium text-emerald-700">Why: </span>{w.reason}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}
      </main>
    </div>
  )
}
