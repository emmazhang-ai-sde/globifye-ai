# GlobiFYE Voice Agent — Console + Knowledge Base

The omnidim-style agent console (styled to the **DialForge** design system) plus
the knowledge-base backend that powers it.

## Where the files go

This mirrors your `ai-pipeline/` repo. Merge the **contents** of this folder into
`ai-pipeline/` — don't keep the `globifye-voice-agent/` wrapper.

```
components/AgentConsole.tsx          ->  ai-pipeline/components/
components/KnowledgeBaseTab.tsx      ->  ai-pipeline/components/
app/agent/page.tsx                   ->  ai-pipeline/app/agent/
app/api/kb/upload/route.ts           ->  ai-pipeline/app/api/kb/upload/
app/api/kb/documents/route.ts        ->  ai-pipeline/app/api/kb/documents/
app/api/kb/documents/[id]/route.ts   ->  ai-pipeline/app/api/kb/documents/[id]/
lib/*.ts                             ->  ai-pipeline/lib/
supabase/migrations/0002_kb.sql      ->  ai-pipeline/supabase/migrations/
```

## Setup

```bash
npm i openai unpdf lucide-react
```

`.env.local`:
```
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_SUPABASE_URL=https://rjhjveatqnwxbnfrthsr.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...        # server-only secret
```

Run the migration `supabase/migrations/0002_kb.sql` (Supabase SQL Editor is the
quick path). Then:

```bash
npm run dev
```

Open **http://localhost:3000/agent**. Before uploads work, edit
`app/agent/page.tsx` and set `organizationId` to a real id
(`select id from organizations limit 1;`).

## Design system (matches the frontend team / DialForge)

The components are self-contained (scoped CSS) so they render correctly even if
your Tailwind config differs, but they use the exact DialForge tokens:

| Token            | Value                               |
|------------------|-------------------------------------|
| bg               | `#07080F`                           |
| surface          | `#12131a` / container `#1e1f27`      |
| primary          | `#ffb4a2` (accent text/icons)       |
| primary-container| `#ff562a` (fire) — gradient `#FF4D1C→#FF8A00` |
| secondary        | `#7cffa3` (mint / success)          |
| on-surface       | `#e3e1ec` / variant `#e5beb4`       |
| display / body / mono | Syne / DM Sans / JetBrains Mono |

Fonts are pulled from Google Fonts inside each component. If you prefer
`next/font` or the shared Tailwind tokens, the CSS variables are named after the
same tokens, so swapping is mechanical. Icons use `lucide-react`; the frontend
mock uses Material Symbols — swap if you want a pixel match.

## What's live vs. in-memory

- **Knowledge Base tab** — fully wired: upload runs the real
  extract→chunk→embed→store pipeline; list/attach/delete read & write Supabase.
- **Configure / Voice / Call tabs** — UI is done, state is in-memory. Persisting
  the agent row (welcome, flow sections as jsonb, model settings) is the next
  backend step, mirroring what the KB tab already does.

## Wiring retrieval into the agent (`lib/agent-llm.ts`)

```ts
import { retrieveChunks, formatContext } from "@/lib/kb-retrieve";

const chunks = await retrieveChunks(userUtterance, {
  organizationId,
  docIds: attachedDocIds, // the KB tab's attach toggles
});
const kbContext = formatContext(chunks); // inject above your flow prompt
```
