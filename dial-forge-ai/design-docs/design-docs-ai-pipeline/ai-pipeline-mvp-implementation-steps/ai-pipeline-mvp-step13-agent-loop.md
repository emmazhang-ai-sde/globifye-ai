# Step 13 — Real-Time Agent Loop: STT → LLM → TTS

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*  
*Architecture decisions: [`ai-agent/ai-agent-architecture-design-doc.md`](../../ai-agent/ai-agent-architecture-design-doc.md)*  
*Agent design: [`ai-agent/ai-agent-design.md`](../../ai-agent/ai-agent-design.md)*

---

## Context

Steps 1–11 built the **recording + post-call analysis** pipeline:  
Mic → Deepgram → transcript DB → (button) → LLM → analysis DB

This step adds the **real-time agent response loop**:  
Deepgram `speech_final` → Groq LLM → ElevenLabs TTS → browser audio

The AI agent now speaks back. Every time the prospect finishes a sentence, the pipeline generates and plays the agent's response — all within a 1.5s latency target.

### What changes vs. what stays the same

| Existing piece | Action |
|---|---|
| Deepgram WebSocket (STT) | **No change** — `speech_final` callback is the entry point |
| `app/api/transcribe/live` | **No change** — DB writes still happen per utterance |
| Post-call analysis (Groq + `lib/llm.ts`) | **No change** — Analyze Call button still works |
| `app/frontend/page.tsx` | **Add** agentMode toggle + conversation history + audio playback |
| `lib/llm.ts` | **No change** — kept for post-call analysis |

New files added:
- `lib/agent-llm.ts` — Groq client for real-time agent responses
- `lib/tts.ts` — ElevenLabs TTS helper
- `app/api/agent/respond/route.ts` — server endpoint: utterance → LLM → TTS audio

---

## Latency Budget

Target: **≤ 1500ms** end-to-end from `speech_final` to first audio heard by user.

```
speech_final fires
│
├── [parallel] DB write → /api/transcribe/live    (non-blocking, fire-and-forget)
│
└── [blocking] → /api/agent/respond
      ├── Groq LLM TTFT:            ~100–250ms   (faster than OpenAI for short responses)
      ├── ElevenLabs TTS TTFB:      ~300–400ms   (starts on first LLM chunk)
      ├── Network (server↔browser): ~50–100ms
      └── Audio decode + play:      ~50ms
      ─────────────────────────────────────────
      Total:                         ~500–800ms  ← well under 1.5s

Key: LLM and TTS run in series but overlap via streaming.
Do NOT wait for the full LLM response before calling TTS.
```

---

## Architecture: Streaming Pipeline

```
speech_final event (browser)
        │
        ▼
fetch POST /api/agent/respond    ← sends: { utterance, history }
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  app/api/agent/respond/route.ts  (Next.js API route)   │
│                                                         │
│  1. Build messages array from history + utterance       │
│  2. groq.chat.completions.create({ stream: true })      │
│         │                                               │
│         │ text chunks stream in                         │
│         ▼                                               │
│  3. Accumulate into sentence buffer                     │
│     (flush to ElevenLabs on . ? ! or buffer > 120 chars)│
│         │                                               │
│         │ sentence-sized text chunks                    │
│         ▼                                               │
│  4. elevenlabs.textToSpeech.stream()                    │
│         │                                               │
│         │ audio chunks stream out                       │
│         ▼                                               │
│  5. Return combined audio (audio/mpeg)                  │
└─────────────────────────────────────────────────────────┘
        │
        ▼
browser receives audio blob → new Audio(url).play()
```

---

## Prerequisites

Before starting this step:
- Steps 1–11 complete, `npm run dev` runs without errors
- `GROQ_API_KEY` already in `.env.local` (from Step 3) — no new key needed
- `groq-sdk` already installed (transitive dep of `@langchain/groq`) — no new install needed
- `ELEVENLABS_API_KEY` available (ElevenLabs account — free tier works for testing)

### New environment variables (add to `.env.local`)

```bash
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM   # "Rachel" — replace with any ElevenLabs voice ID
```

### New package

```bash
npm install elevenlabs
```

---

## Implementation: Step-by-Step

### Step 12.1 — Create `lib/agent-llm.ts`

