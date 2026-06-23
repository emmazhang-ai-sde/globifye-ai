import { NextResponse } from 'next/server'
import { streamAgentResponse, type ConversationMessage } from '@/lib/agent-llm'
import { textToSpeechStream } from '@/lib/tts'

// ============================================================
// Route config
// ============================================================

// ElevenLabs can take up to 10s for long text — tell Vercel to wait

// ============================================================
// Route config — Kokoro runs locally; the first request also
// loads the model, so keep a generous ceiling.
// ============================================================
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
    // 1. Stream the LLM response, accumulate the full reply text.
    //    Replies are 1–2 sentences, so we synthesize the whole thing
    //    in ONE Kokoro call — concatenated WAV files are not valid WAV.
    // ----------------------------------------------------------------
    const textStream = await streamAgentResponse(utterance, history ?? [])
    let fullResponseText = ''
    for await (const chunk of textStream) {
      fullResponseText += chunk
    }

    if (!fullResponseText.trim()) {
      return NextResponse.json({ error: 'empty agent response' }, { status: 500 })
    }

    // ----------------------------------------------------------------
    // 2. One TTS call → one valid WAV.
    // ----------------------------------------------------------------
    const audioStream = await textToSpeechStream(fullResponseText.trim())
    const audioChunks: Uint8Array[] = []
    const reader = audioStream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) audioChunks.push(value)
    }

    const totalLength = audioChunks.reduce((acc, c) => acc + c.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of audioChunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }

    // ----------------------------------------------------------------
    // 3. Return audio + text (text in header so the browser updates
    //    conversation history without a second fetch).
    // ----------------------------------------------------------------
    return new Response(combined, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-Agent-Response-Text': encodeURIComponent(fullResponseText),
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