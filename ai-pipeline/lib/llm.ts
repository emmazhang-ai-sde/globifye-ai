import { ChatGroq } from '@langchain/groq'
// Switch provider by swapping these two lines — everything below stays identical
// import { ChatAnthropic } from '@langchain/anthropic'
// import { ChatOpenAI } from '@langchain/openai'

import { z } from 'zod'
import { supabaseAdmin } from './supabase'

// ---------------------------------------------------------------------------
// LLM client — demo uses Groq (free tier, no credit card)
// ---------------------------------------------------------------------------

const model = new ChatGroq({
  model: 'llama-3.3-70b-versatile',
  apiKey: process.env.GROQ_API_KEY!,
})

// Production alternatives (swap the import above and uncomment one of these):
// const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY! })
// const model = new ChatOpenAI({ model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! })

// ---------------------------------------------------------------------------
// Output schema — LangChain enforces this shape via Zod, no manual JSON.parse needed
// ---------------------------------------------------------------------------

const AnalysisSchema = z.object({
  summary: z.string().describe('2-3 sentence overview of the call'),
  key_topics: z.array(
    z.object({
      name: z.string().describe('Topic name'),
      start_time: z.number().describe('Start timestamp in seconds — use the [Xs] label of the first relevant line'),
      end_time: z.number().describe('End timestamp in seconds — use the [Xs] label of the last relevant line for this topic'),
    })
  ),
  analysis: z.object({
    objections: z.array(
      z.object({
        timestamp: z.number().describe('Timestamp in seconds from the transcript'),
        speaker: z.string().describe('Speaker label from the transcript'),
        exact_quote: z.string().describe('Verbatim quote copied character-for-character from the transcript'),
        reason: z.string().describe('Why this is an objection or hesitation'),
        suggestion: z.string().describe('Specific, actionable coaching advice for the sales rep'),
      })
    ).describe('Empty array [] if there are no objections'),
    what_went_well: z.array(
      z.object({
        timestamp: z.number().describe('Timestamp in seconds from the transcript'),
        speaker: z.string().describe('Speaker label from the transcript'),
        exact_quote: z.string().describe('Verbatim quote copied character-for-character from the transcript'),
        reason: z.string().describe('Why this behavior was effective'),
      })
    ).describe('Empty array [] if nothing notable'),
  }),
})

type Analysis = z.infer<typeof AnalysisSchema>

// ---------------------------------------------------------------------------
// Transcript assembly
// ---------------------------------------------------------------------------

type TranscriptRow = {
  speaker: string
  sentence_start_sec: number
  content_raw: string
}

function buildTranscriptText(rows: TranscriptRow[]): string {
  return rows
    .map(r => `[${Number(r.sentence_start_sec).toFixed(1)}s] ${r.speaker}: ${r.content_raw}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a sales coach reviewing a recorded sales call to give the sales representative specific, actionable feedback.

Each transcript line is formatted as:
[seconds] Speaker_Label: utterance

Identify which speaker is the sales representative and which is the customer from context — the rep typically opens the call, asks discovery questions, and proposes solutions.

Rules:
- timestamp: use the exact number from the [Xs] label at the start of the relevant line. Do not interpolate between lines.
- exact_quote: copy character-for-character from the transcript, including filler words. Do not paraphrase, summarize, or truncate.
- objections: flag moments where the customer expresses budget concern, timeline pressure, trust doubts, need for internal approval, competitor preference, or any hesitation that could prevent or delay closing.
- what_went_well: flag specific behaviors — active listening, handling objections with concrete solutions, building rapport, advancing the deal. Do not flag generic politeness.
- suggestion: must be specific and actionable. Reference the customer's actual words where possible. Do not write generic advice such as "be more confident" or "follow up more".
- Return an empty array [] if no genuine objections or notable moments exist — do not invent entries.`

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function analyzeTranscript(recordingId: string) {
  const { data: rows, error } = await supabaseAdmin
    .from('transcript')
    .select('speaker, sentence_start_sec, content_raw')
    .eq('recording_id', recordingId)
    .order('sentence_start_sec', { ascending: true })

  if (error) throw new Error(`DB fetch failed: ${error.message}`)
  if (!rows || rows.length === 0) throw new Error(`No transcript rows found for recording_id: ${recordingId}`)

  const transcriptText = buildTranscriptText(rows)

  // includeRaw: true preserves the raw LLM response for the raw_llm_output DB field
  const structuredModel = model.withStructuredOutput(AnalysisSchema, { includeRaw: true })

  const { raw, parsed } = await structuredModel.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Analyze the following sales call transcript:\n\n${transcriptText}` },
  ])

  const rawOutput = typeof raw.content === 'string'
    ? raw.content
    : JSON.stringify(raw.content)

  return { parsed, rawOutput }
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

export async function writeAnalysis(recordingId: string) {
  const { parsed, rawOutput } = await analyzeTranscript(recordingId)

  // LLM returns: analysis.objections + analysis.what_went_well
  // DB columns:  objection_analysis + what_went_well
  const { data, error } = await supabaseAdmin
    .from('analysis')
    .insert({
      recording_id:       recordingId,
      summary:            parsed.summary,
      key_topics:         parsed.key_topics,
      objection_analysis: parsed.analysis.objections,
      what_went_well:     parsed.analysis.what_went_well,
      raw_llm_output:     rawOutput,
    })
    .select()
    .single()

  if (error) throw new Error(`DB insert failed: ${error.message}`)
  return data
}
