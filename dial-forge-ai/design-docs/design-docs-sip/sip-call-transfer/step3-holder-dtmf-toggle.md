# Transfer Step 3 — `holder` DTMF Toggle (Increment A)

**Parent doc:** [`transfer-step2-holder-switching.md`](./transfer-step2-holder-switching.md)
**Builds on:** [Transfer Step 1 — salesperson SIP endpoint + muted bridge leg](./transfer-step1-salesperson-sip-endpoint.md)
**Status: built and verified (2026-07-22).** Increment A from the Step 2 design (§5): DTMF-triggered `holder` toggle with epoch guard and playback teardown. Increment B (dashboard toggle + state chip) not yet built.
**Goal:** who is audible on the call is now switchable between AI and salesperson, repeatedly, from a single button-press (`1` on the sales softphone), with no dropped calls and no "AI speaks one extra sentence after takeover" artifact.
**Non-goals:** dashboard UI, `POST /api/holder` control endpoint, browser state chip, capture-and-hand-off fallback. Those remain Step 2 §5's Increments B and C.

---

## 1. What this step delivers

After Step 1, the salesperson leg was always joined muted and the AI always held the call. Increment A layers switching on top: pressing `1` on the sales softphone flips who is audible, and everything the switch entails (mute change, AI generation gating, current-playback teardown, in-flight-turn invalidation) happens together in one place.

DTMF was chosen as the first trigger to isolate the state logic from the demo-UI plumbing — no server changes, no SSE events, no dashboard code needed to prove the switch itself works. The same handler will later be reachable from the dashboard toggle (Increment B).

---

## 2. All changes are in `sip/scripts/stt_bridge_ai_human_transfer.py`

Six edits, all in that one file. Nothing else in the repo touched.

### 2.1 New module globals

Placed near the other call-state globals (right after `current_sales_channel_id`):

```python
# --- TRANSFER (step 2): holder switch. `holder` decides who is audible;
# everything (sales mute, LLM gating, TTS suppression) derives from it. `epoch`
# is bumped on every switch so an in-flight turn started under the old holder
# is discarded rather than played. `current_playback_id` lets a switch cut off
# the AI mid-sentence via DELETE /playbacks/{id}. ---
holder = "ai"                  # "ai" | "human"
epoch = 0
current_playback_id = None
```

### 2.2 `set_holder(value)` — the single derive point

New function, placed after `bridge_call_to_external_media`:

```python
def set_holder(value):
    """Single derive point for a switch. Never set mute and mode independently
    elsewhere -- that can desync into 'sales unmuted while AI still generating',
    with both talking at once. All four actions of a takeover (mute/unmute,
    mode flip, playback teardown, epoch bump) happen together here."""
    global holder, epoch, current_playback_id
    if value == holder:
        return
    holder = value
    epoch += 1  # invalidate any in-flight turn (checked in groq_worker/tts_worker)

    if current_sales_channel_id:
        action = "unmute" if value == "human" else "mute"
        requests.post(
            f"http://{ARI_HOST}/ari/channels/{current_sales_channel_id}/{action}",
            params={"direction": "in"},
            auth=(ARI_USER, ARI_PASSWORD),
        )

    if value == "human" and current_playback_id:
        ari_delete(f"/playbacks/{current_playback_id}")  # cut AI off mid-sentence
        current_playback_id = None

    log("HOLDER", value)
```

Every switch does exactly four things: mute/unmute the sales channel (`direction=in` — the salesperson still hears everything, but their mic is silenced going the other way), bump the epoch, delete the in-flight playback if we're taking over for a human, and log. Nothing else in the codebase should mutate `holder`, `epoch`, or `current_playback_id`.

### 2.3 `groq_worker` — gate the LLM feed and stamp each turn

Two additions to the existing function:

At the top of the `while True:` loop, skip transcript delivery to the LLM when a human is live:

```python
    while True:
        transcript = transcript_queue.get()

        # --- TRANSFER: human is live -- transcript still logged upstream, but
        # don't feed the LLM or generate a reply. ---
        if holder == "human":
            continue

        turn_epoch = epoch  # stamp this turn; drop it if holder switches mid-turn
        ...
```

`turn_epoch` is captured at the moment the turn starts. When the worker pushes sentences to the TTS queue, it re-checks the epoch (twice — once per sentence, once for the trailing tail) and either abandons or forwards accordingly:

