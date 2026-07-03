# Step 1 — Project Setup

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

#### 1.1 Create the Next.js project

Run in your terminal (pick a location for the project folder):

```bash
npx create-next-app@latest globifye-pipeline
```

When prompted, answer:

```bash
Need to install the following packages:
create-next-app@16.2.6
Ok to proceed? (y) 
✔ Would you like to use the recommended Next.js defaults? › No, customize settings
✔ Would you like to use TypeScript? … No / Yes
✔ Which linter would you like to use? › ESLint
✔ Would you like to use React Compiler? … No / Yes
✔ Would you like to use Tailwind CSS? … No / Yes
✔ Would you like your code inside a `src/` directory? … No / Yes
✔ Would you like to use App Router? (recommended) … No / Yes
✔ Would you like to customize the import alias (`@/*` by default)? … No / Yes
✔ Would you like to include AGENTS.md to guide coding agents to write up-to-date Next.js code? … No / Yes
```
```
Creating a new Next.js app in /Users/shuyangzhang/globifye-pipeline.

Using npm.

Initializing project with template: app-tw 


Installing dependencies:
- next
- react
- react-dom

Installing devDependencies:
- @tailwindcss/postcss
- @types/node
- @types/react
- @types/react-dom
- eslint
- eslint-config-next
- tailwindcss
- typescript


added 360 packages, and audited 361 packages in 14s

143 packages are looking for funding
  run `npm fund` for details

2 moderate severity vulnerabilities

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.

Generating route types...
✓ Types generated successfully

Initialized a git repository.

Success! Created globifye-pipeline at /Users/shuyangzhang/globifye-pipeline

```

---

#### 1.2 Navigate into the project

```bash
cd globifye-pipeline
```

---

#### 1.3 Install core dependencies

```bash
npm install @deepgram/sdk @supabase/supabase-js
```
```
added 10 packages, and audited 371 packages in 1s

143 packages are looking for funding
  run `npm fund` for details

2 moderate severity vulnerabilities

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.

```

> ⏳ LangChain.js and the LLM provider package are installed in **Step 7.1** after the LLM provider is confirmed in Step 3.

---

#### 1.4 Create the folder structure

Create these folders manually (some already exist from `create-next-app`):

```
globifye-pipeline/
├── app/
│   ├── api/
│   │   ├── recordings/        ← Step 8: POST /api/recordings/create
│   │   ├── transcribe/        ← Step 8: POST /api/transcribe
│   │   └── analyze/           ← Step 8: POST /api/analyze
│   ├── page.tsx               ← Step 9: main UI page
│   └── layout.tsx
├── lib/
│   ├── deepgram.ts            ← Step 4: Deepgram client + parser
│   ├── supabase.ts            ← Step 2: Supabase client + DB helpers
│   └── llm.ts                 ← Step 7: LangChain.js client + analysis prompt
├── types/
│   └── pipeline.ts            ← TypeScript type definitions
├── supabase/
│   └── migrations/
│       └── 001_schema.sql     ← Step 2: table definitions
└── .env.local                 ← Step 1.5: API keys (never commit this)
```

```bash
mkdir -p app/api/recordings app/api/transcribe app/api/analyze lib types supabase/migrations
```

---

#### 1.5 Create `.env.local`


```env
# Speech-To-Text Model
## Deepgram — sign up at deepgram.com (Step 4)
DEEPGRAM_API_KEY=

# Supabase — from your Supabase project → Settings → API (Step 2)

## Project URL: the format is always https://<your-project-id>.supabase.co — the project ID is the string at the end of your dashboard URL.
NEXT_PUBLIC_SUPABASE_URL=         

## Publishable key  
NEXT_PUBLIC_SUPABASE_ANON_KEY=   

## Secret key
SUPABASE_SERVICE_ROLE_KEY=

# LLM — fill in after Step 3 provider is confirmed (pick one)
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is a secret — only use it in server-side API routes, **never** in browser code or `NEXT_PUBLIC_` variables.

---

#### 1.6 Confirm `.env.local` is gitignored

Open `.gitignore` (created automatically by `create-next-app`) and verify `.env.local` is listed. It should be there by default — just double-check before any `git add .`

---

#### 1.7 Create stub files for `lib/` and `types/`

Create empty placeholder files so the folder structure is ready for later steps:

```bash
touch lib/deepgram.ts lib/supabase.ts lib/llm.ts types/pipeline.ts
touch supabase/migrations/001_schema.sql
```

---

#### 1.8 Test the dev server

```bash
npm run dev
```

```
> globifye-pipeline@0.1.0 dev
> next dev

▲ Next.js 16.2.6 (Turbopack)
- Local:         http://localhost:3000
- Network:       http://192.168.10.240:3000
- Environments: .env.local
✓ Ready in 210ms
```

Open `http://localhost:3000` — you should see the default Next.js welcome page.

> ✅ If it loads, **Step 1 is complete.** Move on to [Step 2 — Supabase Database Schema](ai-pipeline-mvp-step2-supabase-schema.md).
