import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import path from 'path'
import { transcribeFile } from '../lib/deepgram'

// if you use a different name or path, update this accordingly
const AUDIO_FILE = 'sample-audio/sample-audio-2.mp3'
const OUT_DIR = './sample-transcripts' // fs.mkdirSync will create this if it doesn't exist

transcribeFile(AUDIO_FILE)
  .then(utterances => {
    console.log(`✅ Transcription complete — ${utterances.length} utterances\n`)
    utterances.forEach(u => {
      console.log(`[${u.start.toFixed(1)}s] Speaker ${u.speaker}: ${u.transcript}`)
    })

    // Save outputs
    const baseName = path.basename(AUDIO_FILE, path.extname(AUDIO_FILE))
    fs.mkdirSync(OUT_DIR, { recursive: true })

    // JSON — reusable for DB write without re-calling Deepgram
    const jsonPath = path.join(OUT_DIR, `${baseName}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(utterances, null, 2))
    console.log(`\n💾 Saved JSON → ${jsonPath}`)

    // Markdown — human-readable review
    const md = [
      `# Transcript — ${baseName}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      ...utterances.map(u => `**[${u.start.toFixed(1)}s] Speaker ${u.speaker}:** ${u.transcript}`),
    ].join('\n')
    const mdPath = path.join(OUT_DIR, `${baseName}.md`)
    fs.writeFileSync(mdPath, md)
    console.log(`📄 Saved Markdown → ${mdPath}`)
  })
  .catch(err => console.error('❌ Deepgram error:', err.message))
