# Call Transfer Architecture — AI ↔ Salesperson

**Parent doc:** [`sip-loop-mvp-design-doc.md`](./sip-loop-mvp-design-doc.md)
**Builds on:** [Step 7, section 2 — AI/salesperson switching](./sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md) (in-call takeover, same bridge)
**Related:** [`ai-pipeline-vs-ai-agent.md`](../../design-docs/ai-pipeline-vs-ai-agent.md) (why "normal call" and "agent call" are two different systems)
**Status:** Design, not implemented. Answers an architecture question Danish raised in the 2026-07-16 meeting.
**Goal:** Settle where call transfer between the AI voice agent and a human salesperson actually lives, and what each side has to add.
**Non-goals:** DID/number provisioning, concurrency, production error handling. Those stay in Step 7's deferred list.

> **Sequencing note.** The three pieces of this work — the RAG pipeline, adding SIP to the normal (human) call, and transfer itself — are not a dependency chain except at the very end. RAG and normal-call-SIP are independent and can be built in either order or in parallel. Transfer is the only piece that needs both call legs on SIP first. Danish's ordering in the meeting ("finish RAG, then SIP the normal call, then transfer") is a priority call, not a technical constraint.

---

## 1. Why this doc

In the 2026-07-16 meeting Danish asked for two-way call transfer: a human should be able to hand a live call to the AI, and the AI should be able to hand a live call to a human ("both ways"). His example was the website chatbot that says "let me connect you with the support team."

That raised a real architecture question worth settling before anyone builds: **where does transfer live?** Three readings are possible, and they lead to very different code:

1. Transfer is a feature we add inside the AI voice agent pipeline.
2. Transfer is a feature we add inside the normal (human) call pipeline.
3. Transfer is neither — it sits underneath both.

The answer is (3), and getting it right up front avoids building the same handoff logic twice in two places that then have to agree with each other.

> **What's the "normal call" vs. the "agent call":**
> Two separate systems, spelled out in the related doc. The **agent call** is the AI placing and handling the call itself (STT → LLM → TTS), already running over SIP through Asterisk. The **normal call** is the older AI Pipeline MVP: a human salesperson drives the call and the AI only transcribes and summarizes afterward. Its audio today comes from the **browser microphone**, not SIP. "Adding SIP to the normal call" means making the salesperson's leg a real phone call on Asterisk instead of a browser mic.

---

## 2. The technical decisions, and why

### A. Transfer is a call-control operation on Asterisk, not a feature inside either pipeline

The requirement is to move a customer from talking to the AI to talking to a human, or the reverse, without dropping the call. The tension is that "the AI pipeline" and "the human pipeline" are two different audio producers; if either one tries to own the handoff, it has to reach into the other's internals.

The resolution comes from how Asterisk already sees a call. Every party on a call is a **channel**, and two or more channels talking to each other sit in a **bridge**. The customer never leaves; transfer is just changing *who else is in the bridge with them*. That is a call-control action Asterisk performs (via ARI), one level below either pipeline.

> **What's a channel / a bridge:**
> A **channel** is one leg of a call — the customer's phone line, the AI's audio feed, or a salesperson's softphone are each a channel. A **bridge** is Asterisk connecting channels so they hear each other. Transfer = keep the customer's channel, swap which other channel shares its bridge.

```
                      ┌───────────────────────────────┐
  Customer phone ───► │            Asterisk           │
                      │      (channels + bridges)     │
                      └───────┬───────────────┬───────┘
                              │               │
               external media │               │ SIP endpoint
                              ▼               ▼
                      AI Agent loop        Salesperson
                   (STT → LLM → TTS)      (softphone)
                              ▲               ▲
                              └── transfer ───┘
                    (re-bridge the customer to the other leg;
                     each pipeline only exposes a trigger hook)
```

So neither pipeline "absorbs" the other. Each one only needs a small hook that asks Asterisk to re-bridge:

- **AI → human:** the agent loop (or the customer asking for a person) fires a "transfer to salesperson" request, and hands over what it has gathered so far.
- **Human → AI:** the salesperson clicks a button that re-bridges the customer back to the AI leg.

This is the same mechanism as Step 7 section 2's in-call takeover; that design is the special case where the human joins the *existing* bridge instead of replacing the AI in it. Both are bridge-membership changes, which is why they belong together at this layer.

### B. Both legs must be SIP endpoints on the same Asterisk — that is the one real prerequisite

For Asterisk to bridge the customer to a salesperson, the salesperson has to be something Asterisk can dial: a **SIP endpoint**. Today the salesperson in the normal-call pipeline is a browser mic, which Asterisk cannot route to. That is exactly why the "add SIP to the normal call" task exists, and why Danish said both sections need to be on SIP before transfer testing can start ("both the sections need to be on SIP before we actually start doing that").

