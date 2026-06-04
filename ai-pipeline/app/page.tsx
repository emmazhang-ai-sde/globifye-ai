'use client'

import { useState, useRef, useEffect } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TranscriptEntry = { text: string; startSec: number; speaker: number }

type Analysis = {
  id: string
  recording_id: string
  summary: string
  key_topics: { name: string; start_time: number; end_time: number }[]
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
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [sessionComplete, setSessionComplete] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const accumulatedRef = useRef('')
  const utteranceStartSecRef = useRef(0)
  const transcriptLineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const transcriptBottomRef = useRef<HTMLDivElement>(null)
  const [isLive, setIsLive] = useState(false)
  const [liveCaption, setLiveCaption] = useState('')
  const [liveTranscript, setLiveTranscript] = useState<TranscriptEntry[]>([])
  const [highlightedIdx, setHighlightedIdx] = useState<number | null>(null)

  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveTranscript.length, liveCaption])

  function scrollToTranscript(topicStartTime: number) {
    // Find the last transcript entry whose startSec <= topicStartTime
    let bestIdx = 0
    for (let i = 0; i < liveTranscript.length; i++) {
      if (liveTranscript[i].startSec <= topicStartTime) bestIdx = i
      else break
    }
    setHighlightedIdx(bestIdx)
    transcriptLineRefs.current[bestIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setTimeout(() => setHighlightedIdx(null), 2000)
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

  async function startLive() {
    setError(null)

    // Create a new recording row for this live session — no batch transcription required
    const createRes = await fetch('/api/recordings/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_metadata: {} }),
    })
    const createData = await createRes.json()
    if (!createRes.ok || !createData.recording_id) {
      setError(createData.error ?? 'Failed to create recording session')
      return
    }

    // Capture in a local variable — React state updates are async and the
    // WebSocket message handler closure must read the value immediately.
    const liveRecordingId = createData.recording_id
    setRecordingId(liveRecordingId)
    setSessionComplete(false)
    setAnalysis(null)
    setLiveTranscript([])
    accumulatedRef.current = ''
    utteranceStartSecRef.current = 0

    const { key } = await fetch('/api/deepgram-token').then(r => r.json())

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen` +
      `?model=nova-3&language=en-US&diarize=true&interim_results=true&punctuate=true&utterance_end_ms=1000`,
      ['token', key]
    )

    wsRef.current = ws
    setIsLive(true)

    ws.addEventListener('open', async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorderRef.current = recorder

      recorder.addEventListener('dataavailable', (e) => {
        if (ws.readyState === WebSocket.OPEN && e.data.size > 0) ws.send(e.data)
      })

      recorder.start(150)
    })

    ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data as string)

      // Ignore non-transcript messages (e.g. Metadata, UtteranceEnd events)
      if (msg.type && msg.type !== 'Results') return

      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? ''

      if (!msg.is_final) {
        // Interim — show accumulated prefix + current partial
        const prefix = accumulatedRef.current ? accumulatedRef.current + ' ' : ''
        setLiveCaption(prefix + transcript)
        return
      }

      if (!msg.speech_final) {
        // Finalized chunk, but utterance isn't done yet — accumulate and update caption
        if (transcript) {
          if (!accumulatedRef.current) {
            // First chunk of this utterance — capture its start time
            const w = msg.channel?.alternatives?.[0]?.words ?? []
            utteranceStartSecRef.current = w[0]?.start ?? 0
          }
          accumulatedRef.current = accumulatedRef.current
            ? accumulatedRef.current + ' ' + transcript
            : transcript
        }
        setLiveCaption(accumulatedRef.current)
        return
      }

      // speech_final: true — speaker paused, utterance is complete
      const words = msg.channel?.alternatives?.[0]?.words ?? []
      const hadAccumulated = !!accumulatedRef.current
      const fullUtterance = (accumulatedRef.current
        ? accumulatedRef.current + ' ' + transcript
        : transcript
      ).trim()
      const startSec = hadAccumulated ? utteranceStartSecRef.current : (words[0]?.start ?? 0)
      accumulatedRef.current = ''
      utteranceStartSecRef.current = 0

      if (!fullUtterance) return

      const speaker = words[0]?.speaker ?? 0
      setLiveCaption('')
      setLiveTranscript(prev => {
        // Deduplicate consecutive identical entries
        if (prev[prev.length - 1]?.text === fullUtterance) return prev
        return [...prev, { text: fullUtterance, startSec, speaker }]
      })
      await fetch('/api/transcribe/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recording_id: liveRecordingId,
          speaker,
          content_raw: fullUtterance,
          sentence_start_sec: startSec,
        }),
      })
    })

    ws.addEventListener('error', () => { setError('WebSocket error — check the console'); stopLive() })
    ws.addEventListener('close', () => setIsLive(false))
  }

  function stopLive() {
    recorderRef.current?.stop()
    wsRef.current?.close()
    recorderRef.current = null
    wsRef.current = null
    accumulatedRef.current = ''
    utteranceStartSecRef.current = 0
    setIsLive(false)
    setLiveCaption('')
    setSessionComplete(true)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const navItems = [
    { icon: 'dashboard',  label: 'Dashboard' },
    { icon: 'dialpad',    label: 'Power Dialer' },
    { icon: 'reorder',    label: 'Pipeline' },
    { icon: 'history',    label: 'History' },
    { icon: 'contacts',   label: 'Contacts' },
  ]
  const navItemsBottom = [
    { icon: 'alt_route',  label: 'Integrations' },
    { icon: 'groups',     label: 'Team' },
    { icon: 'settings',   label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-[#07080F] text-on-surface font-body">

      {/* Atmospheric background blobs */}
      <div className="fixed inset-0 overflow-hidden -z-10 pointer-events-none">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-primary-container/10 blur-[120px] rounded-full" />
        <div className="absolute top-[40%] -right-[5%] w-[30%] h-[50%] bg-secondary/5 blur-[100px] rounded-full" />
        <div className="absolute -bottom-[10%] left-[20%] w-[50%] h-[30%] bg-primary/5 blur-[120px] rounded-full" />
      </div>

      {/* Sidebar */}
      <aside className="w-[280px] fixed left-0 top-0 h-full bg-surface-container/60 backdrop-blur-xl border-r border-white/10 flex flex-col py-4 px-2 z-50">
        {/* Logo */}
        <div className="px-4 mb-12 flex items-center gap-3">
          <div className="w-10 h-10 fire-gradient rounded-xl flex items-center justify-center">
            <span className="material-symbols-outlined text-on-primary text-xl">call</span>
          </div>
          <div>
            <h2 className="font-display text-lg font-extrabold leading-none text-primary">DialForge</h2>
            <p className="text-[10px] font-mono uppercase tracking-widest text-on-surface-variant mt-1">Enterprise AI VoIP</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col gap-1 overflow-y-auto">
          {navItems.map(({ icon, label }) => (
            <button key={label} className="flex items-center gap-3 px-4 py-3 rounded-lg text-on-surface-variant hover:bg-white/5 transition-all">
              <span className="material-symbols-outlined text-xl">{icon}</span>
              <span className="font-mono text-sm">{label}</span>
            </button>
          ))}

          <div className="h-px bg-white/5 my-3 mx-4" />

          <button className="flex items-center gap-3 px-4 py-3 rounded-lg text-on-surface-variant hover:bg-white/5 transition-all">
            <span className="material-symbols-outlined text-xl">psychology</span>
            <span className="font-mono text-sm">AI Coaching</span>
          </button>

          {navItemsBottom.map(({ icon, label }) => (
            <button key={label} className="flex items-center gap-3 px-4 py-3 rounded-lg text-on-surface-variant hover:bg-white/5 transition-all">
              <span className="material-symbols-outlined text-xl">{icon}</span>
              <span className="font-mono text-sm">{label}</span>
            </button>
          ))}
        </nav>

        {/* Usage bar + upgrade */}
        <div className="mt-auto px-4 pt-4">
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 mb-4">
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-on-surface-variant">Usage</span>
              <span className="text-primary">452 / 1000m</span>
            </div>
            <div className="h-1 bg-surface-container rounded-full overflow-hidden">
              <div className="h-full fire-gradient" style={{ width: '45.2%' }} />
            </div>
          </div>
          <button className="w-full py-2 rounded-full fire-gradient text-on-primary text-sm font-bold active:scale-95 transition-all">
            Upgrade
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="ml-[280px] flex flex-col min-h-screen">

        {/* Top bar */}
        <header className="h-16 flex items-center justify-between px-6 bg-surface/60 backdrop-blur-xl border-b border-white/5 sticky top-0 z-40">
          <div className="flex items-center gap-4">
            <div className="relative">
              <input
                className="bg-surface-container border-none rounded-full px-10 py-2 text-sm w-80 focus:ring-1 focus:ring-primary/50 text-on-surface outline-none"
                placeholder="Global search..."
                type="text"
                readOnly
              />
              <span className="material-symbols-outlined absolute left-3 top-2 text-on-surface-variant text-xl">search</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button className="px-4 py-1.5 rounded-full border border-primary/30 text-primary text-xs font-bold hover:bg-primary/5 transition-all">
              Incoming Call Test
            </button>
            <div className="h-8 w-px bg-white/10" />
            <button className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/5 relative">
              <span className="material-symbols-outlined text-on-surface-variant">notifications</span>
              <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full" />
            </button>
            <div className="flex items-center gap-3 pl-4 border-l border-white/10">
              <div className="w-8 h-8 rounded-full fire-gradient flex items-center justify-center text-on-primary text-sm font-bold shrink-0">A</div>
              <div className="hidden lg:block">
                <p className="text-xs font-bold">Alex Carter</p>
                <p className="text-[10px] text-on-surface-variant uppercase font-mono">Senior Lead</p>
              </div>
            </div>
            {recordingId && (
              <span className="text-xs text-on-surface-variant font-mono hidden xl:block">
                ID: {recordingId.slice(0, 8)}…
              </span>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 space-y-5">

          <div>
            <h2 className="font-display text-4xl text-on-surface">AI Coaching</h2>
            <p className="text-on-surface-variant text-sm mt-1">Live transcription and post-call analysis</p>
          </div>

          {/* Error banner */}
          {error && (
            <div className="liquid-glass rounded-xl border border-red-500/20 px-4 py-3 text-sm text-red-400 flex items-start gap-2">
              <span className="mt-0.5">⚠</span>
              <span>{error}</span>
            </div>
          )}

          {/* Live transcription card */}
          <div className="liquid-glass rounded-2xl p-6">
            <h3 className="text-xs font-mono text-on-surface-variant uppercase tracking-widest mb-4">
              Live Transcription
            </h3>
            <div className="flex gap-3">
              <button
                onClick={startLive}
                disabled={isLive}
                className="px-4 py-2 rounded-lg text-sm font-bold fire-gradient text-on-primary disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
              >
                Start Live
              </button>
              <button
                onClick={stopLive}
                disabled={!isLive}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-white/10 hover:bg-white/15 text-on-surface disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Stop
              </button>
            </div>

            {(isLive || liveTranscript.length > 0) && (
              <div className="mt-4 bg-black/20 rounded-2xl font-mono text-sm overflow-hidden">
                {liveTranscript.length > 0 && (
                  <div className="max-h-48 overflow-y-auto px-4 pt-4">
                    <div className="grid gap-y-0.5" style={{ gridTemplateColumns: '3.5rem 5.5rem 1fr' }}>
                      {liveTranscript.map((entry, i) => {
                        const speakerChanged = i === 0 || liveTranscript[i - 1].speaker !== entry.speaker
                        return (
                          <div key={i} className="contents">
                            <span className={`font-mono text-xs text-on-surface-variant self-start ${speakerChanged && i > 0 ? 'mt-3' : ''}`}>
                              {speakerChanged ? formatTime(entry.startSec) : ''}
                            </span>
                            <span className={`text-xs font-bold text-primary uppercase tracking-wider self-start ${speakerChanged && i > 0 ? 'mt-3' : ''}`}>
                              {speakerChanged ? `Speaker ${entry.speaker + 1}` : ''}
                            </span>
                            <p
                              ref={el => { transcriptLineRefs.current[i] = el }}
                              className={`text-sm leading-relaxed transition-colors duration-300 ${speakerChanged && i > 0 ? 'mt-3' : ''} ${
                                highlightedIdx === i ? 'text-primary' : 'text-on-surface-variant'
                              }`}
                            >
                              {entry.text}
                            </p>
                          </div>
                        )
                      })}
                    </div>
                    <div ref={transcriptBottomRef} />
                  </div>
                )}
                {isLive && (
                  <div className="px-4 py-3 text-secondary">
                    {liveCaption || <span className="opacity-40">Listening…</span>}
                  </div>
                )}
              </div>
            )}

          </div>

          {/* Analyze button */}
          {sessionComplete && recordingId && !analysis && (
            <div className="liquid-glass rounded-2xl p-6">
              <button
                onClick={handleAnalyze}
                disabled={isAnalyzing}
                className="w-full py-2.5 rounded-xl text-sm font-bold fire-gradient text-on-primary disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
              >
                {isAnalyzing ? 'Analyzing — calling LLM…' : 'Analyze Call'}
              </button>
            </div>
          )}

          {/* Analysis results */}
          {analysis && (
            <div className="space-y-5">

              {/* Summary */}
              <div className="liquid-glass rounded-2xl p-6">
                <h3 className="text-xs font-mono text-on-surface-variant uppercase tracking-widest mb-3">Summary</h3>
                <p className="text-on-surface text-sm leading-relaxed">{analysis.summary}</p>
              </div>

              {/* Key Topics */}
              <div className="liquid-glass rounded-2xl p-6">
                <h3 className="text-xs font-mono text-on-surface-variant uppercase tracking-widest mb-3">Key Topics</h3>
                <div className="space-y-0">
                  {analysis.key_topics.map((t, i) => (
                    <div
                      key={i}
                      onClick={() => scrollToTranscript(t.start_time)}
                      className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0 cursor-pointer hover:bg-white/5 rounded-lg px-2 -mx-2 transition-all group"
                    >
                      <span className="font-mono text-xs text-on-surface-variant shrink-0">
                        [{formatTime(t.start_time)} – {formatTime(t.end_time)}]
                      </span>
                      <span className="text-sm text-on-surface group-hover:text-primary transition-colors">{t.name}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Objection Analysis */}
              <div className="liquid-glass rounded-2xl p-6">
                <div className="flex items-baseline gap-2 mb-4">
                  <h3 className="text-xs font-mono text-on-surface-variant uppercase tracking-widest">Objection Analysis</h3>
                  <span className="text-xs text-on-surface-variant">{analysis.objection_analysis.length} detected</span>
                </div>
                {analysis.objection_analysis.length === 0 ? (
                  <p className="text-on-surface-variant text-sm">No objections detected in this call.</p>
                ) : (
                  <div className="space-y-4">
                    {analysis.objection_analysis.map((o, i) => (
                      <div key={i} className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                        <div className="flex items-center gap-2 text-xs text-on-surface-variant mb-2">
                          <span>{o.speaker}</span><span>·</span>
                          <span className="font-mono">{formatTime(o.timestamp)}</span>
                        </div>
                        <blockquote className="text-sm italic text-on-surface-variant border-l-2 border-red-500/40 pl-3 mb-3">
                          &ldquo;{o.exact_quote}&rdquo;
                        </blockquote>
                        <p className="text-sm text-on-surface"><span className="font-bold text-red-400">Why: </span>{o.reason}</p>
                        <p className="text-sm text-on-surface mt-1"><span className="font-bold text-on-surface-variant">Suggestion: </span>{o.suggestion}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* What Went Well */}
              <div className="liquid-glass rounded-2xl p-6">
                <div className="flex items-baseline gap-2 mb-4">
                  <h3 className="text-xs font-mono text-on-surface-variant uppercase tracking-widest">What Went Well</h3>
                  <span className="text-xs text-on-surface-variant">{analysis.what_went_well.length} moments</span>
                </div>
                {analysis.what_went_well.length === 0 ? (
                  <p className="text-on-surface-variant text-sm">Nothing notable detected.</p>
                ) : (
                  <div className="space-y-4">
                    {analysis.what_went_well.map((w, i) => (
                      <div key={i} className="rounded-xl border border-secondary/20 bg-secondary/5 p-4">
                        <div className="flex items-center gap-2 text-xs text-on-surface-variant mb-2">
                          <span>{w.speaker}</span><span>·</span>
                          <span className="font-mono">{formatTime(w.timestamp)}</span>
                        </div>
                        <blockquote className="text-sm italic text-on-surface-variant border-l-2 border-secondary/40 pl-3 mb-3">
                          &ldquo;{w.exact_quote}&rdquo;
                        </blockquote>
                        <p className="text-sm text-on-surface"><span className="font-bold text-secondary">Why: </span>{w.reason}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          )}
        </main>
      </div>
    </div>
  )
}
