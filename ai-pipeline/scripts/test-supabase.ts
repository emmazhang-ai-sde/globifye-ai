// scripts/test-supabase.ts
import { createRecording, getTranscriptForRecording } from '../lib/supabase'

async function main() {
  console.log('Inserting test recording...')
  const rec = await createRecording({
    call_metadata: { rep: 'Test Rep', client: 'Test Client' },
    audio_url: null,
    duration: null,
  })
  console.log('Created:', rec)

  console.log('Fetching transcript (should be empty)...')
  const rows = await getTranscriptForRecording(rec.id)
  console.log('Transcript rows:', rows)
}

main().catch(console.error)