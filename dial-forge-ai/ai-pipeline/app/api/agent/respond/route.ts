// Step 13.3 — Agent respond endpoint
// POST { utterance, history } → audio/mpeg + X-Agent-Response-Text header
// Keys stay server-side — GROQ_API_KEY and ELEVENLABS_API_KEY never reach the browser.

import { NextResponse } from 'next/server'
import { callAgent } from '@/lib/agent-llm'
import { synthesizeSpeech } from '@/lib/tts'

export async function POST(req: Request) {
  try {
    const { utterance, history = [] } = await req.json()
    if (!utterance) return NextResponse.json({ error: 'utterance required' }, { status: 400 })
    if (!process.env.ELEVENLABS_API_KEY) {
      return NextResponse.json({ error: 'ELEVENLABS_API_KEY not set' }, { status: 503 })
    }

    const agentText  = await callAgent(utterance, history)
    const audioBuffer = await synthesizeSpeech(agentText)

    return new Response(new Uint8Array(audioBuffer), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-Agent-Response-Text': encodeURIComponent(agentText),
      },
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
