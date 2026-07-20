# Step 3.3: Console Logging Refactor

**Created:** 2026-07-09

**Related docs:** [Step 3: Wire TTS output back into the call](./step3-wire-tts-output-into-call.md) · [Step 3.1: Debugging log](./step3.1-sip-loop-debugging-log.md) · [Step 3.2: Latency analysis](./step3.2-sip-loop-latency-analysis.md)

**Goal of this step:** make `step2_stt_bridge.py`'s console output readable during a live call: clear labels, no thread interleaving, no duplicate lines. **Not** a pipeline change. Behavior is identical, only what gets printed changes.

---

## 1. Context

```
venv/bin/python3 -u sip/scripts/step2_stt_bridge.py

Listening for RTP on UDP 9000
Connecting to ws://localhost:8088/ari/events?api_key=sip-mvp-user:changeme_use_a_real_secret&app=sip-mvp-app ...
Connected. Waiting for calls into sip-mvp-app (Ctrl+C to stop)
Call arrived: channel 1783616231.22
Bridged caller 1783616231.22 + externalMedia 1783616231.23 into bridge 358a2f4f-0235-4cdb-beda-077e2652bbf0
First RTP packet received (652 bytes)
STT (partial): H
STT (partial): Hi,
STT (partial): Hi, can
STT (partial): Hi, can y
STT (partial): Hi, can you
STT (partial): Hi, can you hear
STT (partial): Hi, can you hear me?
STT: Hi, can you hear me?
[t0 +10667ms]
USER: Hi, can you hear me?
[t1 +10946ms]
Yes, I hear you.TTS: Yes, I hear you.
 How can I help you today?[t2 +11119ms]

[t3 +11746ms]
Successfully copied 20kB to asterisk-mvp:/var/lib/asterisk/sounds/custom/reply_1.wav
```

1. **"So many STT requests":** `STT (partial): ...` prints once per incremental word. Normal Modulate streaming, not repeated API calls. Combined with unlabeled `[t0]`-`[t4]` bracket lines, it reads as noise.
2. **"Same thing again as STT":** a real duplicate. `_modulate_session` prints `STT: {text}` (line 384), then `groq_worker` prints `USER: {same text}` (line 202) right after. Same string, two labels.
3. **Underneath both:** `groq_worker` prints the reply token-by-token with `print(token, end="", flush=True)`. No newline, no lock. `tts_worker` and `play_deepgram` print full lines from other threads at the same time. Result: `Yes, I hear you.TTS: Yes, I hear you.`, two threads writing the same line.

> **Note on the STT two-pass architecture**
> The actual documented two-pass STT idea (`stt-selection-guideline.md`, "Concept 7") belongs to the other pipeline (post-call analytics). It rejects a second STT engine pass as not worth the cost, and is deferred post-MVP anyway. This doc does not add a second STT pass to `step2_stt_bridge.py`. The logging fix below is the real fix for what Danish saw.

## 2. Old vs. new

| What | Old | New |
|---|---|---|
| Thread safety | Every worker calls bare `print()`; `groq_worker` writes raw tokens with no newline | One `log()` helper, guarded by a lock, always writes one complete line |
| STT / USER duplicate | `STT: {text}` (Modulate thread) then `USER: {text}` (Groq thread) | Single `[STT final]` line. Printed once. |
| Timestamps | Bare `[t0 +Xms]` / `[t1 +Xms]` / ... on their own line, no context | Timestamp folded into the labeled line: `[STT final +10667ms] ...` |
| LLM reply | Raw token-by-token stream, interleaves with other threads | Buffered, logged as one complete line when the sentence is done |
| Dead code | `on_transcript()` + `EventType`/`ListenV1Results` imports (never called, leftover from the pre-Modulate Deepgram STT version) | Removed |
| ARI credentials | Printed in cleartext in the `ws://.../events?api_key=user:pass` startup line | Redacted (`api_key=***:***`) |

