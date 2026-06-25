/**
 * test-loop-audio.ts — Full-loop test with STREAMING STT (production-accurate).
 *
 * Per turn:
 *   1. Decode test-audio/test-audio-N.* to raw PCM via ffmpeg
 *   2. Open Deepgram streaming WebSocket (same one the live UI uses)
 *   3. Stream PCM chunks paced at real-time (simulating a live mic)
 *   4. Measure ENDPOINTING LATENCY: wall-clock gap between the last word
 *      ending in audio time and `speech_final` firing.
 *      → This is the STT contribution a real caller experiences.
 *   5. Feed transcript + history to LLM → reply text
 *   6. ElevenLabs TTS (non-streaming MP3) → audio bytes (timed TTFB + total)
 *
 * Loop latency = streaming STT endpointing + LLM + TTS
 *   - Loop to first byte:  STT endpointing + LLM + TTS TTFB
 *   - Loop full clip ready: STT endpointing + LLM + TTS total
 *
 * Requirements:
 *   - ffmpeg in PATH       (brew install ffmpeg)
 *   - Node ≥ 22            (native WebSocket)
 *   - DEEPGRAM_API_KEY in .env.local
 *
 * Place at: ai-pipeline/scripts/test-loop-audio.ts
 * Run:      npx tsx --env-file=.env.local scripts/test-loop-audio.ts
 */

import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { streamAgentResponse, type ConversationMessage } from '../lib/agent-llm'
import { synthesizeSpeech } from '../lib/tts'

// =====================================================================
// Config
// =====================================================================

const SAMPLES_DIR = join(process.cwd(), 'test-audio')
const NUM_TURNS = 5
const LATENCY_BUDGET_MS = 1500
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY

// Streaming STT config — matches Deepgram defaults used by the live UI.
const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2 // 16-bit linear PCM
const CHUNK_MS = 100       // send 100ms of audio every 100ms (real-time pace)
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000
const ENDPOINTING_MS = 300 // Deepgram's silence threshold for speech_final

if (!DEEPGRAM_KEY) {
  console.error('Missing DEEPGRAM_API_KEY. Run with: npx tsx --env-file=.env.local ...')
  process.exit(1)
}
if (!existsSync(SAMPLES_DIR)) {
  console.error(`Samples dir not found: ${SAMPLES_DIR}`)
  process.exit(1)
}

// ffmpeg sanity check — fail loudly upfront, not mid-warmup
const ffCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
if (ffCheck.status !== 0) {
  console.error('ffmpeg not found in PATH. Install with: brew install ffmpeg')
  process.exit(1)
}

// =====================================================================
// Helpers
// =====================================================================

const ms = (n: number) => `${n.toFixed(0)}ms`
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n))

function findAudioFile(turn: number): string {
  const files = readdirSync(SAMPLES_DIR)
  const match = files.find(
    (f) => f === `test-audio-${turn}` || f.startsWith(`test-audio-${turn}.`),
  )
  if (!match) {
    throw new Error(`No audio file for turn ${turn} in ${SAMPLES_DIR}`)
  }
  return join(SAMPLES_DIR, match)
}

