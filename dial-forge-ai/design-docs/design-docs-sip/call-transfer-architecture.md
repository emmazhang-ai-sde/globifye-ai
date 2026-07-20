# Call Transfer Architecture — AI ↔ Salesperson

**Parent doc:** [`sip-loop-mvp-design-doc.md`](./sip-loop-mvp-design-doc.md)
**Builds on:** [Step 7, section 2 — AI/salesperson switching](./sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md) (in-call takeover, same bridge)
**Related:** [`ai-pipeline-vs-ai-agent.md`](../../design-docs/ai-pipeline-vs-ai-agent.md) (why "normal call" and "agent call" are two different systems)
**Status:** Design, not implemented. Answers an architecture question Danish raised in the 2026-07-16 meeting; switching mechanism (section 3) specified 2026-07-18.
**Goal:** Settle where call transfer between the AI voice agent and a human salesperson actually lives, what each side has to add, and how a switch works.
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

This is the same mechanism as Step 7 section 2's in-call takeover; that design is the special case where the human joins the *existing* bridge instead of replacing the AI in it. Both are bridge-membership changes, which is why they belong together at this layer. Section 3 specifies the mechanism concretely.

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

## 3. The switching mechanism

The PM's requirement is more specific than "transfer both ways": a salesperson can let the AI answer from the start **or** hand a live call to the AI mid-call, and can end the AI's turn and take the call back at any moment. Switching is therefore repeated and bidirectional, not a one-time handoff.

### A. Not a SIP transfer

A SIP transfer (`REFER`, blind or attended) means "I drop out, you two carry on." Once the salesperson refers the customer to the AI, they are no longer in the call's signaling path, so taking the call back requires placing a new call. Transfer is also one-shot and slow: every switch renegotiates the media session, and the customer may hear silence or a tone.

Bridge membership has none of those properties. The customer's channel is answered once, joined to the bridge once, and never touched again. Every switch afterwards is a change to who else is in the bridge and whose microphone is open.

> SIP transfer is still the right tool when the customer must reach a **different** PBX or an external number. Every leg here lives on one Asterisk, so bridge manipulation is strictly better.

### B. Topology: one mixing bridge, three channels

The bridge script already creates `type="mixing"` (`bridge_call_to_external_media`). That is the only primitive this feature needs.

| Channel | In the bridge | Role |
|---|---|---|
| Customer (PJSIP) | Whole call | The one leg that never moves |
| `externalMedia` | Whole call | The AI's ears and mouth; STT never stops, so the transcript is continuous in both modes |
| Salesperson (PJSIP softphone) | From first join until hangup | The human voice; controlled by mute, never removed |

Two switches decide who is audible:

**`holder`**
Which side owns the call, `ai` or `human`. In `human`, STT finals still log but are not fed to the LLM, and TTS playback is suppressed.

**Salesperson channel mute**
ARI `POST /channels/{id}/mute` with `direction=in` silences their microphone only. They still hear everything, which makes muted-and-bridged the natural silent-monitoring state.

All three PM scenarios are the same topology with a different starting value:

| Scenario | Initial state | Switch action |
|---|---|---|
| AI answers from the start | `holder=ai`, salesperson muted | none |
| Salesperson answers, hands to AI mid-call | `holder=human`, salesperson unmuted | set `holder=ai` |
| Salesperson takes the call back | any | set `holder=human` |

"AI answers" and "salesperson answers" differ only in the initial value of `holder`. There is no second code path.

### C. One state variable, not two switches

The UI must never expose mute and mode as independent controls, or the call can reach a state where the salesperson is unmuted while the AI is still generating, and both talk at once.

The dashboard sends one thing:

```
POST /api/holder {holder: "human"}    # or "ai"
```

The server derives mute, mode, and teardown from that single value. The dashboard only renders a state chip (AI HANDLING / YOU ARE LIVE).

### D. The button is a toggle, and one press does four things

**Toggle, not push-to-talk.**
A salesperson taking over talks for minutes, not for one sentence, and is usually holding a handset or wearing a headset. Press once to take the call, press again to hand it back, with the state chip showing which side is live.

The reason the button works at all is that the human never has to compete with the AI for the microphone. That only holds if a press does all four of these together:

| # | Action | If omitted |
|---|---|---|
| 1 | Unmute the salesperson channel | The customer cannot hear them |
| 2 | Set `holder=human` | The AI keeps generating replies to the human's speech |
| 3 | `DELETE /playbacks/{id}` on the in-flight TTS | The AI's current sentence plays over the human |
| 4 | Discard in-flight LLM and TTS work | The AI speaks once more, roughly a second after the press |

Actions 1 and 2 are obvious; 3 and 4 are the ones that break a live demo.

Action 4 matters because the turn pipeline is about a second deep: at the moment of the press a Groq request may already be in flight, or a WAV may be mid-downsample, or a file may be mid-`docker cp`. All of it completes after the press and would play.

### E. Epoch counter

**Stamp every turn with the `holder` generation it started under.**

Each switch increments `epoch`. A worker records `epoch` when it starts a turn and compares before handing off: the LLM result is dropped rather than queued for TTS, and the TTS worker re-checks immediately before playback. Anything from a stale epoch is discarded silently.

This is preferable to a set of ad-hoc flag checks because it handles the case where the holder switches twice while one turn is still in flight, which flag checks get wrong.

