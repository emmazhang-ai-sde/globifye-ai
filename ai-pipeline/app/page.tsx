'use client'

import { useState, useRef } from 'react' // 10.2 added useRef — needed to hold WebSocket and MediaRecorder across renders

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

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [utterances, setUtterances] = useState<Utterance[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 10.2 — refs hold the live WebSocket and MediaRecorder instances.
  // useRef instead of useState because changing them should NOT trigger a re-render.
  const wsRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)

  // 10.2 — new state for live transcription mode
  const [isLive, setIsLive] = useState(false)          // true while mic is streaming
  const [liveCaption, setLiveCaption] = useState('')    // partial (in-progress) transcript shown in the caption box

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

  // 10.2 — startLive: fetches a short-lived token, then opens the WebSocket to Deepgram.
  // Steps 10.3 / 10.4 / 10.5 are wired up inside here (mic capture, captions, DB write).
  async function startLive() {
    if (!recordingId) {
      setError('Run a batch transcription first to get a recording ID before starting live mode.')
      return
    }
    setError(null)

    // 10.2 step 1 — ask our own server for a short-lived Deepgram token
    const { key } = await fetch('/api/deepgram-token').then(r => r.json())

    // 10.2 step 2 — open the WebSocket using that token as the subprotocol
    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen` +
      `?model=nova-3&language=en-US&diarize=true&interim_results=true&punctuate=true`,
      ['token', key]
    )

    wsRef.current = ws
    setIsLive(true)

    // 10.3 — once the WebSocket is ready, start the microphone
    ws.addEventListener('open', async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorderRef.current = recorder

      // 10.3 — send each 150ms audio chunk as a binary frame to Deepgram
      recorder.addEventListener('dataavailable', (e) => {
        if (ws.readyState === WebSocket.OPEN && e.data.size > 0) ws.send(e.data)
      })

      recorder.start(150)
    })

    // 10.4 / 10.5 — handle messages from Deepgram
    ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data as string)
      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? ''
      if (!transcript) return

      if (!msg.is_final) {
        // 10.4 — partial result: update the live caption display only, no DB write
        setLiveCaption(transcript)
        return
      }

      // 10.5 — final result: clear caption and write the utterance to Supabase
      setLiveCaption('')
      const words = msg.channel.alternatives[0].words ?? []
      await fetch('/api/transcribe/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recording_id: recordingId,
          speaker: words[0]?.speaker ?? 0,
          content_raw: transcript,
          sentence_start_sec: words[0]?.start ?? 0,
        }),
      })
    })

    // 10.2 — clean up if the WebSocket errors or closes unexpectedly
    ws.addEventListener('error', () => { setError('WebSocket error — check the console'); stopLive() })
    ws.addEventListener('close', () => setIsLive(false))
  }

  // 10.2 — stopLive: stops the mic recorder and closes the WebSocket
  function stopLive() {
    recorderRef.current?.stop()
    wsRef.current?.close()
    recorderRef.current = null
    wsRef.current = null
    setIsLive(false)
    setLiveCaption('')
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
          <span className="text-slate-400 text-sm ml-1">· Call Analysis</span>
        </div>
        {recordingId && (
          <span className="text-xs text-slate-400 font-mono">
            ID: {recordingId.slice(0, 8)}…
          </span>
        )}
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

        {/* 10.2 — Live transcription card (shown once a recordingId exists) */}
        {recordingId && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Live Transcription
            </h2>
            <div className="flex gap-3">
              {/* 10.2 — Start button: disabled if already live or no recordingId */}
              <button
                onClick={startLive}
                disabled={isLive}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white disabled:bg-slate-100 disabled:text-slate-400 transition-colors"
              >
                Start Live Transcription
              </button>
              {/* 10.2 — Stop button: disabled when not live */}
              <button
                onClick={stopLive}
                disabled={!isLive}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-600 hover:bg-slate-700 text-white disabled:bg-slate-100 disabled:text-slate-400 transition-colors"
              >
                Stop
              </button>
            </div>
            {/* 10.4 — live caption box: only visible while streaming */}
            {isLive && (
              <div className="mt-4 p-4 bg-slate-900 text-green-400 rounded-lg font-mono text-sm min-h-12">
                {liveCaption || <span className="opacity-40">Listening…</span>}
              </div>
            )}
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
