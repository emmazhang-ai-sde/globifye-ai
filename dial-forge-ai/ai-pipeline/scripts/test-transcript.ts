import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import path from 'path'
import { DeepgramUtterance, stripFillerWords } from '../lib/deepgram'
import { createRecording, writeTranscript } from '../lib/supabase'

// ⚠️ Points to the JSON saved by scripts/test-deepgram.ts in Step 4
// ⚠️ No Deepgram API call needed — utterances are already on disk
const JSON_FILE = './sample-transcripts/sample-audio-1.json'
const OUT_DIR = './sample-transcripts'

async function run() {
  // 1. Load utterances from saved JSON
  console.log('📂 Loading utterances from saved JSON...')
  const utterances: DeepgramUtterance[] = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'))
  console.log(`✅ Loaded ${utterances.length} utterances from ${JSON_FILE}`)

  // 2. Preview filler stripping before writing to DB — verify stripFillerWords is working
  console.log('\nFiller stripping preview (first 3 utterances):')
  utterances.slice(0, 3).forEach(u => {
    console.log(`  raw:   ${u.transcript}`)
    console.log(`  clean: ${stripFillerWords(u.transcript)}`)
    console.log()
  })

  // 3. Create a recordings row first (required — transcript has FK to recordings)
  // rep/client/source were dropped in Step 11 (not real recordings columns). The FK only
  // needs the row to exist; an empty insert gives us a valid recording_id to attach to.
  console.log('📝 Creating recording row...')
  const recordingId = await createRecording({})
  console.log(`✅ Recording row created: ${recordingId}`)

  // 4. Write all transcript rows in one batch insert
  console.log('\n💾 Writing transcript rows to Supabase...')
  await writeTranscript(recordingId, utterances)
  console.log(`✅ ${utterances.length} transcript rows written`)

  // 5. Save recording_id to file — Step 7 reads this instead of manual copy-paste
  const idsPath = path.join(OUT_DIR, 'recording-ids.json')
  const existing = fs.existsSync(idsPath)
    ? JSON.parse(fs.readFileSync(idsPath, 'utf-8'))
    : []
  existing.push({ recordingId, source: 'mvp-test', createdAt: new Date().toISOString() })
  fs.writeFileSync(idsPath, JSON.stringify(existing, null, 2))
  console.log(`\n💾 recording_id saved → ${idsPath}`)
  console.log(`📋 recording_id for Steps 7+: ${recordingId}`)
}

run().catch(err => console.error('❌', err.message))