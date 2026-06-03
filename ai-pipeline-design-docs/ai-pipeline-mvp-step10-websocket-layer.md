# Step 10 — Real-time WebSocket Layer

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step upgrades the pipeline from batch file upload to live microphone streaming. Audio is chunked and sent directly to Deepgram over a WebSocket — partial results drive UI captions in real time, and final results are written to the `transcript` table.

> **Post-demo scope.** This step is intentionally deferred until the core pipeline (Steps 1–9) is validated in production.

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

**Step 2 — Paste this code**

```ts
import { DeepgramClient } from '@deepgram/sdk';
import { NextResponse } from 'next/server';

export async function GET() {
  const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY!);

  const { result, error } = await deepgram.manage.createProjectKey(
    process.env.DEEPGRAM_PROJECT_ID!,
    {
      comment: 'browser-session',
      scopes: ['usage:write'],
      time_to_live_in_seconds: 60,
    }
  );

  if (error) {
    console.error('[deepgram-token] failed to create key:', error);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }

  return NextResponse.json({ key: result.key });
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
- Fetch the short-lived token first (from the route in 10.1)
- Open the connection with the right query parameters
- Store the `ws` reference in a React ref so it can be closed later

**Step 1 — Add two refs at the top of the `Home` component**

These hold the WebSocket and MediaRecorder instances across renders without causing re-renders themselves.

```ts
const wsRef = useRef<WebSocket | null>(null);
const recorderRef = useRef<MediaRecorder | null>(null);
```

Also add one new state variable for the live caption:

```ts
const [liveCaption, setLiveCaption] = useState<string>('');
const [isLive, setIsLive] = useState<boolean>(false);
```

Make sure `useRef` is imported alongside `useState`:

```ts
import { useState, useRef } from 'react';
```

**Step 2 — Write the `startLive` function**

This function runs when the user clicks "Start Live Transcription".

```ts
async function startLive() {
  // 1. Fetch a short-lived token from your own server
  const { key } = await fetch('/api/deepgram-token').then(r => r.json());

  // 2. Open the WebSocket — query params configure the transcription
  const ws = new WebSocket(
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-3` +
    `&language=en-US` +
    `&diarize=true` +          // enable speaker labels
    `&interim_results=true` +  // send partial results as you speak
    `&punctuate=true`,
    ['token', key]             // second arg is the WebSocket subprotocol — Deepgram reads the token here
  );

  wsRef.current = ws;
  setIsLive(true);
}
```

**What each query parameter does:**

| Parameter | Value | Purpose |
|---|---|---|
| `model` | `nova-3` | Deepgram's most accurate English model |
| `language` | `en-US` | Sets the language |
| `diarize` | `true` | Assigns a speaker number to each word |
| `interim_results` | `true` | Sends partial (in-progress) transcripts |
| `punctuate` | `true` | Adds commas and periods automatically |

**Step 3 — Write the `stopLive` function**

```ts
function stopLive() {
  recorderRef.current?.stop();
  wsRef.current?.close();
  recorderRef.current = null;
  wsRef.current = null;
  setIsLive(false);
  setLiveCaption('');
}
```

**What was added to `page.tsx` and where:**

| Location in `page.tsx` | What was added | Why |
|---|---|---|
| Line 3 — import | `useRef` added alongside `useState` | Needed to hold WebSocket and MediaRecorder without triggering re-renders |
| After last `useState` | `wsRef`, `recorderRef`, `isLive`, `liveCaption` | The four new variables live mode needs |
| After `handleAnalyze` | `startLive()` and `stopLive()` functions | The actual WebSocket + mic logic (steps 10.2–10.5 all wired here) |
| After transcript card | Live transcription UI card | The Start/Stop buttons and green caption box |

---

#### 10.3 Stream microphone audio in 100–200 ms chunks

Audio capture happens with the browser's `MediaRecorder` API. Once the WebSocket is open, start the recorder and wire it up to send each audio chunk as a binary frame.

**Step 1 — Add microphone capture inside `startLive`, after the WebSocket is created**

```ts
// 3. Wait for the WebSocket to be ready, then start the microphone
ws.addEventListener('open', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  recorderRef.current = recorder;

  // Send each audio chunk over the WebSocket as binary data
  recorder.addEventListener('dataavailable', (e) => {
    if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
      ws.send(e.data);
    }
  });

  recorder.start(150); // fire 'dataavailable' every 150 ms
});
```

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

**Note on `mimeType` browser compatibility:**

| Browser | Supported mimeType |
|---|---|
| Chrome / Edge | `audio/webm` (default, works fine) |
| Firefox | `audio/ogg` — change `mimeType: 'audio/ogg'` if needed |
| Safari | Does not support `MediaRecorder` at all — live mode won't work on Safari |

For the MVP, Chrome is sufficient.

---

#### 10.4 Handle partial results (UI captions, no DB write)

Deepgram sends a JSON message for every audio chunk it processes. Messages with `is_final: false` are in-progress guesses — they update rapidly as you speak and should **only** update the live caption display, never touch the database.

**Step 1 — Add the message handler inside `startLive`, after the recorder is set up**

```ts
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data as string);

  // Guard: ignore metadata messages that have no transcript
  const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
  if (!transcript) return;

  if (!msg.is_final) {
    // Partial result — update the caption overlay only
    setLiveCaption(transcript);
    return;
  }

  // Final result — handled in 10.5
});
```

**Step 2 — Add the live caption display to the JSX**

In `app/page.tsx`, add this below the "Start Live Transcription" button:

```tsx
{isLive && (
  <div className="mt-4 p-4 bg-gray-900 text-green-400 rounded font-mono text-sm min-h-12">
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

> This route reuses the same Supabase `transcript` table and schema from Step 5. The only difference is it receives one utterance at a time instead of a full batch.

**Step 2 — Add the final-result handler in `app/page.tsx`**

Inside the `message` event listener (from 10.4), replace the `// Final result — handled in 10.5` comment:

```ts
  // Final result — write to DB
  if (msg.is_final && transcript.length > 0) {
    setLiveCaption(''); // clear the in-progress caption

    const words = msg.channel.alternatives[0].words ?? [];

    await fetch('/api/transcribe/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: currentRecordingId,  // must be set before live mode starts
        speaker: words[0]?.speaker ?? 0,
        content_raw: transcript,
        sentence_start_sec: words[0]?.start ?? 0,
      }),
    });
  }
```

**Step 3 — Make sure `currentRecordingId` exists before going live**

Live transcription needs a `recording_id` to write to. You have two options:

| Option | How |
|---|---|
| Reuse the batch recording ID | Run a normal transcription first (Step 9), then start live mode — `recordingId` is already in state |
| Create a new recording row on "Start Live" | `INSERT INTO recordings (title) VALUES ('Live Session') RETURNING id` — call this at the start of `startLive()` before opening the WebSocket |

For the MVP, Option A (reuse) is simplest.

---

## Complete `startLive` and `stopLive` functions

Here are the final versions of both functions with all parts assembled:

```ts
async function startLive() {
  if (!recordingId) {
    setError('Run a transcription first to get a recording ID before starting live mode.');
    return;
  }

  setError(null);

  const { key } = await fetch('/api/deepgram-token').then(r => r.json());

  const ws = new WebSocket(
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-3&language=en-US&diarize=true&interim_results=true&punctuate=true`,
    ['token', key]
  );

  wsRef.current = ws;
  setIsLive(true);

  ws.addEventListener('open', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recorderRef.current = recorder;

    recorder.addEventListener('dataavailable', (e) => {
      if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
        ws.send(e.data);
      }
    });

    recorder.start(150);
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data as string);
    const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
    if (!transcript) return;

    if (!msg.is_final) {
      setLiveCaption(transcript);
      return;
    }

    setLiveCaption('');
    const words = msg.channel.alternatives[0].words ?? [];

    await fetch('/api/transcribe/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: recordingId,
        speaker: words[0]?.speaker ?? 0,
        content_raw: transcript,
        sentence_start_sec: words[0]?.start ?? 0,
      }),
    });
  });

  ws.addEventListener('error', (e) => {
    console.error('[ws] error:', e);
    setError('WebSocket error — check the console');
    stopLive();
  });

  ws.addEventListener('close', () => setIsLive(false));
}

