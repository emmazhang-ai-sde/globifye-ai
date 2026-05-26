# Speech-to-Text Selection Guideline
## For the GlobiFYE Sales Call System
**Created: May 20, 2026**

---

## 1. Core Requirements

Based on the project documentation, the STT layer must satisfy the following:

| Requirement | Specification |
|-------------|--------------|
| Real-time | Streaming WebSocket, <300ms latency |
| Language | English only |
| Speaker Diarization | Required (distinguish Sales Rep from Customer) |
| Filler word filtering | Must be natively supported or configurable |
| Timestamps | Sentence-level only (word-level not required) |
| Cost | Minimize — PM requires reducing API calls |
| GPU | PM requires reducing GPU usage |

---

## 2. Commercial API Comparison

### 1. Deepgram Nova-3 ✅ Current Choice

| Property | Details |
|----------|---------|
| Streaming latency | <300ms |
| WER | 5.3–6.8% |
| Price (with diarization) | ~$0.41/hr |
| Speaker Diarization | Built-in, free |
| Filler word filtering | Native support via `smart_format` parameter |
| Integration | WebSocket API (simplest available) |
| GPU requirement | None (fully cloud-hosted) |

**Why it wins:**
- Lowest latency, best accuracy, lowest price, simplest integration
- Speaker Diarization included at no extra cost
- `smart_format` handles filler word filtering with no post-processing needed
- Zero GPU consumption

```bash
npm install @deepgram/sdk
```

---

### 2. AssemblyAI Universal-3 (U3 Pro)

| Property | Details |
|----------|---------|
| Streaming latency | ~150ms |
| WER | 6.3% |
| Price (with diarization) | ~$0.57/hr |
| Speaker Diarization | Built-in |
| Unique feature | Native sentence-level Sentiment Analysis |

**Best for:** Switch to this if real-time per-sentence sentiment analysis is needed later. Currently 40% more expensive than Deepgram — not the priority choice.

---

### 3. OpenAI Whisper API

| Property | Details |
|----------|---------|
| Real-time streaming | ❌ Not supported |
| Speaker Diarization | ❌ None |
| Accuracy | ✅ Excellent (batch scenarios) |

**Verdict:** No streaming support — does not fit Phase 1 requirements.

---

### 4. Google Speech-to-Text (Chirp 3)

| Property | Details |
|----------|---------|
| Streaming latency | 300–600ms |
| WER | 11.6% |
| Price | ~$1.30/hr (3× more expensive than Deepgram) |
| Integration complexity | High (gRPC) |

**Verdict:** Expensive, less accurate, complex to integrate — not recommended.

---

### 5. Azure Cognitive Services

| Property | Details |
|----------|---------|
| Streaming latency | 300–500ms |
| WER | 10–12% |
| Price | ~$1.30/hr |
| Integration complexity | Medium |

**Verdict:** Poor value for money — not recommended.

---

### 6. Modulate AI

