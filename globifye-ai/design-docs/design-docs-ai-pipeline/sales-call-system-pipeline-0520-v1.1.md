# cSales Call System — AI Pipeline Design (May 19, 2026)

## Project Overview

Sales team management system with real-time call transcription, AI summary, and sales coaching features.

## Confirmed Requirements

- STT: Real-time (live during call), English-to-English only
- Summary latency: 1–2 minutes after call ends (async)
- Summary structure: team decides
- Objection Analysis: both positive feedback (what went well) + improvement suggestions
- Storage: all data persisted permanently until user deletes

## Pipeline Design (Updated May 20, 2025)

### Phase 1: During Call (Real-Time)

```
Microphone Input
    ↓
Audio Chunks (100–200ms) via persistent WebSocket
    ├── Raw Audio Chunks ──────────────────────────→ Cloud Storage (AWS S3 — see cloud-storage-selection.md)
    └── [Deepgram Nova-3 — STT + Speaker Diarization]
              ├── Partial Results → UI live transcript display (clean version)
              └── Final Results (per sentence, with sentence-level timestamp)
                        ↓
                  Write to `transcript` table in DB
                        ├── content_raw   (filler words retained — for LLM analysis)
                        └── content_clean (filler words removed — for UI display)
```

- UI shows: **Speaker + content_clean only** (no timestamps, no filler words)
- LLM receives **content_raw** — preserves hesitation signals (e.g. "I... um... I'm not sure") for objection analysis
- Filler word filtering happens **after** STT, at the DB write layer — not discarded at STT layer
- Audio binary is never stored in DB — only cloud storage URL is recorded

### Phase 2: After Call Ends (Button-Triggered)

```
User clicks "Analyze" Button
    ↓
Full Transcript passed directly from Frontend state (already in UI — no DB query needed)
    ↓
[LLM — Single call, structured JSON output]
    ├── Summary
    ├── Key Topics (navigation index)
    │     └── topic name + start_time → used for UI timestamp jumping only
    └── Analysis
          ├── Objections
          │     ├── timestamp        (when in the call)
          │     ├── exact_quote      (specific words spoken)
          │     ├── reason           (why customer was unwilling to close)
          │     └── suggestion       (how the sales rep should improve their approach)
          └── What Went Well
                └── specific moments or behaviors that contributed positively
    ↓
Store results in DB
    ↓
UI displays:
    ├── Summary
    ├── Key Topics list (sidebar/bottom) — click to jump to transcript position
    └── Analysis: Objections + What Went Well
```

- Analysis is **never auto-triggered** — only runs on explicit button click
- Transcript is sourced from Frontend state, not re-fetched from DB
- LLM makes a single call and returns one structured JSON response

### Pipeline Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Phase 1 — During Call                      │
│                         (Real-Time Pipeline)                       │
└─────────────────────────────────────────────────────────────────────┘

        User Microphone
                │
                ▼
    Audio Chunks (100–200ms)
      via Persistent WebSocket
                │
        ┌───────┴────────┐
        │                │
        ▼                ▼

┌────────────────┐   ┌────────────────────────────┐
│ Cloud Storage  │   │ Deepgram Nova-3 (STT)     │
│ (AWS S3)       │   │ + Speaker Diarization      │
└────────────────┘   └────────────────────────────┘
        │                         │
        │                         ├──────────────┐
        │                         │              │
        │                         ▼              ▼
        │               Partial Results     Final Results
        │                (live text)       (sentence end)
        │                         │              │
        │                         ▼              ▼
        │                UI Live Transcript   DB Write
        │                   Display           (per sentence)
        │
        ▼
recordings.audio_url

                                     ┌──────────────────────────┐
                                     │ transcript table         │
                                     │--------------------------│
                                     │ speaker                  │
                                     │ content_raw              │
                                     │ content_clean            │
                                     │ sentence_start_sec       │
                                     └──────────────────────────┘


                UI shows:
                - speaker
                - content_clean only

                LLM later receives:
                - content_raw
                - timestamps


