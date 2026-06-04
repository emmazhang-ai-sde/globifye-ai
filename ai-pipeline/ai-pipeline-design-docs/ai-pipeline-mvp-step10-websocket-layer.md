# Step 10 — Real-time WebSocket Layer

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step upgrades the pipeline from batch file upload to live microphone streaming. Audio is chunked and sent directly to Deepgram over a WebSocket — partial results drive UI captions in real time, and final results are written to the `transcript` table.

> **Post-demo scope.** This step is intentionally deferred until the core pipeline (Steps 1–9) is validated in production.

> **Architecture note — two modes, two routes:**
> The batch transcription flow (Steps 1–9) is preserved at `app/batch/page.tsx` (`/batch`) for testing and reference. The main UI (`app/page.tsx`, `/`) now runs live-only. The two modes are completely independent — live transcription creates its own recording row and does not require a prior batch run.

---

## What you will do in this step

**10.1** — Generate a short-lived Deepgram token from the server  
**10.2** — Open a browser-side WebSocket to Deepgram  
**10.3** — Stream microphone audio in 100–200 ms chunks  
**10.4** — Handle partial results (UI captions, no DB write)  
**10.5** — Handle final results (DB write to `transcript` table)

---

## Prerequisites

Before starting this step, confirm:

- Steps 1–9 are complete and the pipeline runs end-to-end in the browser
- `npm run dev` starts without errors
- You have your `DEEPGRAM_API_KEY` already set in `.env.local`

⚠️ **New environment variable needed:**

```bash
DEEPGRAM_PROJECT_ID=your_project_id_here
```
**1. Find your Project ID**

