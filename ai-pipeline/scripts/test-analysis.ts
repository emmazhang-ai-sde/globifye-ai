import { writeAnalysis } from '../lib/llm'

// Paste the UUID from Supabase or your Step 5 console output
const RECORDING_ID = '65195e6d-45a0-4411-bd4a-887b22d2acc7'

writeAnalysis(RECORDING_ID)
  .then((row) => {
    console.log('✅ Analysis written to Supabase:\n')
    console.log(JSON.stringify(row, null, 2))
  })
  .catch((err) => {
    console.error('❌ Analysis failed:', err.message)
    process.exit(1)
  })