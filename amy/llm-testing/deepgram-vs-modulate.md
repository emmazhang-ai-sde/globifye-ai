### TTS Comparison

| Feature            | **Modulate.ai Transcribe**                                                            | **Deepgram Nova-3**                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming cost** | **$0.06/hour** ($0.001/min)                                                           | **$0.29/hour** ($0.0048/min) pay as you go plan; **$0.25/hour** ($0.0042/min) on Growth plan ([Modulate][1])                                                      |
| **Accuracy**       | Reported to outperform Nova-3 on several real-world benchmarks (vendor claim).        | Excellent real-world accuracy; one of the industry standards. ([Modulate][1])                                                                  |
| **Features**       | Streaming, diarization, PII redaction, emotion/accent detection included or low-cost. | Streaming, diarization, smart formatting, language detection, keyterm prompting, etc. Some advanced features are paid add-ons. ([Modulate][1]) |
| **Pros**           | Lowest cost by a wide margin; good enough quality for voice agents.                   | More mature platform; integrates seamlessly with Aura TTS; already used elsewhere in the project.                                              |
| **Cons**           | Requires an additional API provider.                                                  | Approximately **5× more expensive** than Modulate for streaming transcription.                                                                 |

### Pricing plans

| Provider        | Relevant plans                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Modulate.ai** | Free trial (400 hours), then pay-as-you-go. No higher-volume subscription tiers were found. ([Modulate][1])                                                                                   |
| **Deepgram**    | **Pay-as-you-go** with **$200 free credits**, **Growth** plan (prepaid **$4,000+/year**) with ~12–20% discounted usage rates, and **Enterprise** for high-volume deployments. ([Deepgram][2]) |

**Summary**: From our tests, Deepgram Nova and Modulate.ai have comparable performance, and both offer the features we need; Modulate.ai is 4x to 5x cheaper, while using Deepgram reduces the infrastructure needed to support an additional platform.

**Note:** Although this has not yet been successfully validated, allowing the use of an additional provider could further reduce costs. If future testing shows that **OpenAI TTS** can achieve acceptable real-time latency, it would reduce TTS costs by approximately **50%** compared to Deepgram Aura. To partially offset the increased number of providers, the existing **Deepgram Nova** STT used in the call analysis pipeline could also be replaced with **Modulate.ai**, consolidating STT under a single provider. While this would not reduce the number of providers as much as using Deepgram for both STT and TTS, it would still simplify the architecture while lowering overall operating costs.

[1]: https://www.modulate.ai/lp/deepgram-vs-modulate?utm_source=chatgpt.com "Deepgram vs Modulate"
[2]: https://deepgram.com/pricing?utm_source=chatgpt.com "Deepgram Pricing | Scalable Speech-to-Text, Text-to-Speech & Voice Agent APIs"