1. Go to [https://console.deepgram.com](https://console.deepgram.com)
2. Click your project name in the top-left dropdown → **Settings**
3. Copy the **Project ID** (it is a UUID like `a1b2c3d4-1234-...`)

**2. Open `.env.local` and make sure both lines look exactly like this**

```bash
DEEPGRAM_API_KEY=xxxxxxxx # you already have
DEEPGRAM_PROJECT_ID=paste-your-uuid-here # add this line
```

> ⚠️ **No leading space before the API key value**, like `DEEPGRAM_API_KEY= 75a3...` (with a space) is treated as a different string and will fail auth. 

---

## Data flow overview

```
User clicks "Start Live Transcription"
    ↓
Browser → POST /api/recordings/create  →  { recording_id: "uuid" }
    ↓
Browser → GET /api/deepgram-token  →  { key: "tmp_abc123" }
    ↓
Browser opens  wss://api.deepgram.com  using that key
    ↓
MediaRecorder captures mic → sends 150ms chunks over WebSocket
    ↓
Deepgram sends back messages:
    is_final: false  →  update live caption (React state only)
    is_final: true   →  POST /api/transcribe/live  →  Supabase transcript row
    ↓
User clicks "Stop"
    ↓
WebSocket closed, MediaRecorder stopped
    ↓
"Analyze Call" button appears → POST /api/analyze → analysis results
```

---

#### 10.1 Generate a short-lived Deepgram token from the server

**Why not just use the API key directly in the browser?**

> Think of your Deepgram API key like a bank card PIN. If you hardcode it in frontend code:
>
> ```ts
> const DEEPGRAM_API_KEY = "dg_xxxxxxxxxxx"; 
> ```
>
> Anyone can open DevTools, copy the key, and use your account — running up your bill, burning your quota, or even managing your project. The master key must never leave the server.
>
> Instead, the browser asks *your* server for permission:
>
> ```
> Browser → Your Server → Deepgram
> ```
>
> The server verifies the request, then asks Deepgram to mint a short-lived token:
>
> ```json
> { "token": "abc123", 
>   "expires_in": 60 
> }
> ```
>
> This token can only do one thing (`usage:write`), expires in 60 seconds, and cannot touch billing, account settings, or project management. Even if someone intercepts it, the blast radius is near zero.
>
> **Deepgram's design principle:** the real API key stays on the server forever. The browser only ever sees a throwaway token.

---

**Step 1 — Create the route file**

Create a new file at this path (create the `deepgram-token` folder first):

```
app/api/deepgram-token/route.ts
```

**Step 2 — Create `app/api/deepgram-token/route.ts` and call the Deepgram REST API directly**

```ts
import { NextResponse } from 'next/server';

// SDK v5 removed the manage namespace — call the REST API directly.
export async function GET() {
  const projectId = process.env.DEEPGRAM_PROJECT_ID!;
  const apiKey = process.env.DEEPGRAM_API_KEY!;

  const res = await fetch(
    `https://api.deepgram.com/v1/projects/${projectId}/keys`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment: 'browser-session',
        scopes: ['usage:write'],
        time_to_live_in_seconds: 60,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('[deepgram-token] API error:', res.status, body);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ key: data.key });
}
```

**Step 3 — Test the route manually**

With `npm run dev` running, open a new terminal and run:

```bash
curl http://localhost:3000/api/deepgram-token
```

Expected response:

```json
{ "key": "dg_tmp_xxxxxxxxxxxxxxxxxxxxxxxx" }
```
---

If you see `{ "error": "Failed to create token" }`, the most common cause is a missing or wrong `DEEPGRAM_PROJECT_ID`. 

---

If you see a `403 INSUFFICIENT_PERMISSIONS` error in the server log:

```
[deepgram-token] API error: 403 
{"category":"INSUFFICIENT_PERMISSIONS",
 "message":"Your account does not have the required scope to perform that action for this project.",
 "details":"Check that your account has the 'keys:write' scope for this project.",
 "request_id":"xxxxxx"
}
```

The API key you have is a restricted key — it can transcribe audio but cannot create child keys for the browser. Only Admin-level keys have the `keys:write` scope. Fix:

1. Go to [https://console.deepgram.com](https://console.deepgram.com)
2. In the left sidebar, click **API Keys**
3. Click **Create a New API Key** 
    - set the name to `globifye-demo-admin`
    - set the role to **Admin**
4. Copy the new key
5. Replace `DEEPGRAM_API_KEY` in `.env.local` with the new key
6. Restart `npm run dev` with `Ctrl+C`, then retry the curl

---

#### 10.2 Open a browser-side WebSocket to Deepgram

The WebSocket is opened inside `app/page.tsx`. It needs to:
- First create a recording row in Supabase (so live transcription is self-contained)
- Fetch the short-lived token (from the route in 10.1)
- Open the connection with the right query parameters
- Store the `ws` reference in a React ref so it can be closed later

**Step 1 — Add two refs and two state variables at the top of the `Home` component**

| What | Code | Why |
|---|---|---|
| Update import | `import { useState, useRef } from 'react'` | `useRef` is not imported by default — add it alongside `useState` |
| WebSocket ref | `const wsRef = useRef<WebSocket \| null>(null)` | Holds the live WebSocket instance across renders without triggering a re-render |
| MediaRecorder ref | `const recorderRef = useRef<MediaRecorder \| null>(null)` | Holds the mic recorder instance for the same reason |
| Live mode flag | `const [isLive, setIsLive] = useState(false)` | `true` while the mic is streaming — controls button states and caption box visibility |
| Live caption | `const [liveCaption, setLiveCaption] = useState('')` | Stores the partial (in-progress) transcript shown in the caption box |
| Session complete | `const [sessionComplete, setSessionComplete] = useState(false)` | `true` after `stopLive()` — gates the Analyze Call button |

**Step 2 — Write the `startLive` function**

This function runs when the user clicks "Start Live Transcription". It creates its own recording row first, so it is completely independent of the batch flow.

```ts
async function startLive() {
  setError(null)

  // Create a new recording row — live mode does not depend on batch transcription
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

  // Ask our own server for a short-lived Deepgram token
  const { key } = await fetch('/api/deepgram-token').then(r => r.json())

  // Open the WebSocket using that token as the subprotocol
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
        recording_id: liveRecordingId,
        speaker: words[0]?.speaker ?? 0,
        content_raw: transcript,
        sentence_start_sec: words[0]?.start ?? 0,
      }),
    })
  })

  ws.addEventListener('error', () => { setError('WebSocket error — check the console'); stopLive() })
  ws.addEventListener('close', () => setIsLive(false))
}
```

**Step 3 — Write the `stopLive` function**

```ts
function stopLive() {
  recorderRef.current?.stop();
  wsRef.current?.close();
  recorderRef.current = null;
  wsRef.current = null;
  setIsLive(false);
  setLiveCaption('');
  setSessionComplete(true);  // gates the Analyze Call button
}
```

---

#### 10.3 Stream microphone audio in 100–200 ms chunks

Audio capture happens with the browser's `MediaRecorder` API. Once the WebSocket is open, start the recorder and wire it up to send each audio chunk as a binary frame.

**Step 1 — Add microphone capture inside `startLive`, after the WebSocket is created**

```ts
ws.addEventListener('open', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  recorderRef.current = recorder;

  recorder.addEventListener('dataavailable', (e) => {
    if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
      ws.send(e.data);
    }
  });

  recorder.start(150); // fire 'dataavailable' every 150 ms
});
```

> **Note on `mimeType` browser compatibility:**
>
> | Browser | Supported mimeType |
> |---|---|
> | Chrome / Edge | `audio/webm` (default, works fine) |
> | Firefox | `audio/ogg` — change `mimeType: 'audio/ogg'` if needed |
> | Safari | Does not support `MediaRecorder` at all — live mode won't work on Safari |
>
> For the demo, Chrome is sufficient.

> **Why wait for the `open` event?** 
> The WebSocket handshake takes a few milliseconds. If you start recording before the connection is ready, the first chunks get dropped. Listening for `open` guarantees Deepgram is ready to receive before any audio is sent.

**Step 2 — Handle WebSocket errors and unexpected closes**

```ts
ws.addEventListener('error', (e) => {
  console.error('[ws] error:', e);
  setError('WebSocket error — check the console');
  stopLive();
});

