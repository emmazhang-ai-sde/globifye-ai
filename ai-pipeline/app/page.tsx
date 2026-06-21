'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'

// =====================================================================
// Types
// =====================================================================

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
  // ---- Refs (persist across renders, don't trigger re-renders) ----
  const sequenceIndexRef = useRef(0)
  const wsRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)

  // ---- State ----
  const [agentMode, setAgentMode] = useState(false)
  const conversationHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'speaking'>('idle')
  const audioContextRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [isLive, setIsLive] = useState(false)
  const [liveCaption, setLiveCaption] = useState('')
  const [sessionComplete, setSessionComplete] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ------------------------------------------------------------------
  // Start live transcription
  // ------------------------------------------------------------------
  async function startLive() {
    // Create AudioContext during user click — this permanently unlocks autoplay
    // for this page session. Must be created here (user gesture), not later.
    try {
      audioContextRef.current = new AudioContext()
      await audioContextRef.current.resume()
    } catch {
      // Non-fatal — audio may not work but transcription still will
    }

    setError(null)
    setAnalysis(null)
    setSessionComplete(false)
    sequenceIndexRef.current = 0
    conversationHistoryRef.current = []

    try {
      const createRes = await fetch('/api/recordings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in-progress' }),
      })
      const createData = await createRes.json()

      if (!createRes.ok || !createData.recording_id) {
        setError(createData.error ?? 'Failed to create recording session')
        return
      }

      const liveRecordingId = createData.recording_id
      setRecordingId(liveRecordingId)

      const tokenRes = await fetch('/api/deepgram-token')
      const tokenData = await tokenRes.json()

      if (!tokenRes.ok || !tokenData.key) {
        setError(tokenData.error ?? 'Failed to get Deepgram token')
        return
      }

      const ws = new WebSocket(
        `wss://api.deepgram.com/v1/listen` +
        `?model=nova-3&language=en-US&diarize=true&interim_results=true&punctuate=true`,
        ['token', tokenData.key],
      )
      wsRef.current = ws
      setIsLive(true)

      ws.addEventListener('open', async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'].find(
            type => MediaRecorder.isTypeSupported(type))
          const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
          recorderRef.current = recorder

          recorder.addEventListener('dataavailable', (e) => {
            if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
              ws.send(e.data)
            }
          })

          recorder.start(150)
        } catch (err) {
          setError(`Microphone error: ${(err as Error).message}`)
          stopLive()
        }
      })

      ws.addEventListener('message', async (event) => {
        const msg = JSON.parse(event.data as string)
        const transcript = msg.channel?.alternatives?.[0]?.transcript ?? ''
        if (!transcript) return

        if (!msg.is_final) {
          setLiveCaption(transcript)
          return
        }

        setLiveCaption('')
        const words = msg.channel.alternatives[0].words ?? []

        await fetch('/api/transcribe/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recording_id: liveRecordingId,
            speaker: `Speaker ${words[0]?.speaker ?? 0}`,
            content_raw: transcript,
            sentence_start_sec: words[0]?.start ?? 0,
            sequence_index: sequenceIndexRef.current++,
          }),
        })

        if (agentMode) {
          setAgentStatus('thinking')
          try {
            const res = await fetch('/api/agent/respond', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                utterance: transcript,
                history: conversationHistoryRef.current,
              }),
            })

            if (!res.ok) throw new Error(`Agent respond failed: ${res.status}`)

            const agentText = decodeURIComponent(
              res.headers.get('X-Agent-Response-Text') ?? '',
            )

            conversationHistoryRef.current = [
              ...conversationHistoryRef.current,
              { role: 'user', content: transcript },
              { role: 'assistant', content: agentText },
            ]

            // Stop any currently playing audio
            if (sourceNodeRef.current) {
              sourceNodeRef.current.onended = null
              sourceNodeRef.current.stop()
              sourceNodeRef.current = null
            }

            // Decode and play via the persistent AudioContext (no autoplay block)
            const arrayBuffer = await res.arrayBuffer()
            const audioBuffer = await audioContextRef.current!.decodeAudioData(arrayBuffer)

            const source = audioContextRef.current!.createBufferSource()
            source.buffer = audioBuffer
            source.connect(audioContextRef.current!.destination)
            source.onended = () => {
              setAgentStatus('idle')
              sourceNodeRef.current = null
            }
            sourceNodeRef.current = source

            setAgentStatus('speaking')
            source.start(0)
          } catch (err) {
            console.error('Agent error:', err)
            setAgentStatus('idle')
          }
        }
      })

      ws.addEventListener('error', () => {
        setError('WebSocket error — check the browser console')
        stopLive()
      })

      ws.addEventListener('close', () => {
        setIsLive(false)
      })
    } catch (err) {
      setError((err as Error).message)
      setIsLive(false)
    }
  }
  // ------------------------------------------------------------------
  // Stop live transcription
  // ------------------------------------------------------------------
  function stopLive() {
    recorderRef.current?.stop()
    wsRef.current?.close()
    sourceNodeRef.current?.stop()
    audioContextRef.current?.close()
    recorderRef.current = null
    wsRef.current = null
    sourceNodeRef.current = null
    audioContextRef.current = null
    setIsLive(false)
    setLiveCaption('')
    setSessionComplete(true)
  }

  // ------------------------------------------------------------------
  // Trigger LLM analysis
  // ------------------------------------------------------------------
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
    <main className="min-h-screen bg-surface relative overflow-hidden">
      {/* Ambient Glows */}
      <div className="ambient-glow bg-red-600 top-0 left-0"></div>
      <div className="ambient-glow bg-green-500 bottom-0 right-0" style={{ animationDelay: '-5s' }}></div>

      {/* Content */}
      <div className="relative z-10">
        {/* Header */}
        <header className="border-b border-white/5 backdrop-blur-xl sticky top-0 z-40">
          <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-2xl text-red-500">call</span>
              <h1 className="headline-lg text-white">GlobiFYE Sales Pipeline</h1>
            </div>
            <Link
              href="/batch"
              className="text-sm text-gray-400 hover:text-white transition-colors flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">upload_file</span>
              Batch Upload
            </Link>
          </div>
        </header>

        {/* Main Content */}
        <div className="max-w-6xl mx-auto px-6 py-12">
          {/* Hero Section */}
          <div className="mb-12">
            <h2 className="text-4xl font-bold text-white mb-2">
              Record a Live Call
            </h2>
            <p className="text-on-surface-variant">
              Capture every word with real-time transcription and AI coaching insights.
            </p>
          </div>

          {/* Grid Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Panel - Live Transcription */}
            <div className="lg:col-span-2 space-y-6">
              {/* Live Status Card */}
              <div className="liquid-glass rounded-2xl p-8">
                <div className="flex items-center gap-4 mb-6">
                  <div className={`w-3 h-3 rounded-full transition-all ${isLive ? 'bg-red-500 pulse-live' : 'bg-gray-600'
                    }`}></div>
                  <span className="text-sm font-mono text-gray-400">
                    {isLive ? 'RECORDING' : 'READY'}
                  </span>
                </div>

                {/* Live Caption Box */}
                {isLive && (
                  <div className="mb-6 p-4 bg-surface/50 rounded-lg border border-green-500/20">
                    <p className="text-green-400 font-mono text-sm min-h-8">
                      {liveCaption || <span className="text-gray-600">Listening…</span>}
                    </p>
                  </div>
                )}

                {/* Control Buttons */}
                <div className="flex gap-3">
                  {!isLive ? (
                    <button
                      onClick={startLive}
                      disabled={isAnalyzing}
                      className="btn-primary flex-1"
                    >
                      <span className="material-symbols-outlined mr-2">mic</span>
                      Start Recording
                    </button>
                  ) : (
                    <button
                      onClick={stopLive}
                      className="flex-1 px-6 py-3 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 active:scale-95 transition-all"
                    >
                      <span className="material-symbols-outlined mr-2">stop_circle</span>
                      Stop Recording
                    </button>
                  )}
                </div>

                {/* Session Complete Message */}
                {sessionComplete && !isLive && (
                  <div className="mt-6 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                    <p className="text-green-300 text-sm">
                      ✓ Session recorded successfully
                    </p>
                  </div>
                )}
              </div>

              {/* Agent Mode Card */}
              {!isLive && (
                <div className="glass-level-1 rounded-2xl p-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-2xl text-orange-400">smart_toy</span>
                      <div>
                        <h3 className="font-semibold text-white">AI Agent Assistant</h3>
                        <p className="text-xs text-gray-400">Real-time voice responses</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setAgentMode((v) => !v)}
                      className={`px-4 py-2 rounded-lg transition-all ${agentMode
                        ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
                        : 'bg-white/5 text-gray-400 border border-white/10'
                        }`}
                    >
                      {agentMode ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>
              )}

              {/* Agent Status */}
              {agentMode && isLive && agentStatus !== 'idle' && (
                <div className={`glass-level-1 rounded-2xl p-4 flex items-center gap-3 ${agentStatus === 'thinking' ? 'border-blue-500/30' : 'border-green-500/30'
                  }`}>
                  <span className="material-symbols-outlined text-lg animate-spin text-blue-400">
                    {agentStatus === 'thinking' ? 'psychology' : 'volume_2'}
                  </span>
                  <span className="text-sm text-gray-300">
                    {agentStatus === 'thinking' ? 'Agent thinking…' : 'Agent speaking…'}
                  </span>
                </div>
              )}
            </div>

            {/* Sidebar - Actions */}
            <div className="space-y-4">
              {/* Analyze Button */}
              {sessionComplete && !analysis && (
                <button
                  onClick={handleAnalyze}
                  disabled={isAnalyzing}
                  className="w-full btn-primary justify-center"
                >
                  <span className="material-symbols-outlined mr-2">analytics</span>
                  {isAnalyzing ? 'Analyzing…' : 'Analyze Call'}
                </button>
              )}

              {/* Error Alert */}
              {error && (
                <div className="glass-level-1 rounded-lg p-4 border border-red-500/30">
                  <div className="flex gap-3">
                    <span className="material-symbols-outlined text-red-400 shrink-0">error</span>
                    <p className="text-sm text-red-300">{error}</p>
                  </div>
                </div>
              )}

              {/* Quick Stats */}
              {isLive && (
                <div className="glass-level-1 rounded-lg p-4">
                  <div className="text-xs text-gray-500 mb-3">SESSION INFO</div>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Status</span>
                      <span className="text-green-400">Active</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Recording ID</span>
                      <span className="text-gray-300 text-xs font-mono">{recordingId?.slice(0, 8)}…</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Analysis Results Section */}
          {analysis && (
            <div className="mt-12 space-y-6">
              <h3 className="headline-lg text-white">Analysis Results</h3>

              {/* Summary */}
              <div className="liquid-glass rounded-2xl p-8">
                <h4 className="font-semibold text-white mb-4 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg">summarize</span>
                  Summary
                </h4>
                <p className="text-on-surface-variant leading-relaxed">{analysis.summary}</p>
              </div>

              {/* Key Topics */}
              <div className="liquid-glass rounded-2xl p-8">
                <h4 className="font-semibold text-white mb-4 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg">bookmark</span>
                  Key Topics
                </h4>
                {analysis.key_topics.length === 0 ? (
                  <p className="text-gray-400">No topics identified.</p>
                ) : (
                  <div className="space-y-2">
                    {analysis.key_topics.map((t, i) => (
                      <div key={i} className="flex items-center gap-4">
                        <span className="text-gray-500 font-mono text-sm w-12">{formatTime(t.start_time)}</span>
                        <span className="text-white">{t.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Objections */}
              {analysis.objection_analysis.length > 0 && (
                <div className="liquid-glass rounded-2xl p-8">
                  <h4 className="font-semibold text-white mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-lg text-red-400">warning</span>
                    Objections
                  </h4>
                  <div className="space-y-4">
                    {analysis.objection_analysis.map((o, i) => (
                      <div key={i} className="bg-red-500/5 border border-red-500/20 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-mono text-gray-400">{o.speaker}</span>
                          <span className="text-xs text-gray-500">{formatTime(o.timestamp)}</span>
                        </div>
                        <blockquote className="italic text-on-surface-variant text-sm mb-3 border-l-2 border-red-500/30 pl-3">
                          &ldquo;{o.exact_quote}&rdquo;
                        </blockquote>
                        <div className="text-sm space-y-1">
                          <p><span className="text-gray-400">Why: </span>{o.reason}</p>
                          <p><span className="text-gray-400">Suggestion: </span>{o.suggestion}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* What Went Well */}
              {analysis.what_went_well.length > 0 && (
                <div className="liquid-glass rounded-2xl p-8">
                  <h4 className="font-semibold text-white mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-lg text-green-400">check_circle</span>
                    What Went Well
                  </h4>
                  <div className="space-y-4">
                    {analysis.what_went_well.map((w, i) => (
                      <div key={i} className="bg-green-500/5 border border-green-500/20 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-mono text-gray-400">{w.speaker}</span>
                          <span className="text-xs text-gray-500">{formatTime(w.timestamp)}</span>
                        </div>
                        <blockquote className="italic text-on-surface-variant text-sm mb-3 border-l-2 border-green-500/30 pl-3">
                          &ldquo;{w.exact_quote}&rdquo;
                        </blockquote>
                        <p className="text-sm"><span className="text-gray-400">Why: </span>{w.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}