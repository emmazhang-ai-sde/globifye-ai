// import { ElevenLabsClient } from 'elevenlabs'

// const elevenlabs = new ElevenLabsClient({
//   apiKey: process.env.ELEVENLABS_API_KEY!,
// })

// const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM'

// export async function textToSpeechStream(
//   text: string,
// ): Promise<ReadableStream<Uint8Array>> {
//   // Use convert() instead of stream() — returns a Node.js Readable
//   const audioStream = await elevenlabs.textToSpeech.convert(VOICE_ID, {
//     text,
//     model_id: 'eleven_turbo_v2_5',
//     voice_settings: {
//       stability: 0.5,
//       similarity_boost: 0.75,
//     },
//     output_format: 'mp3_44100_128',
//   })

//   // Convert Node.js Readable → Web ReadableStream
//   return new ReadableStream<Uint8Array>({
//     async start(controller) {
//       for await (const chunk of audioStream) {
//         controller.enqueue(
//           chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
//         )
//       }
//       controller.close()
//     },
//   })
// }

// lib/tts.ts
//
// Deepgram Aura 2 TTS via REST API.
//
// We use the REST endpoint directly instead of the SDK so the code is immune
// to SDK version drift — `fetch` + a documented HTTP endpoint just works.
// The response body IS a ReadableStream<Uint8Array>, so we hand it back as-is;
// the caller gets the same shape that Kokoro returned, just streamed.
//
// Output format is MP3. The browser playback path (decodeAudioData) is
// format-agnostic, so no change is needed in page.tsx. The route's
// Content-Type header should be 'audio/mpeg' (not 'audio/wav').

const DG_KEY = process.env.DEEPGRAM_API_KEY
if (!DG_KEY) {
  throw new Error('DEEPGRAM_API_KEY is not set')
}

// Aura 2 model. `aura-2-asteria-en` is the professional female voice that
// matched the demo persona earlier. Swap via env var if you want a different
// voice (e.g. aura-2-luna-en, aura-2-orion-en).
const MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-asteria-en'

export async function textToSpeechStream(
  text: string,
): Promise<ReadableStream<Uint8Array>> {
  const url =
    `https://api.deepgram.com/v1/speak` +
    `?model=${encodeURIComponent(MODEL)}&encoding=mp3`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${DG_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Deepgram TTS failed: ${res.status} ${detail}`)
  }

  // res.body is the streamed audio. First-byte latency is therefore just the
  // fetch round-trip + Aura's TTFB — typically ~75–150ms for short replies.
  return res.body
}