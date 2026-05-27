import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Browser-safe client (limited permissions)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server-only client (full permissions — only use in API routes)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

// Add at the top, with the other imports
import type {
  NewRecording,
  NewTranscriptRow,
  NewAnalysis,
  Recording,
  TranscriptRow,
  Analysis,
} from '@/types/pipeline'

// =====================
// recordings helpers
// =====================

export async function createRecording(data: NewRecording): Promise<Recording> {
  const { data: row, error } = await supabaseAdmin
    .from('recordings')
    .insert(data)
    .select()
    .single()

  if (error) throw new Error(`createRecording failed: ${error.message}`)
  return row as Recording
}

export async function updateRecordingDuration(
  recordingId: string,
  duration: number,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('recordings')
    .update({ duration })
    .eq('id', recordingId)

  if (error) throw new Error(`updateRecordingDuration failed: ${error.message}`)
}

// =====================
// transcript helpers
// =====================

export async function insertTranscriptRows(
  rows: NewTranscriptRow[],
): Promise<TranscriptRow[]> {
  const { data, error } = await supabaseAdmin
    .from('transcript')
    .insert(rows)
    .select()

  if (error) throw new Error(`insertTranscriptRows failed: ${error.message}`)
  return data as TranscriptRow[]
}

export async function getTranscriptForRecording(
  recordingId: string,
): Promise<TranscriptRow[]> {
  const { data, error } = await supabaseAdmin
    .from('transcript')
    .select('*')
    .eq('recording_id', recordingId)
    .order('sentence_start_sec', { ascending: true })

  if (error) throw new Error(`getTranscriptForRecording failed: ${error.message}`)
  return data as TranscriptRow[]
}

// =====================
// analysis helpers
// =====================

export async function insertAnalysis(data: NewAnalysis): Promise<Analysis> {
  const { data: row, error } = await supabaseAdmin
    .from('analysis')
    .insert(data)
    .select()
    .single()

  if (error) throw new Error(`insertAnalysis failed: ${error.message}`)
  return row as Analysis
}

export async function getAnalysisForRecording(
  recordingId: string,
): Promise<Analysis | null> {
  const { data, error } = await supabaseAdmin
    .from('analysis')
    .select('*')
    .eq('recording_id', recordingId)
    .maybeSingle()

  if (error) throw new Error(`getAnalysisForRecording failed: ${error.message}`)
  return data as Analysis | null
}