## 3. Technical decisions

**Decision 1: One thread-safe `log()` helper, used everywhere.**
Requirement: no two threads can ever interleave mid-line.
Approach: a module-level `threading.Lock()` wraps a single `print()` call inside `log(tag, text="", ms=None)`.
Why not just rename: labels alone don't fix interleaving. `groq_worker`'s raw stream would still race with `tts_worker`/`play_deepgram`.

**Decision 2: Buffer LLM output instead of streaming raw tokens by default.**
Requirement: the reply must print as one clean line, not a token crawl another thread can interrupt.
Approach: `groq_worker` already accumulates `full_response`. Log it once, when the sentence completes. Add an opt-in `SHOW_LLM_STREAM=1` env var to restore the live token crawl for demos.
Why not always show the stream: a token-by-token print is a partial-line write, the exact failure mode being fixed. Default to clean output, make the demo version opt-in.

**Decision 3: Keep every timestamp (`t0`-`t4`), fold into the labeled line.**
Requirement: `step3.2-sip-loop-latency-analysis.md`'s methodology (`t0`-`t4`, `t4 - t0` = caller-perceived turn latency) has to keep working.
Approach: `log(tag, text, ms=...)` renders `[tag +Xms] text`. Same numbers, attached to a real label instead of a bare bracket.
Why not remove the timestamps for a cleaner look: they're load-bearing for latency analysis, not decoration.

**Decision 4: Remove `on_transcript()` and its imports.**
Requirement: nothing in the file should look like a second, unused STT path.
Approach: delete the function and the `EventType`/`ListenV1Results` imports. Confirmed via grep, not referenced anywhere else in the file. `DeepgramClient` stays, it's used for TTS.
Why not leave it: dead code from before the Modulate switch. It reads like a second STT integration that doesn't exist.

**Decision 5: Redact ARI credentials from the startup log line.**
Requirement: the current `ws://...?api_key=sip-mvp-user:changeme_use_a_real_secret&app=...` line prints the ARI password in cleartext, on the same line already being edited for the ARI connect log.
Approach: log the same line with `api_key=***:***`.
Why not skip it: one-line fix on a line already being edited.

**Decision 6: Blank line before the three headline latency checkpoints (2026-07-09 follow-up).**
Requirement: after the first live-call test, the turn still read as one dense block. Needed visual breaks between phases: the STT partial stream, the finalized transcript, the LLM starting, and the TTS starting.
Approach: `log()` takes a `blank_before` flag. Set it on exactly the three checkpoint calls: `STT final`, `LLM first-token`, `TTS audio`. The blank line prints inside the same lock as the log line, so it can't get split from its line by another thread.
Why only these three: they're the three headline markers from `step3.2`'s latency table (`t0`, `t1`, `t3`). `TTS gen`/`TTS played` stay attached to their turn, since they're not separate phases, just the tail end of the TTS one.

**Decision 7: two blank lines before call-end (2026-07-09 follow-up).**
Requirement: `[CALL] ended` needed to read as a clear session boundary, not just another turn line.
Approach: `log()`'s `blank_before`/`blank_after` now accept an int (still accepts `True`/`False`). `log("CALL", f"ended: {channel_id}", blank_before=2)` gives the end-of-call divider two blank lines.
Why two lines here and one everywhere else: call-end is a session boundary, not a turn boundary. A bigger gap makes it visually distinct from the per-turn spacing from Decision 6.

**Decision 8: blank line before every new STT partial stream, not just the first one (2026-07-09 follow-up).**
Requirement: only the very first call's first partial got a gap (via a one-time `blank_after` on the RTP first-packet line). Every later turn's partial stream ran straight on from the previous turn's `[TTS played]` line with no gap.
Approach: `_modulate_session` tracks `first_partial_of_utterance`, a local flag starting `True`. Each `STT partial` log call passes `blank_before=first_partial_of_utterance`, then flips it to `False`. Each `STT final` flips it back to `True`, so the next utterance's first partial gets its blank line too. This also covers the very first partial of a call, so the RTP `blank_after` from the original Decision 7 is removed as redundant.
Why a flag instead of gapping every partial line: gapping every single partial word would double the output's line count for no benefit. Only the start of a new partial stream is a real phase boundary.

