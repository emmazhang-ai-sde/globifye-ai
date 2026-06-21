import { NextResponse } from 'next/server'
import { streamAgentResponse, type ConversationMessage } from '@/lib/agent-llm'
import { textToSpeechStream } from '@/lib/tts'

// ============================================================
// Route config
// ============================================================

// ElevenLabs can take up to 10s for long text — tell Vercel to wait
export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const { utterance, history } = (await req.json()) as {
      utterance: string
      history: ConversationMessage[]
    }

    if (!utterance?.trim()) {
      return NextResponse.json({ error: 'utterance is required' }, { status: 400 })
    }

    // ----------------------------------------------------------------
    // 1. Stream LLM response, accumulate into sentences
    // ----------------------------------------------------------------
    const textStream = await streamAgentResponse(utterance, history ?? [])

    let fullResponseText = ''
    let sentenceBuffer = ''
    const audioChunks: Uint8Array[] = []

    // ----------------------------------------------------------------
    // 2. For each LLM chunk, accumulate into sentence buffer
    //    Flush to ElevenLabs at sentence boundaries or 120 chars
    // ----------------------------------------------------------------
    for await (const chunk of textStream) {
      fullResponseText += chunk
      sentenceBuffer += chunk

      const shouldFlush =
        /[.?!]/.test(sentenceBuffer) ||   // hit a sentence boundary
        sentenceBuffer.length > 100       // or buffer is getting long

      if (shouldFlush && sentenceBuffer.trim().length > 0) {
        // Send this sentence-chunk to ElevenLabs immediately
        const audioStream = await textToSpeechStream(sentenceBuffer.trim())

        // Collect audio chunks from this TTS call
        const reader = audioStream.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) audioChunks.push(value)
        }

        sentenceBuffer = ''   // reset buffer
      }
    }

    // ----------------------------------------------------------------
    // 3. Flush any remaining text in the buffer
    // ----------------------------------------------------------------
    if (sentenceBuffer.trim().length > 0) {
      const audioStream = await textToSpeechStream(sentenceBuffer.trim())
      const reader = audioStream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) audioChunks.push(value)
      }
    }

    // ----------------------------------------------------------------
    // 4. Combine all audio chunks into a single buffer
    // ----------------------------------------------------------------
    const totalLength = audioChunks.reduce((acc, c) => acc + c.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of audioChunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }

    // ----------------------------------------------------------------
    // 5. Return audio + text (text goes in header for browser to read)
    // ----------------------------------------------------------------
    return new Response(combined, {
      headers: {
        'Content-Type': 'audio/mpeg',
        // Send full text in header so browser can update conversation history
        // without a second fetch. encodeURIComponent handles non-ASCII chars.
        'X-Agent-Response-Text': encodeURIComponent(fullResponseText),
        // Allow browser to read this custom header
        'Access-Control-Expose-Headers': 'X-Agent-Response-Text',
      },
    })
  } catch (err) {
    console.error('[agent/respond] error:', err)
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  }
}