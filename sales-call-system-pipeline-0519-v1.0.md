# Sales Call System — AI Pipeline Design

## Project Overview
Sales team management system with real-time call transcription, AI summary, and sales coaching features.

## Confirmed Requirements
- STT: Real-time (live during call), English-to-English only
- Summary latency: 1–2 minutes after call ends (async)
- Summary structure: team decides
- Objection Analysis: both positive feedback (what went well) + improvement suggestions
- Storage: all data persisted permanently until user deletes

## Pipeline Design

### Phase 1: During Call (Real-time)
```
Live Audio
    ↓
[STT - Deepgram Nova-3]
    ↓
Transcript chunks (with timestamps) → UI live caption display
    ↓
Write to Database in real-time
```
UI shows: live transcript only

### Phase 2: After Call Ends (Async)
```
Full Transcript (already in DB)
    ↓
[Async Queue]
    ↓
[LLM — Single call, structured JSON output]
    ├── Summary
    ├── Objection Analysis
    │     ├── what_went_well
    │     └── improvement_suggestions
    └── Topic-level Timestamp Analysis
          (segment transcript by topic,
           each topic maps to a time range)
    ↓
Store results in Database
    ↓
UI updates to show Summary + Topic Timestamps + Objection Analysis
```

## Database Schema (3 tables concept)

| Table | Content | Written |
|-------|---------|---------|
| `transcript` | each sentence + timestamp | real-time, during call |
| `summary` | Summary + Objection Analysis | after call ends |
| `topics` | topic name + start/end timestamps | after call ends |

## Timestamp Jumping (two types)
- Jump to a transcript line → use `transcript` table
- Jump to a topic start → use `topics` table

## STT Service: Deepgram Nova-3
- Word-level timestamps native, no extra cost
- <300ms streaming latency
- ~$0.41/hr (STT + diarization)
- WebSocket API, simplest integration
- Alternative: AssemblyAI if sentiment analysis per sentence is needed later

## LLM Output Structure
```json
{
  "summary": "...",
  "key_topics": ["...", "..."],
  "action_items": ["...", "..."],
  "objection_analysis": [
    {
      "objection": "...",
      "what_went_well": "...",
      "improvement_suggestions": "..."
    }
  ],
  "topics": [
    {
      "name": "...",
      "start_time": 0.0,
      "end_time": 45.2
    }
  ]
}
```

## Still Pending
- Backend tech stack (affects LangChain decision)
- Whether Objection Analysis should also run in real-time during call or only post-call
- Exact latency SLA (still being confirmed with PM Danish Parray)
