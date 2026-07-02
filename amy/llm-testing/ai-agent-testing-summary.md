# Speech-to-Speech Stack Evaluation

## Speech-to-Text (STT)

| Model                  | Cost                        | Performance       | Quality (Subjective) | Notes                                                                     |
| ---------------------- | --------------------------- | --------------------------- | -------------------- | ------------------------------------------------------------------------- |
| 🟢 **Deepgram Nova-3** | $0.0048/min (streaming STT) | Fast                        | ★★★★★                | Excellent accuracy and reliability, but more expensive than alternatives. |
| 🟢 **Modulate.ai**     | $0.001/min                  | Fast, incremental streaming | ★★★★★                | Very smooth incremental transcription while remaining inexpensive.        |

---

## Large Language Model (LLM)

| Model                    | Cost | Average Latency                                                            | Quality (Subjective) | Notes                                                                                                      |
| ------------------------ | ---- | ---------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| 🟢 **Groq GPT-OSS 120B** | Free | Time to first token: 259 ± 71.5 ms<br>Total thinking time: 314 ± 86 ms | ★★★★★                | Worked extremely well with excellent latency. No compelling reason was found to benchmark additional LLMs. |

---

## Text-to-Speech (TTS)

| Model                              | Cost                                 | Average Latency       | Quality (Subjective) | Notes                                                                                                                              |
| ---------------------------------- | ------------------------------------ | --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 **ElevenLabs Eleven Turbo 2.5** | ≈ $50 / 1M characters                | 288 ms                | ★★★★☆                | Impressively low latency. Speech is smooth and fairly natural with only occasional unnatural pauses. Most expensive option tested. |
| 🔴 **Kokoro**                      | Free                                 | 2530 ms               | ★★                   | Too slow for conversational voice agents despite being free.                                                                       |
| 🟢 **Cartesia Sonic 2**            | Subscription only (no pay-as-you-go) | ~250 ms (approximate) | ★★★★★                | Probably the most natural and human-like voice tested, but lack of a pay-as-you-go option makes it impractical.                    |
| 🟡 **OpenAI TTS-1**                | $15 / 1M characters                  | 864 ms                | ★★★☆                 | Very inexpensive but noticeable generation delay.                                                                                  |
| 🟢 **Deepgram Aura-2**             | $30 / 1M characters                  | 281 ms                | ★★★★★                | Natural, smooth speech with consistently low latency, though more expensive than OpenAI.                                           |
| 🟡 **OpenAI GPT Realtime TTS**     | ≈ $80 / 1M output audio tokens       | 838 ms                | ★★★★                 | Sounds good overall but has noticeable lag and substantially higher cost.                                                          |
| 🟢 **xAI Grok TTS v1**             | $15 / 1M characters                  | 470 ms                | ★★★★☆                | Natural, smooth voice quality with good latency at a low price.                                                                    |
| 🟡 **Deepgram Aura-1**             | $15 / 1M characters                  | 383 ms                | ★★★☆                 | Affordable with decent latency, but voices sound somewhat less natural than Aura-2.                                                |

---

# Overall Conclusions

| Component | Preferred Choice                       | Why                                                                                                                |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **STT**   | **Modulate.ai**  | Offers comparable quality at a lower cost than Deepgram. |
| **LLM**   | **Groq GPT-OSS 120B**                  | Free, fast, and performed well.                  |
| **TTS**   | **Deepgram Aura-2** or **xAI Grok**                    | Deepgram has slightly lower latency but is double the cost.                                     |
