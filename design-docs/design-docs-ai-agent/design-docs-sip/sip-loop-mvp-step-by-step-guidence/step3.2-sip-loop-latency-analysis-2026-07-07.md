# Step 3.2: SIP Loop Latency Analysis (2026-07-07)

**Related docs:** [Step 3: Wire TTS output back into the call](./step3-wire-tts-output-into-call.md) · [Step 3.1: Debugging log](./step3.1-sip-loop-debugging-log-2026-07-07.md)

**Question answered:** how long, in milliseconds, from the moment the caller stops speaking until the AI voice starts replying in the call.

**Short answer:** about **1.8 seconds** on average (range 1.1s to 2.4s across 4 turns), measured from STT-final to the reply audio being pushed into the call. Only ~0.9s of that is compute (STT to LLM to first TTS byte). The other ~1.0s is the file-based playback overhead (assembling the audio, `ffmpeg`, `docker cp`, ARI play). See the caveats section for why the true figure is a bit higher.

---

## What the timestamps mean

The script prints five markers per turn, all in ms since the script started (`_ms()`). Only the differences matter.

| Marker | Printed when | Represents |
|---|---|---|
| `t0` | Modulate emits the final utterance | STT-final (proxy for "caller stopped speaking") |
| `t1` | Groq's first token arrives | LLM started responding |
| `t2` | Groq's stream ends | LLM finished |
| `t3` | first Deepgram Aura audio chunk arrives | TTS started producing audio |
| `t4` | after WAV write + `ffmpeg` + `docker cp` + ARI `/play` | reply audio pushed into the call (AI voice starts) |

The relevant number for "stop speaking to AI voice" is **`t4 - t0`** (using the first `t4` of each turn, since a reply is split into multiple sentences and only the first one starts the voice).

## Raw numbers (4 turns)

All values in ms. Deltas are stage-by-stage; the last column is the headline.

| Turn | t1-t0 | t2-t1 | t3-t2 | t4-t3 | t0→t3 (compute) | **t0→t4 (to reply audio)** |
|---|---|---|---|---|---|---|
| 1 ("Hi, this is Emma... product.") | 361 | 158 | 287 | 930 | 806 | **1736** |
| 2 ("Hi... $1,000.") | 411 | 253 | 319 | 1150 | 983 | **2133** |
| 3 ("Um, I want to buy... about?") | 192 | 242 | 261 | 436 | 695 | **1131** |
| 4 ("Yeah, any discount?") | 327 | 345 | 323 | 1360 | 995 | **2355** |
| **Average** | **323** | **250** | **298** | **969** | **870** | **~1839** |

## Where the time goes

Averaged across the 4 turns:

| Stage | Marker | Avg (ms) | Share |
|---|---|---|---|
| STT-final to LLM first token | t1 - t0 | 323 | 18% |
| LLM generation | t2 - t1 | 250 | 14% |
| LLM done to first TTS byte | t3 - t2 | 298 | 16% |
| TTS assemble + ffmpeg + docker cp + ARI play | t4 - t3 | 969 | 53% |
| **Total (STT-final to reply audio)** | **t4 - t0** | **~1839** | **100%** |

The single biggest cost is `t4 - t3` (~1.0s, over half the total): collecting the first sentence's remaining Aura chunks, writing the WAV, downsampling with `ffmpeg`, copying it into the container, and triggering ARI playback. The compute path (STT to LLM to first TTS byte) is only ~0.9s and stays stable turn to turn.

## Key observations

1. **The playback path, not the AI, is the bottleneck.** LLM + STT + TTS compute is a stable ~0.9s. The file-based playback (`t4 - t3`) is larger and more variable (436ms to 1360ms). This is the "simple but slow" trade-off the Step 3 doc chose on purpose.
2. **Short first sentences reply faster.** The fastest turn (1131ms) opened with "Sure thing." (3 words). Longer openers pushed `t4 - t3` up because there is more audio to receive and a bigger file to copy. Prompting the AI to open with a brief acknowledgment is the cheapest latency win available today.
3. **LLM latency is small.** Groq first-token was 192ms to 411ms, and full generation added only another 158ms to 345ms. The model is not the problem.

## Caveats (why the real number is a bit higher)

1. **`t0` is not your true end of speech.** `t0` is when Modulate emits the *final* utterance, which happens after its silence/endpointing delay. Your actual "mouth stops moving" moment is earlier, so the real "stop speaking to voice" latency is `t4 - t0` **plus** an unmeasured endpointing delay (typically a few hundred ms). These logs cannot measure that delay.
2. **`t4` is when playback is triggered, not when sound reaches the ear.** The ARI `/play` call returns at `t4`; the audio arrives in the caller's ear a little after that (Asterisk buffering + RTP). So `t4 - t0` slightly underestimates perceived latency too.
3. **These offset in the same direction:** both caveats mean the true perceived latency is somewhat higher than the ~1.8s measured here, not lower.

## Correction to earlier notes

Earlier checkpoints cited "~800ms end-of-speech to reply audio." That figure was `t3 - t0` (STT-final to the first TTS byte *received by the script*), which is the compute latency, not the moment the caller hears anything. The caller-perceived figure (audio pushed into the call, `t4 - t0`) is **~1.8s**. The ~0.9s number is still correct as the compute-only sub-latency.

## Out of scope for the MVP

Optimizing this is explicitly deferred (see Step 5 scope guardrails). The obvious next lever is the streaming-playback path (reverse `externalMedia`, noted in Step 3 section 2), which would remove most of the `t4 - t3` file overhead and get closer to the product spec's 1.5s target.