/** Decode any audio file to raw PCM 16-bit mono @16kHz via ffmpeg. */
function decodeToPcm(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', filePath,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-hide_banner',
      '-loglevel', 'error',
      '-',
    ])
    const chunks: Buffer[] = []
    let stderr = ''
    ff.stdout.on('data', (c: Buffer) => chunks.push(c))
    ff.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg failed (${code}): ${stderr}`))
    })
    ff.on('error', reject)
  })
}

// =====================================================================
// Stage runners
// =====================================================================

type StreamingSTTResult = {
  transcript: string
  endpointingMs: number     // wall-clock gap from end-of-last-word to speech_final
  audioDurationMs: number   // length of the recording
  lastWordEndSec: number    // where speech ended within the audio (for sanity)
}

/**
 * Stream the file through Deepgram's WebSocket at real-time pace.
 * Measures the production-accurate STT contribution to user latency.
 */
async function runStreamingSTT(filePath: string): Promise<StreamingSTTResult> {
  const pcm = await decodeToPcm(filePath)
  const audioDurationMs = (pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000

  const url =
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-3` +
    `&language=en-US` +
    `&encoding=linear16` +
    `&sample_rate=${SAMPLE_RATE}` +
    `&channels=1` +
    `&interim_results=true` +
    `&punctuate=true` +
    `&smart_format=true` +
    `&endpointing=${ENDPOINTING_MS}`

  // Deepgram uses subprotocol-based auth — same shape the browser uses.
  const ws = new WebSocket(url, ['token', DEEPGRAM_KEY!])

  let transcript = ''
  let lastWordEndSec = 0
  let streamStartAt = -1
  let resolved = false

  return new Promise<StreamingSTTResult>((resolve, reject) => {
    const timeoutMs = audioDurationMs + 5000
    const timeoutId = setTimeout(() => {
      if (resolved) return
      resolved = true
      try { ws.close() } catch {}
      reject(
        new Error(
          `STT timeout after ${ms(timeoutMs)} — speech_final never fired. ` +
            `Does this recording have trailing silence?`,
        ),
      )
    }, timeoutMs)

    ws.addEventListener('open', async () => {
      try {
        streamStartAt = performance.now()
        // Stream chunks at real-time pace — simulating a live mic
        for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
          if (resolved) break // speech_final already fired during streaming; stop early
          const end = Math.min(i + CHUNK_BYTES, pcm.length)
          const chunk = pcm.subarray(i, end)
          ws.send(new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength))
          if (end < pcm.length) await sleep(CHUNK_MS)
        }
      } catch (err) {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutId)
          try { ws.close() } catch {}
          reject(err)
        }
      }
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data.toString())
        const alt = msg.channel?.alternatives?.[0]
        const text: string = alt?.transcript ?? ''

        if (msg.is_final && text) {
          transcript += (transcript ? ' ' : '') + text
          const words = alt.words ?? []
          if (words.length > 0) {
            lastWordEndSec = Math.max(lastWordEndSec, words[words.length - 1].end)
          }
        }

        if (msg.speech_final && !resolved) {
          resolved = true
          clearTimeout(timeoutId)

          const speechFinalAt = performance.now()
          const totalWallMs = speechFinalAt - streamStartAt
          // Endpointing = wall-clock elapsed since end-of-last-word (in audio time)
          const endpointingMs = Math.max(0, totalWallMs - lastWordEndSec * 1000)

          try { ws.close() } catch {}
          resolve({
            transcript: transcript.trim(),
            endpointingMs,
            audioDurationMs,
            lastWordEndSec,
          })
        }
      } catch (err) {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutId)
          try { ws.close() } catch {}
          reject(err)
        }
      }
    })

    ws.addEventListener('error', () => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutId)
      reject(new Error('Deepgram WebSocket error'))
    })
  })
}

async function runLLM(utterance: string, history: ConversationMessage[]) {
  const t0 = performance.now()
  let ttftMs = -1
  let text = ''
  const stream = await streamAgentResponse(utterance, history)
  for await (const chunk of stream) {
    if (ttftMs < 0) ttftMs = performance.now() - t0
    text += chunk
  }
  return {
    text: text.trim(),
    ttftMs: ttftMs < 0 ? 0 : ttftMs,
    totalMs: performance.now() - t0,
  }
}

async function runTTS(text: string) {
  const t0 = performance.now()
  // ElevenLabs synthesizeSpeech() is non-streaming — the whole MP3 arrives
  // in one buffer, so TTFB and total latency are the same here.
  const buf = await synthesizeSpeech(text)
  const totalMs = performance.now() - t0
  return {
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    ttfbMs: totalMs,
    totalMs,
  }
}

