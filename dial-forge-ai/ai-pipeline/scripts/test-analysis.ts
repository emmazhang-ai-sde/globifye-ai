import { writeAnalysis } from '../lib/llm'

// Paste the recordingId value from sample-transcripts/recording-ids.json
const RECORDING_ID = '941ad1db-17a1-4cc6-a0d4-cdac06db264b'

writeAnalysis(RECORDING_ID)
  .then(row => {
    console.log('✅ Analysis written to Supabase:')
    console.log(JSON.stringify(row, null, 2))
  })
  .catch(err => {
    console.error('❌ Analysis failed:', err.message)
  })