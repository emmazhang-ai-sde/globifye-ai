import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { transcribeFile } from '../lib/deepgram'

const AUDIO_FILE = './sample-audio.mp3'

transcribeFile(AUDIO_FILE)
  .then(utterances => {
    console.log(`✅ Transcription complete — ${utterances.length} utterances\n`)
    utterances.forEach(u => {
      console.log(`[${u.start.toFixed(1)}s] Speaker ${u.speaker}: ${u.transcript}`)
    })
  })
  .catch(err => console.error('❌ Deepgram error:', err.message))