## 4. Diff

All changes are in `sip/scripts/step2_stt_bridge.py`.

### 4.1 Add the logging helper (near `_ms()`)

```diff
 _START = time.time()
 def _ms():
     return int((time.time() - _START) * 1000)
+
+
+_log_lock = threading.Lock()
+SHOW_LLM_STREAM = os.environ.get("SHOW_LLM_STREAM") == "1"
+
+
+def log(tag, text="", ms=None, blank_before=0, blank_after=0):
+    """Thread-safe, single-line logger. Every worker must call this instead
+    of print() -- concurrent bare prints (esp. groq_worker's raw token
+    stream) is what caused interleaved garbage like
+    "Yes, I hear you.TTS: Yes, I hear you." (see step3.3 doc). blank_before
+    (int, also accepts True/False) marks the three headline latency
+    checkpoints (STT final, LLM first-token, TTS audio) so a turn's phases
+    are visually separated, and the end-of-call divider. blank_after
+    separates the one-time call-setup block from the STT partial stream
+    that follows it."""
+    stamp = f" +{ms}ms" if ms is not None else ""
+    line = f"[{tag}{stamp}] {text}" if text else f"[{tag}{stamp}]"
+    with _log_lock:
+        for _ in range(int(blank_before)):
+            print()
+        print(line, flush=True)
+        for _ in range(int(blank_after)):
+            print()
```

### 4.2 Remove dead code

```diff
 from deepgram import DeepgramClient
-from deepgram.core.events import EventType
-from deepgram.listen.v1.types import ListenV1Results
 from groq import Groq
```

```diff
-def on_transcript(data):
-    if not isinstance(data, ListenV1Results):
-        return
-
-    sentence = data.channel.alternatives[0].transcript.strip()
-
-    if not sentence:
-        return
-
-    print("STT:", sentence)
-
-    if data.is_final:
-        transcript_queue.put(sentence)
-        x = _ms()
-        print(f"[t0 +{x}ms]")
-
-
 # --- STEP 2 CHANGE: was mic_worker(socket) reading a PyAudio mic_stream
```

### 4.3 `rtp_listener()`

```diff
     sock.bind(("0.0.0.0", UDP_LISTEN_PORT))
-    print(f"Listening for RTP on UDP {UDP_LISTEN_PORT}")
+    log("RTP", f"listening on UDP {UDP_LISTEN_PORT}")
     first = True
     while True:
         packet, _ = sock.recvfrom(2048)
         if first:
-            print(f"First RTP packet received ({len(packet)} bytes)")
+            log("RTP", f"first packet received ({len(packet)} bytes)")
             first = False
```

### 4.4 `groq_worker()`

```diff
     while True:
         transcript = transcript_queue.get()
-
-        print("USER:", transcript)
 
         conversation_history.append({
             "role": "user",
             "content": transcript
         })
@@
         for chunk in response:
             token = chunk.choices[0].delta.content
 
             if token is None:
                 continue
 
             if first_token:
-                b = _ms()
-                print(f"[t1 +{b}ms]")
+                log("LLM first-token", ms=_ms(), blank_before=True)
                 first_token = False
 
             sentence += token
             full_response += token
 
-            print(token, end="", flush=True)
+            if SHOW_LLM_STREAM:
+                print(token, end="", flush=True)
 
             if sentence.endswith((".", "!", "?")):
                 tts_queue.put(sentence)
                 sentence = ""
 
         if sentence:
             tts_queue.put(sentence)
 
-        a = _ms()
-        print(f"[t2 +{a}ms]")
-        print()
+        if SHOW_LLM_STREAM:
+            print()
+        log("LLM reply", full_response, ms=_ms())
```

