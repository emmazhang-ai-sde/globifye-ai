// lib/agent-llm.ts
//
// LangChain-based agent LLM call. The exported function signature is
// IDENTICAL to the previous groq-sdk version so callers (route + test
// script) don't change. Underneath, we now have:
//
//   ChatPromptTemplate ─→ ChatGroq ─→ StringOutputParser
//
// Why this matters even though behavior is unchanged today:
//   - Prompt is a structured, versioned template (easy to swap/test)
//   - History flows through MessagesPlaceholder — the canonical pattern
//   - The same chain shape supports tool-binding for CRM actions later
//     (model.bindTools([...])) without restructuring this file
//   - Swapping Groq for another provider becomes a one-line change
//
// Install: npm install @langchain/groq @langchain/core

import { ChatGroq } from '@langchain/groq'
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { StringOutputParser } from '@langchain/core/output_parsers'

// ============================================================
// System prompt — what the AI agent IS
// ============================================================
// Hardcoded for now. Future: load from per-customer config so each
// GlobiFYE customer can define their own agent persona + script.

const AGENT_SYSTEM_PROMPT = `You are a professional sales representative on a live call.
Listen carefully to the prospect and respond naturally and concisely.

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
// Chain setup (built once at module load, reused per request)
// ============================================================

// llama-3.1-8b-instant: ~100-150ms TTFT, good for 1-2 sentence replies.
// Switch to llama-3.3-70b-versatile only if quality is noticeably poor.
const AGENT_MODEL = 'llama-3.1-8b-instant'

const model = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY!,
  model: AGENT_MODEL,
  temperature: 0.7, // some variation so it doesn't sound robotic
  maxTokens: 150,   // keep responses short — this is spoken dialogue
})

// The prompt template is the structured replacement for hand-rolling
// the messages array. The {utterance} variable is filled per call;
// {history} is filled with prior turns via MessagesPlaceholder.
const promptTemplate = ChatPromptTemplate.fromMessages([
  ['system', AGENT_SYSTEM_PROMPT],
  new MessagesPlaceholder('history'),
  ['human', '{utterance}'],
])

// The chain. `.pipe()` composes runnables left-to-right.
// StringOutputParser flattens AIMessageChunk → plain string at each step,
// so consumers get strings directly (no .content access needed).
const agentChain = promptTemplate.pipe(model).pipe(new StringOutputParser())

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
 * Returns an async iterable of text chunks — caller is responsible for
 * accumulating into sentences before sending to TTS.
 *
 * Signature is unchanged from the previous groq-sdk implementation.
 */
export async function streamAgentResponse(
  utterance: string,
  history: ConversationMessage[],
): Promise<AsyncIterable<string>> {
  // Convert our plain history shape to LangChain message instances.
  // (LangChain uses class instances rather than {role, content} objects.)
  const lcHistory = history.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  )

  const stream = await agentChain.stream({
    utterance,
    history: lcHistory,
  })

  // The stream yields strings directly (thanks to StringOutputParser).
  // Wrap in an async generator to match the existing return type.
  return (async function* () {
    for await (const chunk of stream) {
      if (chunk) yield chunk
    }
  })()
}