async function runParallelLLMTTS(utterance: string, history: ConversationMessage[]) {
  const t0 = performance.now()
  let ttfbMs = -1       // time to first audio byte (from first sentence TTS)
  let llmTtftMs = -1
  let fullText = ''
  let sentenceBuffer = ''

  const sentenceResults: Uint8Array[] = []
  const sentencePromises: Promise<void>[] = []

  async function processSentence(text: string, index: number) {
    const buf = await synthesizeSpeech(text)
    if (ttfbMs < 0) ttfbMs = performance.now() - t0  // first sentence's full buffer arrives
    sentenceResults[index] = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  let sentenceIndex = 0
  const stream = await streamAgentResponse(utterance, history)

  for await (const chunk of stream) {
    if (llmTtftMs < 0) llmTtftMs = performance.now() - t0
    fullText += chunk
    sentenceBuffer += chunk

    const shouldFlush = /[.?!]/.test(sentenceBuffer) || sentenceBuffer.length > 120
    if (shouldFlush && sentenceBuffer.trim().length > 0) {
      const idx = sentenceIndex++
      sentencePromises.push(processSentence(sentenceBuffer.trim(), idx))
      sentenceBuffer = ''
    }
  }

  const llmDoneMs = performance.now() - t0

  if (sentenceBuffer.trim().length > 0) {
    sentencePromises.push(processSentence(sentenceBuffer.trim(), sentenceIndex++))
  }

  await Promise.all(sentencePromises)
  const totalMs = performance.now() - t0

  const allChunks = sentenceResults.filter(Boolean)
  const totalLen = allChunks.reduce((s, c) => s + c.length, 0)
  const bytes = new Uint8Array(totalLen)
  let off = 0
  for (const c of allChunks) { bytes.set(c, off); off += c.length }

  return {
    text: fullText.trim(),
    llmTtftMs: llmTtftMs < 0 ? 0 : llmTtftMs,
    llmDoneMs,
    ttfbMs: ttfbMs < 0 ? 0 : ttfbMs,
    totalMs,
    bytes,
    sentences: sentenceIndex,
  }
}

// =====================================================================
// Types
// =====================================================================

type TurnResult = {
  turn: number
  audioFile: string
  audioDurationMs: number
  sttTranscript: string
  sttEndpointingMs: number  // production-accurate STT contribution
  llmText: string
  llmChars: number
  llmTtftMs: number
  llmMs: number
  ttsTtfbMs: number
  ttsMs: number
  loopTtfbMs: number  // STT endpointing + LLM + TTS TTFB
  loopMs: number      // STT endpointing + LLM + TTS total
  responseBytes: number
  parallelTtfbMs: number   // STT endpointing + parallel TTFB
  parallelTotalMs: number  // STT endpointing + parallel total
  parallelSentences: number
}

// =====================================================================
// Main
// =====================================================================

async function main() {
  for (let n = 1; n <= NUM_TURNS; n++) findAudioFile(n)

  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const outDir = join(process.cwd(), 'benchmark-results', `full-loop-${stamp}`)
  const audioDir = join(outDir, 'audio')
  mkdirSync(audioDir, { recursive: true })

  console.log('='.repeat(70))
  console.log('Full-loop test (streaming STT)')
  console.log(`Samples dir: ${SAMPLES_DIR}`)
  console.log(`Turns: ${NUM_TURNS}   Budget: ${LATENCY_BUDGET_MS}ms`)
  console.log(`Deepgram endpointing: ${ENDPOINTING_MS}ms`)
  console.log('='.repeat(70))

  process.stdout.write('\nWarmup (LLM + TTS cold connect)... ')
  const warmT0 = performance.now()
  try {
    const w = await runLLM('Hello.', [])
    await runTTS(w.text || 'Hello.')
    console.log(`done in ${ms(performance.now() - warmT0)}\n`)
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`)
    process.exit(1)
  }

  const history: ConversationMessage[] = []
  const turns: TurnResult[] = []
  const transcriptLog: string[] = [
    `# Conversation transcript`,
    ``,
    `Started: ${startedAt.toISOString()}`,
    ``,
  ]

  for (let n = 1; n <= NUM_TURNS; n++) {
    console.log(`\n${'─'.repeat(70)}\nTURN ${n}`)
    const audioFile = findAudioFile(n)

    const stt = await runStreamingSTT(audioFile)
    console.log(
      `  STT: endpointing ${ms(stt.endpointingMs)} ` +
        `(audio ${(stt.audioDurationMs / 1000).toFixed(1)}s, ` +
        `last word at ${stt.lastWordEndSec.toFixed(2)}s)`,
    )
    console.log(`       "${stt.transcript}"`)
    if (!stt.transcript) {
      console.error(`  ⚠ Empty transcript — skipping turn.`)
      continue
    }

    const llm = await runLLM(stt.transcript, history)
    const tts = await runTTS(llm.text)
    const parallel = await runParallelLLMTTS(stt.transcript, history)

    const loopTtfbMs    = stt.endpointingMs + llm.totalMs + tts.ttfbMs
    const loopMs        = stt.endpointingMs + llm.totalMs + tts.totalMs
    const parallelTtfbMs  = stt.endpointingMs + parallel.ttfbMs
    const parallelTotalMs = stt.endpointingMs + parallel.totalMs

    const ttfbMark     = loopTtfbMs     <= LATENCY_BUDGET_MS ? '✓' : '✗'
    const totalMark    = loopMs         <= LATENCY_BUDGET_MS ? '✓' : '✗'
    const parTtfbMark  = parallelTtfbMs <= LATENCY_BUDGET_MS ? '✓' : '✗'
    const parTotalMark = parallelTotalMs <= LATENCY_BUDGET_MS ? '✓' : '✗'

    console.log(`  LLM (${ms(llm.totalMs)}, ttft ${ms(llm.ttftMs)}, ${llm.text.length} chars): "${llm.text}"`)
    console.log(`  TTS sequential: ttfb ${ms(tts.ttfbMs)}, total ${ms(tts.totalMs)}`)
    console.log(`  TTS parallel:   ttfb ${ms(parallel.ttfbMs)}, total ${ms(parallel.totalMs)}, ${parallel.sentences} sentences`)
    console.log(
    `  → Sequential  loop TTFB ${ms(loopTtfbMs)} ${ttfbMark}   total ${ms(loopMs)} ${totalMark}`,
    )
    console.log(
    `  → Parallel    loop TTFB ${ms(parallelTtfbMs)} ${parTtfbMark}   total ${ms(parallelTotalMs)} ${parTotalMark}   [budget ${LATENCY_BUDGET_MS}ms]`,
    )

    writeFileSync(join(audioDir, `turn-${n}-sequential.mp3`), tts.bytes)
    writeFileSync(join(audioDir, `turn-${n}-parallel.mp3`), parallel.bytes)

    transcriptLog.push(`## Turn ${n}`)
    transcriptLog.push(``)
    transcriptLog.push(`**Caller:** ${stt.transcript}`)
    transcriptLog.push(``)
    transcriptLog.push(`**Agent (sequential):** ${llm.text}`)
    transcriptLog.push(``)
    transcriptLog.push(`**Agent (parallel):** ${parallel.text}`)
    transcriptLog.push(``)
    transcriptLog.push(`*STT endpointing: ${ms(stt.endpointingMs)} | LLM: ${ms(llm.totalMs)} | Seq loop: ${ms(loopMs)} | Par loop: ${ms(parallelTotalMs)}*`)
    transcriptLog.push(``)
    transcriptLog.push(`---`)
    transcriptLog.push(``)

    turns.push({
      turn: n,
      audioFile: audioFile.split('/').pop()!,
      audioDurationMs: stt.audioDurationMs,
      sttTranscript: stt.transcript,
      sttEndpointingMs: stt.endpointingMs,
      llmText: llm.text,
      llmChars: llm.text.length,
      llmTtftMs: llm.ttftMs,
      llmMs: llm.totalMs,
      ttsTtfbMs: tts.ttfbMs,
      ttsMs: tts.totalMs,
      loopTtfbMs,
      loopMs,
      responseBytes: tts.bytes.length,
      parallelTtfbMs,
      parallelTotalMs,
      parallelSentences: parallel.sentences,
    })
  }

  if (turns.length === 0) {
    console.error('\nNo successful turns — aborting report.')
    process.exit(1)
  }

  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
  const max  = (a: number[]) => (a.length ? Math.max(...a) : 0)
  const min  = (a: number[]) => (a.length ? Math.min(...a) : 0)
  const agg  = (a: number[]) => ({ mean: mean(a), max: max(a), min: min(a) })

  const summary = {
    startedAt: startedAt.toISOString(),
    turnCount: turns.length,
    budgetMs: LATENCY_BUDGET_MS,
    endpointingParamMs: ENDPOINTING_MS,
    sttEndpointing: agg(turns.map((t) => t.sttEndpointingMs)),
    llm:            agg(turns.map((t) => t.llmMs)),
    ttsTtfb:        agg(turns.map((t) => t.ttsTtfbMs)),
    tts:            agg(turns.map((t) => t.ttsMs)),
    loopTtfb:       agg(turns.map((t) => t.loopTtfbMs)),
    loop:           agg(turns.map((t) => t.loopMs)),
    turnsTtfbWithinBudget: turns.filter((t) => t.loopTtfbMs <= LATENCY_BUDGET_MS).length,
    turnsLoopWithinBudget: turns.filter((t) => t.loopMs <= LATENCY_BUDGET_MS).length,
    parallelLoopTtfb: agg(turns.map((t) => t.parallelTtfbMs)),
    parallelLoop:     agg(turns.map((t) => t.parallelTotalMs)),
    parallelTurnsTtfbWithinBudget: turns.filter((t) => t.parallelTtfbMs <= LATENCY_BUDGET_MS).length,
    parallelTurnsLoopWithinBudget: turns.filter((t) => t.parallelTotalMs <= LATENCY_BUDGET_MS).length,
  }

  const ttfbPass = summary.loopTtfb.max <= LATENCY_BUDGET_MS
  const loopPass = summary.loop.max <= LATENCY_BUDGET_MS

  console.log('\n' + '='.repeat(70))
  console.log('SUMMARY')
  console.log('='.repeat(70))
  console.log(`STT endpointing  mean ${ms(summary.sttEndpointing.mean)}    max ${ms(summary.sttEndpointing.max)}`)
  console.log(`LLM              mean ${ms(summary.llm.mean)}    max ${ms(summary.llm.max)}`)
  console.log(`TTS TTFB         mean ${ms(summary.ttsTtfb.mean)}    max ${ms(summary.ttsTtfb.max)}`)
  console.log(`TTS total        mean ${ms(summary.tts.mean)}    max ${ms(summary.tts.max)}`)
  console.log(`Loop to first byte    mean ${ms(summary.loopTtfb.mean)}    max ${ms(summary.loopTtfb.max)}`)
  console.log(`Loop full clip ready  mean ${ms(summary.loop.mean)}    max ${ms(summary.loop.max)}`)
  console.log(
    `\nBudget ${LATENCY_BUDGET_MS}ms:` +
      `\n  Loop to first byte:   ${ttfbPass ? '✓ PASS' : '✗ FAIL'} ` +
      `(${summary.turnsTtfbWithinBudget}/${summary.turnCount} within, max ${ms(summary.loopTtfb.max)})` +
      `\n  Loop full clip ready: ${loopPass ? '✓ PASS' : '✗ FAIL'} ` +
      `(${summary.turnsLoopWithinBudget}/${summary.turnCount} within, max ${ms(summary.loop.max)})`,
  )

  writeFileSync(join(outDir, 'data.json'), JSON.stringify({ summary, turns }, null, 2))
  writeFileSync(join(outDir, 'transcripts.md'), transcriptLog.join('\n'))
  writeFileSync(join(outDir, 'report.md'), buildReport(summary, turns, ttfbPass, loopPass))

  console.log(`\nResults written to: ${outDir}`)
  console.log(`  report.md       — summary for humans`)
  console.log(`  data.json       — raw per-turn data`)
  console.log(`  transcripts.md  — full conversation`)
  console.log(`  audio/turn-N-response.mp3 — agent's spoken replies`)
}

function buildReport(s: any, turns: TurnResult[], ttfbPass: boolean, loopPass: boolean): string {
  let perTurn =
  '| # | STT endpoint | LLM (ttft, chars) | TTS TTFB | TTS total | **Seq TTFB** | **Seq total** | **Par TTFB** | **Par total** | Sentences |\n'
perTurn +=
  '|---|---|---|---|---|---|---|---|---|---|\n'
for (const t of turns) {
  const seqTtfbOk  = t.loopTtfbMs      <= s.budgetMs ? '✓' : '✗'
  const seqLoopOk  = t.loopMs          <= s.budgetMs ? '✓' : '✗'
  const parTtfbOk  = t.parallelTtfbMs  <= s.budgetMs ? '✓' : '✗'
  const parLoopOk  = t.parallelTotalMs <= s.budgetMs ? '✓' : '✗'
  perTurn +=
    `| ${t.turn} ` +
    `| ${t.sttEndpointingMs.toFixed(0)}ms ` +
    `| ${t.llmMs.toFixed(0)}ms (ttft ${t.llmTtftMs.toFixed(0)}ms, ${t.llmChars}c) ` +
    `| ${t.ttsTtfbMs.toFixed(0)}ms ` +
    `| ${t.ttsMs.toFixed(0)}ms ` +
    `| ${seqTtfbOk} **${t.loopTtfbMs.toFixed(0)}ms** ` +
    `| ${seqLoopOk} **${t.loopMs.toFixed(0)}ms** ` +
    `| ${parTtfbOk} **${t.parallelTtfbMs.toFixed(0)}ms** ` +
    `| ${parLoopOk} **${t.parallelTotalMs.toFixed(0)}ms** ` +
    `| ${t.parallelSentences} |\n`
}

  const parTtfbPass = s.parallelLoopTtfb.max <= s.budgetMs
  const parLoopPass = s.parallelLoop.max <= s.budgetMs

  const ttfbVerdict = ttfbPass
    ? `**✓ PASS** — every turn's time-to-first-audio came in under ${s.budgetMs}ms (max ${s.loopTtfb.max.toFixed(0)}ms).`
    : `**✗ FAIL** — ${s.turnCount - s.turnsTtfbWithinBudget}/${s.turnCount} turns exceeded ${s.budgetMs}ms to first audio byte (max ${s.loopTtfb.max.toFixed(0)}ms).`

  const loopVerdict = loopPass
    ? `**✓ PASS** — every turn's full audio response was ready under ${s.budgetMs}ms (max ${s.loop.max.toFixed(0)}ms).`
    : `**✗ FAIL** — ${s.turnCount - s.turnsLoopWithinBudget}/${s.turnCount} turns exceeded ${s.budgetMs}ms for full response (max ${s.loop.max.toFixed(0)}ms).`

  const parTtfbVerdict = parTtfbPass
    ? `**✓ PASS** — every turn's parallel time-to-first-audio came in under ${s.budgetMs}ms (max ${s.parallelLoopTtfb.max.toFixed(0)}ms).`
    : `**✗ FAIL** — ${s.turnCount - s.parallelTurnsTtfbWithinBudget}/${s.turnCount} turns exceeded ${s.budgetMs}ms to first audio byte in parallel (max ${s.parallelLoopTtfb.max.toFixed(0)}ms).`

  const parLoopVerdict = parLoopPass
    ? `**✓ PASS** — every turn's full parallel audio response was ready under ${s.budgetMs}ms (max ${s.parallelLoop.max.toFixed(0)}ms).`
    : `**✗ FAIL** — ${s.turnCount - s.parallelTurnsLoopWithinBudget}/${s.turnCount} turns exceeded ${s.budgetMs}ms for full parallel response (max ${s.parallelLoop.max.toFixed(0)}ms).`

  return `# Full-Loop Test Report (streaming STT)

**Date:** ${s.startedAt}
**Stack:** Deepgram Nova-3 streaming STT → Groq \`llama-3.1-8b-instant\` → ElevenLabs \`eleven_turbo_v2_5\` TTS
**Turns:** ${s.turnCount}
**Budget:** ${s.budgetMs}ms, from end of caller's speech to AI audio response
**Deepgram endpointing param:** ${s.endpointingParamMs}ms

## What "STT endpointing" measures

The audio files are streamed to Deepgram at real-time pace, mimicking a live phone call. The reported STT number is the **endpointing latency** — the wall-clock gap between the moment the prospect's last word ends (in audio time) and the moment Deepgram fires \`speech_final\`. This is the exact STT contribution to user-perceived latency that a real caller would experience.

## The two loop numbers

- **Loop to first byte** = STT endpointing + LLM + TTS-TTFB. Production-realistic if the agent's audio response is streamed to the browser.
- **Loop full clip ready** = STT endpointing + LLM + TTS-total. Today's reality, with the route buffering the full body before returning.

## Verdict against ${s.budgetMs}ms budget

### Sequential

**Loop to first byte:** ${ttfbVerdict}

**Loop full clip ready:** ${loopVerdict}

### Parallel

**Loop to first byte:** ${parTtfbVerdict}

**Loop full clip ready:** ${parLoopVerdict}

## Aggregate timings

| Stage | Mean | Min | Max |
|---|---|---|---|
| STT endpointing | ${s.sttEndpointing.mean.toFixed(0)}ms | ${s.sttEndpointing.min.toFixed(0)}ms | ${s.sttEndpointing.max.toFixed(0)}ms |
| LLM | ${s.llm.mean.toFixed(0)}ms | ${s.llm.min.toFixed(0)}ms | ${s.llm.max.toFixed(0)}ms |
| TTS TTFB (sequential) | ${s.ttsTtfb.mean.toFixed(0)}ms | ${s.ttsTtfb.min.toFixed(0)}ms | ${s.ttsTtfb.max.toFixed(0)}ms |
| TTS total (sequential) | ${s.tts.mean.toFixed(0)}ms | ${s.tts.min.toFixed(0)}ms | ${s.tts.max.toFixed(0)}ms |
| **Sequential loop TTFB** | **${s.loopTtfb.mean.toFixed(0)}ms** | **${s.loopTtfb.min.toFixed(0)}ms** | **${s.loopTtfb.max.toFixed(0)}ms** |
| **Sequential loop total** | **${s.loop.mean.toFixed(0)}ms** | **${s.loop.min.toFixed(0)}ms** | **${s.loop.max.toFixed(0)}ms** |
| **Parallel loop TTFB** | **${s.parallelLoopTtfb.mean.toFixed(0)}ms** | **${s.parallelLoopTtfb.min.toFixed(0)}ms** | **${s.parallelLoopTtfb.max.toFixed(0)}ms** |
| **Parallel loop total** | **${s.parallelLoop.mean.toFixed(0)}ms** | **${s.parallelLoop.min.toFixed(0)}ms** | **${s.parallelLoop.max.toFixed(0)}ms** |
## Per-turn breakdown

${perTurn}

See \`transcripts.md\` for the full conversation and \`audio/turn-N-response.mp3\` for the agent's spoken replies.

## Notes

- **Cold start excluded.** First-call LLM and TTS warmup costs are paid in a discarded warmup pass.
- **Single conversation.** Rerun for statistical confidence.
- **Endpointing param** is set to ${s.endpointingParamMs}ms; raising it reduces false-positive end-of-speech detection but adds latency.
- **LLM reply length** drives TTS total. If "first byte" passes but "full clip ready" fails, the fixes are (a) tighten the system prompt for shorter replies, or (b) stream audio out of the route so the user starts hearing it after TTFB instead of after the full clip.
`
}

main().catch((err) => {
  console.error('Test crashed:', err)
  process.exit(1)
})