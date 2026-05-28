import { DeepgramClient } from '@deepgram/sdk'
import type { ListenV1Response } from '@deepgram/sdk'

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY! })

export type DeepgramUtterance = {
  speaker: number          // 0, 1, 2... — Deepgram's speaker index
  transcript: string       // raw text, filler words intact
  start: number            // utterance start time in seconds
  end: number              // utterance end time in seconds
}

/**
 * Transcribes a local audio file using Deepgram batch (pre-recorded) API.
 * Returns utterances — sentence-level segments with speaker labels and timestamps.
 *
 * Why utterances and not words?
 *   - utterances=true groups words into sentence-level chunks per speaker
 *   - Each utterance maps to one row in the transcript table
 *   - Word-level timestamps are not needed for this pipeline
 */
export async function transcribeFile(filePath: string): Promise<DeepgramUtterance[]> {
  const response = await deepgram.listen.v1.media.transcribeFile(
    { path: filePath },
    {
      model: 'nova-3',       // best accuracy for English
      diarize: true,         // required: identifies and labels speakers
      punctuate: true,       // adds sentence-ending punctuation
      utterances: true,      // required: groups words into speaker-labeled segments
      smart_format: true,    // formats numbers, currencies, dates (useful for sales calls)
      // filler_words: false  // default — filler words (um, uh) are kept in output
                              // we strip them ourselves in Step 5 to produce content_clean
    }
  ) as ListenV1Response

  const utterances = response?.results?.utterances
  if (!utterances || utterances.length === 0) {
    throw new Error(
      'Deepgram returned no utterances. Verify diarize=true and utterances=true are set, and that the audio file has audible speech.'
    )
  }

  return utterances.map(u => ({
    speaker: u.speaker ?? 0,
    transcript: u.transcript ?? '',
    start: u.start ?? 0,
    end: u.end ?? 0,
  }))
}

// ---------------------------------------------------------------------------
// 5.3 Add filler word stripping to lib/deepgram.ts
// ---------------------------------------------------------------------------

// Matches filler words as whole words only, including any trailing comma and space.
// content_raw keeps these intact (sent to LLM — signals hesitation).
// content_clean strips them (displayed in UI).
// Note: only predictable, unambiguous fillers are listed here (um, uh, hmm).
// Context-dependent words (like, basically, right, actually) are intentionally
// excluded — regex cannot distinguish filler use from meaningful use.
// Production upgrade: let the Step 7 LLM correction pass own content_clean instead.
const FILLER_PATTERN = /\b(um+|uh+|hmm+|mhm|uh-huh)\b[,]?\s*/gi

export function stripFillerWords(text: string): string {
  return text
    .replace(FILLER_PATTERN, '')
    .replace(/\s{2,}/g, ' ')   // collapse any double spaces left behind
    .trim()
}