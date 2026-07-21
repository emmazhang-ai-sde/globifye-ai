# Transfer Step 2 — `holder` Switching (AI ↔ Salesperson)

**Parent doc:** [`call-transfer-architecture.md`](./call-transfer-architecture.md) (section 3, the switching mechanism)
**Builds on:** [Transfer Step 1 — salesperson SIP endpoint + muted bridge leg](./transfer-step1-salesperson-sip-endpoint.md)
**Status: design + increment plan, not yet implemented.**
**Goal:** make *who is audible on the call* switchable between the AI and the salesperson, repeatedly and in both directions, over the persistent three-party bridge Step 1 built — without ever dropping the call.
**Non-goals:** concurrency (multiple simultaneous calls), browser-WebRTC audio for the salesperson, production auth. Those stay in the roadmap's deferred list.

---

## 1. What Step 1 gives us, and what's missing

Step 1 built a persistent mixing bridge with three channels: the customer (never moves), the AI's `externalMedia` (STT never stops), and the salesperson (joined muted at call setup). Today the salesperson is **permanently muted** and the AI **always** holds the call.

Step 2 makes that switchable. Because all three channels are already in one bridge, a switch is never a re-bridge or a SIP transfer — it is only a change to **who is audible** and **whether the AI is generating**. That is the entire point of the bridge-membership design: the customer's channel is answered once, joined once, and never touched again.

> **Why not a SIP transfer (`REFER`):** a SIP transfer means "I drop out, you two carry on" — once the salesperson refers the customer to the AI they're out of the signaling path, so taking the call back needs a whole new call, and every switch renegotiates media (silence/tones for the customer). Bridge-membership switching has none of those properties. SIP transfer is only the right tool when a leg must reach a *different* Asterisk/PBX or external number — not the case here.

---

## 2. Core design decision: one state variable, not two switches

The switch is driven by a **single** value:

```
holder ∈ { "ai", "human" }
```

Everything else is *derived* from it. The UI/DTMF handler never sets mute and mode independently, because independent controls can desync into "salesperson unmuted while the AI is still generating" — both talking at once.

| `holder` | Salesperson mic | LLM fed from STT finals? | TTS playback? |
|---|---|---|---|
| `ai` (default) | muted (`mute direction=in`) | yes | yes |
| `human` | unmuted | **no** (STT finals still *log*, so transcript continues) | **suppressed** |

STT never stops in either mode — the transcript stays continuous regardless of who's speaking. Only the *consumption* of STT finals (feeding them to the LLM) and TTS playback are gated.

The three PM scenarios are all the same topology with a different starting `holder`:

| Scenario | Initial `holder` | Switch action |
|---|---|---|
| AI answers from the start | `ai` (sales muted) | none |
| Salesperson answers, hands to AI mid-call | `human` (sales unmuted) | set `holder=ai` |
| Salesperson takes the call back | any | set `holder=human` |

"AI answers" vs "salesperson answers" differ only in the initial `holder` value — there is no second code path.

---

## 3. The toggle does four things, not one

A press (or DTMF, or button) that takes the call for the human must do **all four** of these together, or a live demo breaks:

| # | Action | If omitted |
|---|---|---|
| 1 | Unmute the salesperson channel (`POST /channels/{sales}/unmute`) | Customer can't hear them |
| 2 | Set `holder=human` | AI keeps generating replies to the human's speech |
| 3 | `DELETE /playbacks/{id}` on the in-flight TTS | The AI's current sentence plays over the human |
| 4 | Discard in-flight LLM + TTS work | The AI speaks once more, ~1s after the press |

Actions 1–2 are obvious. **3 and 4 are the ones that break demos**, because the turn pipeline is ~1s deep: at the instant of the press, a Groq request may be in flight, a WAV mid-downsample, or a file mid-`docker cp`. All of it would otherwise complete and play *after* the human has taken over.

