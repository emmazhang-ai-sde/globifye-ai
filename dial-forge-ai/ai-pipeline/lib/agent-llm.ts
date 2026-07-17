// Step 13.1 — Real-time agent LLM (Groq, llama-3.1-8b-instant)
// Kept separate from lib/llm.ts (post-call analysis) because speed matters
// more than depth here — 8B instant beats 70B versatile for 1-2 sentence replies.

type Message = { role: 'user' | 'assistant'; content: string }

const SYSTEM_PROMPT = `You are an AI sales agent on a live call. Respond in 1–2 sentences only. Be concise, conversational, and helpful. Your goal is to advance the sales conversation and handle objections naturally.`

export async function callAgent(utterance: string, history: Message[]): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: utterance },
      ],
      max_tokens: 150,
      temperature: 0.7,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Groq agent error ${res.status}: ${text}`)
  }

  const data = await res.json()
  return (data.choices[0].message.content as string).trim()
}
