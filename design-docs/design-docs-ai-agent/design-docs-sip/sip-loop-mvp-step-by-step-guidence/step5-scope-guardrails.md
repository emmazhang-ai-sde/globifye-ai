# Step 5 — Explicitly Not Doing Yet (Scope Guardrails)

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) — section 4, Step 5
**Purpose of this doc:** not an implementation step — a boundary list, so Steps 1–4 don't quietly expand into a much bigger project. Written down explicitly because "just prove the loop works" is easy to scope-creep past without noticing.

---

## Deferred items and why

| Item | Why it's deferred | Revisit when |
|---|---|---|
| **Concurrency / multiple simultaneous calls** | Danish flagged this as a *separate* test item on 6/30 ("we need to test how many calls can go simultaneously") — not blocking for a single-call proof of loop | After Step 4 passes reliably at least once |
| **Production-grade error handling, reconnection, failover** | Adds significant complexity (retry logic, dropped-call detection, WebSocket reconnects) for a step whose only goal is proving the happy path works at all | Once the team commits to building past the MVP stage |
| **Full agent LLM behavior** (custom instructions, objection handling, per-account persona, etc.) | This is a whole separate, already-scoped piece of the product (see `ai-agent-architecture-design-doc.md`) — conflating it with the SIP plumbing test makes it harder to isolate bugs in either | Once SIP loop is proven; agent behavior work continues independently either way |
| **DID / phone number provisioning and billing** | Abraham's pricing/backend track (call recording pricing, DID cost lines) is a separate, parallel workstream — this MVP only needs *a* SIP endpoint to dial, not a real customer-facing phone number | Once DID/SIP provider pricing is finalized on the backend side |
| **Streaming (non-file-based) TTS playback into the call** | File-based playback (Step 3) is slower per turn but far simpler to debug; the reverse-`externalMedia` streaming approach is meaningfully more complex | Once latency actually needs optimizing against the 1.5s budget — not before |
| **Resolving Modulate vs. Deepgram for STT, or ElevenLabs vs. Deepgram Aura for TTS, in this codepath specifically** | Those are pipeline-wide vendor decisions being worked in parallel (see personal notes 7/1) — the SIP MVP should use whatever's already wired up and working, not block on re-plumbing vendor swaps | After both the SIP loop and the vendor decision are independently settled |

## Why this doc exists

Every one of the items above is legitimate future work — none of them are being dismissed. The point is that Steps 1–4 have a narrow, achievable goal (prove the loop closes once), and each of these items would meaningfully expand that scope if pulled in early. Keeping them written down and explicitly deferred — rather than just "not mentioned" — makes it easier to say "that's real, and it's next, not now" if it comes up mid-implementation.
