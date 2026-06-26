# Test 1:
## Pipeline: 
- STT: Deepgram Nova 3
- LLM: (Groq) GPT OSS 120b
- TTS: (Elevenlabs) Eleven Turbo 2.5

## Performance:
Smooth, with quick responses (perhaps a little too quick, if the speaker talks slowly or pauses mid-sentence the LLM may jump in); adjustments will be made.

- Reaction time (end of speaker to first token): avg **238.25** [247 ms, 206 ms, 279 ms, 221 ms]
- Thinking time (first token to full response done): avg **263.25** [220 ms, 354 ms, 282 ms, 197 ms]
- Speaking lag (response done to first TTS): avg **249** [334 ms, 187 ms, 296 ms, 179 ms]
- Total lag: avg **750.5** [801 ms, 747 ms, 857 ms, 597 ms]

**Update:** endpointing added to Deepgram setup, resolved jump-in issue. Latency still feels minimal and natural.

# Test 2:
## Pipeline: 
- STT: Modulate.ai
- LLM: (Groq) GPT OSS 120b
- TTS: (Elevenlabs) Eleven Turbo 2.5

## Performance:
Smooth, TTS is surprisingly incremental (almost seems like the audio is being typed out, impressive). However, noticed some issues with Elevenlabs TTS - most notably, reading decimal numbers (LLM reads the decimal point as a period and ends the sentence) and hyphenated words (slightly unnatural pause).

- Reaction time (end of speaker to first token): avg **248** [288 ms, 180 ms, 274 ms, 250 ms]
- Thinking time (first token to full response done): avg **338.5** [256 ms, 417 ms, 393 ms, 288 ms]
- Speaking lag (response done to first TTS): avg **326** [522 ms, 423 ms, 156 ms, 203 ms]
- Total lag: avg **912.5** [1066 ms, 1020 ms, 823 ms, 741 ms]

**Note:** increase in latency is due to inconsistency in the performance of the LLMs and slight differences in the test questions, likely not a reflection of the performance of the LLMs.

# Test 3:
## Pipeline: 
- STT: Modulate.ai
- LLM: (Groq) GPT OSS 120b
- TTS: Kokoro

## Performance:
Noticeably slower, expected because Kokoro is entirely free. TTS ignores "/" and "$" and has unnatural lag.

- Reaction time (end of speaker to first token): avg **323.5** [333 ms, 314 ms]
- Thinking time (first token to full response done): avg **353** [372 ms, 334 ms]
- Speaking lag (response done to first TTS): avg **2530** [1873 ms, 3187 ms]
- Total lag: avg **3206.5** [2578 ms, 3835 ms]

**Note:** the massive latency may also be due to lack of streaming; my previous code for Elevenlabs was streaming with the HTTP API, not their WebSocket API (which could be faster), and the LLM output isn't streaming yet either. When I switched to Kokoro, I did not check to see if the STT was still streaming. But either way, Kokoro is too slow to be worth it.

# Test 4:
## Pipeline: 
- STT: Modulate.ai
- LLM: (Groq) GPT OSS 120b
- TTS: Cartesia Sonic 2

## Performance:
Most natural speech. Performance is good overall. A few slightly unnatural pauses with dashes/hyphens, but this can be fixed in the LLM prompting as well.

- Reaction time (end of speaker to first token): avg **238.5** [198 ms, 116 ms, 411 ms, 229 ms]
- Thinking time (first token to full response done): avg **372.5** [448 ms, 513 ms, 271 ms, 258 ms]
- Speaking lag (response done to first TTS): avg **~250** [6 ms??, 196-353 ms??, 260 ms, 152 ms] (timestamps were inconsistent, unsure why)
- Total lag: avg **~861** [~896 ms, ~879 ms, ~932 ms, ~737 ms] (using 250 ms as speaking lag for all)

**Note:** This is with the WebSocket API.