function stopLive() {
  recorderRef.current?.stop();
  wsRef.current?.close();
  recorderRef.current = null;
  wsRef.current = null;
  setIsLive(false);
  setLiveCaption('');
}
```

---

## Add the live transcription UI to `app/page.tsx`

Add this section below the existing transcript panel (after the "Analyze Call" button):

```tsx
{/* ---- Live transcription ---- */}
<section className="mb-8">
  <h2 className="text-xl font-semibold mb-3">Live Transcription</h2>
  <p className="text-sm text-gray-500 mb-4">
    Requires a recording ID — run a batch transcription first, then start live mode.
  </p>
  <div className="flex gap-3">
    <button
      onClick={startLive}
      disabled={isLive || !recordingId}
      className="px-4 py-2 bg-purple-600 text-white rounded disabled:opacity-50"
    >
      Start Live Transcription
    </button>
    <button
      onClick={stopLive}
      disabled={!isLive}
      className="px-4 py-2 bg-gray-600 text-white rounded disabled:opacity-50"
    >
      Stop
    </button>
  </div>

  {isLive && (
    <div className="mt-4 p-4 bg-gray-900 text-green-400 rounded font-mono text-sm min-h-12">
      {liveCaption || <span className="opacity-40">Listening…</span>}
    </div>
  )}