Handing *back* to the AI (`holder=ai`) is simpler: re-mute the salesperson, re-enable the LLM/TTS path. No playback teardown needed (nothing of the human's is "in flight" in the AI pipeline).

---

## 4. The epoch guard (how actions 3–4 actually work)

Stamp every turn with the `holder` generation it started under.

```
epoch = 0            # module global, incremented on every switch

# groq_worker, per turn:
turn_epoch = epoch
... call Groq, build reply ...
if turn_epoch != epoch:      # holder switched during this turn
    continue                  # drop the reply, do not queue for TTS

# tts_worker, immediately before playback:
if turn_epoch != epoch:
    continue                  # drop stale audio silently
```

Each switch does `epoch += 1`. A worker records `epoch` when it starts a turn and re-checks before handing off (LLM → TTS) and before playback. Anything from a stale epoch is discarded silently.

Why an epoch counter rather than a boolean "is human live" flag: the counter correctly handles the case where the holder switches **twice** while one turn is still in flight — a flag check gets that wrong (it can read "back to ai" and let a stale turn through). The counter is monotonic, so a turn born under epoch N is unambiguously stale the moment epoch advances.

Also track the current playback id so a switch can `DELETE /playbacks/{id}` and cut the AI off mid-sentence (action 3). `play_deepgram` returns/stores the playback id from the ARI `/play` response.

---

## 5. Increment plan (build in this order)

### Increment A — DTMF-triggered toggle (no UI)

Prove the whole switch mechanic with the crudest trigger, isolating the state logic from any demo-server/SSE plumbing. Section 3F of the parent doc wants DTMF anyway (the salesperson is often on a phone away from the dashboard).

**What to build:**
- `holder` global (`"ai"` default), `epoch` global (`0`), `current_playback_id` global.
- `set_holder(value)` — the single function that derives everything: mute/unmute the sales channel, bump `epoch`, and on `→human` delete the in-flight playback; on `→ai` nothing extra.
- Gate `groq_worker`: skip feeding the transcript to the LLM when `holder == "human"`.
- Gate the TTS path: skip playback when `holder == "human"`, plus the epoch re-check.
- Handle `ChannelDtmfReceived` in `ari_event_loop`: on `*1` (or a chosen digit), call `set_holder(toggle)`.

**Test:** on a live call, press `*1` on the salesperson softphone → AI goes quiet, salesperson audible → press again → AI resumes. Verify the AI does **not** speak one extra time after takeover (that's the epoch guard working).

### Increment B — dashboard toggle + state chip

Layer the UI control on the proven state logic.

**What to build:**
- Demo UI server: `POST /api/holder {holder}` — the single control endpoint. Derives mute, mode, playback teardown, and epoch bump from one value (calls the same `set_holder` mechanism, via a small localhost control hook from the UI server to the bridge, since today's event flow is one-way bridge→UI).
- Sales dashboard: a **toggle** button (not push-to-talk — a takeover lasts minutes) plus a state chip (`AI HANDLING` / `YOU ARE LIVE`) driven by an SSE event, visible on both views.

### Increment C — capture-and-hand-off fallback (independent, can be done anytime)

The parent doc's decision D: when a live bridge transfer isn't wanted/ready, the AI stores the caller's name, number, and intent and flags it for sales follow-up. **No bridge surgery** — a write to `contacts`/call log plus a flag. Already partially present (`FALLBACK_LINE` collects name + phone). This decouples value from difficulty and can ship independent of A/B.

---

## 6. Component change map

| Where | What | New / Change |
|---|---|---|
| Bridge script — globals | `holder`, `epoch`, `current_playback_id` | **New** |
| Bridge script — `set_holder(value)` | Single derive point: mute/unmute sales channel, `epoch += 1`, delete in-flight playback on `→human` | **New** |
| Bridge script — `groq_worker` | Record `turn_epoch`; skip LLM feed when `holder=="human"`; drop reply if epoch advanced | Change |
| Bridge script — TTS path | Skip playback when `holder=="human"`; re-check epoch before playback; store playback id | Change |
| Bridge script — `ari_event_loop` | Handle `ChannelDtmfReceived` → `set_holder(toggle)` (`*1`) | Change |
| Demo UI server | `POST /api/holder {holder}` control endpoint + localhost hook to the bridge | **New** |
| Sales dashboard | Toggle button + `AI HANDLING`/`YOU ARE LIVE` state chip via SSE | Change |

---

## 7. Latency note (why the sales leg already joins early)

The three ARI calls behind a switch (mute/unmute, delete playback, in-process epoch bump) are local HTTP and complete well inside 50ms — the press feels instant. The only slow part is the **first** `originate` to the salesperson softphone, which waits for a human to answer. Step 1 already pays that cost once, at call setup, by joining the sales leg muted. **No switch after the first ever performs an `originate`** — every switch is just mute/unmute + epoch. This is why Step 1 originates the sales leg eagerly rather than on first takeover.

---

## 8. Open questions to settle before/while building

| Question | Notes |
|---|---|
| Transcript speaker attribution in `human` mode | `externalMedia` carries the **mixed** bridge audio, so with diarization off, human and customer turns aren't separated. Options: accept mixed turns, revisit Modulate diarization, or replace the single bridge-level `externalMedia` with per-channel `POST /channels/{id}/snoop` (one extra STT stream, speaker attribution for free) |
| Analysis semantics across AI + human segments | The sales-coach analysis assumes the agent side is one voice; a mixed AI/human call needs a segment marker in the transcript |
| Where `holder`/`epoch` live per call | Global singletons are fine for single-active-call MVP; concurrency would need them per-channel/per-call |
| "Every call must enter Stasis" | A call a salesperson answers with no AI involvement must **still** route through `Stasis(sip-mvp-app,<company>)`, not a bare `Dial()` — otherwise it's not in the ARI app and can't be handed to the AI without a real transfer. Settle this in the dialplan before Increment B |
| No-answer on the sales leg | Step 1 leaves this open: if the sales phone isn't answered the leg stays `Down`. Decide whether a takeover attempt should (re-)originate, or whether the leg must always be pre-joined |

---

## Deliverable

End-to-end proof, when built — four checks on a single call that is **never dropped**:

1. AI answers; salesperson presses the toggle (or `*1`); the customer is now talking to the softphone, call still up.
2. Press again; automated AI answering resumes.
3. Salesperson answers a call themselves (`holder=human` initial), hands it to the AI mid-call; the AI picks up the conversation.
4. Press the toggle **while the AI is mid-sentence**: the AI stops immediately and says nothing further. *(This is the check that catches a missing playback teardown (action 3) or a missing epoch guard (action 4).)*

---

## Failures log

_(empty — fill during implementation: symptom / cause / fix. Likely candidates: playback-id tracking races, epoch checks placed at the wrong point in the worker, mute direction wrong (`in` vs `out`), and the mixed-audio transcript problem in §8.)_

## Next

Once Increments A/B verify, fold speaker attribution (§8, `snoop` vs mixed) and the "every call must enter Stasis" dialplan constraint into the build, and update [`sip-task-split.md`](./sip-task-split.md) with what shipped.