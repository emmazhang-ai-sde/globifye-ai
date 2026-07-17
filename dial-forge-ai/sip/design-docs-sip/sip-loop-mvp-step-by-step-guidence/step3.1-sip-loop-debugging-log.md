# SIP Loop MVP — Debugging Log

**Created:** 2026-07-07

**Related docs:** [Step 2 — Wire call audio into STT](./step2-wire-call-audio-into-stt.md) · [Step 3 — Wire TTS output back into the call](./step3-wire-tts-output-into-call.md)

---

Getting from "code written" to "I can hear the AI talk back" took ~16 rounds of run-observe-fix. This is the full blow-by-blow so nobody re-walks it. Each round: **what was run**, **the diagnosis**, and **the change**. (macOS host, Linphone softphone, Asterisk in Docker Desktop.)

## Environment / key setup

**Round 1 — `ModuleNotFoundError: No module named 'deepgram'`.**
Ran:
```
$ python3 -u sip/scripts/step2_stt_bridge.py          → ModuleNotFoundError: deepgram
$ source venv/bin/activate && python3 -u ...           → ModuleNotFoundError: deepgram (still!)
$ venv/bin/python3 -u ...                              → runs, but Modulate closes with 4003
```
*Diagnosis:* deps live in the project venv, not system Python — but `source venv/bin/activate` *also* failed because the venv broke when the repo folder was renamed `GlobiFYE/` → `globifye-ai/` (`activate` hardcoded the dead old path). Only `venv/bin/python3` worked. See the "Known gotcha" box in the Step 2 doc. *Change:* none yet (diagnosis).

**Round 2 — recreate the venv.** *Change:* froze the 33 packages, rebuilt the venv in place at the correct path, reinstalled, verified `activate`/`pip`/imports all work.

**Round 3 — `ConnectionClosedError: received 4003`.** *Diagnosis:* 4003 = Modulate rejecting an empty `MODULATE_KEY`. No Modulate key existed anywhere in the repo (Amy owns that account); Groq + Deepgram keys were already in `ai-pipeline/.env.local`. *Change:* none yet — surfaced the choice; user opted to wait for the real key.

**Round 4 — Modulate endpoint choice.** From Modulate's model list, narrowed to the two STT+streaming endpoints. *Change:* landed on `velma-2-stt-streaming` (the one Amy validated in `agent-test6.py`), keeping `velma-2-stt-streaming-english-v2` as a later A/B optimization.

**Round 5 — env-loading.** *Change:* found the key already in `.env.local` as `Modulate_API_KEY` (mixed case); normalized it to `MODULATE_API_KEY`, and added a zero-dependency `_load_env_local()` parser so the script reads `DEEPGRAM_API_KEY`/`GROQ_API_KEY`/`MODULATE_API_KEY` from `.env.local` instead of hardcoded blanks. First clean startup (no 4003) confirmed the key authenticated.

## The 7-bug live-call chain

**Round 6 — dialed `1000`, got a cascade + crash (BUG 1).**
```
Bridged caller 1783452914.42 + externalMedia 1783452914.43 ...
Call arrived: channel 1783452914.43
Bridged caller 1783452914.43 + externalMedia 1783452914.44 ...   ← cascading
...
requests.exceptions.HTTPError: 422 Client Error: Unprocessable Entity
```
*Diagnosis:* an `externalMedia` channel joins the same Stasis app a caller does, so creating one fires its *own* `StasisStart` — which the loop treated as a new call, bridging it to yet another externalMedia channel, ad infinitum, until Asterisk 422'd. Left 45 orphaned channels/bridges. *Change:* track our own externalMedia channel IDs in `_external_media_channel_ids` and skip their `StasisStart`. Restarted the container to clear the orphans.

**Round 7 — clean single call, but "I don't see the transcript."**
```
Call arrived: channel 1783453293.0
Bridged caller ...
Call ended: channel ...
```
*Diagnosis:* cascade fixed (one clean call now), but no RTP indicator and `rtp_listener` logged nothing, so we were blind. *Change:* added `First RTP packet received` + periodic packet-count logging to `rtp_listener`.

**Round 8 — spoke, still no `First RTP packet` (BUG 2).**
```
Call arrived: channel 1783454166.3
Bridged caller ...
^C   ("i do speak")
```
*Diagnosis:* `asterisk-mvp` runs in Docker **bridge** network mode, so `external_host=127.0.0.1` pointed at the *container's* loopback, not the Mac host where the script listens. Asterisk was sending RTP into its own void. *Change:* `EXTERNAL_MEDIA_HOST = host.docker.internal:9000` (Docker Desktop's DNS name for the host). Cleared orphaned channels.

**Round 9 — "I was calling from a landline to 1000 — do I need to add it as a contact?"**
*Diagnosis:* no — `1000` is an internal dialplan extension, not a phone number/contact, and the logs showed the call already reaching Asterisk via the registered `test-endpoint` softphone. Proved container→host UDP works (8/8 probe packets delivered to the host on a spare port). Noticed the registered contact was `192.168.65.x` — the Docker-NAT fingerprint. Enabled RTP debug for the next call.

