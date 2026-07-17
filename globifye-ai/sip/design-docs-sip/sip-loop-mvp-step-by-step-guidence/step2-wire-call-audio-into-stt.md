# Step 2 — Wire Call Audio into STT

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) — section 4, Step 2
**Goal of this step:** words spoken on the test call (from Step 1) show up as transcribed text.

---

## 1. Existing patterns in the repo

Two integration patterns already exist. Neither is plug-and-play for SIP, but one is close enough to build on:

| File | Pattern | Relevant to SIP? |
|---|---|---|
| `ai-pipeline/` live UI (per project architecture) | **Browser → Deepgram WebSocket directly.** The browser holds the persistent connection; Vercel only mints a short-lived token. | **No** — there's no browser in a phone call. SIP audio needs a server-side WebSocket connection instead. |
| `yunxi/sts_tests/test-loop-audio.ts` | **Server-side (Node) → Deepgram WebSocket**, streaming pre-recorded PCM at real-time pace to simulate a live mic. Config: `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, listens for `speech_final`. | A valid pattern, but Deepgram-as-STT is no longer the confirmed choice (see §4). |
| `amy/llm-testing/agent-test6.py` (supersedes the earlier `sts-test.py` reference) | **Python, PyAudio mic → Modulate (STT) → Groq (LLM) → Deepgram Aura (TTS)**, raw queues/threads. Matches the confirmed production stack and the 6/30 meeting's "hardcoded Python, queues/threads" description. | **This is the base.** Swap `modulate_worker()`'s inline mic read for a function reading from Asterisk's audio channel — everything downstream (Modulate, transcript queue, Groq, TTS) stays the same. |

**Decision:** Python, following `agent-test6.py` — no third parallel implementation. It matches the confirmed stack (Modulate for STT); the older `sts-test.py` reference predates that decision and is Deepgram-only.

## 2. Getting audio out of Asterisk: `externalMedia`

Asterisk ARI has three ways to access a channel's audio. Only one fits live streaming STT:

| ARI feature | What it does | Fits this use case? |
|---|---|---|
| `channels/{id}/record` | Records the channel to a file | No — file-based, not live |
| Snoop channel | Spy on another channel's audio without joining the call | Not needed — we already answer the call in Step 1 |
| **`externalMedia`** | Forwards the call's live RTP audio to a UDP endpoint you control | **Yes — this is the one** |

Create it via the ARI REST API:

```
POST /ari/channels/externalMedia
{
  "app": "sip-mvp-app",
  "external_host": "127.0.0.1:9000",
  "format": "slin16"
}
```

This tells Asterisk to send the channel's audio as raw RTP to UDP port 9000 on localhost, encoded `slin16` (16-bit PCM — close to what Deepgram/Modulate already expect).

## 3. Implementation: [`sip/scripts/step2_stt_bridge.py`](../../scripts/step2_stt_bridge.py)

Full copy of Amy's `agent-test6.py`. Only the audio *source* changed — everything downstream (Modulate connection, transcript queue, Groq, Deepgram Aura TTS) is untouched:

1. **ARI event loop** (mirrors `verify_ari.py`'s `StasisStart`/answer pattern): answers an incoming call, creates a `mixing` bridge, adds the caller channel and a new `externalMedia` channel to it. This is what makes Asterisk start forwarding RTP.
2. **`rtp_listener()`** (repurposed from `mic_worker()` — dead code in `agent-test6.py`, since the mic read had actually been inlined into `modulate_worker`): listens on UDP 9000, strips the 12-byte RTP header, queues raw PCM onto `audio_queue`.
3. **`modulate_worker()`**: unchanged except `send_audio` now does `audio_queue.get()` instead of `mic_stream.read(...)`.

`externalMedia` is requested as `slin16` (16-bit PCM), assumed to be 16kHz to match `RATE=16000` in the Modulate connection — **verify this against what Asterisk actually sends**. If it's 8kHz instead, force `slin16` explicitly or resample before queuing (`ffmpeg`/`sox`/`audioop`).

## 4. STT provider note

**Decision: Modulate, not Deepgram.** Matches the confirmed production stack (6/30 meeting); `agent-test6.py` already implements it, so no later "swap to Modulate" step is needed.

**Endpoint (2026-07-07): `velma-2-stt-streaming`** — the general endpoint Amy already validated (★★★★★, "very smooth incremental streaming"). Staying on her tested config rather than introducing an unvalidated variable.

---

## Deliverable for this step

**Deliverable:** Speak into the softphone from Step 1 → `step2_stt_bridge.py` prints `STT (partial): ...` / `STT: ...` lines for what was said.

**Status: ✅ MET (2026-07-07).** A live call transcribed cleanly — and because the same script also runs the Groq LLM + Deepgram Aura TTS path, the **full SIP loop closed in one call** (Steps 2, 3, and 4 together): spoken audio → transcript → LLM reply → audio played back into the call, audible on the softphone. See checkpoint log.

### Checkpoint log

**2026-07-07 — full loop working.** Spoke *"Hi, this is Emma. I'm calling to inquire about your company's product."* into Linphone → `STT:` printed it verbatim → Groq replied *"Hi Emma, thanks for calling. How can I help you with our product?"* → Aura TTS played back into the call, audible. End-of-sentence to audible reply ≈ 1.8s (~0.9s of it compute); see [`step3.2-sip-loop-latency-analysis.md`](./step3.2-sip-loop-latency-analysis.md).

**Getting there took a chain of fixes — every one was a real, distinct bug** (documented so nobody re-walks this path):

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Cascade of `Call arrived` / 422 error, dozens of orphaned channels | externalMedia channels join the same Stasis app, firing their own `StasisStart` | Track our own externalMedia channel IDs; skip their `StasisStart` (`step2_stt_bridge.py`) |
| 2 | Zero RTP ever reached the script | `external_host=127.0.0.1` resolves to the *container's* loopback, not the host | `EXTERNAL_MEDIA_HOST = host.docker.internal:9000` |
| 3 | RTP debug "showed" nothing → wrong conclusions | `docker logs` only captures the console log channel, which defaulted to `notice,warning,error` — all verbose/debug silently dropped | Temporarily widen `logger.conf` console to `verbose,debug` (reverted after; see logger.conf comment) |
| 4 | Call connects, but no caller audio reaches Asterisk | No NAT handling; Asterisk advertised its unreachable container IP in SDP | `pjsip.conf`: `external_media_address=127.0.0.1` + `rtp_symmetric`/`force_rport`/`rewrite_contact`/`direct_media=no` |
| 5 | Still no caller audio | Asterisk allocated RTP port 18104, outside Docker's published `10000-10100` | `rtp.conf`: `rtpend=10100` to match the published range |
| 6 | RTP arrived but no transcript; amplitude pinned at exactly 32768 | Asterisk `slin16` is **big-endian**; Modulate stream is `s16le` (little-endian) → byte-swapped noise | Byte-swap each sample in `rtp_listener` before queuing to Modulate |
| 7 | First call's audio hit a dead Modulate socket (`ConnectionClosedOK` 1000) | Modulate connection opened once at startup, then idle-timed-out before any call | Connect lazily (block until audio) and reconnect per call (`modulate_worker`) |

**Config changes that are permanent and required** (do NOT revert): `pjsip.conf` NAT block, `rtp.conf` `rtpend=10100`, and the script fixes above. **Diagnostic-only changes were reverted:** `logger.conf` console channel, and `rtp set debug` / `pjsip set logger` (runtime, off).

This table is the quick reference; for the full round-by-round narrative (what was run, the diagnosis, the fix, in order) see [`step3.1-sip-loop-debugging-log.md`](./step3.1-sip-loop-debugging-log.md).

> **Earlier checkpoint (same day) — Modulate auth confirmed** before any call: the script came up clean (no `4003`) with real keys from `.env.local`, proving the key authenticated end-to-end. That was the first milestone before the audio-path work above.

## Running the script (environment notes)

Run with the project venv's Python and unbuffered output so prints flush live:

```bash
cd globifye-ai
venv/bin/python3 -u sip/scripts/step2_stt_bridge.py
```

Dependencies beyond what `verify_ari.py` used (`requests` + `websocket-client`): `websockets`, `groq`, `deepgram-sdk`. (`ffmpeg` is also needed for Step 3's playback, but not for Step 2's STT path.)

> **Known gotcha (resolved 2026-07-07): renaming `globifye-ai/` broke the venv.**
>
> - **Cause:** `venv/` was created while the repo folder was still named `GlobiFYE/`. Python venvs hardcode absolute paths and don't survive a folder rename.
> - **Symptoms:** `source venv/bin/activate` pointed at the dead path (`VIRTUAL_ENV=/Users/.../GlobiFYE/venv`), so `python3` silently fell through to system Python → `ModuleNotFoundError: No module named 'deepgram'`, even though the packages were installed. `venv/bin/pip` had a matching `bad interpreter` shebang error. `venv/bin/python3` invoked directly still worked (it resolves `pyvenv.cfg` relative to its own location, not the stale path).
> - **Fix:** recreated the venv in place (`python3.14 -m venv venv`, reinstalled the frozen package list). `activate` and `pip` both work normally now.
> - **Lesson:** don't rename a folder containing a venv — recreate the venv after any such move.
> - **Scope:** seen on Shuyang's machine only; unconfirmed elsewhere. Hitting the same symptom? Run `grep VIRTUAL_ENV venv/bin/activate` to check for a stale path before assuming it's a new issue.

## API keys — everyone should have their own `.env.local`

Keys load from `ai-pipeline/.env.local` at startup (`DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `MODULATE_API_KEY` — small zero-dependency parser, no `python-dotenv` needed), not hardcoded. It's gitignored, so it's local-only per machine — not a shared file. **Everyone should keep their own `.env.local`,** not one shared copy or keys pasted into Slack/docs:

1. **Leak risk.** Gitignored ≠ safe to paste — treat it like a password (no chat, screenshots, or shared docs).
2. **No overwrite collisions.** One shared file means whoever edits last wins — someone's working Modulate key can vanish under an old Deepgram key pasted over it. Separate files keep separate provider accounts separate.

If a key is missing, the script prints `WARNING: missing keys in .env.local: ...` at startup instead of failing silently — check that first before assuming something else is broken.

## Common Pitfalls

| Symptom | Likely cause |
|---|---|
| No RTP packets arriving on UDP 9000 | `externalMedia` channel not actually bridged to the call — confirm `bridge_call_to_external_media()` added both channels to the same ARI bridge, not just created the `externalMedia` channel standalone |
| `OSError: [Errno 48] Address already in use` on UDP 9000 | A previous run of the script is still alive holding the port (its main ARI loop survives even after a worker thread crashes) — find it with `lsof -nP -iUDP:9000` and kill that PID before re-running |
| Garbled/static transcript | Sample rate mismatch (8kHz vs 16kHz) between what Asterisk sends and what Modulate is told to expect (`sample_rate=RATE` in the connection URL) — the most likely first bug |
| Transcript is silent even though audio "looks" like it's flowing | RTP header stripping is off — headers are usually 12 bytes but can be longer with extensions; log raw packet length and content type to confirm |
| Modulate websocket closes with `4003 (private use)` right after connect | Missing/empty `MODULATE_KEY` (auth reject) — expected until `.env.local` has a real key; the rest of the script (ARI connect, UDP bind) still comes up fine |
| `ModuleNotFoundError: websockets` / `groq` / `deepgram` | Running with the wrong Python. Use `venv/bin/python3` (see environment notes above) — the deps live in the project venv, not system Python |

## Next

Once spoken words on the test call reliably produce transcripts, move to [Step 3 — Wire TTS output back into the call](./step3-wire-tts-output-into-call.md).
