// scripts/test-supabase.ts
import { createRecording, getTranscriptForRecording } from '../lib/supabase'

async function main() {
  console.log('Inserting test recording...')
  const recordingId = await createRecording({
  status: 'in_progress',
  })
  console.log('Created:', recordingId)

  console.log('Fetching transcript (should be empty)...')
  const rows = await getTranscriptForRecording(recordingId)
  console.log('Transcript rows:', rows)
}

main().catch(console.error)