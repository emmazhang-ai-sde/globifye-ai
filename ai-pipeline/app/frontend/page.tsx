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

function formatTimer(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0')
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

const COACH_SUGGESTIONS = [
  'Emphasize the ROI over specific technical features now.',
  'Address the budget concern early.',
  "Mirror the prospect's pacing.",
  'Ask about the decision-making process.',
  "Use the customer's own words to reflect their pain points.",
]

const NAV_ITEMS = [
  { icon: 'dashboard',        label: 'Dashboard' },
  { icon: 'call',             label: 'Call',          active: true },
  { icon: 'queue_play_next',  label: 'Queue' },
  { icon: 'model_training',   label: 'Coaching' },
  { icon: 'dialpad',          label: 'Dialer' },
  { icon: 'account_tree',     label: 'Pipeline' },
  { icon: 'history',          label: 'History' },
  { icon: 'contacts',         label: 'Contacts' },
  { icon: 'hub',              label: 'Integrations' },
  { icon: 'pin',              label: 'Numbers' },
  { icon: 'payments',         label: 'Billing' },
  { icon: 'groups',           label: 'Team' },
  { icon: 'notifications',    label: 'Notifications' },
  { icon: 'settings',         label: 'Settings' },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LiveCallPage() {
  // --- Transcription state (ported from app/page.tsx) ---
  const [recordingId, setRecordingId]       = useState<string | null>(null)
  const [sessionComplete, setSessionComplete] = useState(false)
  const [analysis, setAnalysis]             = useState<Analysis | null>(null)
  const [isAnalyzing, setIsAnalyzing]       = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [isLive, setIsLive]                 = useState(false)
  const [liveCaption, setLiveCaption]       = useState('')
  const [liveTranscript, setLiveTranscript] = useState<TranscriptEntry[]>([])
  const [highlightedIdx, setHighlightedIdx] = useState<number | null>(null)

  const wsRef               = useRef<WebSocket | null>(null)
  const sequenceIndexRef    = useRef(0)  // add this ref to track sequence index for live transcription
  const recorderRef         = useRef<MediaRecorder | null>(null)
  const accumulatedRef      = useRef('')
  const utteranceStartSecRef = useRef(0)
  const transcriptLineRefs  = useRef<(HTMLParagraphElement | null)[]>([])
  const transcriptBottomRef = useRef<HTMLDivElement>(null)

  // --- UI state (new for this page) ---
  const [isMuted, setIsMuted]             = useState(false)
  const [isOnHold, setIsOnHold]           = useState(false)
  const [activeModal, setActiveModal]     = useState<string | null>(null)
  const [timerSec, setTimerSec]           = useState(0)
  const [coachIdx, setCoachIdx]           = useState(0)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-scroll transcript
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveTranscript.length, liveCaption])

  // Live timer
  useEffect(() => {
    if (isLive) {
      timerIntervalRef.current = setInterval(() => setTimerSec(s => s + 1), 1000)
    } else {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
    }
    return () => { if (timerIntervalRef.current) clearInterval(timerIntervalRef.current) }
  }, [isLive])

  // AI coach suggestion rotation
  useEffect(() => {
    const id = setInterval(() => setCoachIdx(i => (i + 1) % COACH_SUGGESTIONS.length), 14000)
    return () => clearInterval(id)
  }, [])

  // -------------------------------------------------------------------------

  function scrollToTranscript(topicStartTime: number) {
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
    setTimerSec(0)

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

    // Must be a local variable — React state is async, would be null inside the WS handler closure
    const liveRecordingId = createData.recording_id
    setRecordingId(liveRecordingId)
    setSessionComplete(false)
    setAnalysis(null)
    setLiveTranscript([])
    accumulatedRef.current = ''
    sequenceIndexRef.current = 0 // add this line to reset sequence index at the start of a new live session
    utteranceStartSecRef.current = 0

    const { key } = await fetch('/api/deepgram-token').then(r => r.json())
    const ws = new WebSocket(
      'wss://api.deepgram.com/v1/listen' +
      '?model=nova-3&language=en-US&diarize=true&interim_results=true&punctuate=true&utterance_end_ms=1000',
      ['token', key],
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
      if (msg.type && msg.type !== 'Results') return

      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? ''

      if (!msg.is_final) {
        const prefix = accumulatedRef.current ? accumulatedRef.current + ' ' : ''
        setLiveCaption(prefix + transcript)
        return
      }

      if (!msg.speech_final) {
        if (transcript) {
          if (!accumulatedRef.current) {
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

      // speech_final — utterance is complete
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
          sequence_index: sequenceIndexRef.current++,   // add this — post-increment
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

  function handleEndCall() {
    stopLive()
    // Confetti burst using Web Animations API
    const colors = ['#ff562a', '#ffb4a2', '#7cffa3', '#ffffff']
    for (let i = 0; i < 40; i++) {
      const el = document.createElement('div')
      Object.assign(el.style, {
        position: 'fixed', width: '8px', height: '8px', borderRadius: '2px',
        zIndex: '200', pointerEvents: 'none', left: '50%', top: '80%',
        background: colors[Math.floor(Math.random() * colors.length)],
      })
      document.body.appendChild(el)
      const destX = (Math.random() - 0.5) * 800
      const destY = -Math.random() * 600
      el.animate(
        [
          { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
          { transform: `translate(${destX}px,${destY}px) rotate(${Math.random() * 360}deg)`, opacity: 0 },
        ],
        { duration: 1000 + Math.random() * 1000, easing: 'ease-out', fill: 'forwards' },
      )
      setTimeout(() => el.remove(), 2000)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="bg-background text-on-background font-body-md overflow-hidden h-screen relative">

      {/* Ambient background glows */}
      <div className="ambient-glow bg-primary" style={{ top: 0, left: 0 }} />
      <div className="ambient-glow bg-secondary" style={{ bottom: 0, right: 0, animationDelay: '-5s' }} />

      {/* ------------------------------------------------------------------ */}
      {/* Sidebar                                                             */}
      {/* ------------------------------------------------------------------ */}
      <nav className="w-16 hover:w-64 transition-all duration-300 h-screen fixed left-0 top-0 z-50 flex flex-col backdrop-blur-xl border-r border-white/10 shadow-2xl bg-surface/70 group overflow-hidden">
        {/* Logo */}
        <div className="h-16 flex items-center px-4 w-full shrink-0">
          <span className="material-symbols-outlined text-primary text-3xl">local_fire_department</span>
          <span className="ml-4 font-headline-md text-headline-md font-bold text-primary opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
            DialForge
          </span>
        </div>

        {/* Nav items */}
        <div className="flex-1 w-full py-4 space-y-1 overflow-y-auto overflow-x-hidden">
          {NAV_ITEMS.map(({ icon, label, active }) => (
            <a
              key={label}
              href="#"
              className={`flex items-center w-full px-5 py-3 transition-colors ${
                active
                  ? 'text-primary border-r-2 border-primary bg-primary/10'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5'
              }`}
            >
              <span className="material-symbols-outlined">{icon}</span>
              <span className="ml-4 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                {label}
              </span>
            </a>
          ))}
        </div>

        {/* Profile footer */}
        <div className="mt-auto w-full border-t border-white/5 bg-surface/40 p-4">
          <a href="#" className="flex items-center w-full gap-4 text-on-surface-variant hover:text-on-surface transition-colors">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0 border border-primary/30">
              <span className="material-symbols-outlined text-sm">person</span>
            </div>
            <span className="opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap text-sm font-medium">
              Profile
            </span>
          </a>
        </div>
      </nav>

      {/* ------------------------------------------------------------------ */}
      {/* Top AppBar                                                          */}
      {/* ------------------------------------------------------------------ */}
      <header className="h-16 fixed top-0 right-0 left-16 z-40 flex justify-between items-center px-6 backdrop-blur-xl border-b border-white/10 shadow-sm bg-surface/70">
        <div className="flex items-center gap-6">
          <h1 className="font-headline-md text-headline-md font-bold text-primary">Active Session</h1>

          {/* Timer */}
          <div className="flex items-center gap-2 bg-surface-container px-3 py-1 rounded-full border border-white/5">
            <span className="material-symbols-outlined text-xs text-error pulse-live">fiber_manual_record</span>
            <span className="font-label-mono text-label-mono text-on-surface tracking-widest">
              {formatTimer(timerSec)}
            </span>
          </div>

          {/* Status badges */}
          <div className="flex gap-2">
            {isMuted && (
              <div className="flex items-center gap-1 px-3 py-1 rounded-full border border-white/5 bg-primary/20 text-primary">
                <span className="text-[10px] font-bold tracking-widest">MUTED</span>
              </div>
            )}
            {isOnHold && (
              <div className="flex items-center gap-1 px-3 py-1 rounded-full border border-white/5 bg-primary/20 text-primary">
                <span className="text-[10px] font-bold tracking-widest">ON HOLD</span>
              </div>
            )}
            {isLive && (
              <div className="flex items-center gap-1 px-3 py-1 rounded-full border border-white/5 bg-error/20 text-error">
                <span className="text-[10px] font-bold tracking-widest">RECORDING</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-on-surface-variant font-label-mono text-sm">239/500 mins</span>
          <button className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-all">
            timer
          </button>
          <button className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-all">
            dark_mode
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Main content — 12-column grid                                       */}
      {/* ------------------------------------------------------------------ */}
      <main className="ml-16 mt-16 h-[calc(100vh-64px)] p-6 grid grid-cols-12 gap-4 relative">

        {/* ---- Left/Center: Call interface (8 cols) ---- */}
        <div className="col-span-8 flex flex-col items-center justify-between py-12 relative overflow-hidden">

          {/* AI Coach bubble */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 w-80 glass-level-2 p-4 rounded-xl shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full fire-gradient flex items-center justify-center shrink-0">
                <span
                  className="material-symbols-outlined text-white text-sm"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  model_training
                </span>
              </div>
              <div>
                <p className="text-xs font-bold text-primary uppercase tracking-tighter">AI Coach Suggestion</p>
                <p className="text-sm text-on-surface mt-1 italic transition-opacity duration-500">
                  &ldquo;{COACH_SUGGESTIONS[coachIdx]}&rdquo;
                </p>
              </div>
            </div>
          </div>

          {/* Contact avatar + name */}
          <div className="flex flex-col items-center gap-6 mt-12">
            <div className="relative">
              <div className="w-48 h-48 rounded-full border-2 border-primary/30 p-2">
                <div className="w-full h-full rounded-full overflow-hidden border-4 border-surface bg-surface-container flex items-center justify-center shadow-[0_0_40px_rgba(255,86,42,0.2)]">
                  <span className="material-symbols-outlined text-6xl text-on-surface-variant">person</span>
                </div>
              </div>
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 fire-gradient px-4 py-1 rounded-full fire-glow">
                <span className="text-[10px] font-bold text-white tracking-widest uppercase">LIVE</span>
              </div>
            </div>
            <div className="text-center">
              <h2 className="font-headline-lg text-headline-lg text-on-surface">Jonathan Sterling</h2>
              <p className="text-on-surface-variant font-body-md">VP of Operations, Global Logistics Group</p>
            </div>
          </div>

          {/* Control bar */}
          <div className="glass-level-2 px-8 py-4 rounded-full flex items-center gap-6 shadow-2xl mt-auto">
            {/* Camera */}
            <button
              onClick={() => setActiveModal('camera')}
              className="w-12 h-12 rounded-full glass-level-1 flex items-center justify-center text-on-surface hover:text-primary transition-all spring-pop"
            >
              <span className="material-symbols-outlined">videocam</span>
            </button>

            {/* Mute */}
            <button
              onClick={() => setIsMuted(m => !m)}
              className={`w-12 h-12 rounded-full glass-level-1 flex items-center justify-center transition-all spring-pop ${
                isMuted ? 'btn-active' : 'text-on-surface hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined">{isMuted ? 'mic_off' : 'mic'}</span>
            </button>

            {/* Screen share */}
            <button
              onClick={() => setActiveModal('share')}
              className="w-12 h-12 rounded-full glass-level-1 flex items-center justify-center text-on-surface hover:text-primary transition-all spring-pop"
            >
              <span className="material-symbols-outlined">screen_share</span>
            </button>

            <div className="w-px h-8 bg-white/10 mx-2" />

            {/* Hold */}
            <button
              onClick={() => setIsOnHold(h => !h)}
              className={`w-12 h-12 rounded-full glass-level-1 flex items-center justify-center transition-all spring-pop ${
                isOnHold ? 'btn-active' : 'text-on-surface hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined">pause</span>
            </button>

            {/* Transfer */}
            <button
              onClick={() => setActiveModal('transfer')}
              className="w-12 h-12 rounded-full glass-level-1 flex items-center justify-center text-on-surface hover:text-primary transition-all spring-pop"
            >
              <span className="material-symbols-outlined">forward_to_inbox</span>
            </button>

            {/* Voicemail (decorative) */}
            <button className="w-12 h-12 rounded-full glass-level-1 flex items-center justify-center text-on-surface hover:text-primary transition-all spring-pop">
              <span className="material-symbols-outlined">voicemail</span>
            </button>

            {/* Start / recording indicator */}
            <button
              onClick={isLive ? undefined : startLive}
              disabled={isLive}
              className={`w-12 h-12 rounded-full glass-level-1 flex items-center justify-center transition-all spring-pop ${
                isLive ? 'btn-active-error cursor-default' : 'text-on-surface hover:text-primary'
              }`}
              title={isLive ? 'Recording in progress' : 'Start recording'}
            >
              <span className="material-symbols-outlined">
                {isLive ? 'fiber_manual_record' : 'note_add'}
              </span>
            </button>

            <div className="w-px h-8 bg-white/10 mx-2" />

            {/* End Call */}
            <button
              onClick={handleEndCall}
              className="px-8 h-12 rounded-full bg-error text-on-error font-bold flex items-center gap-2 hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-error/20"
            >
              <span className="material-symbols-outlined">call_end</span>
              End Call
            </button>
          </div>
        </div>

        {/* ---- Right panel (4 cols) ---- */}
        <aside className="col-span-4 flex flex-col gap-4 overflow-hidden h-full">

          {/* Error banner */}
          {error && (
            <div className="glass-level-1 p-3 rounded-xl border-l-4 border-error text-sm text-error">
              ⚠ {error}
            </div>
          )}

          {/* Objection alert */}
          {analysis?.objection_analysis?.length ? (
            <div className="glass-level-2 p-4 rounded-xl border-l-4 border-error fire-glow shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-error" style={{ fontVariationSettings: "'FILL' 1" }}>
                  warning
                </span>
                <h4 className="text-sm font-bold text-error uppercase tracking-wider">Objection Detected</h4>
              </div>
              <p className="text-sm text-on-surface">&ldquo;{analysis.objection_analysis[0].exact_quote}&rdquo;</p>
            </div>
          ) : (
            <div className="glass-level-2 p-4 rounded-xl border-l-4 border-error fire-glow shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-error" style={{ fontVariationSettings: "'FILL' 1" }}>
                  warning
                </span>
                <h4 className="text-sm font-bold text-error uppercase tracking-wider">High-Priority Alert</h4>
              </div>
              <p className="text-sm text-on-surface">
                Client mentioned &ldquo;Budget Freeze&rdquo;. AI suggests shifting to &ldquo;Deferred Payment Model&rdquo;.
              </p>
            </div>
          )}

          {/* Lead Intelligence */}
          <div className="glass-level-1 p-6 rounded-xl space-y-4 shrink-0">
            <div className="flex justify-between items-start">
              <h3 className="font-headline-md text-on-surface">Lead Intelligence</h3>
              <span className="material-symbols-outlined text-on-surface-variant">info</span>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-on-surface-variant">Lead Score</span>
                <span className="text-secondary font-label-mono">92/100</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-on-surface-variant">Pipeline Stage</span>
                <span className="text-on-surface">Negotiation</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-on-surface-variant">Last Interaction</span>
                <span className="text-on-surface">2 days ago via Email</span>
              </div>
            </div>
            <div className="pt-4 border-t border-white/5">
              <label className="text-[10px] font-bold text-on-surface-variant uppercase mb-2 block">
                Quick Notes
              </label>
              <textarea
                className="w-full bg-surface-container-lowest border border-white/10 rounded-lg p-3 text-sm focus:ring-1 focus:ring-primary focus:outline-none h-20 resize-none"
                placeholder="Add live call notes..."
              />
            </div>
          </div>

          {/* Live Transcript */}
          <div className="glass-level-1 flex-1 rounded-xl flex flex-col overflow-hidden min-h-0">
            {/* Header */}
            <div className="px-6 py-4 border-b border-white/5 flex justify-between items-center bg-surface-container/50 shrink-0">
              <h3 className="text-sm font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-sm">auto_awesome</span>
                Live Transcript
              </h3>
              {isLive ? (
                <span className="text-[10px] text-secondary font-label-mono animate-pulse">TRANSCRIBING...</span>
              ) : sessionComplete ? (
                <span className="text-[10px] text-on-surface-variant font-label-mono">ENDED</span>
              ) : (
                <span className="text-[10px] text-on-surface-variant font-label-mono">READY</span>
              )}
            </div>

            {/* Transcript lines */}
            <div className="p-4 overflow-y-auto flex-1 space-y-4 text-sm" id="transcript-container">
              {liveTranscript.length === 0 && !isLive && (
                <p className="text-on-surface-variant text-xs text-center pt-4">
                  Press the record button to start transcription.
                </p>
              )}

              {liveTranscript.map((entry, i) => {
                const speakerChanged = i === 0 || liveTranscript[i - 1].speaker !== entry.speaker
                return (
                  <div key={i} className={`space-y-1 ${speakerChanged && i > 0 ? 'mt-4' : ''}`}>
                    {speakerChanged && (
                      <div className="flex items-center gap-2">
                        <span className={`font-bold text-[10px] uppercase ${entry.speaker === 0 ? 'text-primary' : 'text-on-surface-variant'}`}>
                          {entry.speaker === 0 ? 'Agent (You)' : `Speaker ${entry.speaker + 1}`}
                        </span>
                        <span className="text-on-surface-variant text-[10px] font-label-mono">
                          {formatTime(entry.startSec)}
                        </span>
                      </div>
                    )}
                    <p
                      ref={el => { transcriptLineRefs.current[i] = el }}
                      className={`leading-relaxed transition-colors duration-300 ${
                        highlightedIdx === i ? 'text-primary' : 'text-on-surface/80'
                      }`}
                    >
                      {entry.text}
                    </p>
                  </div>
                )
              })}

              {/* Live caption (interim) */}
              {isLive && (
                <div className="space-y-1 italic">
                  <p className="text-on-surface-variant text-[10px]">
                    {liveCaption || 'Listening for response...'}
                  </p>
                </div>
              )}

              <div ref={transcriptBottomRef} />
            </div>

            {/* Analyze button (post-session) */}
            {sessionComplete && recordingId && !analysis && (
              <div className="p-4 border-t border-white/5 shrink-0">
                <button
                  onClick={handleAnalyze}
                  disabled={isAnalyzing}
                  className="w-full py-2.5 rounded-xl text-sm font-bold fire-gradient text-on-primary disabled:opacity-40 active:scale-95 transition-all"
                >
                  {isAnalyzing ? 'Analyzing...' : 'Analyze Call'}
                </button>
              </div>
            )}
          </div>

          {/* Analysis results (scrollable, shown after Analyze) */}
          {analysis && (
            <div className="space-y-4 overflow-y-auto shrink-0 max-h-[45vh]">

              {/* Summary */}
              <div className="glass-level-1 p-5 rounded-xl">
                <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-2">
                  Summary
                </h3>
                <p className="text-on-surface text-sm leading-relaxed">{analysis.summary}</p>
              </div>

              {/* Key Topics */}
              <div className="glass-level-1 p-5 rounded-xl">
                <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">
                  Key Topics
                </h3>
                <div className="space-y-0">
                  {analysis.key_topics.map((t, i) => (
                    <div
                      key={i}
                      onClick={() => scrollToTranscript(t.start_time)}
                      className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0 cursor-pointer hover:bg-white/5 rounded-lg px-2 -mx-2 transition-all group"
                    >
                      <span className="font-label-mono text-[10px] text-on-surface-variant shrink-0">
                        [{formatTime(t.start_time)} – {formatTime(t.end_time)}]
                      </span>
                      <span className="text-sm text-on-surface group-hover:text-primary transition-colors">
                        {t.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Objections */}
              {analysis.objection_analysis.length > 0 && (
                <div className="glass-level-1 p-5 rounded-xl">
                  <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">
                    Objections
                  </h3>
                  <div className="space-y-3">
                    {analysis.objection_analysis.map((o, i) => (
                      <div key={i} className="rounded-lg border border-error/20 bg-error/5 p-3">
                        <div className="text-[10px] text-on-surface-variant mb-1 font-label-mono">
                          {o.speaker} · {formatTime(o.timestamp)}
                        </div>
                        <blockquote className="text-sm italic text-on-surface-variant border-l-2 border-error/40 pl-2 mb-2">
                          &ldquo;{o.exact_quote}&rdquo;
                        </blockquote>
                        <p className="text-sm text-on-surface">
                          <span className="font-bold text-error">Why: </span>{o.reason}
                        </p>
                        <p className="text-sm text-on-surface mt-1">
                          <span className="font-bold text-on-surface-variant">Suggestion: </span>{o.suggestion}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* What Went Well */}
              {analysis.what_went_well.length > 0 && (
                <div className="glass-level-1 p-5 rounded-xl">
                  <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">
                    What Went Well
                  </h3>
                  <div className="space-y-3">
                    {analysis.what_went_well.map((w, i) => (
                      <div key={i} className="rounded-lg border border-secondary/20 bg-secondary/5 p-3">
                        <div className="text-[10px] text-on-surface-variant mb-1 font-label-mono">
                          {w.speaker} · {formatTime(w.timestamp)}
                        </div>
                        <blockquote className="text-sm italic text-on-surface-variant border-l-2 border-secondary/40 pl-2 mb-2">
                          &ldquo;{w.exact_quote}&rdquo;
                        </blockquote>
                        <p className="text-sm text-on-surface">
                          <span className="font-bold text-secondary">Why: </span>{w.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </main>

      {/* ------------------------------------------------------------------ */}
      {/* Modals                                                              */}
      {/* ------------------------------------------------------------------ */}

      {activeModal === 'camera' && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 backdrop-blur-sm"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="w-[500px] glass-level-2 rounded-2xl p-8 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-headline-md text-on-surface">Camera Settings</h2>
              <button
                className="material-symbols-outlined hover:text-error transition-colors"
                onClick={() => setActiveModal(null)}
              >
                close
              </button>
            </div>
            <div className="w-full aspect-video rounded-xl bg-surface-container-lowest border border-white/5 mb-6 flex items-center justify-center">
              <span className="material-symbols-outlined text-4xl text-on-surface-variant">no_photography</span>
            </div>
            <button className="w-full fire-gradient py-4 rounded-full text-white font-bold fire-glow hover:brightness-110 transition-all">
              Apply &amp; Turn On
            </button>
          </div>
        </div>
      )}

      {activeModal === 'share' && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 backdrop-blur-sm"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="w-[600px] glass-level-2 rounded-2xl p-8 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-headline-md text-on-surface">Screen Sharing</h2>
              <button
                className="material-symbols-outlined hover:text-error transition-colors"
                onClick={() => setActiveModal(null)}
              >
                close
              </button>
            </div>
            <div className="grid grid-cols-3 gap-4 mb-8">
              {(['tab', 'window', 'monitor'] as const).map((icon, i) => (
                <button
                  key={icon}
                  className="flex flex-col items-center gap-4 p-6 rounded-xl border border-white/10 hover:border-primary/50 hover:bg-primary/5 transition-all group"
                >
                  <span className="material-symbols-outlined text-3xl text-on-surface-variant group-hover:text-primary">
                    {icon}
                  </span>
                  <span className="text-xs font-bold uppercase">
                    {['Chrome Tab', 'Window', 'Entire Screen'][i]}
                  </span>
                </button>
              ))}
            </div>
            <button className="w-full fire-gradient py-4 rounded-full text-white font-bold fire-glow hover:brightness-110 transition-all">
              Start Broadcast
            </button>
          </div>
        </div>
      )}

      {activeModal === 'transfer' && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 backdrop-blur-sm"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="w-[500px] glass-level-2 rounded-2xl p-8 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-headline-md text-on-surface">Transfer Call</h2>
              <button
                className="material-symbols-outlined hover:text-error transition-colors"
                onClick={() => setActiveModal(null)}
              >
                close
              </button>
            </div>
            <div className="relative mb-6">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-on-surface-variant text-sm">
                search
              </span>
              <input
                className="w-full bg-surface-container-lowest border border-white/10 rounded-full pl-10 pr-4 py-3 text-sm focus:ring-1 focus:ring-primary focus:outline-none"
                placeholder="Search team directory..."
                type="text"
              />
            </div>
            <button className="w-full fire-gradient py-4 rounded-full text-white font-bold fire-glow hover:brightness-110 transition-all">
              Transfer Now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
