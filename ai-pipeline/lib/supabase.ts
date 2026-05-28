import { createClient } from '@supabase/supabase-js'

// 5.4 Add DB write helpers to lib/supabase.ts
import { DeepgramUtterance, stripFillerWords } from './deepgram'


const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Browser-safe client (limited permissions)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server-only client (full permissions — only use in API routes)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)


// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new row in the recordings table and returns its UUID.
 * Must be called before writeTranscript — transcript rows have a FK to recordings.
 */
export async function createRecording(
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('recordings')
    .insert({ call_metadata: metadata })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create recording row: ${error.message}`)
  return data.id
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

/**
 * Batch-inserts all utterances as transcript rows for a given recording.
 * Produces content_raw (filler words kept) and content_clean (filler words stripped).
 */
export async function writeTranscript(
  recordingId: string,
  utterances: DeepgramUtterance[]
): Promise<void> {
  const rows = utterances.map(u => ({
    recording_id:       recordingId,
    speaker:            `Speaker ${u.speaker}`,         // "Speaker 0", "Speaker 1"
    content_raw:        u.transcript,                   // filler words intact — sent to LLM
    content_clean:      stripFillerWords(u.transcript), // filler words stripped — shown in UI
    sentence_start_sec: u.start,
  }))

  const { error } = await supabaseAdmin
    .from('transcript')
    .insert(rows)

  if (error) throw new Error(`Transcript write failed: ${error.message}`)
}