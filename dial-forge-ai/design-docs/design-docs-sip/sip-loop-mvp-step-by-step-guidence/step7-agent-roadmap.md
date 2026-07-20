# Step 7 - Agent Roadmap and Deferred Scope

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md), section 4, Step 7
**Builds on:** [Step 5, the demo console](./step5-pm-demo-ui.md) and [Step 6, the data sync](./step6-supabase-sync.md)
**Status: designs, not implementations.** Everything in this doc is planned work; nothing here is built unless a section says otherwise.

## 1. Knowledge base -> RAG

**Today (built, Step 5 section 3):** each company's whole KB file is injected into the LLM system prompt per call. At the current size (roughly 950 tokens per company) this is the right design: zero added latency, no retrieval failure modes, the whole KB always in context.

**Until RAG lands:** any question the KB does not cover, and any company without a KB connected, gets the standard fallback (say the `FALLBACK_LINE`, collect name and phone number; Step 5 section 3). Once a company's library is active, grounded answers take over automatically.

**Planned:** move to retrieval (store the KB in chunks, retrieve only the sections relevant to the caller's question) when any trigger fires: a KB passes ~2,000 tokens, a company needs multiple documents, the KB becomes UI-editable, or more than ~5 companies onboard.

Options, stack comparison (pgvector on the Step 6 Supabase project + OpenAI embeddings), tenant isolation, latency budget, and the full recommendation live in the dedicated decision doc:

**[`../rag-per-company-kb-design-doc.md`](../rag-per-company-kb-design-doc.md)**

## 2. AI agent / salesperson switching

**Status: designed 2026-07-13, not implemented.**

The story: calls are answered by the AI agent as today. A salesperson watches the live transcript on the sales dashboard and can click **Take over call** to speak to the client as a human; the button becomes **Hand back to AI**, which returns the call to automated voice responses.

```
Call arrives -> AI answers (current loop)
        |
        |  salesperson clicks [Take over call]
        v
Asterisk originates to the salesperson's softphone
        -> salesperson channel joins the existing mixing bridge
        -> bridge script gates the LLM/TTS path (mode = human)
        -> STT keeps running, so the live transcript continues
        |
        |  salesperson clicks [Hand back to AI]
        v
LLM/TTS path re-enabled (mode = ai)
        -> salesperson channel muted or removed from the bridge
        -> AI voice resumes answering
```

Planned mechanics, by component:

| Component | Change |
|---|---|
| Asterisk / pjsip.conf | A second endpoint for the salesperson (e.g. `[sales-endpoint]`), registered on a second softphone |
| Bridge script | A `mode` flag (`ai` / `human`). In `human` mode, STT finals still log (transcript continues) but are not fed to the LLM, and TTS playback is suppressed |
| Bridge script control path | A small localhost control endpoint (or ARI channel variable) so the UI server can flip the mode; today's event flow is one-way, bridge to UI |
| Demo UI server | `POST /api/handoff {mode}`: originate the salesperson leg into the current call's bridge on first takeover, then flip the bridge mode |
| Sales dashboard | The Take over / Hand back button, plus a state chip (AI HANDLING / YOU ARE LIVE) driven by an SSE event, visible on both views |

Open questions to settle before building:

| Question | Notes |
|---|---|
| Salesperson audio device | A second softphone registration is the near-term answer; browser WebRTC audio remains deferred (section 4). Needs a second device or a second Linphone identity |
| Transcript speakers during human mode | `externalMedia` carries the mixed bridge audio, so human and client turns would not be separated. Diarization is off in the Modulate config today; either accept mixed turns or revisit diarization |
| Analysis semantics | The sales-coach analysis assumes the agent side is one voice; a call with both AI and human segments needs a segment marker in the transcript |
| Where `mode` lives per call | Single active call today makes a global flag fine; concurrency (section 4) would need it per-channel |

## 3. Sales pipeline stage tracking (proposed)

**Status: proposed (Shuyang, 2026-07-15).** Today the pipeline is **content only**: each company's KB and the agent prompt are written around the five stages (Prospect, Contact, Demo, Proposal, Closing; Step 5 section 3), and the agent works the prospect toward the next stage on the call. The stage is not stored or reported.

The proposal is to make the stage structured and tracked:

- **`contacts.pipeline_stage`** in the merged project: where each prospect currently sits, set or advanced per call.
- **Post-call analysis**: the on-demand analysis already reads the transcript; have it also return the stage the call reached and the recommended next step, and write that to the contact.
- **UI**: show the stage on the sales dashboard and in call history; optionally a per-company view of how many contacts sit at each stage.

Cost: one column (or a small table) in Supabase, one added field in the analysis JSON + prompt, and a small UI addition. No change to the call path. Sequenced after the demo is settled with the PM.

## 4. Deferred scope (updated 2026-07-15)

Originally the Step 5 guardrails doc: a boundary list so the work does not quietly expand. Updated with what has changed since 2026-07-01.

| Item | Status / why deferred | Revisit when |
|---|---|---|
| **Concurrency / multiple simultaneous calls** | Still deferred. Danish flagged it as a separate test item (6/30). The whole stack assumes one active call (bridge globals, demo UI state) | After the demo console story is settled with the PM |
| **Production-grade error handling, reconnection, failover** | Partially improved en route (bridge survives bad calls, heartbeat liveness, leak cleanup: Step 5 section 8), but still not production-grade | Team commits to building past MVP |
| **Full agent LLM behavior** (objection handling, persona) | Partially superseded: per-company identity + KB grounding now exist (Step 5 section 3). Deeper behavior (RAG, tools, memory) still deferred | RAG design doc approval |
| **DID / phone number provisioning and billing** | Unchanged; Abraham's parallel track | Provider pricing finalized |
| **Streaming (non-file-based) TTS playback** | Unchanged; file-based playback is ~1.0s of the ~1.8s turn latency, so this is the main latency lever | When latency must close on the 1.5s budget |
| **STT/TTS vendor resolution in this codepath** | Unchanged; pipeline-wide decision in parallel | Vendor decision lands |
| **Browser as the audio device (WebRTC)** | The softphone is the client's voice; the browser pages are synced views. WebRTC into Asterisk is a meaningful build (certs, ICE, media path) | If the demo needs to run without a softphone |
| **Real authentication and per-role authorization** | Demo login is plaintext + shared session; analysis separation is interface-level only (Step 5 section 2) | Before anyone outside the team touches the console |
| **UI-editable knowledge base** | KB files are edited on disk; the UI only views them | With the RAG work (section 1) |
| **RAG retrieval** | Designed, not implemented | Trigger conditions in section 1 |
| **AI/salesperson switching** | Designed, not implemented (section 2) | PM review of the section 2 design |
| **Sales pipeline stage tracking** | Content only today; structured tracking proposed (section 3) | PM review; after the demo is settled |
| **Speaker diarization** | Needed for clean transcripts once a human can join the call (section 2) | With the switching build |

Every item above is legitimate future work; none are dismissed. Writing them down explicitly keeps "that's real, and it's next, not now" easy to say mid-implementation.
