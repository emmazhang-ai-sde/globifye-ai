# Step 12 — Frontend UI Integration `[Milestone 2]`

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

> **Milestone 2 — Production UI + Agent Runway**
> After this step the pipeline runs on the frontend team's production-quality UI. Steps 13+ build the real-time agent loop on top of this foundation.

---

## Context

Steps 1–11 built the full backend pipeline (DB schema, Deepgram WebSocket layer, LLM analysis, API routes). This step wires the pipeline to a production-quality UI provided by the frontend team, replacing all internal React prototypes.

**Key decision:** Use the frontend team's static HTML files directly (served from `public/`) rather than converting them to React components. This avoids drift between the reference design and the live implementation — any future UI update from the frontend team is a file copy, not a re-implementation.

---

## Files Involved

| File | Role |
|------|------|
| `public/frontend.html` | Power Dialer + Active Queue (entry point). Based on `frontend-team/Stitch.html`. |
| `public/live-call.html` | Live call screen with real-time transcription + analysis. Based on `frontend-team/liveTranscription.html`. |
| `app/page.tsx` | Root redirect → `/frontend.html` |
| `frontend-team/Stitch.html` | Original design reference — do not touch. Received from frontend team on 2026-06-01. |
| `frontend-team/liveTranscription.html` | Original design reference — do not touch. Received from frontend team on 2026-06-05. |

---

## Architecture Decision: Static HTML over React

| Approach | Tradeoff |
|----------|----------|
| Convert HTML to React (old approach) | Any frontend team update requires manual re-conversion. Style drift is inevitable. |
| Serve HTML from `public/` (chosen) | Frontend team files are served as-is. Our logic lives in a `<script>` block added to each file. UI updates = file copy. |

The HTML files call our Next.js API routes (`/api/recordings/create`, `/api/deepgram-token`, `/api/transcribe/live`, `/api/analyze`) via `fetch`. No framework coupling.

---

## User Flow

```
localhost:3000
    │
    └─ redirect → /frontend.html  (Power Dialer)
                      │
                      ├─ Type phone number → dial button
                      └─ Click "Call Now" in Active Queue
                                    │
                                    └─ /live-call.html?name=...&phone=...&company=...
                                                │
                                                ├─ Auto: POST /api/recordings/create
                                                ├─ Auto: GET  /api/deepgram-token
                                                ├─ Auto: WebSocket → Deepgram Nova-3
                                                ├─ Live: transcript lines appear
                                                ├─ End Call → POST stop + show "Analyze"
                                                └─ Analyze → POST /api/analyze → results panel
```

---

## frontend.html — Changes from Stitch.html

Only two functions were modified. Everything else (HTML, CSS, all other JavaScript) is 100% the frontend team's original code.

### `triggerCall(contact)`

**Before (original):** Showed a floating call overlay in the bottom-right corner of the same page.

**After:** Navigates to `live-call.html` with the contact's info as URL params.

```javascript
triggerCall(contact) {
    const params = new URLSearchParams({
        name:    contact.name    || '',
        phone:   contact.phone   || '',
        company: contact.company || ''
    });
    window.location.href = '/live-call.html?' + params.toString();
},
```

### `testCall()`

**Before (original):** Always picked a random contact and called `triggerCall`.

**After:** If a number has been typed in the dialer input, navigates with that number. Otherwise falls back to a random contact from state.

```javascript
testCall() {
    const dialerInput = document.getElementById('dialer-input');
    const number = dialerInput ? dialerInput.value.trim() : '';
    if (number && number !== '+1 (555) 000-0000') {
        window.location.href = '/live-call.html?' + new URLSearchParams({ phone: number }).toString();
    } else {
        const randomContact = state.contacts[Math.floor(Math.random() * state.contacts.length)];
        this.triggerCall(randomContact);
    }
},
```

**Result:** Typing a number and clicking the call button dials that number. Clicking "Call Now" on a queue entry passes name + phone + company to the live call screen.

---

## live-call.html — Changes from liveTranscription.html

The frontend team's HTML and CSS are unchanged. The following was added or modified in the `<script>` block only.

### HTML additions (minimal, IDs only)

| Element | Change |
|---------|--------|
| `<h2>Jonathan Sterling</h2>` | Added `id="caller-name-display"` |
| `<p>VP of Operations...</p>` | Added `id="caller-company-display"` |
| New `<p>` after company | `id="caller-phone-display"` — shows dialed number |
| Avatar `<img>` | Added `id="caller-avatar-img"` + sibling `<span id="caller-avatar-initials">` for name initials |
| TRANSCRIBING span | Added `id="transcript-status"` |
| New div after transcript container | `id="analyze-footer"` — hidden until call ends, holds Analyze button |
| New div after Live Transcript card | `id="analysis-results"` — hidden until analysis completes |
| New div before alert card | `id="error-banner"` — hidden until an error occurs |

### JavaScript: removed

- The fake transcript simulation (`simulatedLines`, `appendTranscriptLine` setTimeout loop)
- `location.reload()` in `handleEndCall` — replaced with recording stop + Analyze button reveal

### JavaScript: added

#### 1. Contact info from URL params
```javascript
const CALLER_NAME    = urlParams.get('name')    || '';
const CALLER_PHONE   = urlParams.get('phone')   || '';
const CALLER_COMPANY = urlParams.get('company') || '';
```
On `DOMContentLoaded`: populates the contact name/company/phone display and swaps the avatar photo for name initials (e.g. "SJ" for Sarah Jenkins).

