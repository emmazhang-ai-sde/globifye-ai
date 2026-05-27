import path from 'path'
import {
  transcribeAudioFile,
  extractUtterances,
} from '../lib/deepgram'

const AUDIO_FILE = path.resolve(__dirname, '../sample-audio-noise.wav')

async function main() {
  console.log(`Transcribing ${AUDIO_FILE}...`)
  const result = await transcribeAudioFile(AUDIO_FILE)

  const utterances = extractUtterances(result)
  console.log(`✅ Transcription complete — ${utterances.length} utterances\n`)

  for (const u of utterances) {
    console.log(
      `[${u.sentence_start_sec.toFixed(1)}s] ${u.speaker}: ${u.content_raw}`,
    )
  }

  console.log('\n--- Cleaned versions (filler words stripped) ---\n')
  for (const u of utterances) {
    console.log(
      `[${u.sentence_start_sec.toFixed(1)}s] ${u.speaker}: ${u.content_clean}`,
    )
  }
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})