Removing `print("USER:", transcript)` kills the duplicate Danish flagged. The transcript already prints once, in `_modulate_session`'s `[STT final]` line below.

### 4.5 `play_deepgram()`

```diff
     if current_channel_id is None:
-        print("No active call channel -- skipping playback for:", text)
+        log("TTS", f"no active call channel, skipping playback for: {text}")
         return
@@
     for chunk in dg.speak.v1.audio.generate(...):
         if first:
-            t = _ms()
-            print(f"[t3 +{t}ms]")
+            log("TTS audio", ms=_ms(), blank_before=True)
             first = False
         pcm_chunks.append(chunk)
@@
     ari_post(f"/channels/{current_channel_id}/play", media=f"sound:custom/{sound_name}")
-
-    z = _ms()
-    print(f"[t4 +{z}ms]")
+    log("TTS played", sound_name, ms=_ms())
```

### 4.6 `tts_worker()`

```diff
 def tts_worker():
     while True:
         text = tts_queue.get()
-
-        print("TTS:", text)
+        log("TTS gen", text)
         play_deepgram(text)
```

### 4.7 `_modulate_session()`

```diff
         send_thread = threading.Thread(target=send_audio, daemon=True)
         send_thread.start()
+        # starts True so the first partial of the call also gets its blank
+        # line; reset to True after each STT final so the next utterance's
+        # partial stream starts with a gap too (see step3.3 doc, Decision 8)
+        first_partial_of_utterance = True
         try:
             for message in ws:
                 if isinstance(message, bytes):
                     continue
                 data = json.loads(message)
                 msg_type = data.get("type")
 
             if msg_type == "partial_utterance":
                 partial_text = data.get("partial_utterance", {}).get("text", "").strip()
                 if partial_text:
-                    print("STT (partial):", partial_text)
+                    log("STT partial", partial_text, blank_before=first_partial_of_utterance)
+                    first_partial_of_utterance = False
 
             elif msg_type == "utterance":
                 text = data.get("utterance", {}).get("text", "").strip()
                 if text:
-                    print("STT:", text)
                     transcript_queue.put(text)
-                    x = _ms()
-                    print(f"[t0 +{x}ms]")
+                    log("STT final", text, ms=_ms(), blank_before=True)
+                    first_partial_of_utterance = True
```

### 4.8 `modulate_worker()`

```diff
         except Exception as e:
-            print(f"[Modulate] session ended ({type(e).__name__}); "
-                  f"will reconnect when the next call starts")
+            log("STT", f"session ended ({type(e).__name__}); reconnecting on next call")
```

### 4.9 `ari_event_loop()`

```diff
     ws_url = f"ws://{ARI_HOST}/ari/events?api_key={ARI_USER}:{ARI_PASSWORD}&app={APP_NAME}"
-    print(f"Connecting to {ws_url} ...")
+    log("ARI", f"connecting to ws://{ARI_HOST}/ari/events?api_key=***:***&app={APP_NAME}")
     ari_ws = create_connection(ws_url)
-    print("Connected. Waiting for calls into", APP_NAME, "(Ctrl+C to stop)")
+    log("ARI", f"connected, waiting for calls into {APP_NAME} (Ctrl+C to stop)")
 
     while True:
         message = ari_ws.recv()
@@
             print(f"Call arrived: channel {channel_id}")
+            # (above line replaced below)
```

```diff
-            print(f"Call arrived: channel {channel_id}")
+            log("CALL", f"arrived: {channel_id}")
             requests.post(...)
             bridge_call_to_external_media(channel_id)
             current_channel_id = channel_id
 
         elif event_type == "StasisEnd":
             channel_id = event["channel"]["id"]
             if channel_id == current_channel_id:
-                print(f"Call ended: channel {channel_id}")
+                log("CALL", f"ended: {channel_id}", blank_before=2)
                 current_channel_id = None
```