#### 2. `startLive()` — auto-called on page load
```
POST /api/recordings/create  →  recordingId
GET  /api/deepgram-token     →  short-lived browser key
WebSocket → Deepgram Nova-3  →  audio stream
```
- Uses `speech_final` (not `is_final`) as the utterance boundary — consistent with Step 10 rule.
- Accumulates `is_final` chunks in `accText` until `speech_final` fires.
- Each committed utterance: renders a transcript line in the DOM + `POST /api/transcribe/live`.

#### 3. `addTranscriptLine(text, speaker, startSec)`
Appends a real transcript line. Speaker 0 = "Agent (You)", Speaker 1+ = caller name (or "Speaker N" fallback). Matches the visual style of the frontend team's simulated lines.

#### 4. `handleEndCall()` — replaces original
```
stop MediaRecorder
close WebSocket
setTranscriptStatus('ENDED')
show #analyze-footer
disable End Call button
confetti (from frontend team's original code, unchanged)
```
Does **not** reload the page. The transcript stays visible so Key Topics navigation works after analysis.

#### 5. `handleAnalyze()` + `renderAnalysis(data)`
```
POST /api/analyze { recording_id }
→ renders: Summary, Key Topics, Objections, What Went Well
   into #analysis-results (shown below Live Transcript card)
```
Also updates the alert card with the first detected objection if present.

---

## DB Fields Populated Per Call

| Field | Source | Status |
|-------|--------|--------|
| `recordings.caller_number` | URL param `?phone=` | ✅ stored |
| `recordings.status` | hardcoded `'in_progress'` | ✅ stored |
| `recordings.recorded_by` | — | ⏳ requires UUID FK → users (future: backend team) |
| `recordings.contact_id` | — | ⏳ requires UUID FK → contacts (future: backend team) |
| `recordings.organization_id` | — | ⏳ requires UUID FK → organizations (future: backend team) |
| `transcript.*` | Deepgram `speech_final` events | ✅ stored per utterance |
| `analysis.*` | LLM response | ✅ stored on Analyze click |

The three FK fields (`recorded_by`, `contact_id`, `organization_id`) require UUIDs that exist in the backend team's users/contacts/organizations tables. They are intentionally left null for the MVP and will be wired in when Abraham/Kim's backend exposes the relevant IDs.

---

## What Was Deleted

| Removed | Reason |
|---------|--------|
| `app/frontend/page.tsx` (React route `/frontend`) | Replaced by `public/live-call.html` + `public/frontend.html` |
| Pre-call modal (type caller name/agent name in a pop-up) | Replaced by Active Queue flow — contact info comes from the dialer, not a modal |
| `public/sage.html` | Renamed to `public/frontend.html` |

---

## Rule: Do Not Touch Reference Files

`frontend-team/Stitch.html` (received 2026-06-01) and `frontend-team/liveTranscription.html` (received 2026-06-05) are the frontend team's design source files. They must never be modified. All functional changes live in `public/frontend.html` and `public/live-call.html` only.

---

## Why Are the FK Fields Empty? (Data Architecture)

Running `node scripts/check-null-fields.mjs` against the live DB confirms the following state:

| Table | Row count | Reason |
|-------|-----------|--------|
| `organizations` | 0 | No company has completed SuperAdmin signup yet |
| `users` | 0 | No sales rep has been invited/accepted yet |
| `contacts` | 0 | CRM sync hasn't run (depends on `crm_integrations`) |

As a result, all three FK columns in every recording row are `NULL`:

| Column | State | Blocking dependency |
|--------|-------|---------------------|
| `organization_id` | NULL | no row in `organizations` |
| `recorded_by` | NULL | no row in `users` |
| `contact_id` | NULL | no row in `contacts` |

This is expected. Each table has a strict owner and creation condition:

### `organizations` — Created by Abraham/Kim on SuperAdmin signup

One row per company tenant. This is a platform-admin operation, not something the AI pipeline initiates. Until a company completes the onboarding flow, this table stays empty.

### `users` — Created on signup / invite accepted

A company admin invites sales reps; each accepted invite inserts a row. Backend-owned. Currently empty because no company has gone through the full onboarding.

### `contacts` — Populated via CRM sync (Apollo.io / HubSpot)

The `contacts` table has `apollo_id` and `hubspot_id` columns — contacts are **not entered manually**. They come from external CRM systems synced through `crm_integrations` (OAuth tokens) and tracked in `crm_sync_log`. No organization exists yet, so no integration has been configured, so no contacts have synced.

### The full dependency chain

```
1. Abraham/Kim creates an organizations row           ← backend team
2. Admin invites users (sales reps)                   ← backend team
3. SuperAdmin connects Apollo.io / HubSpot            ← backend team
       → crm_integrations row created
4. CRM sync runs → contacts table populated           ← backend team
5. Sales rep logs in → frontend queries contacts
   WHERE organization_id = current user's org
   → Active Queue shows real leads instead of hardcoded sample data
6. Rep dials → recordings.contact_id + recorded_by filled in  ← AI pipeline
```

**Our AI pipeline owns step 6. Steps 1–5 are the backend team's work.**

### Current Active Queue workaround

Because steps 1–5 are not done, `public/frontend.html` uses `state.contacts` — four hardcoded sample entries (Sarah Jenkins, Michael Chen, etc.). No DB query, no `organization_id`. This is intentional for the MVP.

> **Action item:** Confirm with Danish / Abraham when seed data (at minimum one `organizations` row and one `users` row) will be available. Once that exists, `recorded_by` and `organization_id` can be wired in, and the Active Queue can be switched to a real Supabase query.
