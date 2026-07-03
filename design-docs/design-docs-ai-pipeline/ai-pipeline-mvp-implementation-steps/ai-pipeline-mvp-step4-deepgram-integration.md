# Step 4 — Deepgram Integration (batch mode first, streaming later)

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

#### Batch Mode vs. Streaming Mode

- Use **batch** to validate the full pipeline end-to-end (audio → transcript → DB → LLM → output), then
- Add the **WebSocket** layer in **Step 10** once the demo is complete.

These two modes are two completely different APIs in Deepgram — different protocol, different SDK method, different use case.

**Batch Mode — What You Are Doing Now (Steps 4–9)**

```
Local audio file → HTTP POST → Deepgram → wait → complete transcript returned
```

The SDK call is:
```typescript
deepgram.listen.v1.media.transcribeFile({ path: filePath }, { ... })
```

The Deepgram Console's Developer Tool also uses this mode — you upload a file, it processes it and returns the result. It is the same REST API under the hood.

**Streaming Mode — To Be Added Later (Step 10)**

```
Microphone → 100–200ms audio chunks → persistent WebSocket → Deepgram → real-time partial/final results
```

The SDK call is a completely different method:
```typescript
deepgram.listen.v1.connect({ model: 'nova-3', ... })  // opens a WebSocket connection
```

**Side-by-Side Comparison**

| Feature | Batch | Streaming |
|---|---|---|
| Protocol | HTTP REST | WebSocket |
| Input | Complete audio file | Live audio chunks (100–200ms) |
| Output | Full transcript returned once | Partial + final results pushed continuously |
| Pipeline stage | MVP demo (Steps 4–9) | Real-time captions after demo (Step 10) |

---

This step gets Deepgram working end-to-end: 
```
account setup 
→ API key 
→ `lib/deepgram.ts` 
→ test script 
→ verified output. 
```

---

#### 4.1 Sign up for Deepgram and get free credits

1. Go to [https://deepgram.com](https://deepgram.com) and sign up
2. Deepgram offers \$200.00 free credits on new accounts

> ⚠️ Deepgram charges per audio-hour. Free credits cover testing, but don't run large audio files repeatedly once you're past validation.

---

#### 4.2 Get the API key

1. In the Deepgram Console, click **"API Keys"** in the left sidebar
2. Click **"Create a New API Key"**
3. Give it a name (e.g. `globifye-mvp`) and set permissions to **Member**
4. Copy the key (**it is only shown once**), and add it to `.env.local`:

```env
DEEPGRAM_API_KEY = your-deepgram-api-key-here
```

Developer tools:
```bash
curl -X POST \
  -H "Authorization: Token YOUR_SECRET" \
  -H 'content-type: application/json' \
  -d '{"url": "https://static.deepgram.com/examples/Bueller-Life-moves-pretty-fast.wav"}' \
  "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true"
```

---

#### 4.3 Get a sample audio file

You need a test `.mp3` or `.wav` file of a two-person conversation to validate speaker diarization. 

Place the file in the project root as `sample-audio.mp3`

> ⚠️ Add `sample-audio.mp3` to `.gitignore` — don't commit audio files to the repo.

---

#### 4.4 Populate `lib/deepgram.ts`

---

#### 4.5 Test the batch transcription

Create `scripts/test-deepgram.ts`

Run it: ```npx ts-node --esm scripts/test-deepgram.ts```

Expected output (abbreviated):

```
✅ Transcription complete — 233 utterances

[0.0s] Speaker 0: Hi, thanks for calling GlobiFYE. How can I help you today?
[3.2s] Speaker 1: Yeah, um, I was looking at your pricing page and I had a few questions.
[6.8s] Speaker 0: Of course, happy to walk you through it.
[8.5s] Speaker 1: So the thing is, uh, we're a pretty small team and the enterprise tier feels like a lot.
...
```

> 📝 **What is an Utterance?**
>
> An utterance is one continuous segment of speech from a single speaker. Deepgram automatically splits the full audio by speaker and pauses — each resulting segment is called an utterance.
>
> Example:
> ```
> [0.0s]  Speaker 0: Hi, thanks for calling. How can I help you?
> [3.2s]  Speaker 1: Yeah, I had a few questions about pricing.
> [6.8s]  Speaker 0: Of course, happy to walk you through it.
> ```
> There are 3 utterances above. Each utterance contains:
> - **Who spoke** (`speaker`)
> - **What was said** (`transcript`)
> - **When it started** (`start`)
> - **When it ended** (`end`)
>
> **Why utterances and not words?**
> Deepgram can also return word-level timestamps, but that level of detail is not needed here. Each utterance maps to one row in the `transcript` table — the granularity is just right: a complete sentence with a speaker label and a timestamp.

---

#### 4.6 Verify the output — four things to check

| What to check | What to look for | Problem if missing |
|---|---|---|
| **Multiple speakers** | At least `Speaker 0` and `Speaker 1` appear | Diarization failed — confirm `diarize: true` is set and the audio has two distinct voices |
| **Sentence-level segments** | Each line is a complete sentence or phrase, not a single word | `utterances: true` may not be set |
| **Filler words present** | Words like `um`, `uh`, `like`, `you know` appear in the transcript | They should be there — Nova-3 does not strip them by default. Needed for `content_raw` in Step 5 |
| **Timestamps make sense** | `[0.0s]` at the start, numbers increase throughout, roughly match the audio duration | If all timestamps are `0.0`, the audio file may be corrupt or in an unsupported format |

---

#### 4.7 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `DEEPGRAM_API_KEY` is `undefined` | Key not in `.env.local` or file not loaded | Confirm `.env.local` has `DEEPGRAM_API_KEY=...` and restart the terminal |
| `Deepgram returned no utterances` | Audio has no speech, or wrong format | Test with a different audio file; confirm it plays correctly before transcribing |
| `Error: ENOENT: no such file or directory` | `sample-audio.mp3` not found | Confirm the file is in the project root and the path matches |
| `401 Unauthorized` | Invalid or expired API key | Regenerate the key in the Deepgram Console |
| All utterances assigned to `Speaker 0` | Only one voice detected, or voices too similar | Normal for single-speaker audio — diarization works best with two distinct voices |

---

---

#### 4.8 Verify the saved output files

After the script finishes, confirm that two files were created in `sample-transcripts/`:

**`sample-transcripts/sample-audio-1.json`** — open it and check:
- It is a JSON array where each object has `speaker`, `transcript`, `start`, and `end`
- The array length matches the utterance count printed in the terminal
- Speaker values are integers (`0`, `1`, etc.)

```json
[
  {
    "speaker": 0,
    "transcript": "Hi, thanks for calling GlobiFYE. How can I help you today?",
    "start": 0.0,
    "end": 2.1
  },
  ...
]
```

**`sample-transcripts/sample-audio-1.md`** — open it and check:
- Each line is a readable utterance in the format `**[0.0s] Speaker 0:** ...`
- The conversation flows in chronological order

> This JSON file is the direct input for Step 5 — no Deepgram API call needed there.

---

> ✅ If you see multiple speakers, sentence-level segments, filler words in the terminal output, and both files saved in `sample-transcripts/`, **Step 4 is complete.**

→ Next: [Step 5 — Transcript Parsing & DB Write](ai-pipeline-mvp-step5-transcript-parsing-db-write.md)