</section>
```

---

## Key files touched in this step

| File | Change |
|---|---|
| `app/api/deepgram-token/route.ts` | New — mints short-lived browser token |
| `app/api/transcribe/live/route.ts` | New — single-utterance DB write endpoint |
| `app/page.tsx` | Add refs, state, `startLive`, `stopLive`, live caption UI |
| `.env.local` | Add `DEEPGRAM_PROJECT_ID` |

---

## Verification

**Step 1 — Start the dev server**

```bash
cd ai-pipeline
npm run dev
```

**Step 2 — Run a batch transcription first**

Upload an audio file and click **Start Transcription**. Wait for the transcript to appear. This gives you the `recordingId` needed for live mode.

**Step 3 — Start live transcription**

Click **Start Live Transcription**. The browser will ask for microphone permission — allow it. The dark caption box should appear showing "Listening…".

**Step 4 — Speak a sentence**

You should see your words appear in the caption box within ~300 ms. As you keep speaking, the caption updates continuously.

**Step 5 — Pause speaking**

After a brief pause, the caption box clears. Open **Supabase Dashboard → Table Editor → transcript** and refresh — a new row should have appeared with your spoken sentence, the correct `speaker` value, and a `sentence_start_sec` timestamp.

**Step 6 — Click Stop**

The caption box disappears. The WebSocket is closed.

**What a successful result looks like:**

| Check | Expected |
|---|---|
| Caption updates while speaking | Within ~300 ms of speaking |
| Caption clears after pause | Deepgram sent `is_final: true` |
| New `transcript` row in Supabase | Correct `content_raw`, `speaker`, `sentence_start_sec` |
| No errors in browser console | No WebSocket errors or failed fetches |

---

## Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| "Failed to create token" from `/api/deepgram-token` | `DEEPGRAM_PROJECT_ID` missing or wrong | Copy Project ID from Deepgram Console → Settings; restart `npm run dev` |
| Microphone permission denied | Browser blocked mic access | Click the lock icon in the address bar → reset microphone permission → reload |
| Caption never appears | WebSocket failed to open | Open DevTools → Network tab → filter by WS → check if the WebSocket connection shows an error |
| `audio/webm` not supported | Firefox browser | Change `mimeType: 'audio/webm'` to `mimeType: 'audio/ogg'` in the MediaRecorder options |
| Transcript rows not written to Supabase | `recordingId` is null when live mode starts | Make sure you complete a batch transcription before clicking Start Live |
| WebSocket closes immediately | Short-lived token expired before WS opened | Token TTL is 60s — if your network is slow, increase `time_to_live_in_seconds` to `120` in the token route |

---

> ✅ When spoken words appear in the caption box in real time and new rows show up in Supabase after each pause, **Step 10 is complete** and the full real-time pipeline is working.

← Previous: [Step 9 — Basic UI](ai-pipeline-mvp-step9-basic-ui.md)
