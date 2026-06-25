// Step 13.2 — ElevenLabs TTS (eleven_turbo_v2_5, ~300-400ms TTFB)
// Uses direct REST fetch — no SDK dependency needed.
// Voice: set ELEVENLABS_VOICE_ID in .env.local. Default = Rachel (21m00Tcm4TlvDq8ikWAM).

const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText}`)
  }

  return Buffer.from(await res.arrayBuffer())
}

// const DG_KEY = process.env.DEEPGRAM_API_KEY
// if (!DG_KEY) {
//   throw new Error('DEEPGRAM_API_KEY is not set')
// }

// // Aura 2 model. `aura-2-asteria-en` is the professional female voice that
// // matched the demo persona earlier. Swap via env var if you want a different
// // voice (e.g. aura-2-luna-en, aura-2-orion-en).
// const MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-asteria-en'

// export async function textToSpeechStream(
//   text: string,
// ): Promise<ReadableStream<Uint8Array>> {
//   const url =
//     `https://api.deepgram.com/v1/speak` +
//     `?model=${encodeURIComponent(MODEL)}&encoding=mp3`

//   const res = await fetch(url, {
//     method: 'POST',
//     headers: {
//       Authorization: `Token ${DG_KEY}`,
//       'Content-Type': 'application/json',
//     },
//     body: JSON.stringify({ text }),
//   })

//   if (!res.ok || !res.body) {
//     const detail = await res.text().catch(() => '')
//     throw new Error(`Deepgram TTS failed: ${res.status} ${detail}`)
//   }

//   // res.body is the streamed audio. First-byte latency is therefore just the
//   // fetch round-trip + Aura's TTFB — typically ~75–150ms for short replies.
//   return res.body
// }