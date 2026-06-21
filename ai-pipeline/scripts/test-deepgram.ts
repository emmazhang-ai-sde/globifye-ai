import path from 'path'
import {
  transcribeAudioFile,
  extractUtterances,
  utterancesToTranscriptRows,
} from '../lib/deepgram'
import {
  createRecording,
  insertTranscriptRows,
  updateRecordingDuration,
} from '../lib/supabase'

const AUDIO_FILE = path.resolve(__dirname, '../sample-audio-long.mp3')

async function main() {
  // ----------------------------------------------------------
  // 1. Transcribe with Deepgram
  // ----------------------------------------------------------
  console.log(`🎙  Transcribing ${AUDIO_FILE}...`)
  const result = await transcribeAudioFile(AUDIO_FILE)
  const utterances = extractUtterances(result)
  console.log(`✅ Got ${utterances.length} utterances from Deepgram`)

  // ----------------------------------------------------------
  // 2. Create the recording row (parent)
  // ----------------------------------------------------------
  console.log('💾 Creating recording row...')
  const recordingId = await createRecording({
  status: 'in_progress',
  })
  console.log(`   recordingId = ${recordingId}`)

  // ----------------------------------------------------------
  // 3. Convert utterances → transcript rows, then batch insert
  // ----------------------------------------------------------
  const rows = utterancesToTranscriptRows(utterances, recordingId)
  console.log(`💾 Inserting ${rows.length} transcript rows...`)
  const inserted = await insertTranscriptRows(rows)
  console.log(`✅ Inserted ${inserted.length} transcript rows`)

  // ----------------------------------------------------------
  // 4. Update the recording with its duration
  // ----------------------------------------------------------
  const duration = computeDurationFromUtterances(result)
  if (duration !== null) {
    await updateRecordingDuration(recordingId, duration)
    console.log(`✅ Updated recording.duration = ${duration.toFixed(1)}s`)
  }

  // ----------------------------------------------------------
  // 5. Print a sample of what was stored
  // ----------------------------------------------------------
  console.log('\n📋 First 5 stored utterances:\n')
  for (const row of inserted.slice(0, 5)) {
    console.log(`[${row.sentence_start_sec?.toFixed(1)}s] ${row.speaker}`)
    console.log(`   raw:   ${row.content_raw}`)
    console.log(`   clean: ${row.content_clean}\n`)
  }

  console.log('🎉 Step 5 complete')
}

/**
 * Pull duration from Deepgram's metadata, or fall back to the last
 * utterance's end time.
 */
function computeDurationFromUtterances(deepgramResult: any): number | null {
  const metaDuration = deepgramResult?.metadata?.duration
  if (typeof metaDuration === 'number') return metaDuration

  const utterances = deepgramResult?.results?.utterances
  if (Array.isArray(utterances) && utterances.length > 0) {
    return utterances[utterances.length - 1].end ?? null
  }
  return null
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})