**Round 10 — mic permission ruled out; NAT settings missing (BUG 4).**
User confirmed Linphone had mic permission and wasn't muted. *Diagnosis:* the `[test-endpoint]` config had **no NAT handling** — Asterisk advertised its unreachable container IP in SDP, so caller audio had nowhere to go. Step 1 only ever proved *signaling* ("silence is fine"), so media had never actually worked. *Change:* added to `pjsip.conf` — `external_media_address=127.0.0.1` + `external_signaling_address=127.0.0.1` on the transport, and `rtp_symmetric`/`force_rport`/`rewrite_contact`/`direct_media=no` on the endpoint. Reloaded pjsip.

**Round 11 — still no RTP; the diagnostics themselves were lying (BUG 3).**
```
Call arrived: channel 1783457335.4
Bridged caller ...
Call ended: ...
```
*Diagnosis (an honest correction):* my earlier "Asterisk received zero RTP" reading was **unproven** — `docker logs` only captures Asterisk's *console* log channel, which defaulted to `notice,warning,error`, silently dropping every `verbose`/`debug` line including all RTP/SIP-trace output. *Change:* temporarily widened `logger.conf` console to `notice,warning,error,verbose,debug`; `logger reload`; enabled `pjsip set logger on`. Now the SIP/SDP exchange and RTP flow were actually visible.

**Round 12 — SDP finally readable: wrong RTP port (BUG 5).**
With logging fixed, the call's SDP showed Asterisk's answer: `c=IN IP4 127.0.0.1`, `m=audio 18104 ...`. *Diagnosis:* `external_media_address=127.0.0.1` worked, but Asterisk allocated RTP port **18104** — outside Docker's published `10000-10100` range — so Linphone's audio to `127.0.0.1:18104` hit the Mac's loopback and was dropped. *Change:* `rtp.conf` `rtpend=20000` → `rtpend=10100` to match the published range. Reloaded `res_rtp_asterisk.so`.

**Round 13 — first RTP packet! + the 00:00 timer.**
```
First RTP packet received (652 bytes)
RTP packets received so far: 500
Call ended: ...
```
(plus a Linphone screenshot showing `00:00`.) *Diagnosis:* audio path open at last (RTP debug now showed 968 `Got RTP` from Linphone + 968 `Sent RTP` to the script). The `00:00` timer is **cosmetic** — the logs proved a full 20-second call with bidirectional RTP and a proper SIP answer. Still no transcript, so: is the audio speech or garbage? *Change:* added amplitude logging + a raw-PCM dump to `rtp_listener`.

**Round 14 — amplitude pinned at exactly 32768 (BUG 6).**
```
RTP packets: 500, peak amplitude this window: 32768
RTP packets: 1000, peak amplitude this window: 32768   ← constant, never varies
```
*Diagnosis:* a rock-constant `32768` (the 16-bit rail) is the fingerprint of an **endianness mismatch**. Analyzing the dump confirmed it: little-endian read = peak 32768 / rms 18221 (full-scale noise); big-endian read = peak 4954 / rms 409 (clean speech). Asterisk `slin16` is **big-endian** (RTP network order); Modulate's stream is `s16le`. *Change:* byte-swap each 16-bit sample in `rtp_listener` before queuing to Modulate.

**Round 15 — audio clean, but the Modulate socket was dead (BUG 7).**
```
First RTP packet received ...
Exception in thread Thread-7 (send_audio):
  ... ConnectionClosedOK: received 1000 (OK)
...
RTP packets: 500, peak amplitude this window: 718     ← real speech now! (was 32768)
RTP packets: 1000, peak amplitude this window: 3516
```
*Diagnosis:* the byte-swap worked (amplitudes now look like speech). But the Modulate websocket was opened once at startup and sat idle until the call, so Modulate idle-closed it (`1000 OK`) before any audio arrived — and nothing reconnected. (The separate Linphone "Call could not be created" popup was a client glitch; quitting/relaunching Linphone cleared it.) *Change:* made `modulate_worker` connect **lazily** (block until audio starts) and **reconnect per call**.

**Round 16 — 🎉 the loop closed.**
```
STT: Hi, this is Emma. I'm calling to inquire about your company's product.
USER: Hi, this is Emma. ...
Hi Emma, thanks for calling. How can I help you with our product?
Successfully copied 28.7kB to asterisk-mvp:.../reply_1.wav
```
Spoken audio → transcript → Groq reply → Aura TTS **audible in the call**. Steps 2, 3, and 4 all proven in a single call. ~1.8s from end-of-speech to audible reply (~0.9s of it compute); see [`step3.2-sip-loop-latency-analysis.md`](./step3.2-sip-loop-latency-analysis.md).

## Cleanup after success
- Turned off `rtp set debug` / `pjsip set logger`; reverted `logger.conf` console channel to `notice,warning,error` (left a comment on how to re-enable).
- Trimmed the amplitude/dump diagnostics from `rtp_listener` (kept the byte-swap fix); deleted the temp PCM dump.
- **Permanent, required changes (do NOT revert):** `pjsip.conf` NAT block, `rtp.conf` `rtpend=10100`, and all the `step2_stt_bridge.py` fixes (cascade, `host.docker.internal`, byte-swap, lazy/reconnecting Modulate, env-loading).
