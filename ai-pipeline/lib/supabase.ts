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

export async function updateRecordingDuration(
  recordingId: string,
  duration: number,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('recordings')
    .update({ duration_seconds: duration })   // ← was `duration`
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

import type { ParsedUtterance } from './deepgram'
import { utterancesToTranscriptRows } from './deepgram'

/**
 * Convenience: takes parsed utterances + a recording_id, writes them all to
 * the transcript table. Used by the API route in Step 8.
 */
export async function writeTranscript(
  recordingId: string,
  utterances: ParsedUtterance[],
): Promise<TranscriptRow[]> {
  const rows = utterancesToTranscriptRows(utterances, recordingId)
  return insertTranscriptRows(rows)
}

// ============================================================
// topics helpers (Step 11)
// ============================================================

export async function writeTopics(
  topics: {
    recording_id: string
    analysis_id: string
    name: string
    start_time: number
    sequence_index: number
  }[],
): Promise<void> {
  if (topics.length === 0) return
  const { error } = await supabaseAdmin.from('topics').insert(topics)
  if (error) throw new Error(`Topics write failed: ${error.message}`)
}

// ============================================================
// gpu_jobs helpers (Step 11) — fire-and-forget
// ============================================================

export async function writeGpuJob(params: {
  organization_id?: string
  recording_id: string
  job_type: string
  status: string
}): Promise<void> {
  await supabaseAdmin.from('gpu_jobs').insert(params)
  // Intentionally no error throw — gpu_jobs failures must not block the pipeline
}