import { DeepgramClient } from '@deepgram/sdk'
import fs from 'fs'
import type { NewTranscriptRow } from '@/types/pipeline'

// ============================================================
// Deepgram client setup (SDK v5)
// ============================================================

const deepgramApiKey = process.env.DEEPGRAM_API_KEY
if (!deepgramApiKey) {
  throw new Error('DEEPGRAM_API_KEY is not set in environment')
}

export const deepgram = new DeepgramClient({ apiKey: deepgramApiKey })

// ============================================================
// Types
// ============================================================

export interface ParsedUtterance {
  speaker: string
  content_raw: string
  content_clean: string
  sentence_start_sec: number
}

// ============================================================
// Filler word stripping
// ============================================================

const FILLER_WORDS = [
  'um', 'uh', 'er', 'ah', 'hmm',
  'like', 'you know', 'i mean', 'sort of', 'kind of',
  'basically', 'literally', 'actually',
]

export function stripFillerWords(text: string): string {
  const sorted = [...FILLER_WORDS].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    `\\b(${sorted.map(escapeRegex).join('|')})\\b[,.]?`,
    'gi',
  )

  return text
    .replace(pattern, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.?!])/g, '$1')
    .trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ============================================================
// Main transcription function (v5 API)
// ============================================================

export async function transcribeAudioFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`)
  }

  const audioStream = fs.createReadStream(filePath)

  const response = await deepgram.listen.v1.media.transcribeFile(audioStream, {
    model: 'nova-3',
    diarize: true,
    punctuate: true,
    utterances: true,
    smart_format: true,
    filler_words: true,
  })

  return response
}

// ============================================================
// Parser: Deepgram response → clean utterances
// ============================================================

export function extractUtterances(deepgramResult: any): ParsedUtterance[] {
  const utterances = deepgramResult?.results?.utterances

  if (!utterances || !Array.isArray(utterances)) {
    throw new Error(
      'No utterances in Deepgram response — was diarize+utterances set?',
    )
  }

  return utterances.map((u: any) => {
    const raw = u.transcript ?? ''
    return {
      speaker: `Speaker ${u.speaker ?? 0}`,
      content_raw: raw,
      content_clean: stripFillerWords(raw),
      sentence_start_sec: u.start ?? 0,
    }
  })
}

export function utterancesToTranscriptRows(
  utterances: ParsedUtterance[],
  recordingId: string,
): NewTranscriptRow[] {
  return utterances.map((u) => ({
    recording_id: recordingId,
    speaker: u.speaker,
    content_raw: u.content_raw,
    content_clean: u.content_clean,
    sentence_start_sec: u.sentence_start_sec,
    sequence_index: null, 
  }))
}


import { insertTranscriptRows } from './supabase'

/**
 * High-level convenience: convert utterances + write them to the transcript
 * table in one call. Used by /api/transcribe.
 */
export async function writeTranscriptForRecording(
  recordingId: string,
  utterances: ParsedUtterance[],
) {
  const rows = utterancesToTranscriptRows(utterances, recordingId)
  return insertTranscriptRows(rows)
}