**Purpose:** Groq streaming client for generating the agent's real-time spoken responses. Exports `streamAgentResponse(utterance, history)`, which the API route calls to get a stream of text chunks from the LLM.

Kept separate from `lib/llm.ts` (post-call analysis) because the two serve different purposes: post-call analysis needs structured JSON output and deep reasoning; the agent loop needs fast, short conversational replies.

**Model choice: `llama-3.1-8b-instant`**

| | `llama-3.1-8b-instant` | `llama-3.3-70b-versatile` |
|---|---|---|
| TTFT | ~100–150ms | ~250–400ms |
| Quality for 1–2 sentence replies | Good | Excellent |
| Used for | **Agent loop (this file)** | Post-call analysis (`lib/llm.ts`) |

For real-time spoken responses, speed matters more than depth. A 1–2 sentence reply does not benefit from the 70B model's extra capacity. Switch to 70B only if response quality tests poorly.

**Upgrade path:** When the loop is validated, swap Groq for OpenAI by replacing `groq-sdk` with the `openai` package and changing `GROQ_API_KEY` → `OPENAI_API_KEY`. The rest of the file is identical — both SDKs share the same interface.

---

### Step 12.2 — Create `lib/tts.ts`

**Purpose:** ElevenLabs TTS wrapper. Exports `textToSpeechStream(text)`, which takes a text string and returns a `ReadableStream<Uint8Array>` of MP3 audio chunks. Called by the API route after each sentence-sized LLM chunk is ready.

**Model choice: `eleven_turbo_v2_5`**

Selected in Research 1 (see [`ai-agent-research-plan.md`](../../ai-agent/ai-agent-research-plan.md)) for best quality-to-latency tradeoff. TTFB ~300–400ms. Deepgram Aura is faster (76ms) but noticeably more robotic — Danish approved ElevenLabs for voice quality.

**Voice settings:**

| Parameter | Value | Why |
|---|---|---|
| `stability` | 0.5 | Consistent tone across turns without sounding flat |
| `similarity_boost` | 0.75 | Stays close to selected voice; lower = more expressive |
| `output_format` | `mp3_44100_128` | Standard quality MP3, good browser compatibility |

---

### Step 12.3 — Create `app/api/agent/respond/route.ts`

**Purpose:** Server-side Next.js route that orchestrates the full LLM → TTS pipeline and returns audio to the browser. Keeps `GROQ_API_KEY` and `ELEVENLABS_API_KEY` server-side — never exposed to the browser.

Takes `{ utterance, history }` in the request body. Returns an `audio/mpeg` blob. Also sends the agent's text reply in the `X-Agent-Response-Text` response header, so the browser can update conversation history without a second round-trip.

**Sentence buffer design:** LLM text chunks are accumulated and flushed to ElevenLabs when a sentence boundary (`. ? !`) is hit or the buffer exceeds 120 characters. This gives ElevenLabs enough context for natural prosody without waiting for the full LLM response.

- If latency is too high: reduce threshold 120 → 60 chars
- If audio sounds choppy: increase threshold 120 → 200 chars

**Buffered vs. streaming response:** The route collects all audio before returning. A true streaming response (`TransformStream` + browser `MediaSource`) would shave ~100ms but adds complexity. Add only if measured latency consistently exceeds 1.5s.

---

### Step 12.4 — Update `app/frontend/page.tsx`

**A) New state and refs** (add alongside existing `useRef`/`useState` declarations):

```typescript
const [agentMode, setAgentMode] = useState(false)
const conversationHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'speaking'>('idle')
const audioRef = useRef<HTMLAudioElement | null>(null)
```

**B) Reset conversation history in `startLive()`** (add alongside `sequenceIndexRef.current = 0`):

```typescript
conversationHistoryRef.current = []
```

**C) Call the agent after `speech_final`** (add at the end of the `speech_final` handler block, after the existing DB write fetch):