```python
            if sentence.endswith((".", "!", "?")):
                if turn_epoch != epoch:   # holder switched -- abandon this turn
                    break
                tts_queue.put((sentence, turn_epoch))
                sentence = ""

        if sentence and turn_epoch == epoch:
            tts_queue.put((sentence, turn_epoch))
```

**The queue items changed shape.** They were bare strings; they are now `(text, turn_epoch)` tuples. `tts_worker` unpacks them accordingly (§2.4). Anything else that reads `tts_queue` would need to match.

### 2.4 `tts_worker` — unpack the epoch, re-check before playback

Full replacement of the tiny existing body:

```python
def tts_worker():
    while True:
        # --- TRANSFER (step 2): tts_queue items are (text, turn_epoch) tuples,
        # so a switch mid-turn drops stale audio at the last moment before playback. ---
        text, turn_epoch = tts_queue.get()
        if turn_epoch != epoch or holder == "human":
            continue  # stale turn or human took over -- drop silently
        log("TTS gen", text)
        play_deepgram(text)
```

The re-check just before `play_deepgram` catches the last-mile case: an LLM turn that finished (and made it onto the queue) *before* the switch, still sitting in the queue when the switch fires. Without this check, that stale audio would play seconds after the human took over — the "AI speaks one extra sentence" artifact the design flagged.

### 2.5 `play_deepgram` — capture the playback id

Two edits inside the existing function.

Add `current_playback_id` to the `global` declaration:

```python
def play_deepgram(text):
    global _reply_counter, current_playback_id
```

At the point where the ARI play request goes out (was fire-and-forget; now captures the response):

```python
    # --- TRANSFER (step 2): capture the playback id so set_holder("human") can
    # DELETE /playbacks/{id} and cut the AI off mid-sentence. ---
    result = ari_post(f"/channels/{current_channel_id}/play", media=f"sound:custom/{sound_name}")
    current_playback_id = result["id"] if result else None
    log("TTS played", sound_name, ms=_ms())
```

`current_playback_id` is what `set_holder("human")` deletes in §2.2.

### 2.6 `ari_event_loop` — handle `ChannelDtmfReceived`

A new `elif` branch, sibling of `StasisStart` and `StasisEnd`, inside the same `try:` block so a bad DTMF event can't kill the loop:

```python
            # --- TRANSFER (step 2): DTMF-triggered holder toggle. The salesperson
            # presses `1` on their softphone to take the call over (holder=human)
            # or hand it back (holder=ai). Same handler will be reachable from the
            # dashboard toggle in a later increment (POST /api/holder via a
            # localhost control hook). The unconditional DTMF log is temporary,
            # left in for now so we can confirm the events fire; remove once the
            # UI toggle path is proven and DTMF is no longer the only trigger. ---
            elif event_type == "ChannelDtmfReceived":
                digit = event.get("digit")
                ch = event.get("channel", {}).get("id")
                log("DTMF", f"{digit} from {ch}")
                if ch == current_sales_channel_id and digit == "1":
                    set_holder("human" if holder == "ai" else "ai")
```

Only the salesperson's DTMF triggers the toggle — a customer pressing `1` on their softphone is ignored. The unconditional `log("DTMF", ...)` is deliberately verbose; it's the fastest confirmation that DTMF is even reaching Asterisk when this is set up on a new machine. Fine to remove once the pipeline is trusted (see §6).

---

## 3. Design decisions worth calling out

### 3.1 One state variable, not two

The design (§2 of the Step 2 doc) is deliberate: `holder` is the *only* value the caller sets; mute, mode, playback teardown, and epoch bump are all *derived*. Never expose "mute the sales channel" and "flip the mode" as separate operations, or the two can desync into "salesperson unmuted while the AI is still generating" — both talking at once. That's exactly what `set_holder` centralizes.

### 3.2 Epoch counter, not a boolean

A flag ("is human currently live?") is insufficient because a turn can start under `holder=ai`, the human can take over, and hand back to AI, all while that one turn is still in flight. A flag check at the end of the turn would read "ai again" and let the stale turn through. A monotonic counter is unambiguous: any turn born under a previous epoch is stale, forever.

Two epoch checks are in place: one at the sentence-completion point in `groq_worker` (abandons the rest of the turn), and one at the queue-pop point in `tts_worker` (catches sentences already queued before the switch).

### 3.3 Why the playback teardown matters

