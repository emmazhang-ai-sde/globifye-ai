import { ChatGroq } from '@langchain/groq'
// To swap providers later, change the import + model class:
//   import { ChatAnthropic } from '@langchain/anthropic'
//   import { ChatOpenAI } from '@langchain/openai'

import { z } from 'zod'
import { supabaseAdmin } from './supabase'

// ============================================================
// 1. LLM client
// ============================================================

const model = new ChatGroq({
  model: 'llama-3.3-70b-versatile',  // good structured-output performance
  apiKey: process.env.GROQ_API_KEY!,
  temperature: 0,                     // deterministic — same input ≈ same output
})

// ============================================================
// 2. Zod output schema
//    The .describe() hints get sent to the LLM as field instructions.
// ============================================================

const KeyTopicSchema = z.object({
  name: z.string().describe('Short topic name, e.g. "Pricing Discussion"'),
  start_time: z
    .number()
    .describe('Timestamp in seconds — must match a [Xs] label in the transcript exactly'),
})

const ObjectionSchema = z.object({
  timestamp: z.number().describe('Timestamp in seconds — must match a [Xs] label exactly'),
  speaker: z.string().describe('Speaker label exactly as it appears, e.g. "Speaker 1"'),
  exact_quote: z
    .string()
    .describe('Verbatim text from the transcript, character-for-character including filler words'),
  reason: z.string().describe('Why the customer was unwilling to commit at this moment'),
  suggestion: z
    .string()
    .describe(
      'Specific, actionable improvement tied to this objection — not generic advice',
    ),
})

const WhatWentWellSchema = z.object({
  timestamp: z.number().describe('Timestamp in seconds — must match a [Xs] label exactly'),
  speaker: z.string().describe('Speaker label exactly as it appears'),
  exact_quote: z.string().describe('Verbatim text from the transcript, character-for-character'),
  reason: z.string().describe('Why this moment contributed positively to the call'),
})

const AnalysisSchema = z.object({
  summary: z.string().describe('2–3 sentence overview of the call'),
  key_topics: z
    .array(KeyTopicSchema)
    .describe('Major discussion topics with their start times for navigation'),
  analysis: z.object({
    objections: z
      .array(ObjectionSchema)
      .describe('Customer objections — empty array if none genuinely exist'),
    what_went_well: z
      .array(WhatWentWellSchema)
      .describe('Positive sales behaviors — empty array if nothing notable'),
  }),
})

// ============================================================
// 3. Transcript assembly
// ============================================================

type TranscriptRow = {
  speaker: string
  sentence_start_sec: number
  content_raw: string
}

function buildTranscriptText(rows: TranscriptRow[]): string {
  return rows
    .map(
      (r) =>
        `[${Number(r.sentence_start_sec).toFixed(1)}s] ${r.speaker}: ${r.content_raw}`,
    )
    .join('\n')
}

// ============================================================
// 4. System prompt (from Step 6)
// ============================================================

const SYSTEM_PROMPT = `You are a sales coach giving actionable feedback to the sales rep on a recorded customer call.

You will receive a timestamped transcript in this format:
[Xs] Speaker_Label: utterance text

Each line is one utterance. The number in brackets is the time in seconds when the utterance started. "Speaker 0" and "Speaker 1" are unlabeled speaker identifiers — infer which is the sales rep and which is the customer from context (e.g., the rep typically introduces themselves, describes the product, or asks discovery questions).

Rules:

Timestamps:
- Every timestamp you emit (start_time, timestamp) must be the exact number from a [Xs] label in the transcript. Do not interpolate or invent values.

Exact quotes:
- Every exact_quote must be copied character-for-character from the transcript, including filler words like "um" and "uh". Do not paraphrase, clean up, or summarize.

Speaker field:
- Use the same "Speaker 0" / "Speaker 1" labels exactly as they appear in the transcript.

Objections:
- An objection is a moment where the customer expresses hesitation, resistance, or a blocker to closing. Common types: budget/price, timeline, trust/credibility, internal approval, competitor preference, feature fit.
- Only flag genuine objections raised by the customer. Do not flag agreement, acknowledgement, or neutral questions.
- For each objection, identify the reason (what specifically the customer was unwilling to commit to) and a concrete, actionable suggestion tied to this exact moment.
- Suggestions must be specific to this conversation. Do not write generic advice like "build more rapport" or "provide references." Tie the suggestion to what was said.

What went well:
- Flag specific sales behaviors that contributed positively — strong discovery questions, clear value statements, active listening, well-handled pushback.
- Do not flag generic politeness ("said hello professionally", "thanked the customer").

Empty arrays:
- If there are no genuine objections, return an empty objections array. If nothing notable went well, return an empty what_went_well array. Do not invent entries to fill space.

Summary:
- 2–3 sentences capturing the substance: what was discussed, the customer's main concerns, where it ended up.`

// ============================================================
// 5. Core analysis function
// ============================================================

export async function analyzeTranscript(recordingId: string) {
  // Fetch transcript rows for this recording, ordered chronologically
  const { data: rows, error } = await supabaseAdmin
    .from('transcript')
    .select('speaker, sentence_start_sec, content_raw')
    .eq('recording_id', recordingId)
    .order('sentence_start_sec', { ascending: true })

  if (error) throw new Error(`Failed to fetch transcript: ${error.message}`)
  if (!rows || rows.length === 0) {
    throw new Error(`No transcript rows found for recording ${recordingId}`)
  }

  const transcriptText = buildTranscriptText(rows as TranscriptRow[])

  // Bind the schema to the model — LangChain handles the function-calling spec
  const structuredModel = model.withStructuredOutput(AnalysisSchema, {
    includeRaw: true,  // returns both parsed object and raw response
    name: 'sales_call_analysis',
  })

  const response = await structuredModel.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Analyze the following sales call transcript:\n\n${transcriptText}`,
    },
  ])

  return {
    parsed: response.parsed,
    rawOutput: response.raw?.content ?? '',
  }
}

// ============================================================
// 6. Write to analysis table
// ============================================================

export async function writeAnalysis(recordingId: string) {
  const { parsed, rawOutput } = await analyzeTranscript(recordingId)

  // Note the field-name mapping: LLM nests inside `analysis`,
  // DB has flat columns `objection_analysis` and `what_went_well`.
  const { data, error } = await supabaseAdmin
    .from('analysis')
    .insert({
      recording_id: recordingId,
      summary: parsed.summary,
      key_topics: parsed.key_topics,
      objection_analysis: parsed.analysis.objections,
      what_went_well: parsed.analysis.what_went_well,
      raw_llm_output:
        typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput),
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to insert analysis: ${error.message}`)
  return data
}