import Groq from 'groq-sdk'

// ============================================================
// Groq client — same API key as lib/llm.ts, different model
// ============================================================

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
})

// llama-3.1-8b-instant: ~100-150ms TTFT, good for 1-2 sentence replies
// Switch to llama-3.3-70b-versatile only if quality is noticeably poor
const AGENT_MODEL = 'llama-3.1-8b-instant' 

// ============================================================
// System prompt — what the AI agent IS
// ============================================================
// This is hardcoded for now. Future: load from per-customer config
// so each GlobiFYE customer can define their own agent persona + script.

const AGENT_SYSTEM_PROMPT = `You are a professional sales representative on a live call. 
Listen carefully to the prospect and respond naturally and concisely, \


Your goals:
- Understand what products they're interested in and their preferences
- Explain GlobiFYE's counseling service clearly and concisely
- Handle objections about price, timeline, or fit with empathy and specifics
- Move toward booking a follow-up consultation call

Rules:
- Reply with ONE sentence, maximum 15 words. You are speaking out loud.
- Sound natural and human, not like a script.
- Never make up specific statistics or guarantees you can't back up.
- If you don't know something, say "let me follow up on that for you."
- Do not repeat what the prospect just said back to them verbatim.`

// ============================================================
// Types
// ============================================================

export type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

// ============================================================
// Main export
// ============================================================

/**
 * Stream the agent's response to a prospect utterance.
 * Returns an async iterable of text chunks — caller is responsible
 * for accumulating into sentences before sending to TTS.
 */
export async function streamAgentResponse(
  utterance: string,
  history: ConversationMessage[],
): Promise<AsyncIterable<string>> {
  const messages = [
    { role: 'system' as const, content: AGENT_SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: utterance },
  ]

  const stream = await groq.chat.completions.create({
    model: AGENT_MODEL,
    messages,
    stream: true,
    max_tokens: 150,      // keep responses short — this is spoken dialogue
    temperature: 0.7,     // some variation so it doesn't sound robotic
  })

  // Return an async generator that yields text chunks
  return (async function* () {
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? ''
      if (text) yield text
    }
  })()
}