Without §2.5's captured `current_playback_id` and §2.2's `DELETE /playbacks/{id}`, the AI's current spoken sentence continues to completion even after the human takes over — the caller hears the AI finish its thought while the salesperson is trying to speak. Two-way audio collision. The `DELETE` on the playback stops it *immediately* at Asterisk, not "at the next natural break."

### 3.4 One key on the sales phone, not a `*1` sequence

The design (§4) mentioned `*1` as the DTMF trigger, but a two-key sequence needs buffering across events. Increment A uses a single digit `1` — enough to prove the switch works, and easy to change later if `1` collides with something else the customer might dial.

---

## 4. Verification

**Deliverable:** on a live call, pressing `1` on the sales softphone flips the audible party between AI and salesperson, repeatedly, with no dropped calls and no lingering AI audio after a takeover.

### 4.1 Test sequence

1. Both softphones registered (`pjsip show contacts` shows `test-endpoint` and `sales-endpoint`).
2. Clean state (`core show channels` shows `0 active channels`).
3. Start the bridge script; dial 1000 from the customer softphone; answer the sales softphone (joins muted, `holder=ai`).
4. Speak as the customer — AI replies normally.
5. **Press `1` on the sales softphone.** Terminal should log:
   ```
   [DTMF] 1 from <sales-channel-id>
   [HOLDER] human
   ```
   Now speak on the sales phone. Customer hears the salesperson; the AI does not react.
6. **Press `1` again.** `[HOLDER] ai` logs; sales re-muted; AI resumes on the next customer utterance.
7. **The critical check:** while the AI is mid-reply, press `1`. The AI should stop within the current word/sentence and *not* speak again ~1s later. This exercises both the `DELETE /playbacks/{id}` (cutting the current sentence) and the epoch guard (dropping any turn already queued for TTS).

### 4.2 Verified result (2026-07-22)

All four passed. The mid-reply takeover test (step 7) produced immediate silence — no trailing sentence. `[HOLDER] human`/`[HOLDER] ai` toggled cleanly across repeated presses within a single call.

---

## 5. Failures log

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | *(none observed during Increment A)* | | |

Predicted-but-not-yet-hit failure modes worth watching for as this gets used:

- **DTMF events don't fire.** Softphone isn't sending RFC 2833 DTMF, or the endpoint's `dtmf_mode` isn't `rfc4733`. The unconditional `log("DTMF", ...)` in §2.6 is the fastest confirmation — if pressing `1` produces nothing in the log at all, the problem is between the softphone and Asterisk, not in this code.
- **Toggle fires but AI still speaks one more sentence.** Either `current_playback_id` isn't being captured (missing `global` in `play_deepgram`), or the epoch check in `tts_worker` isn't in place. Both are in §2.4/§2.5 and must be present together.
- **Toggle changes `holder` but sales mic doesn't come live.** The mute/unmute request is failing silently. Check `set_holder` is targeting the right channel id (`current_sales_channel_id`, not `current_channel_id`) and that the ARI mute call uses `direction=in`.

---

## 6. Known limitations / what to remove or add next

| Item | Status |
|---|---|
| Unconditional `log("DTMF", ...)` in §2.6 | Temporary. Remove once DTMF is trusted and Increment B's UI toggle is the primary trigger, so the log isn't spammed by every keypress a curious salesperson makes. |
| Only digit `1` is bound | Fine for a demo; if `1` collides with anything the customer might dial (menu, extension), rebind to `*1` (requires DTMF buffering across events) or a less common digit. |
| Solo audio testing | With both softphones on one Mac and one speaker, "who is audible" is hard to hear. Rely on the log (`[HOLDER] human`/`ai`) and structural checks (`core show channel <sales-id> \| grep -i mute`), not your ears. |
| Analysis semantics | The sales-coach analysis assumes one voice on the "agent" side. A call with both AI and human segments needs a segment marker in the transcript — deferred to Increment B or later. |
| Transcript speaker attribution during a human turn | `externalMedia` carries mixed bridge audio; with Modulate diarization off, human and customer turns are not separated. Deferred (Step 2 §8). |

---

## Next

**Increment B — dashboard toggle + state chip.** Layers the UI control on the proven state logic:
- Demo UI server: `POST /api/holder {holder}` control endpoint, calls into the bridge's `set_holder` via a localhost hook.
- Sales dashboard: toggle button + `AI HANDLING` / `YOU ARE LIVE` state chip, driven by an SSE event visible on both views.

**Increment C — capture-and-hand-off fallback**, independent, can be built in parallel: store caller name/number/intent and flag it for sales follow-up when no live transfer is possible.
