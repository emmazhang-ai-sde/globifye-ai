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



export async function createRecording(params: {
  organization_id?: string
  recorded_by?: string
  contact_id?: string
  did_number?: string
  caller_number?: string
  audio_url?: string
  status?: string
  duration_seconds?: number
  sip_provider?: string
} = {}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('recordings')
    .insert(params)
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

/** Batch-inserts topic rows for a given recording and analysis. 
 * Each row represents one topic segment, 
 * which may be a short snippet or a long segment depending 
 * on how the LLM categorized the content.
 * 
 * @param topics 
 */
export async function writeTopics(topics: {
  recording_id: string
  analysis_id: string
  name: string
  start_time: number
  sequence_index: number
}[]): Promise<void> {
  if (topics.length === 0) return
  const { error } = await supabaseAdmin.from('topics').insert(topics)
  if (error) throw new Error(`Topics write failed: ${error.message}`)
}

/** Inserts a GPU job request into the database, which will be picked up by our worker.
 * @param params 
 */
export async function writeGpuJob(params: {
  organization_id?: string
  recording_id: string
  job_type: string
  status: string
  compute_units?: number
  cost?: number
}): Promise<void> {
  await supabaseAdmin.from('gpu_jobs').insert(params)
  // fire-and-forget — intentionally no error throw
}