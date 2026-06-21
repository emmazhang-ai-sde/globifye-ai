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


import { DeepgramClient } from '@deepgram/sdk'

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY! })

export async function textToSpeechStream(
  text: string,
): Promise<ReadableStream<Uint8Array>> {
  const response = await deepgram.speak.v1.audio.generate({
    text,
    model: 'aura-2-thalia-en',   // Aura 2 — newer, better quality, similar latency
    encoding: 'mp3',
  })

  const stream = response.stream()
  if (!stream) {
    throw new Error('Deepgram TTS returned no audio stream')
  }

  return stream as ReadableStream<Uint8Array>
}