### F. Latency, and why the salesperson leg joins early

The three ARI calls behind a press are local HTTP and complete well inside 50ms, so the press feels instant. The cost is entirely in the **first** `originate` to the salesperson's softphone, which has to wait for them to answer.

So the salesperson leg joins the bridge muted when the call is set up, and the button only ever mutes and unmutes. No switch after the first ever performs an `originate`.

The same handler should be reachable by DTMF (for example `*1`, via the ARI `ChannelDtmfReceived` event), because the salesperson is often on a phone away from the dashboard, which is the situation the feature exists for.

---

## 4. What to change, and where

| Where | What | New / Change |
|---|---|---|
| Asterisk config (`asterisk-config/pjsip.conf`) | Register the salesperson as a SIP endpoint on the same Asterisk as the agent leg, so the customer can be bridged to them | Change |
| The live agent loop ([`sip/scripts/step2_stt_bridge.py`](../scripts/step2_stt_bridge.py)) | Add a trigger hook: on "transfer to human" (LLM decision or customer request), ask Asterisk to re-bridge and pass along the gathered context | Change |
| Normal (human) call pipeline | Move the salesperson's audio from browser mic to a SIP softphone leg on Asterisk (the "add SIP to normal call" task) | Change |
| The live agent loop | An `epoch` counter incremented on every switch, checked by the LLM and TTS workers so in-flight turns from the previous holder are discarded (section 3E) | **New** |
| The live agent loop | Track the current playback id so a switch can `DELETE /playbacks/{id}` and cut the AI off mid-sentence (section 3D) | **New** |
| Demo/sales UI server | `POST /api/holder {holder}`: the single control endpoint. Derives mute, mode, playback teardown, and epoch bump from one value (section 3C) | **New** |
| Demo/sales UI server | Join the salesperson leg to the bridge muted at call setup, so no switch after the first performs an `originate` (section 3F) | **New** |
| Sales dashboard | A toggle button plus a state chip showing who currently holds the call (AI HANDLING / YOU ARE LIVE) | Change |
| Bridge script | Handle `ChannelDtmfReceived` so `*1` reaches the same holder handler as the button | Change |
| Contacts / call log (Supabase) | The capture-and-hand-off fallback: store caller name, number, and intent, and flag it for sales follow-up when no live transfer happens | Change |

Section 3 supersedes Step 7 section 2's sketch of the takeover mechanics. Two of its open questions still stand: transcript speaker attribution while the human is live, and where `holder` lives once there is more than one concurrent call.

---

## Deliverable

An agreed answer to the meeting question, verifiable in plain terms:

- **Where transfer lives:** at the Asterisk bridge layer, triggered by hooks in each pipeline — not owned by either pipeline.
- **What each side adds:** the agent leg adds a trigger hook; the normal call adds a SIP softphone leg for the salesperson; both must be on the same Asterisk before transfer works.
- **What can start now, independent of RAG:** adding SIP to the normal call, and the capture-and-hand-off fallback.

- **How a switch works:** one persistent mixing bridge, one `holder` value the UI sets, mute plus playback teardown plus an epoch bump derived from it.

End-to-end proof, when built, is four checks on a single call that is never dropped:

1. AI answers, salesperson presses the toggle, the customer is talking to the softphone with the call still up.
2. Press again, automated answering resumes.
3. Salesperson answers a call themselves, hands it to the AI mid-call, and the AI picks up the conversation.
4. Press the toggle while the AI is mid-sentence: the AI stops immediately and says nothing further (this is the check that catches a missing playback teardown or a missing epoch guard).

## Failures log

_(empty — fill during implementation: symptom / cause / fix. Bridge and NAT issues are the likely candidates.)_

## Appendix — build-time specifics (skip on a first read)

- **ARI calls behind one switch:** `POST /channels/{sales}/mute` or `/unmute` with `direction=in`, `DELETE /playbacks/{id}` for the in-flight TTS, and an in-process `epoch += 1`. The customer channel is never touched. The only `originate` is the one that joins the salesperson leg at call setup.
- **Every call must enter Stasis.** The dialplan always routes to `Stasis(sip-mvp-app,<company>)`, including calls a salesperson answers with no AI involvement. A call that lives in a plain `Dial()` is not in the ARI app, so handing it to the AI mid-call would require a real transfer after all. This is the one constraint to settle before any of this is built.
- **Salesperson endpoint:** a second `[sales-endpoint]` in `pjsip.conf`, registered on a second softphone or a second Linphone identity (Step 7 section 2 open question, "Salesperson audio device").
- **Transcript during a human leg:** `externalMedia` carries mixed bridge audio, so with diarization off the human and the customer are not separated. A three-party call makes this worse than it was in Step 7. Worth evaluating with the build: replace the single bridge-level `externalMedia` with a per-channel `POST /channels/{id}/snoop`, which costs one extra STT stream and gives speaker attribution for free.
- **Context passed on handoff:** the "what the caller wanted" payload reuses the same transcript/analysis the console already produces (Step 5); the fallback path writes it to the contact record instead of a live channel.

## Next

Fold the agreed ordering into [`sip-task-split.md`](./sip-task-split.md) once the PM signs off on doing normal-call-SIP in parallel with RAG rather than strictly after it.