ws.addEventListener('close', () => {
  setIsLive(false);
});
```



---

#### 10.4 Handle partial results (UI captions, no DB write)

Deepgram sends a JSON message for every audio chunk it processes. Messages with `is_final: false` are in-progress guesses — they update rapidly as you speak and should **only** update the live caption display, never touch the database.

**Step 1 — Add the message handler inside `startLive`, after the recorder is set up**

```ts
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data as string);

  const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
  if (!transcript) return;

  if (!msg.is_final) {
    setLiveCaption(transcript);
    return;
  }

  // Final result — handled in 10.5
});
```

**Step 2 — Add the live caption display to the JSX**

In `app/page.tsx`, add this inside the Live Transcription card:

```tsx
{isLive && (
  <div className="mt-4 p-4 bg-slate-900 text-green-400 rounded-lg font-mono text-sm min-h-12">
    {liveCaption || <span className="opacity-40">Listening…</span>}
  </div>
)}
```

What the user sees while speaking:

```
┌─────────────────────────────────────────────────┐
│  so the reason I'm calling today is to follow   │  ← updates live as you speak
└─────────────────────────────────────────────────┘
```

When you pause, Deepgram sends `is_final: true`, the caption clears, and the utterance is written to the database (Step 10.5).

---

#### 10.5 Handle final results (DB write to `transcript` table)

When Deepgram is confident in a segment of speech it sends `is_final: true`. This is the signal to write the utterance to Supabase.

**Step 1 — Create a new API route for single-utterance writes**

Create `app/api/transcribe/live/route.ts`:
- This route reuses the same Supabase `transcript` table and schema from Step 5. 
- **The only difference is it receives one utterance at a time instead of a full batch.**


```ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const { recording_id, speaker, content_raw, sentence_start_sec } = await req.json();

  if (!recording_id || content_raw === undefined) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const { error } = await supabase.from('transcript').insert({
    recording_id,
    speaker,
    content_raw,
    content_clean: content_raw.trim(),
    sentence_start_sec,
  });

  if (error) {
    console.error('[transcribe/live] insert error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
```


**Step 2 — Add the final-result handler in `app/page.tsx`**

Inside the `message` event listener (from 10.4), replace the `// Final result — handled in 10.5` comment:

```ts
  if (msg.is_final && transcript.length > 0) {
    setLiveCaption('');

    const words = msg.channel.alternatives[0].words ?? [];

    await fetch('/api/transcribe/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: liveRecordingId,  // local variable — not React state
        speaker: words[0]?.speaker ?? 0,
        content_raw: transcript,
        sentence_start_sec: words[0]?.start ?? 0,
      }),
    });
  }
```

> **Why `liveRecordingId` and not `recordingId` (state)?**
> React state updates are asynchronous. The `setRecordingId(liveRecordingId)` call at the top of `startLive` schedules an update — it does not change the value immediately. The WebSocket message handler closes over the state variable at the time it is created, which is still `null`. Using the local `liveRecordingId` variable captures the correct value.

---

## Complete `startLive` and `stopLive` functions

```ts
async function startLive() {
  setError(null)

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

  const liveRecordingId = createData.recording_id
  setRecordingId(liveRecordingId)
  setSessionComplete(false)
  setAnalysis(null)

  const { key } = await fetch('/api/deepgram-token').then(r => r.json())

  const ws = new WebSocket(
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-3&language=en-US&diarize=true&interim_results=true&punctuate=true`,
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
        speaker: words[0]?.speaker ?? 0,
        content_raw: transcript,
        sentence_start_sec: words[0]?.start ?? 0,
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
  setIsLive(false)
  setLiveCaption('')
  setSessionComplete(true)
}
```

---

## UI structure in `app/page.tsx`

The main page only renders three things:

```
┌──────────────────────────────────────────┐
│  Live Transcription card                 │
│  [Start Live Transcription]  [Stop]      │
│  ┌────────────────────────────────────┐  │
│  │  Listening… / live caption text   │  │  ← visible only while isLive
│  └────────────────────────────────────┘  │
│  Session recorded — click Analyze...     │  ← visible after Stop
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  [Analyze Call]                          │  ← visible after Stop, before analysis
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  Summary / Key Topics / Objections /     │  ← visible after analysis completes
│  What Went Well                          │
└──────────────────────────────────────────┘
```

The batch transcription flow (upload → transcribe → analyze on file) lives at `/batch` and is accessible at any time for testing.

---

## Key files touched in this step

| File | Change |
|---|---|
| `app/api/deepgram-token/route.ts` | New — mints short-lived browser token |
| `app/api/transcribe/live/route.ts` | New — single-utterance DB write endpoint |
| `app/page.tsx` | Live-only UI: refs, state, `startLive`, `stopLive`, caption, analyze |
| `app/batch/page.tsx` | Preserved batch flow — upload → transcribe → analyze |
| `.env.local` | Add `DEEPGRAM_PROJECT_ID` |

---

## Verification

**Step 1 — Start the dev server**

```bash
cd ai-pipeline
npm run dev
```

**Step 2 — Start live transcription**

Open `localhost:3000`. Click **Start Live Transcription**. The browser will ask for microphone permission — allow it. The dark caption box should appear showing "Listening…".

**Step 3 — Speak a sentence**

You should see your words appear in the caption box within ~300 ms. As you keep speaking, the caption updates continuously.

**Step 4 — Pause speaking**

After a brief pause, the caption box clears. Open **Supabase Dashboard → Table Editor → transcript** and refresh — a new row should have appeared with your spoken sentence, the correct `speaker` value, and a `sentence_start_sec` timestamp.

**Step 5 — Click Stop**

The caption box disappears. A "Session recorded — click Analyze Call" message appears below the buttons.

**Step 6 — Click Analyze Call**

The analysis results (Summary, Key Topics, Objection Analysis, What Went Well) should appear below.

**What a successful result looks like:**

| Check | Expected |
|---|---|
| Caption updates while speaking | Within ~300 ms of speaking |
| Caption clears after pause | Deepgram sent `is_final: true` |
| New `transcript` row in Supabase | Correct `content_raw`, `speaker`, `sentence_start_sec` |
| Analyze Call button appears after Stop | `sessionComplete` state is `true` |
| Analysis results render | LLM call succeeded, analysis cards populate |
| No errors in browser console | No WebSocket errors or failed fetches |

---

## Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| "Failed to create token" from `/api/deepgram-token` | `DEEPGRAM_PROJECT_ID` missing or wrong | Copy Project ID from Deepgram Console → Settings; restart `npm run dev` |
| "Failed to create recording session" on Start | `/api/recordings/create` failed | Check Supabase connection and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` |
| Microphone permission denied | Browser blocked mic access | Click the lock icon in the address bar → reset microphone permission → reload |
| Caption never appears | WebSocket failed to open | Open DevTools → Network tab → filter by WS → check if the WebSocket connection shows an error |
| `audio/webm` not supported | Firefox browser | Change `mimeType: 'audio/webm'` to `mimeType: 'audio/ogg'` in the MediaRecorder options |
| Transcript rows not written to Supabase | `liveRecordingId` closure issue | Make sure you are using the local `liveRecordingId` variable, not the `recordingId` state, in the message handler |
| WebSocket closes immediately | Short-lived token expired before WS opened | Token TTL is 60s — if your network is slow, increase `time_to_live_in_seconds` to `120` in the token route |

---

> ✅ When spoken words appear in the caption box in real time, new rows show up in Supabase after each pause, and the Analyze Call button produces results after stopping — **Step 10 is complete** and the full real-time pipeline is working.

← Previous: [Step 9 — Basic UI](ai-pipeline-mvp-step9-basic-ui.md)