| Property | Details |
|----------|---------|
| Streaming latency | Not publicly disclosed |
| WER | Not disclosed — marketed as "best-in-class accuracy on real-world audio" |
| Price (batch) | **$0.03/hr** ($0.0005/min) — ~8× cheaper than Deepgram batch |
| Price (streaming) | Not specified |
| Speaker Diarization | ✅ Built-in (`speaker_diarization=true` parameter) |
| Streaming mode | ✅ WebSocket |
| Batch mode | ✅ |
| Languages | Multilingual (exact count not disclosed) |
| Unique features | Emotion detection, accent detection, PII/PHI redaction, deepfake detection (98.9% accuracy, #1 Hugging Face), specialized vocabulary (medical / geographic / political) |
| Velma engine | Beyond STT — analyzes 7 acoustic layers: tone, emotion, prosody, speaker dynamics, deception cues |
| Free tier | ✅ Credit-based |
| Integration | `speaker_diarization=true` parameter; SDK not well documented |
| Ecosystem maturity | Early-stage / enterprise-focused; less community adoption than Deepgram |

**Why Modulate AI is interesting:**
- At **$0.03/hr**, it is 8–15× cheaper than Deepgram depending on mode — significant at scale
- Emotion detection and deception-cue analysis from Velma could enhance Phase 2 analytics in future iterations
- Deepfake detection (98.9% accuracy) is a differentiator for call authenticity verification

**Why it does NOT replace Deepgram Nova-3 for this MVP:**

| Risk | Impact |
|------|--------|
| No public WER benchmark | Cannot verify accuracy claim before Monday demo — high risk |
| No latency data | Cannot confirm Phase 1 <300ms requirement is met |
| No keyterm prompting | Deepgram's 100-term domain vocabulary tuning unavailable |
| Thinner SDK ecosystem | `@deepgram/sdk` is battle-tested; Modulate has no equivalent npm package documented |
| Less documented | Fewer community examples, tutorials, and edge-case handling |

**Verdict:** Compelling on price; insufficient publicly documented specs to trust for a live demo. **Revisit post-MVP** if call volume grows and cost becomes a concern — the 8× cost saving justifies a proper benchmark test at that point.

---

### Commercial API Summary

| Service | Word Error Rate | Streaming Latency | Price/hr (approx) | Diarization | Integration |
|---------|-----|------------------|-------------------|-------------|-------------|
| **Deepgram Nova-3** ✅ | 5.3–6.8% | <300ms | $0.41 (streaming) / $0.26 (batch) | ✅ Built-in | Simplest |
| AssemblyAI U3 Pro | 6.3% | ~150ms | $0.57 | ✅ Built-in | Simple |
| **Modulate AI** | Undisclosed | Undisclosed | $0.03 **(batch)** | ✅ Built-in | Undocumented SDK |
| OpenAI Whisper API | Lowest | ❌ No streaming | Per-minute | ❌ None | Simple |
| Google Chirp 3 | 11.6% | 300–600ms | $1.30 | Built-in | High (gRPC) |
| Azure Standard | 10–12% | 300–500ms | $1.30 | Built-in | Medium |

> **Note on Modulate AI pricing:** $0.03/hr is for their STT batch API. Streaming pricing and volume tiers are not published. The dramatic price gap warrants a dedicated benchmark comparison once the MVP is validated.

---

## 3. Open-Source Options (GitHub) 

> ⚠️ We are currently focused on commercial API solutions. Open-source self-hosting options are not being evaluated at this stage.

---

## 4. Decision Framework

```
Phase 1 (Real-time) and Phase 2 (Post-call) can be chosen independently

                    ┌─────────────────────────────────┐
                    │         Decision Tree            │
                    └─────────────────────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
       Real-time streaming?                   Post-call batch?
              │                                       │
        ┌─────┴──────┐                         ┌─────┴──────┐
        │            │                         │            │
    Speed /       Full              High accuracy     Extreme
    low ops    self-host                           cost savings
        │            │                         │            │
   Deepgram      whisper.cpp              Deepgram     faster-whisper
   Nova-3        + pyannote               Nova-3       / Distil-Whisper
   ✅ Recommended  Needs server          ✅ Current     Self-hosted
```

---

## 5. Final Recommendation for GlobiFYE

| Phase | Recommended Option | Rationale |
|-------|-------------------|-----------|
| **Phase 1 — Real-time transcription** | **Deepgram Nova-3** | Lowest latency, built-in Diarization, zero GPU, simplest WebSocket, lowest cost |
| **Phase 2 — Post-call analysis** | **No additional STT needed** | Transcript is passed directly from Frontend State to LLM — no re-transcription |
| **Future cost optimization (optional)** | whisper.cpp + pyannote | Consider self-hosting only at very high call volume; weigh against ops overhead |

### Interpreting PM's "Reduce APIs / Reduce GPU" Requirements

- **Reduce GPU:** Deepgram already satisfies this — fully cloud-hosted, zero local GPU consumption.
- **Reduce API calls:** This is aimed primarily at **Phase 2 LLM calls**. The current design already handles this:
  - A single LLM call returns the complete structured JSON (summary + key_topics + objections + what_went_well)
  - Transcript is passed in from Frontend State — no extra DB query

**Conclusion: Deepgram Nova-3 is the right choice. No need to switch.**

---

## 6. Core Concept Breakdowns

> Each concept is explained in the context of the GlobiFYE pipeline.

---

### Concept 1: WebSocket Streaming

#### The Analogy: Text Message vs Phone Call

| Method | Analogy | Technical equivalent |
|--------|---------|---------------------|
| Text message | Write a message, send it, wait for reply, connection closes | **HTTP request** |
| Phone call | Connection stays open; both sides can speak at any time | **WebSocket** |

Every HTTP communication follows this cycle:
```
Client → send request → server processes → return result → connection closes
```
If HTTP were used for audio, a new connection would have to be established every 100ms — the overhead is enormous and the latency is unacceptable.

WebSocket works like this:
```
Client → one-time handshake → bidirectional persistent communication → close when call ends
```

#### Why Audio Requires WebSocket

If HTTP were used:
```
[1st second of audio] → POST /transcribe → wait → return text
[2nd second of audio] → POST /transcribe → wait → return text
...
```
- Each request requires a new TCP handshake (100–300ms additional overhead)
- The user finishes a full sentence before seeing the first word
- Real-time caption experience like Otter.ai is impossible

With WebSocket:
```
One connection established
→ Continuously send 100ms audio chunks
→ Deepgram continuously returns recognized text
→ Connection closes when call ends
```

#### What are Audio Chunks?

Microphone input is a **continuous audio stream** that must be sliced into small segments:
```
Continuous microphone input:
████████████████████████████████████████

Sliced into 100ms chunks:
[chunk1][chunk2][chunk3][chunk4][chunk5]...
  100ms   100ms   100ms   100ms   100ms
```

**Why 100–200ms?**
- Too short (< 50ms): too many network requests, high overhead
- Too long (> 500ms): too much latency, real-time feel is lost
- 100–200ms: Deepgram's recommended range — balances latency and efficiency

#### How It Works in GlobiFYE

```
Sales Rep begins call
      ↓
Microphone captures audio
      ↓
Slice into 100–200ms chunks
      ↓
Send continuously via WebSocket to Deepgram
      ↓
Deepgram recognizes as it receives, returns text continuously
      ↓
Frontend displays live captions (Partial Results)
      ↓
Write to DB when sentence ends (Final Results)
```

Pseudocode:
```js
// Open WebSocket connection — once per call
const ws = new WebSocket("wss://api.deepgram.com/v1/listen?...")

// Microphone loop
mediaRecorder.ondataavailable = (event) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(event.data)  // send one chunk every 100ms
  }
}

// End of call
ws.close()
```

The WebSocket connection stays open for the entire call — like a continuous audio pipe flowing into Deepgram.


---

### Concept 2: Speaker Diarization

#### What Is It?

The core task of Diarization (pronounced: dai-uh-rize-ay-shun) is:
> **"Who said what and when"**

STT tells you *what was said*. Diarization additionally tells you *who said it*.

```
Without Diarization:
"Hello I'm calling about the pricing plan
 Sure let me pull that up for you
 Actually we have a budget concern"

With Diarization:
[Speaker 0 - 00:00] Hello I'm calling about the pricing plan
[Speaker 1 - 00:03] Sure let me pull that up for you
[Speaker 0 - 00:06] Actually we have a budget concern
```

#### How Does It Work Technically?

1. **Voiceprint feature extraction:** Each person's voice has unique frequency characteristics (pitch, resonance, etc.). The model converts audio segments into voiceprint vectors.
2. **Clustering:** Segments with similar voiceprints are grouped under the same speaker label; different voiceprints become different speakers.
3. **Label output:** Each transcribed segment is tagged as `speaker_0`, `speaker_1`, etc.

Note: Diarization **does not know who the speakers are** (it won't tell you their names). It only knows "these two segments came from the same person." In your system, `Speaker 0` and `Speaker 1` are mapped to Sales Rep / Customer at the business logic layer.

#### Why It Matters for GlobiFYE

Without Diarization, the database stores:
```
content: "Hello let me check that for you actually we have a concern"
```
There is no way to tell which lines came from the Sales Rep and which from the Customer — the LLM cannot analyze "customer objections" vs "sales rep responses."

With Diarization:
```sql
| speaker   | content_raw                        |
|-----------|------------------------------------|
| Speaker 0 | Hello let me check that for you    |
| Speaker 1 | Actually we have a budget concern  |
| Speaker 0 | I understand, let me explain...    |
```
The LLM can now accurately identify which line is a customer objection and which is the sales rep's response.

#### Why Deepgram's Built-in Diarization Is Valuable

The open-source alternative `pyannote.audio` requires:
- Deploying a separate Python service
- GPU to run at acceptable speed
- Timestamp alignment with STT output (complex)
- 300–800ms of additional latency

With Deepgram Nova-3, you enable it by adding one parameter to the WebSocket URL:
```
wss://api.deepgram.com/v1/listen?diarize=true&model=nova-3
```
Results automatically include a `speaker` field — **zero extra cost, zero extra latency**.


---

### Concept 3: WER (Word Error Rate)

#### The Formula

```
WER = (S + D + I) / N

S = Substitutions  — word was recognized incorrectly, replaced by wrong word
D = Deletions      — a word was missed entirely
I = Insertions     — an extra word was added that was never spoken
N = Total number of words in the reference (ground truth)
```

#### Worked Example

**Ground truth (what was actually said):**
```
"We have a budget concern with the current pricing plan"
 We  have  a  budget  concern  with  the  current  pricing  plan
  1    2   3    4       5       6     7      8        9      10    → N = 10
```

**Deepgram output (hypothesis):**
```
"We have a budget concerns with current pricing plans"
```

Word-by-word comparison:

| # | Reference | Hypothesis | Error type |
|---|-----------|-----------|-----------|
| 1 | We | We | ✅ |
| 2 | have | have | ✅ |
| 3 | a | a | ✅ |
| 4 | budget | budget | ✅ |
| 5 | concern | concerns | ❌ Substitution |
| 6 | with | with | ✅ |
| 7 | the | — | ❌ Deletion |
| 8 | current | current | ✅ |
| 9 | pricing | pricing | ✅ |
| 10 | plan | plans | ❌ Substitution |

```
WER = (2 + 1 + 0) / 10 = 3/10 = 30%
```

#### What Does 5.3% vs 11.6% Mean in Practice?

For a 10-minute call (approximately 1,500 words):

| Service | WER | Errors in 1,500 words |
|---------|-----|----------------------|
| Deepgram Nova-3 | 5.3% | ~80 word errors |
| Google Chirp 3 | 11.6% | ~174 word errors |

That is **more than 2× the error count**.

#### Why Sales Call Scenarios Are Especially WER-Sensitive

The LLM analysis outputs `exact_quote`:
```json
{
  "objections": [{
    "exact_quote": "We don't have the budget for this quarter",
    "reason": "Customer cited budget constraints"
  }]
}
```

If STT transcribes "we don't have the budget" as "we do have the budget," the LLM will reach the exact opposite conclusion — one Substitution error with a business-critical consequence.

High-WER services cause the most problems in:
- Industry jargon (CRM, SaaS, ROI — common in sales contexts)
- Accented English
- Overlapping speech
- Background noise

---

### Concept 4: Partial Results vs Final Results

#### Why Does STT Return Two Types of Results?

Speech recognition is a **continuous refinement process**. While someone says "I think the price is...":
- After "I" → model predicts: "I"
- After "think" → updates: "I think"
- After "the" → updates: "I think the"
- ...until a pause or sentence end is detected, confirming the final output

Each intermediate update pushed to you is a Partial Result.
Once the sentence ends and the output stabilizes, that is a Final Result.

#### Comparison

| | Partial Results | Final Results |
|--|----------------|--------------|
| Triggered when | Continuously while speaking | Once sentence-end pause is detected |
| Stability | Frequently changes, may be revised | Stable — will not change again |
| Accuracy | Lower (incomplete context) | Higher (full sentence context) |
| Flag field | `"is_final": false` | `"is_final": true` |
| Used for | Live caption display in UI | Writing to database |

#### Timeline Walkthrough

User says: "I don't think the pricing works for us"

```
Timeline →
t=0.1s  Partial: "I"
t=0.3s  Partial: "I don't"
t=0.6s  Partial: "I don't think"
t=0.9s  Partial: "I don't think the"
t=1.2s  Partial: "I don't think the pricing"
t=1.5s  Partial: "I don't think the pricing works"
t=1.8s  Partial: "I don't think the pricing works for"
t=2.1s  Partial: "I don't think the pricing works for us"
[sentence-end pause detected]
t=2.3s  ✅ FINAL: "I don't think the pricing works for us"
```

The UI starts displaying text at t=0.1s — the experience feels fluid.
The database write happens at t=2.3s — only clean, confirmed data is stored.

#### How GlobiFYE Uses Each

```
Deepgram returns result
       │
       ├── is_final: false → Partial Result
       │         │
       │         └── Update UI display (no DB write)
       │               User sees captions update in real time
       │
       └── is_final: true  → Final Result
                 │
                 ├── content_raw    → Write to DB (filler words retained)
                 ├── content_clean  → Write to DB (filler words removed)
                 ├── speaker        → Write to DB
                 └── sentence_start_sec → Write to DB
```

**Why not write Partial Results to DB too?**

Assume a sentence generates 8 Partial updates:
- Writing all Partials = 9 DB writes (8 Partial + 1 Final)
- Writing Final only = 1 DB write

A 30-minute call has roughly 300 sentences:
- Storing all Partials: ~2,700 DB writes, massive redundancy
- Final only: ~300 DB writes, clean data

The LLM only needs Final Results for analysis — storing Partials adds nothing.

#### Deepgram JSON Response Examples

```json
// Partial Result (is_final = false)
{
  "type": "Results",
  "is_final": false,
  "channel": {
    "alternatives": [{
      "transcript": "I don't think the pricing",
      "words": [...]
    }]
  }
}

// Final Result (is_final = true)
{
  "type": "Results",
  "is_final": true,
  "channel": {
    "alternatives": [{
      "transcript": "I don't think the pricing works for us",
      "words": [...],
      "speaker": 1
    }]
  },
  "start": 142.5,   // sentence_start_sec
  "duration": 2.3
}
```

---

### Concept 5: Streaming Latency vs Real-time Streaming

These two terms appear together often and are easy to confuse — but they describe **completely different things**.

#### One-line Distinction

| Concept | What it is | What it describes |
|---------|-----------|------------------|
| **Real-time Streaming** | A **processing architecture** — audio is processed as it arrives, not after recording ends | The system's operating mode |
| **Streaming Latency** | A **performance metric** — how long between speaking a word and seeing it appear on screen | The system's response speed |

Analogy:
- **Real-time Streaming** = "we're on a phone call" (describes the communication method)
- **Streaming Latency** = "how long after I speak before you hear me" (describes the call quality)

---

#### What Is Real-time Streaming?

Real-time streaming is defined in contrast to **batch processing**:

```
Batch mode:
─────────────────────────────────────────────────────
Call starts ──────────────────── Call ends
                                      │
                                      ▼
                               Full recording uploaded
                                      │
                                      ▼
                               STT begins processing
                                      │
                                      ▼
                               Full transcript returned
─────────────────────────────────────────────────────
User sees text: seconds or minutes after call ends


Real-time streaming mode:
─────────────────────────────────────────────────────
Call starts
  │
  ├─ Says "Hello"   → sends chunk → STT → returns "Hello"
  ├─ Says "I'm"     → sends chunk → STT → returns "Hello I'm"
  ├─ Says "calling" → sends chunk → STT → returns "Hello I'm calling"
  └─ ...
─────────────────────────────────────────────────────
User sees text: captions appear in real time as speech happens
```

**GlobiFYE uses real-time streaming** — this is the prerequisite for the Otter.ai-style live caption experience.

---

#### What Is Streaming Latency?

Once you have a real-time streaming architecture, how *real-time* is it? That is what latency measures:

```
User speaks a word
      │
      ├── Audio chunk transmitted to server     → network latency (~10–50ms)
      ├── Deepgram model inference              → model processing (~100–200ms)
      ├── Result returned via WebSocket         → network return (~10–50ms)
      └── Frontend renders the text             → render time (~5–10ms)
                                                       │
                                                       ▼
                                          Word appears on screen
```

**Streaming latency = total time across all steps above**

Deepgram Nova-3's `<300ms` means: **from the moment you speak a word to the moment it appears on screen, no more than 300 milliseconds**.

What does 300ms feel like?
- A human eye blink ≈ 150–400ms
- <300ms: captions feel truly real-time ✅
- 300–800ms: slight lag, still acceptable ⚠️
- >1000ms (1 second): captions visibly lag behind speech — poor experience ❌

---

#### How They Relate

Real-time streaming is the **prerequisite**. Streaming latency is the **quality measure**:

```
No real-time streaming → streaming latency is irrelevant (it's not streaming at all)

Has real-time streaming → now check if latency is low enough
               ├── <300ms    → captions feel real-time ✅
               ├── 300–800ms → slight lag, acceptable ⚠️
               └── >1000ms   → noticeable delay, bad experience ❌
```

Think of it this way:
- Real-time streaming = whether the "real-time" feature exists
- Streaming latency = how well the real-time feature performs

---

#### Why Does Batch Processing Have Better Accuracy?

| Mode | Latency | Accuracy (WER) |
|------|---------|---------------|
| Real-time streaming | 300–800ms | Slightly worse (limited context) |
| Batch processing | Seconds to minutes | 10–17% better WER (full context) |

Why:
- In streaming, each chunk only has access to **current and prior** audio — it cannot see what comes next
- In batch mode, the model sees the **entire recording** and can use full context
- Example: when streaming hears "I'll meet you at the..." it cannot yet determine whether the next word is "bank" (financial) or "bend" (road). Batch mode hears the full sentence first.

**GlobiFYE's two-phase solution:**
- Phase 1 (real-time streaming): trades a small accuracy loss for live caption experience
- Phase 2 (LLM analysis): already has the full transcript — no re-transcription needed, goes straight to semantic analysis

---

#### Streaming Latency Comparison Across Services

| Service | Streaming Latency | Notes |
|---------|------------------|-------|
| AssemblyAI U3 Pro | ~150ms | Fastest, but more expensive |
| **Deepgram Nova-3** | **<300ms** | **Best value** ✅ |
| Google Chirp 3 | 300–600ms | Expensive and slow |
| Azure Standard | 300–500ms | Same issue |
| whisper.cpp (self-hosted) | ~500–800ms | Depends on hardware |

---

### Five Concepts Connected to the Pipeline

```
┌─────────────────────────────────────────────────────────┐
│              GlobiFYE Phase 1 — Full Flow               │
└─────────────────────────────────────────────────────────┘

Sales Rep speaks
      │
      ▼
Microphone captures continuous audio stream
      │
      ▼
Sliced into 100–200ms audio chunks      ← Concept 1: audio chunking
      │
      ▼
Sent continuously via WebSocket         ← Concept 1: WebSocket streaming
(one handshake, connection stays open for entire call)
      │
      ▼
Deepgram Nova-3 receives and recognizes
      │
      ├── Partial Results (is_final: false)   ← Concept 4
      │         │
      │         └── UI displays live captions
      │               (user sees text follow speech)
      │
      └── Final Results (is_final: true)      ← Concept 4
                │
                ├── speaker: 0 or 1           ← Concept 2: Diarization
                ├── transcript (WER ~5.3%)    ← Concept 3: WER
                ├── start_time
                └── Write to DB
                      ├── content_raw (filler words retained)
                      ├── content_clean (filler words removed)
                      ├── speaker
                      └── sentence_start_sec
```

**How the five concepts relate:**
- **Real-time Streaming** defines the system's operating mode (process as it arrives vs process after recording)
- **WebSocket** is the technical mechanism that enables real-time streaming
- **Streaming Latency** measures how well real-time streaming performs
- **Partial / Final Results** determine when to display and when to store
- **Diarization** answers "who said this line"
- **WER** measures the quality of the recognition output

---

### Concept 6: Balancing Real-time Streaming and Batch Processing (Hybrid Layered Architecture)

Real-time streaming and batch processing are not mutually exclusive. **Different layers of the same pipeline can each use whichever mode suits them best.**

#### Core Idea

> Only the layer that directly affects user experience needs to be truly real-time. Every other layer can choose a more economical approach.

```
┌─────────────────────────────────────────────────────────┐
│  Layer           Mode              Latency Tolerance    │
├─────────────────────────────────────────────────────────┤
│  UI display      Real-time         Very low (<300ms)    │
│  DB writes       Micro-batch       Low (~sentence end)  │
│  LLM analysis    Full batch        High (button click)  │
└─────────────────────────────────────────────────────────┘
```

GlobiFYE's pipeline is already naturally layered this way — real-time streaming exists only at the user-facing layer; everything deeper becomes progressively more batch-oriented.

#### Deepgram's Built-in Balance Parameters

**① `interim_results=false` — Disable Partial Results**

```
Default (interim_results=true):
  t=0.3s  Partial: "I don't"
  t=0.6s  Partial: "I don't think"
  t=0.9s  Partial: "I don't think the"
  t=2.3s  ✅ Final: "I don't think the pricing works for us"
  → N messages pushed

Disabled (interim_results=false):
  t=2.3s  ✅ Final: "I don't think the pricing works for us"
  → 1 message pushed
```

Effect: keeps the streaming architecture while drastically reducing message frequency — approaches "sentence-level batch processing."
Trade-off: UI cannot show real-time captions; text only appears at sentence end, causing a jumping effect.

**② `endpointing` — Control sentence-end detection timing**

```
endpointing=300 (default, in ms):
  Speech → 300ms silence → sentence end detected → Final Result sent

endpointing=1000:
  Speech → 1000ms silence → sentence end detected → Final Result sent
```

Increasing `endpointing` = waiting for a longer pause before confirming sentence end = merging short fragments into more complete Final Results.
Benefit: fewer DB writes, more context per sentence, better accuracy.
Trade-off: Final Results arrive later, DB write latency increases.

#### Micro-batching at the DB Write Layer

```
❌ Naive approach (write each Final to DB immediately):
   Final #1 → INSERT
   Final #2 → INSERT
   Final #3 → INSERT
   ... (one DB write per sentence)

✅ Micro-batching (buffer then bulk write):
   Final #1 → buffer
   Final #2 → buffer
   Final #3 → buffer
   [every N sentences or N seconds] → bulk INSERT
```

Completely transparent to the frontend (captions are still real-time), but DB write pressure is reduced by roughly 10×.

#### Complete Layered View

```
Audio chunks (100–200ms)
        │  ← real-time streaming (<300ms)
        ▼
   Deepgram WebSocket
        │
        ├── Partial Results ──→ UI live captions (real-time display)
        │                       no DB writes
        │
        └── Final Results ──→ sentence buffer
                                │  ← micro-batch (every N sentences)
                                ▼
                           bulk write to DB
                                │
                                ▼
                        full transcript
                                │  ← full batch (button-triggered)
                                ▼
                           single LLM call
```

---

### Concept 7: Second-Pass Correction

#### Why Does the Full Transcript Reveal More Errors?

The fundamental limitation of streaming recognition is **one-directional context** — when recognizing each word, the model can only see what came before it:

```
During streaming:
  Speaking...  "I'll meet you at the ___"
                                    ↑
                     Context stops here.
              Can't tell if next word is "bank" or "bend"

In batch mode:
  "I'll meet you at the bank to sign the loan documents"
                              ↑
         Full context available — clearly "bank" (financial institution)
```

Scenarios most prone to streaming errors:
- **Homophones:** their / there / they're, too / to / two
- **Industry jargon:** SaaS, CRM, ROI — common in sales contexts
- **Company / product names:** Apollo → "a polo", Salesforce → "sales force"
- **Sentence beginnings:** least context available, most unstable recognition

#### Three Second-Pass Correction Approaches

**Option A: Re-run Batch STT (Re-transcribe)**

After the call ends, call Deepgram's Pre-recorded API again on the audio file stored in S3/GCS:

```
Call ends
    │
    ├── Streaming transcript (already in DB) → used for UI display
    └── Call Deepgram Pre-recorded API
              │  Input: audio_url (from S3)
              ▼
         Batch transcription (more accurate)
              ▼
         Overwrite DB transcript
              ▼
         LLM analysis uses the corrected version
```

Accuracy improvement: WER drops from ~5.3% to ~4% — roughly 1–2% better.
Trade-off: STT cost doubles; Phase 2 must wait for this step.
**Verdict: Marginal gain, high cost — not worth it in most cases.**

---

**Option B: LLM Correction in Passing (Best fit for GlobiFYE) ✅**

The LLM in Phase 2 already receives the full transcript. Add a correction instruction to the same prompt:

```
Current Phase 2 prompt:
┌──────────────────────────────────────────┐
│  Analyze the following call transcript:  │
│  1. Generate Summary                     │
│  2. Extract Key Topics                   │
│  3. Analyze Objections and What Went Well│
└──────────────────────────────────────────┘

With correction added:
┌──────────────────────────────────────────┐
│  Analyze the following call transcript   │
│  (may contain STT transcription errors): │
│  0. Correct obvious transcription errors │  ← added
│     (homophones, jargon, company names)  │
│  1. Generate Summary                     │
│  2. Extract Key Topics                   │
│  3. Analyze Objections and What Went Well│
│                                          │
│  Note: use corrected text for exact_quote│
└──────────────────────────────────────────┘
```

Types of errors the LLM can correct:

| Error type | Raw STT output | After LLM correction |
|-----------|---------------|---------------------|
| Homophone | "their budget is to small" | "their budget is too small" |
| Industry term | "we use a polo for leads" | "we use Apollo for leads" |
| Company name | "integrate with sales force" | "integrate with Salesforce" |
| Sentence boundary | "the deal is done it closed" | "the deal is done, it closed" |

What the LLM cannot correct: pure audio-level mishearing (e.g., "pricing" heard as a phonetically similar word) — the LLM only has text, not the original audio.

**Advantage: zero extra cost, zero extra API calls — fully aligned with PM's "reduce APIs" requirement.**

---

**Option C: Confidence Score Filtering (Selective Re-processing)**

Deepgram returns a `confidence` score (0–1) for each word. Only re-process low-confidence segments:

```json
{
  "words": [
    { "word": "Apollo",  "confidence": 0.43 },
    { "word": "pricing", "confidence": 0.98 }
  ]
}
```

```
Full transcript written to DB
        │
        ▼
Scan all word confidence scores
        │
        ├── confidence ≥ 0.7 → keep original text
        └── confidence < 0.7 → flag for correction
                                    │
                                    ▼
                    Pass to LLM with context (Option B)
                    or re-process just that audio segment (Option A)
```

Targeted correction of error-prone segments with controlled cost.

#### Recommended Path for GlobiFYE

```
Do not re-run full STT (high cost, minimal gain)

Recommended:

Streaming transcript (DB)
        │
        ▼
Phase 2 LLM call (already exists)
   ├── Add correction instruction   ← zero extra cost
   ├── LLM uses full context to fix homophones and jargon
   └── exact_quote uses corrected text in output
```

| | Phase 1 streaming transcript | Phase 2 LLM-corrected transcript |
|--|------------------------------|----------------------------------|
| **Used for** | Live UI captions + DB storage | LLM `exact_quote` output |
| **Accuracy** | WER ~5.3% | Higher (semantic-level correction) |
| **Extra cost** | — | Zero |
| **Extra API calls** | — | Zero |

---

## 7. Complete Pipeline Diagram

> Real-time streaming, micro-batching, full batch processing, and second-pass correction — all integrated into one diagram.

---

```
╔═════════════════════════════════════════════════════════════════════════════╗
║              GlobiFYE Sales Call System — Complete AI Pipeline             ║
╚═════════════════════════════════════════════════════════════════════════════╝


┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 1 — During Call                                  Real-time Layer     │
└─────────────────────────────────────────────────────────────────────────────┘

               Sales Rep / Customer on a call
                         │
                         ▼
               ┌──────────────────┐
               │    Microphone    │
               └────────┬─────────┘
                        │
                        │  Sliced into one audio chunk every 100–200ms
                        ▼
               ╔════════════════════════════════╗
               ║   WebSocket (persistent)        ║  ← one handshake, open for entire call
               ╚═════════════╦══════════════════╝
                             │
               ┌─────────────┴──────────────┐
               │                            │
               ▼                            ▼
    ┌─────────────────────┐    ┌─────────────────────────────┐
    │   Cloud Storage     │    │      Deepgram Nova-3         │
    │   (S3 / GCS)        │    │   STT + Speaker Diarization  │
    │   raw audio binary  │    │   WER ~5.3%  |  <300ms       │
    └──────────┬──────────┘    └──────────────┬──────────────┘
               │                              │
               ▼                    ┌─────────┴──────────┐
    recordings.audio_url            │                    │
                                    ▼                    ▼
                           ┌──────────────┐    ┌─────────────────┐
                           │   Partial    │    │     Final        │
                           │   Results    │    │     Results      │
                           │ is_final:    │    │  is_final: true  │
                           │   false      │    │  confirmed at    │
                           └──────┬───────┘    │  sentence end    │
                                  │            └────────┬─────────┘
                                  ▼                     │
                         ┌────────────────┐             ▼
                         │  UI live       │    ┌────────────────────┐
                         │  captions      │    │  sentence buffer   │
                         │  (no DB write) │    │  (in-memory cache) │
                         └────────────────┘    └─────────┬──────────┘
                                                         │
                                                         │ micro-batch
                                                         │ every N sentences / N seconds
                                                         ▼
                                              ┌──────────────────────────┐
                                              │     transcript table (DB)│
                                              │  speaker                 │
                                              │  content_raw             │  ← filler words retained
                                              │  content_clean           │  ← filler words removed
                                              │  sentence_start_sec      │
                                              └──────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 2 — After Call                                   Full Batch Layer    │
│  (triggered by user clicking "Analyze" button)                              │
└─────────────────────────────────────────────────────────────────────────────┘

               User clicks "Analyze" button
                         │
                         ▼
               Full transcript
               (from Frontend State — no DB query needed)
                         │
                         ▼
╔════════════════════════════════════════════════════════════════════════════╗
║                       LLM — Single Call                                   ║
║              (one call, returns complete structured JSON)                  ║
║                                                                            ║
║  ┌──────────────────────────────────────────────────────────────────────┐ ║
║  │  Step 0: Second-Pass Correction                                      │ ║
║  │                                                                      │ ║
║  │  Uses full context to fix streaming STT limitations:                 │ ║
║  │  • Homophones     their → there, too → to                           │ ║
║  │  • Jargon         a polo → Apollo, sales force → Salesforce         │ ║
║  │  • Company names  CRM, SaaS, ROI, etc.                              │ ║
║  │  • Sentence breaks  add punctuation, fix boundaries                 │ ║
║  │                                                                      │ ║
║  │  Corrected text feeds all subsequent steps                          │ ║
║  └──────────────────────────────────────────────────────────────────────┘ ║
║                                                                            ║
║  Step 1: Summary                                                           ║
║                                                                            ║
║  Step 2: Key Topics (UI navigation index)                                  ║
║          topic name + start_time → click to jump to transcript position    ║
║                                                                            ║
║  Step 3: Objection Analysis                                                ║
║          timestamp    ← when in the call this occurred                     ║
║          exact_quote  ← customer's words (using corrected text)            ║
║          reason       ← concrete reason customer was unwilling to close    ║
║          suggestion   ← how the sales rep should improve                   ║
║                                                                            ║
║  Step 4: What Went Well                                                    ║
║          timestamp    ← when it occurred                                   ║
║          exact_quote  ← sales rep's words (using corrected text)           ║
║          reason       ← why this was effective                             ║
╚═════════════════════════════════════╦══════════════════════════════════════╝
                                      │
                                      ▼
                         ┌────────────────────────────────┐
                         │       analysis table (DB)       │
                         │  summary                        │
                         │  key_topics        (JSON)       │
                         │  objection_analysis (JSON)      │
                         │  what_went_well     (JSON)      │
                         └────────────────┬───────────────┘
                                          │
                                          ▼
                         ┌────────────────────────────────┐
                         │              UI                 │
                         │  ├── Summary                    │
                         │  ├── Key Topics navigation      │
                         │  ├── Objection Analysis         │
                         │  └── What Went Well             │
                         └────────────────────────────────┘
```

---

### Three-Layer Processing Mode Reference

| Layer | Mode | Latency | Trigger | Purpose |
|-------|------|---------|---------|---------|
| **UI caption display** | Real-time streaming | <300ms | Partial Results | User experience — captions follow speech |
| **DB writes** | Micro-batch | ~sentence end (~2s) | Final Results buffer | Reduce write pressure, clean data |
| **LLM analysis** | Full batch | After call ends | User button click | Full context, highest accuracy |

### Two-Phase Transcript Quality Reference

| | Phase 1 streaming transcript | Phase 2 LLM-corrected transcript |
|--|------------------------------|----------------------------------|
| **Source** | Deepgram Final Results | LLM Second-Pass Correction |
| **Accuracy** | WER ~5.3% (homophone/jargon risk) | Higher (semantic-level correction) |
| **Used for** | Live UI captions + DB storage | `exact_quote` output |
| **Extra cost** | — | Zero (same LLM call) |

---

## 8. Reference Resources

| Resource | Link |
|----------|------|
| Deepgram Documentation | https://developers.deepgram.com |
| Deepgram Nova-3 Pricing | https://deepgram.com/pricing |
| AssemblyAI Documentation | https://www.assemblyai.com/docs |
| whisper.cpp GitHub | https://github.com/ggerganov/whisper.cpp |
| faster-whisper GitHub | https://github.com/SYSTRAN/faster-whisper |
| pyannote.audio GitHub | https://github.com/pyannote/pyannote-audio |
| Distil-Whisper GitHub | https://github.com/huggingface/distil-whisper |
| Vosk GitHub | https://github.com/alphacep/vosk-api |
| Modulate AI Website | https://www.modulate.ai |
| Modulate AI Docs | https://docs.modulate.ai |
| Modulate AI Developer Portal | https://modulate-developer-apis.com |