┌─────────────────────────────────────────────────────────────────────┐
│                     Phase 2 — After Call Ends                      │
│                    (Button-Triggered Analysis)                     │
└─────────────────────────────────────────────────────────────────────┘

      User clicks "Analyze"
                │
                ▼
 Full Transcript from Frontend State
     (no DB query needed)
                │
                ▼

     ┌────────────────────────────┐
     │        LLM Analysis         │
     │   Single Structured Call    │
     └────────────────────────────┘
                │
                │
        ┌───────┼───────────────────────────────────┐
        │       │                                   │
        ▼       ▼                                   ▼

   Summary   Key Topics                    Sales Analysis
                  │                               │
                  │                               │
                  ▼                               ▼

       Topic Name + Start Time          ┌────────────────────┐
                                        │ Objections         │
                                        │--------------------│
                                        │ timestamp          │
                                        │ exact_quote        │
                                        │ reason             │
                                        │ suggestion         │
                                        └────────────────────┘

                                        ┌────────────────────┐
                                        │ What Went Well     │
                                        │--------------------│
                                        │ timestamp          │
                                        │ exact_quote        │
                                        │ reason             │
                                        └────────────────────┘


                ▼
        Store Analysis Results
                │
                ▼

┌────────────────────────────────────┐
│ analysis table                     │
│------------------------------------│
│ summary                            │
│ key_topics (JSON)                  │
│ objection_analysis (JSON)          │
│ what_went_well (JSON)              │
└────────────────────────────────────┘


                ▼
               UI

    ┌───────────────────────────────┐
    │ Summary                       │
    │ Key Topics Navigation         │
    │ Objection Analysis            │
    │ What Went Well                │
    └───────────────────────────────┘
```

## Database

### Data Flow

```
Audio Stream
    ↓
Streaming STT
    ↓
Transcript DB
    ↓
Frontend Transcript State
    ↓
LLM Analysis
    ↓
Structured JSON
    ↓
Analysis DB
    ↓