| Leg | On SIP today? | What it needs for transfer |
|---|---|---|
| AI agent call | Yes (Steps 1–4) | Nothing new for transport; add a trigger hook |
| Normal (human) call | No — browser mic | Register the salesperson as a SIP endpoint on the same Asterisk |

Only when both legs live on the same Asterisk is there anything to bridge. This is the single hard ordering constraint in the whole feature.

### C. RAG and normal-call-SIP are independent; you can add SIP to the normal call first

Danish's stated order was RAG first, then SIP the normal call, then transfer. That order is fine, but it is a priority choice, not a dependency:

- **RAG** changes what the AI *says* — it lives in the LLM step of the agent loop and touches the knowledge base and retrieval. It does not touch telephony at all.
- **Normal-call-SIP** changes where the human leg's *audio comes from* — pure transport, no LLM involvement.

They share no code, so they can be built in either order or in parallel (for example, one person on RAG, another on normal-call-SIP). The only thing that must come after both is transfer testing, per decision B. A useful side benefit of doing the agent SIP work first (already done) is that the Asterisk setup pain — NAT, codecs, ARI app registration — is already paid for, so wiring the salesperson leg reuses that config.

### D. When live transfer is not ready, the fallback is capture-and-hand-off

Danish accepted a fallback for when a real bridge transfer is hard: instead of transferring, the AI stores the caller's information (name, number, what they wanted) and hands it to the sales team to call back. He asked for both scenarios to be tested. This is worth stating because it decouples value from difficulty: the capture-and-hand-off path needs no bridge surgery at all — it is a write to the contacts/call log plus a notification — so it can ship even before decision B's prerequisite is met.

---

## 3. What to change, and where

| Where | What | New / Change |
|---|---|---|
| Asterisk config (`asterisk-config/pjsip.conf`) | Register the salesperson as a SIP endpoint on the same Asterisk as the agent leg, so the customer can be bridged to them | Change |
| The live agent loop ([`sip/scripts/step2_stt_bridge.py`](../scripts/step2_stt_bridge.py)) | Add a trigger hook: on "transfer to human" (LLM decision or customer request), ask Asterisk to re-bridge and pass along the gathered context | Change |
| Normal (human) call pipeline | Move the salesperson's audio from browser mic to a SIP softphone leg on Asterisk (the "add SIP to normal call" task) | Change |
| Demo/sales UI server | A transfer control endpoint the dashboard calls to move the customer between the AI leg and the salesperson leg, both directions | **New** |
| Sales dashboard | A transfer button plus a state chip showing who currently holds the call (AI / salesperson) | Change |
| Contacts / call log (Supabase) | The capture-and-hand-off fallback: store caller name, number, and intent, and flag it for sales follow-up when no live transfer happens | Change |

The bridge/ARI takeover mechanics (mode flag, joining vs. replacing in the bridge, transcript continuity) are already specified in Step 7 section 2 and are not repeated here; this doc is the layer-and-ordering decision that sits above them.

---

## Deliverable

An agreed answer to the meeting question, verifiable in plain terms:

- **Where transfer lives:** at the Asterisk bridge layer, triggered by hooks in each pipeline — not owned by either pipeline.
- **What each side adds:** the agent leg adds a trigger hook; the normal call adds a SIP softphone leg for the salesperson; both must be on the same Asterisk before transfer works.
- **What can start now, independent of RAG:** adding SIP to the normal call, and the capture-and-hand-off fallback.

End-to-end proof, when built: place an AI-answered call, click transfer, confirm the customer is now talking to the salesperson's softphone with the call still up; then hand back to the AI and confirm automated answering resumes.

## Failures log

_(empty — fill during implementation: symptom / cause / fix. Bridge and NAT issues are the likely candidates.)_

## Appendix — build-time specifics (skip on a first read)

- **ARI transfer primitive:** the customer channel stays put; transfer is `POST` of a channel into (or out of) the existing bridge, plus an `originate` to the salesperson endpoint on first AI→human handoff. Exact ARI bridge/channel calls follow Step 7 section 2's control-path design.
- **Salesperson endpoint:** a second `[sales-endpoint]` in `pjsip.conf`, registered on a second softphone or a second Linphone identity (Step 7 section 2 open question, "Salesperson audio device").
- **Transcript during a human leg:** `externalMedia` carries mixed bridge audio, so human and customer turns are not separated with diarization off today — same open question as Step 7 section 2; resolve with the switching build.
- **Context passed on handoff:** the "what the caller wanted" payload reuses the same transcript/analysis the console already produces (Step 5); the fallback path writes it to the contact record instead of a live channel.

## Next

Fold the agreed ordering into [`sip-task-split.md`](./sip-task-split.md) once the PM signs off on doing normal-call-SIP in parallel with RAG rather than strictly after it.
