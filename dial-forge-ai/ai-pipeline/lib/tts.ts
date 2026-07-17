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
