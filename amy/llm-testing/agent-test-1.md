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
