# DialForge — Features

## Calling
- Inbound and outbound calling over SIP, using the customer's existing numbers.
- Concurrent calls: multiple agents run in parallel; capacity scales with the plan.
- Warm handoff to a human agent, or callback capture when no one is available.

## Understanding and speaking
- Real-time speech-to-text with support for natural, interrupting (barge-in) conversation.
- Natural text-to-speech with a choice of voices.
- Low latency: typically around one second from end of caller speech to start of reply.

## Grounding and accuracy
- Answers are grounded in the customer's knowledge base, not open model knowledge.
- Configurable fallback: when a question is not covered, the agent says so and captures a callback rather than guessing.
- Guardrails to keep the agent on-topic and on-brand.

## After the call
- Full call transcript with speaker labels.
- Post-call analysis: summary, key topics, and follow-up items.
- Automatic capture of caller name and phone number when provided.

## Management
- A dashboard to watch live calls, review history, and read analyses.
- Per-agent configuration: objective, tone, persona, and knowledge base.
- Role-based access for teams (Enterprise).

## Integrations
CRM logging, calendar booking, and webhooks push call data into the tools a team already uses. See the integrations document for the current list.