UI Visualization
```

### Database Schema (Updated May 20, 2026)


| Table        | Key Fields                                                                                           | Written When                              |
| ------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `recordings` | `id`, `call_metadata`, `audio_url` (AWS S3), `duration`, `created_at`                                | Call starts / ends                        |
| `transcript` | `recording_id`, `speaker`, `content_raw`, `content_clean`, `sentence_start_sec`                      | Real-time, per final sentence during call |
| `analysis`   | `recording_id`, `summary`, `key_topics` (JSON), `objection_analysis` (JSON), `what_went_well` (JSON) | After button click                        |


**Notes:**

- `content_raw` retains filler words for LLM analysis; `content_clean` strips them for UI display
- `sentence_start_sec` in `transcript` is a sentence-level timestamp used internally by the LLM — it is **not displayed in the UI**
- `key_topics` and `objection_analysis` are stored as JSON within `analysis`, not as separate tables
- Raw audio is stored in cloud storage; `recordings.audio_url` is the pointer

### Timestamp Jumping (two types)

- Jump to a transcript sentence → use `transcript.sentence_start_sec`
- Jump to a topic start → use `analysis.key_topics[n].start_time`

## STT Service: Deepgram Nova-3

- Sentence-level timestamps native (word-level available but not needed)
- Speaker Diarization built-in
- Filler word filtering configurable
- <300ms streaming latency
- ~$0.41/hr (STT + diarization)
- WebSocket API, simplest integration
- Alternative: AssemblyAI if per-sentence sentiment analysis is needed later

## LLM Preset Output Structure (Updated May 20, 2026)

> `key_topics` is a **UI navigation index**, not part of the analysis output.
> Each topic's `start_time` maps to a position in the transcript — clicking a topic in the UI jumps to that point.

```json
{
  "summary": "...",
  "key_topics": [
    {
      "name": "...",
      "start_time": 0.0
    }
  ],
  "analysis": {
    "objections": [
      {
        "timestamp": 142.5,
        "speaker": "Customer",
        "exact_quote": "...",
        "reason": "...",
        "suggestion": "..."
      }
    ],
    "what_went_well": [
      {
        "timestamp": 60.0,
        "speaker": "Sales Rep",
        "exact_quote": "...",
        "reason": "..."
      }
    ]
  }
}
```

## Still Pending *(originally noted May 19)*

- Backend tech stack (affects LangChain decision) — **[May 20 meeting]** Backend confirmed both TypeScript and JavaScript are supported.
- Whether Objection Analysis should also run in real-time during call or only post-call — **[Resolved May 20 meeting]**
- Exact latency SLA (still being confirmed with PM Danish Parray) — **[Resolved May 20 meeting]**
- **reduce apis, reduce cpu usage**

---

## PM Clarification Points — May 20, 2026

### 1. Live Audio Storage Mechanism

- **(a) Storage flow**: To be confirmed — does audio get recorded in full first and then written to the database, or is it written incrementally in real-time during recording?
- **(b) Industry reference (e.g., Otter.ai)**: Need to confirm whether to adopt streaming write (real-time incremental) or batch write (write after recording ends), and the architectural implications of each approach.

### 2. Live Transcription Processing

- **(a) Filler word filtering**: Following Otter.ai's approach — filler words (e.g., "um", "uh") should be filtered out during transcription and not written to the record.
- **(b) Storage timing**: To be confirmed — are transcription results written to the database in real-time as a stream, or generated in full after recording ends and then stored?
- **(c) Timestamp requirement**: Word-level timestamps are **not required**. Only **Speaker + Content (who said what)** needs to be recorded.

### 3. Other Feature Requirement Updates

- **(a) UI Capture removed**: Confirmed — UI Capture feature is **not needed**.
- **(b) Trigger mechanism updated**: A **Button** will be added. All AI analysis outputs (Summary, Topic, Timestamp, Objection Analysis) are **only triggered when the user explicitly clicks this button** — no automatic execution.
- **(c) Objection Analysis refined**: LLM analysis must output:
  - At which **timestamp / time point** in the call
  - The **specific words/statements** spoken
  - The **concrete reason** why the customer was unwilling to close the deal

---

## Research: Live Audio & Live Transcription Processing Mechanisms — May 20, 2026

### Live Audio — Storage Mechanism

**Industry standard: Streaming Write (write while recording)**

Modern systems do not wait for recording to end before storing. Audio is sliced into **100–200ms chunks** and transmitted in real-time over a **persistent WebSocket connection** to the server:

```
Microphone → Audio Chunks (100–200ms) → WebSocket → Server → Cloud Storage + DB Metadata
```

- Raw audio files are typically written to **cloud storage** — **decided: AWS S3** (see `cloud-storage-selection.md`) — not directly into a relational database.
- The database stores **metadata** (recording ID, timestamps, speaker info, etc.), not raw audio binaries.
- The WebSocket connection stays open throughout the call, eliminating per-request handshake overhead that would destroy real-time performance.

### Live Transcription — Processing Mechanism

**Two modes compared:**


|          | Streaming (Real-Time)              | Batch (Post-Recording)                      |
| -------- | ---------------------------------- | ------------------------------------------- |
| Latency  | 300–800ms                          | Seconds to minutes                          |
| Accuracy | Slightly lower (no full context)   | 10–17% better WER                           |
| Best for | Live conversation, Agent pipelines | Post-call analysis, precision transcription |


**How Otter.ai works (Streaming mode):**

- Text appears on screen in real-time as the user speaks.
- Speaker Diarization and timestamps are identified live.
- Transcription results are **written to the database incrementally**, not after recording ends.

**Technical flow (e.g., Deepgram / AssemblyAI):**

- Audio chunks are sent to the STT service via WebSocket.
- The service returns **partial results** (live, updated continuously) and **final results** (confirmed when a sentence ends).
- Only **final results** are committed to the database.

### Recommended Approach for This Pipeline


| Question                                                | Recommended Answer                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Audio: record-then-store or stream-and-store?           | **Stream-and-store** — chunks written to cloud storage in real-time |
| Transcription: generate-then-store or stream-and-store? | **Stream-and-store** — final results trigger DB write per sentence  |
| Filler words?                                           | Filter at STT layer (Deepgram supports this natively)               |
| Word-level timestamps needed?                           | No — Speaker + Content only, as confirmed by PM                     |


