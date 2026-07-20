# AI Pipeline (Next.js)

**Last updated:** 2026-07-16

The batch sales-call analysis pipeline and its web UI: upload / pick a call recording, run Deepgram STT, then Groq (LangChain) sales-coach analysis, and store results in Supabase. Built with Next.js (App Router) + Tailwind.

## How to start

From this folder:

```bash
cd ~/GlobiFYE/globifye-ai/ai-pipeline
npm install        # first time only
npm run dev
```

Then open http://localhost:3400 in a browser.

**Verify it is up:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3400
```

Expected output: `200`.

Other scripts (from `package.json`):

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server with hot reload on port 3400 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build (run `build` first) |
| `npm run lint` | ESLint |

## Environment variables

Secrets go in `ai-pipeline/.env.local` (never committed). Variables referenced by the code:

| Variable | Used for |
|----------|----------|
| `DEEPGRAM_API_KEY`, `DEEPGRAM_PROJECT_ID` | STT transcription |
| `GROQ_API_KEY` | LLM analysis (LangChain + Groq) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client (browser side) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase writes from server-side code and scripts |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | TTS (shared with the SIP demo) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Alternative LLM providers used in comparison/testing code |

Note: this same `.env.local` is also read by the SIP demo scripts (`sip/scripts/step2_stt_bridge.py` and `sip/demo-ui/demo_ui_server.py`), so it is the single place for secrets in this repo.

## Folder map

- `app/` — Next.js App Router pages (`page.tsx`, `demo/`, `batch/`) and API routes (`api/`)
- `lib/` — pipeline logic (STT, LLM analysis, Supabase access)
- `scripts/` — one-off Node/TS scripts (run with `npx tsx scripts/<name>.ts`)
- `supabase/` — schema and migration SQL
- `types/` — shared TypeScript types