```typescript
// Fire-and-forget DB write (existing code stays exactly as is)
fetch('/api/transcribe/live', { ... })   // existing — do not touch

// Agent response (new — only runs when agentMode is on)
if (agentMode) {
  setAgentStatus('thinking')
  try {
    const res = await fetch('/api/agent/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utterance: fullUtterance,
        history: conversationHistoryRef.current,
      }),
    })
    if (!res.ok) throw new Error(`Agent respond failed: ${res.status}`)

    const agentText = decodeURIComponent(res.headers.get('X-Agent-Response-Text') ?? '')

    conversationHistoryRef.current = [
      ...conversationHistoryRef.current,
      { role: 'user', content: fullUtterance },
      { role: 'assistant', content: agentText },
    ]

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    if (audioRef.current) {
      audioRef.current.pause()
      URL.revokeObjectURL(audioRef.current.src)
    }
    const audio = new Audio(url)
    audioRef.current = audio
    audio.onended = () => {
      setAgentStatus('idle')
      URL.revokeObjectURL(url)
    }
    setAgentStatus('speaking')
    audio.play()
  } catch (err) {
    console.error('Agent error:', err)
    setAgentStatus('idle')
  }
}
```

**D) UI: Agent Mode toggle + status indicator**

Add near the Start/Stop button area:

```tsx
{/* Agent mode toggle — only show when not in a live session */}
{!isLive && (
  <button
    onClick={() => setAgentMode(v => !v)}
    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      agentMode
        ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
        : 'bg-white/5 text-white/50 border border-white/10'
    }`}
  >
    {agentMode ? 'Agent Mode: ON' : 'Agent Mode: OFF'}
  </button>
)}

{/* Agent speaking status */}
{agentMode && isLive && agentStatus !== 'idle' && (
  <div className="text-sm text-orange-400">
    {agentStatus === 'thinking' ? 'Agent thinking...' : 'Agent speaking...'}
  </div>
)}
```

---

### Step 12.5 — End-to-End Test

1. Run `npm run dev`, open `/frontend`
2. Toggle **Agent Mode: ON**
3. Click **Start Session** and speak a sentence
4. Wait for `speech_final` — you should hear the agent's response within ~1s
5. Verify:
   - Agent responds in natural English, 1–2 sentences
   - Transcript still appears in the UI as before
   - `transcript` table still gets DB writes
   - Conversation history builds correctly across multiple turns
6. Click **Stop Session**, then **Analyze Call** — post-call analysis still works unchanged

**Common issues:**

| Symptom | Cause | Fix |
|---|---|---|
| `ELEVENLABS_API_KEY` error | Missing env var | Add to `.env.local`, restart dev server |
| Audio cuts off or overlaps | Old audio not stopped before new one starts | Verify `audioRef.current.pause()` runs before creating new `Audio()` |
| Agent responds to its own speech | Deepgram picks up speaker output | Use headphones during testing |
| `X-Agent-Response-Text` header missing | URL encoding issue | Ensure `encodeURIComponent` in route + `decodeURIComponent` in page |
| Latency > 1.5s consistently | Sentence buffer threshold too high | Reduce flush threshold 120 → 60 chars in the route |

---

## Files to Touch

| File | Change |
|---|---|
| `.env.local` | Add `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| `package.json` | `npm install elevenlabs` |
| `lib/agent-llm.ts` | **New** — Groq streaming client for agent responses |
| `lib/tts.ts` | **New** — ElevenLabs TTS helper |
| `app/api/agent/respond/route.ts` | **New** — server endpoint: utterance → LLM → TTS audio |
| `app/frontend/page.tsx` | Add agentMode toggle, conversationHistoryRef, speech_final hook, audio playback (Step 12.4) |

Files **not touched**: `lib/llm.ts`, `lib/supabase.ts`, `app/api/transcribe/live`, `app/api/analyze`, `app/api/deepgram-token`

---

## What This Step Does NOT Cover

- **Barge-in detection** — if the prospect speaks while the agent is still talking, the agent's audio is not interrupted. Fix by muting Deepgram during agent playback or adding VAD-based interruption.
- **SIP integration** — audio plays in the browser via Web Audio API. Routing TTS audio through Abraham's SIP layer is a separate step pending the audio interface contract.
- **Streaming audio response** — the route currently buffers all audio before returning. Add true chunk-streaming only if measured latency exceeds the 1.5s target.
- **Custom objective / persona** — system prompt in `lib/agent-llm.ts` is hardcoded. Replace with a user-defined field from the frontend (see Section 5, Q5 in `ai-agent-design.md`).
- **CRM tools** (`search_knowledge_base`, `lookup_crm_prospect`) — add via Groq function calling after the basic loop is validated.
- **Voicemail mode** — defined in [`ai-agent-design.md`](../../ai-agent/ai-agent-design.md); not part of the real-time loop.