### 4.10 `bridge_call_to_external_media()`

```diff
     ari_post(f"/bridges/{bridge_id}/addChannel", channel=ext_channel["id"])
-    print(
-        f"Bridged caller {caller_channel_id} + externalMedia "
-        f"{ext_channel['id']} into bridge {bridge_id}"
-    )
+    log("CALL", f"bridged {caller_channel_id} + externalMedia {ext_channel['id']} into bridge {bridge_id}")
```

## 5. Expected output after the refactor

Same call as the one in the 7/9 session that prompted this doc:

```
[RTP] listening on UDP 9000
[ARI] connecting to ws://localhost:8088/ari/events?api_key=***:***&app=sip-mvp-app
[ARI] connected, waiting for calls into sip-mvp-app (Ctrl+C to stop)
[CALL] arrived: 1783622193.28
[CALL] bridged 1783622193.28 + externalMedia 1783622193.29 into bridge 06206b70-...
[RTP] first packet received (652 bytes)

[STT partial] Hi, can you hear me?

[STT final +6845ms] Hi, can you hear me?

[LLM first-token +8204ms]
[TTS gen] Yes, I hear you.
[LLM reply +8341ms] Yes, I hear you. How can I help today?

[TTS audio +8628ms]
Successfully copied 20.5kB to asterisk-mvp:/var/lib/asterisk/sounds/custom/reply_1.wav
[TTS played +9200ms] reply_1
[TTS gen]  How can I help today?

[TTS audio +9313ms]
Successfully copied 23.6kB to asterisk-mvp:/var/lib/asterisk/sounds/custom/reply_2.wav
[TTS played +9966ms] reply_2

[STT partial] U
[STT partial] Uh,
[STT partial] Uh, nothing.

[STT final +16199ms] Uh, nothing.
...


[CALL] ended: 1783622193.28
```

Taken verbatim from the live tests that drove this doc. No interleaving, no duplicate transcript, a blank line ahead of each new turn's `STT partial` stream (not just the first turn's), a blank line ahead of each of the three headline checkpoints (`STT final`, `LLM first-token`, `TTS audio`), and a two-line divider before `[CALL] ended` marking the session boundary.

## 6. Verification

1. Run the script as usual: `venv/bin/python3 -u sip/scripts/step2_stt_bridge.py`
2. Place a test call, speak one sentence, wait for the reply.
3. Confirm in the output:
   - No line is split mid-word by another thread's print (no `Yes, I hear you.TTS: Yes, I hear you.`-style garbage)
   - The caller's words appear exactly once, as `[STT final]`
   - `t0`-`t4` are still recoverable, now as `[STT final +Xms]`, `[LLM first-token +Xms]`, `[LLM reply +Xms]`, `[TTS audio +Xms]`, `[TTS played +Xms]`. Spot-check `t4 - t0` against `step3.2`'s methodology.
   - `STT final`, `LLM first-token`, and `TTS audio` each have a blank line above them
   - every new turn's `[STT partial]` stream starts with a blank line above it, including the first turn (right after `[RTP] first packet received`) and every turn after
   - two blank lines separate the last turn from `[CALL] ended`
4. Optional: run with `SHOW_LLM_STREAM=1 venv/bin/python3 -u sip/scripts/step2_stt_bridge.py` and confirm the old live token crawl still works for demo purposes.

## 7. Status

**Applied and verified on a live call (2026-07-09).** All diffs in section 4, plus Decisions 6, 7, and 8's blank-line spacing, are in `step2_stt_bridge.py`. The output in section 5 is taken from the live tests that drove this doc: clean labels, no interleaving, no duplicate transcript, visibly separated phases per turn, and a clear session boundary at call-end.

## Next

Once applied and verified, re-run the test call from `step2-wire-call-audio-into-stt.md`'s checkpoint log. Confirm the transcript still prints correctly and the loop still closes, with the new, clean output.
