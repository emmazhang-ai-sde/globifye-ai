# Sales Call System — Backend & Infrastructure Design (June 17, 2026)

## Project Overview

Multi-tenant SaaS platform for AI-powered sales call transcription, analysis, and coaching. The platform sits at the center of a sales operations pipeline — connecting lead sourcing (Apollo.io), call recording and AI analysis (Deepgram + LLM), CRM logging (HubSpot), support ticketing (Zendesk), and workflow automation (Zapier).

The backend is split across two systems with a clearly defined boundary:

| System                | Owner                           | Responsibility                                                        |
| --------------------- | ------------------------------- | --------------------------------------------------------------------- |
| SIP / Telephony Layer | Abraham + Wil + Kim (our group) | Call routing, DID management, call queue, agent config, auth, billing |
| AI Pipeline           | AI team                         | Real-time STT, LLM response, TTS, transcript, analysis, topics        |

The two systems are linked by a shared `sip_session_id` stored in the `recordings` table.

---

## Confirmed Requirements

- Auth: Role-based access (SuperAdmin, Admin, Team Member) per organization
- Multi-tenancy: Full data isolation between organizations via Row Level Security
- Storage: All data persisted permanently until user deletes
- Billing: Store subscription state, transactions, and payment logs — payment processing handled externally by payment gateway
- Usage tracking: Log every AI compute job for billing purposes
- Duplicate protection: Idempotency key on all transactions — no customer can be double-charged
- SIP / DID: Each organization gets a unique DID phone number — handled by Asterisk + Kamailio
- SIP GUI: FreePBX manages Asterisk configuration
- Apollo: Pull-only — contact data cached temporarily, never pushed back
- CRM Sync: After call analysis, results pushed to HubSpot and Zendesk (if issue detected)
- Outbound Webhooks: Platform emits events Zapier can subscribe to for workflow automation
- Email: Zoho Mail for invite emails and system notifications
- AI Agent: Supports autonomous AI caller with configurable objective, tone, and persona per org

---

## System Boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│              OUR GROUP (Abraham + Wil + Kim)                              │
│                                                                     │
│  ├── SIP / telephony layer (Asterisk + Kamailio + FreePBX)          │
│  ├── Call routing and DID management (Telxi)                        │
│  ├── Call queue and scheduling                                      │
│  ├── Agent configuration storage                                    │
│  ├── Auth, roles, and organization management                       │
│  ├── Billing and subscription tracking                              │
│  └── Bridge: sip_session_id links our calls to AI team transcripts  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    sip_session_id (shared key)
                              │
┌─────────────────────────────────────────────────────────────────────┐
│              AI TEAM                                                │
│                                                                     │
│  ├── Real-time STT (Deepgram Nova-3)                                │
│  ├── LLM response generation (Groq → OpenAI)                        │
│  ├── TTS (ElevenLabs eleven_turbo_v2_5)                             │
│  ├── transcript table (per sentence, real-time)                     │
│  ├── analysis table (summary, objections, what went well)           │
│  └── topics table (key topics with timestamps)                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                           │
│                        Hosted on Vercel                             │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API Layer (Vercel)                           │
│                    API Routes — owned by API team                   │
└─────────────────────────────────────────────────────────────────────┘
         │              │               │              │
         ▼              ▼               ▼              ▼
┌──────────────┐ ┌────────────┐ ┌───────────────┐ ┌──────────────────┐
│ AI Pipeline  │ │ Backend/DB │ │Payment Gateway│ │ CRM Integrations │
│  (AI team)   │ │(our group) │ │  (external)   │ │(external APIs)   │
│              │ │            │ │               │ │                  │
│Deepgram      │ │ Supabase   │ │Sends webhook →│ │ HubSpot          │
│Nova-3        │ │ PostgreSQL │ │our API stores │ │ Zendesk          │
│LLM + TTS     │ │            │ │it             │ │ Apollo (pull)    │
└──────────────┘ └────────────┘ └───────────────┘ └──────────────────┘
       │                │                                   ▲
       └──sip_session_id│                                   │
                        ▼                                   │
         ┌──────────────────────────────┐                   │
         │      PostgreSQL Database     │ ──── syncs ───────┘
         │      (hosted on Supabase)    │
         └──────────────────────────────┘
                        ▲
                        │
┌─────────────────────────────────────────────────────────────────────┐
│                    External Automation                              │
│              Zapier subscribes to outbound webhooks                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer               | Technology                                                         |
| ------------------- | ------------------------------------------------------------------ |
| Database            | Supabase (PostgreSQL)                                              |
| Authentication      | Supabase Auth                                                      |
| Hosting             | Vercel (API routes)                                                |
| Payment integration | Payment gateway (TBD) + webhook receiver                           |
| Email service       | Zoho Mail                                                          |
| SIP server          | Asterisk (open source, self-hosted)                                |
| SIP GUI             | FreePBX (manages Asterisk configuration)                           |
| SIP proxy           | Kamailio (handles routing and load balancing in front of Asterisk) |
| DID provider        | TBD (VoIP.ms / Flowroute / other)                                  |
| CRM integrations    | HubSpot API, Zendesk API, Apollo.io API (pull only)                |
| Workflow automation | Zapier (via outbound webhooks)                                     |
| Language            | TypeScript / JavaScript (Node.js)                                  |
| ORM / Query         | Supabase client or raw SQL via `pg`                                |

---

## SIP Infrastructure Design

```
Customer / Prospect (PSTN / cell phone)
              │
         [SIP Trunk]
              │
              ▼
┌────────────────────────────────────────┐
│  DID Number (e.g. +1 555 123 4567)     │
│  Unique per organization               │
│  Stored in phone_numbers table         │
│  Provisioned by Telxi                  │
└────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────┐
│  Kamailio (SIP Proxy)                  │
│  ├── Routes calls to correct org       │
│  ├── Load balances across Asterisk     │
│  └── Handles failover if Asterisk down │
└────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────┐
│  Asterisk (SIP Server)                 │
│  ├── Manages SIP sessions              │
│  ├── Handles call logic and routing    │
│  ├── Forks audio to AI pipeline        │
│  └── Managed via FreePBX GUI           │
└────────────────────────────────────────┘
        │                    │
   (WebRTC)            (RTP audio stream)
        │                    │
        ▼                    ▼
┌──────────────┐    ┌─────────────────────┐
│  Frontend    │    │  AI Pipeline        │
│  (Next.js)   │    │  (AI team)          │
│  Team member │    │  Deepgram → LLM     │
│  hears call  │    │  → TTS → back to    │
└──────────────┘    │  Asterisk → caller  │
                    └─────────────────────┘
```

### What each SIP component does

| Component    | Role                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Kamailio** | SIP proxy that sits in front of Asterisk. Routes incoming calls to the right org, handles failover, and load balances across multiple Asterisk instances if needed |
| **Asterisk** | The core SIP server. Manages the actual phone call sessions, routes audio, and handles call logic                                                                  |
| **FreePBX**  | Web-based GUI that sits on top of Asterisk. Used to configure extensions, DID routing, and call rules without touching Asterisk config files directly              |

---

## Role System

```
Organization
    │
    ├── SuperAdmin (1 per org)
    │     ├── Owns billing and subscription
    │     ├── Manages all admins
    │     ├── Configures CRM integrations (HubSpot, Zendesk, Apollo)
    │     ├── Configures AI agent settings (objective, tone, persona)
    │     └── Sees all usage, costs, and team data
    │
    ├── Admin (1 or more per org)
    │     ├── Manages team members (invite, remove)
    │     ├── Views all team calls and usage
    │     └── Limited billing visibility (read-only)
    │
    └── Team Member (many per org)
          ├── Makes and monitors calls
          ├── Views own call history and AI summaries
          └── Cannot access billing, CRM config, or team management
```

### Permission Matrix

**Platform side** (our company managing the platform)

| Action                       | SuperAdmin | Admin     | Team Member |
| ---------------------------- | ---------- | --------- | ----------- |
| View billing / subscription  | ✅         | Read only | ❌          |
| Manage admins                | ✅         | ❌        | ❌          |
| Invite / remove team members | ✅         | ✅        | ❌          |
| Configure CRM integrations   | ✅         | ❌        | ❌          |
| Configure AI agent           | ✅         | ❌        | ❌          |
| View all team calls          | ✅         | ✅        | ❌          |
| Make / record calls          | ✅         | ✅        | ✅          |
| View own calls               | ✅         | ✅        | ✅          |

**Client side** (the startup organizations paying to use the platform)

| Action                       | Account Owner | Admin     | Team Member |
| ---------------------------- | ------------- | --------- | ----------- |
| View billing / subscription  | ✅            | Read only | ❌          |
| Manage admins                | ✅            | ❌        | ❌          |
| Invite / remove team members | ✅            | ✅        | ❌          |
| Configure CRM integrations   | ✅            | ❌        | ❌          |
| Configure AI agent           | ✅            | ❌        | ❌          |
| View all team calls          | ✅            | ✅        | ❌          |
| Make / record calls          | ✅            | ✅        | ✅          |
| View own calls               | ✅            | ✅        | ✅          |

**Key difference between the two sides:**

- Platform SuperAdmin can see and manage ALL organizations on the platform
- Client Account Owner can only see and manage their own organization
- Both have the same permissions within their respective scope

---

## Auth Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SuperAdmin Signup (org creation)                 │
└─────────────────────────────────────────────────────────────────────┘

  SuperAdmin signs up via email/password
              │
              ▼
  Supabase Auth creates auth.users record
              │
              ▼
  Trigger auto-creates row in public.users
              │
              ▼
  SuperAdmin creates organization
              │
              ▼
  public.users updated: role = 'superadmin', organization_id = org.id
              │
              ▼
  DID number assigned to organization → stored in phone_numbers table
  Kamailio routing rule updated to route that DID to the org

┌─────────────────────────────────────────────────────────────────────┐
│               Admin / Team Member Invite Flow                       │
└─────────────────────────────────────────────────────────────────────┘

  SuperAdmin / Admin enters invitee email + role
              │
              ▼
  Invite record created in invites table (token, role, org_id)
              │
              ▼
  Email sent via Zoho Mail: app.com/accept-invite?token=xxxx
              │
              ▼
  Invitee clicks link → signs up
              │
              ▼
  public.users updated: role = invite.role, organization_id = invite.organization_id
              │
              ▼
  Invite status updated to 'accepted'
```

---

## Data Flow — Call Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Phase 1 — During Call (Real-Time)                │
│                   Owned by: Our group (SIP layer)                  │
└─────────────────────────────────────────────────────────────────────┘

Step 1 — Call Initialization
  Customer dials org's DID number from cell or landline
              │
         [SIP Trunk]
              │
              ▼
  Kamailio receives call → identifies org by DID number
              │
              ▼
  Routes to Asterisk → session established
              │
              ▼
  Asterisk fires call-started webhook → POST /calls/start
              │
              ▼
  recordings row created:
    status = 'active'
    sip_session_id = Asterisk session ID   ← links to AI team's DB
    organization_id = looked up from DID
    call_mode = 'inbound' or 'auto_dialer'

Step 2 — Audio Split
  Asterisk forks audio into two parallel streams:
  ├──► WebRTC → Frontend (Next.js) — team member hears / talks live
  └──► RTP stream → AI pipeline (AI team's system)
                       └── Deepgram Nova-3 transcribes in real-time
                       └── LLM generates AI response
                       └── ElevenLabs TTS → audio back to Asterisk
                       └── Asterisk plays AI audio to caller

Step 3 — Audio Storage
  Raw audio streams to cloud storage (S3 / GCS — TBD)
  Raw audio is never written to the database
  recordings.audio_url updated with storage pointer

Step 4 — Call Termination
  Call ends → Asterisk fires call-ended webhook → POST /calls/:id/end
              │
              ▼
  recordings updated:
    status = 'completed'
    duration_seconds = calculated
              │
              ▼
  Outbound webhook fired → Zapier receives 'call.completed' event
              │
              ▼
  AI team receives call-ended event → triggers post-call analysis loop


┌─────────────────────────────────────────────────────────────────────┐
│              Phase 2 — Post-Call Analysis                          │
│              Owned by: AI team                                     │
└─────────────────────────────────────────────────────────────────────┘

  AI team fetches full transcript from their DB using sip_session_id
              │
              ▼
  LLM generates structured analysis (automatic — no button needed):
    ├── Summary
    ├── Objection analysis
    ├── What went well
    └── Key topics with timestamps
              │
              ▼
  AI team writes to their analysis + topics tables
              │
              ▼
  AI team notifies our API → POST /analysis-ready/:recording_id
              │
              ▼
  gpu_jobs row logged for billing (job_type: 'summarization')
              │
              ▼
  recordings.status updated to 'summarized'
              │
              ▼
  Outbound webhook fired → Zapier receives 'analysis.ready' event


┌─────────────────────────────────────────────────────────────────────┐
│              Phase 3 — CRM Sync (Post-Analysis)                    │
│              Owned by: Our group                                    │
└─────────────────────────────────────────────────────────────────────┘

  Analysis ready notification received
              │
              ▼
  Backend checks crm_integrations for this organization
              │
        ┌─────┴────────────────────────┐
        ▼                              ▼
  HubSpot connected?           Zendesk connected?
        │                              │
        ▼                              ▼
  POST to HubSpot              Issue detected in analysis?
  Engagements API                ├── YES → create Zendesk ticket
  → log call duration,           │         with summary + recording URL
    summary, recording URL,      └── NO  → skip Zendesk
    contact linked by phone
        │
        ▼
  crm_sync_log updated (synced / failed) for each provider
```

---

## Apollo Integration (Pull Only)

Apollo is used **only as a contact lookup** — data is pulled before a call starts and cached temporarily. Nothing is pushed back to Apollo.

```
Sales rep selects contact to call
              │
              ▼
Check contacts table: is there a fresh cached entry?
  ├── YES (not expired) → use cached data, no API call
  └── NO (expired or missing) → pull from Apollo API
              │
              ▼
Store in contacts table with 24-hour expiry:
  cached_at = NOW()
  expires_at = NOW() + 24 hours
              │
              ▼
Call starts → contact_id linked to recordings row
              │
              ▼
Nightly cleanup job deletes expired contacts
not linked to any recording
```

---

## Database Schema

### Data Flow (simplified)

```
DID number lookup → phone_numbers table
      ↓
Call starts → recordings table (sip_session_id links to AI team DB)
      ↓
Audio → cloud storage (audio_url stored in recordings)
      ↓
AI team handles: transcript → analysis → topics (their DB)
      ↓
AI team notifies us → gpu_jobs logged, status updated
      ↓
CRM sync → crm_sync_log table
      ↓
Zapier webhook fired
```

### Schema Tables (our group owns these)

| Table              | Key Fields                                                                                                                                                                                       | Written When                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `organizations`    | `id`, `name`, `created_at`                                                                                                                                                                       | On SuperAdmin signup                 |
| `users`            | `id` (UUID), `organization_id`, `email`, `role`, `is_active`                                                                                                                                     | On signup / invite accepted          |
| `invites`          | `organization_id`, `invited_by`, `email`, `role`, `token`, `status`                                                                                                                              | When admin sends invite              |
| `phone_numbers`    | `organization_id`, `did_number`, `is_active`, `assigned_at`                                                                                                                                      | When org is created                  |
| `contacts`         | `organization_id`, `apollo_id`, `hubspot_id`, `name`, `email`, `phone`, `company`, `cached_at`, `expires_at`                                                                                     | When call is initiated (Apollo pull) |
| `recordings`       | `id`, `organization_id`, `recorded_by`, `contact_id`, `did_number`, `caller_number`, `audio_url`, `status`, `duration_seconds`, `sip_session_id`, `sip_provider`, `call_mode`, `agent_config_id` | Call starts / ends                   |
| `call_queue`       | `organization_id`, `contact_id`, `scheduled_at`, `priority`, `status`, `call_mode`                                                                                                               | When AI auto-dialer queues a contact |
| `agent_configs`    | `organization_id`, `created_by`, `name`, `objective`, `tone`, `persona`, `account_type`, `is_active`                                                                                             | When SuperAdmin configures AI agent  |
| `gpu_jobs`         | `organization_id`, `recording_id`, `job_type`, `status`, `compute_units`, `cost`, `started_at`, `completed_at`                                                                                   | After each AI job completes          |
| `crm_integrations` | `organization_id`, `provider`, `access_token`, `refresh_token`, `token_expires_at`, `is_active`                                                                                                  | When SuperAdmin connects a CRM       |
| `crm_sync_log`     | `recording_id`, `organization_id`, `provider`, `external_record_id`, `sync_type`, `status`, `error_message`, `synced_at`                                                                         | After each CRM push attempt          |
| `webhooks`         | `organization_id`, `event_type`, `target_url`, `secret`, `is_active`                                                                                                                             | When org configures Zapier           |
| `subscriptions`    | `organization_id`, `plan_type`, `status`, `gpu_quota`, `renewal_date`, `started_at`, `cancelled_at`                                                                                              | On org signup / plan change          |
| `transactions`     | `transaction_key` (unique), `organization_id`, `subscription_id`, `amount`, `currency`, `status`, `description`                                                                                  | Payment gateway webhook              |
| `payment_logs`     | `transaction_key`, `organization_id`, `event_type`, `raw_payload` (JSON)                                                                                                                         | Every gateway event received         |
| `api_keys`         | `organization_id`, `created_by`, `key_hash`, `label`, `is_active`                                                                                                                                | When SuperAdmin generates key        |

### Tables owned by AI team (not in our DB)

| Table        | Owner   |
| ------------ | ------- |
| `transcript` | AI team |
| `analysis`   | AI team |
| `topics`     | AI team |

### Schema Notes

- `sip_session_id` in `recordings` is the critical bridge — both our DB and the AI team's DB store this ID to link call records to transcripts and analysis
- `recordings.audio_url` is a pointer to cloud storage — raw audio binary is never stored in the database
- `transaction_key` has a UNIQUE constraint — duplicate webhook events are silently rejected at the DB level
- `raw_payload` in `payment_logs` stores the full gateway response as JSON for audit trail
- `gpu_jobs` tracks every billable AI compute job — both transcription (Deepgram) and summarization (LLM)
- `crm_integrations` stores OAuth tokens per organization per provider — encrypted at rest
- `crm_sync_log` is the audit trail for every CRM push — failed syncs store error messages for retry
- `contacts.expires_at` drives the Apollo cache — entries older than 24 hours are refreshed on next access
- `contacts` not linked to any recording are deleted nightly by a cleanup job
- `agent_configs` stores the user-defined AI agent objective, tone, and persona per organization
- `call_queue` supports the AI auto-dialer — tracks which prospects are scheduled to be called and in what order
- `recordings.call_mode` identifies how the call was initiated: auto_dialer, human_transfer, or inbound

---

## CRM Integration Design

### Apollo (pull only)

| Action                                               | Allowed |
| ---------------------------------------------------- | ------- |
| Pull contact name, email, phone, company before call | ✅      |
| Push call outcome back to Apollo                     | ❌      |
| Cache contact data for 24 hours                      | ✅      |

### HubSpot and Zendesk (push after analysis)

| Provider | What is sent                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| HubSpot  | Call logged as engagement — duration, summary, recording URL, linked to contact by phone number               |
| Zendesk  | Ticket created only if analysis contains objections or unresolved issues — includes summary and recording URL |

### OAuth token storage

```
SuperAdmin connects HubSpot
        ↓
OAuth flow → access_token + refresh_token returned
        ↓
Stored in crm_integrations:
  organization_id = org.id
  provider = 'hubspot'
  access_token = encrypted token
  token_expires_at = expiry timestamp
```

Tokens are refreshed automatically before `token_expires_at` to prevent broken connections.

### Outbound webhooks for Zapier

| Event            | Fired when                                                  |
| ---------------- | ----------------------------------------------------------- |
| `call.started`   | recordings row created, status = 'active'                   |
| `call.completed` | call ends, status = 'completed'                             |
| `analysis.ready` | AI team notifies us analysis is done, status = 'summarized' |

---

## Billing & Payment Design

```
Payment gateway processes charge (external)
              │
              ▼
Gateway sends webhook → POST /webhook/payment
              │
              ▼
Check: does transaction_key already exist in transactions table?
  ├── YES → duplicate detected, return 200, do not insert
  └── NO  → insert into transactions table
            insert into payment_logs table (raw event)
            update subscriptions.status if needed
```

### Duplicate Charge Prevention

- Every transaction includes a unique `transaction_key` from the gateway
- PostgreSQL `UNIQUE` constraint on `transaction_key` makes double-insertion impossible at DB level
- API catches the `23505` unique violation error and returns `200` silently

### Responsibility Split

| Responsibility               | Owner                          |
| ---------------------------- | ------------------------------ |
| Charging the customer's card | Payment gateway                |
| Sending payment confirmation | Payment gateway                |
| Storing subscription state   | Our database                   |
| Storing transaction records  | Our database                   |
| Storing raw payment events   | Our database (payment_logs)    |
| Calculating invoices         | Payment gateway                |
| Preventing duplicate records | Our database (idempotency key) |

---

## Row Level Security (RLS)

All tables have RLS enabled. Users can only read and write data belonging to their own organization. Same policy pattern applied to all tables:

```sql
CREATE POLICY "org isolation on recordings"
ON recordings FOR ALL
USING (
  organization_id = (
    SELECT organization_id FROM public.users WHERE id = auth.uid()
  )
);
```

Tables with RLS enabled: `organizations`, `users`, `invites`, `phone_numbers`, `contacts`, `recordings`, `call_queue`, `agent_configs`, `gpu_jobs`, `crm_integrations`, `crm_sync_log`, `webhooks`, `subscriptions`, `transactions`, `payment_logs`, `api_keys`.

---

## Integration Contract with AI Team

These must be agreed on before either team starts building the connection:

| Item                            | Detail                                                                             | Status |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| **sip_session_id format**       | Who generates it — Asterisk or our API? UUID or string?                            | TBD    |
| **Call-started event**          | Asterisk webhook to our API → we notify AI team, or AI team listens directly?      | TBD    |
| **Call-ended event**            | Same question — who notifies the AI team to start post-call analysis?              | TBD    |
| **Audio format**                | How does Asterisk deliver audio to Deepgram — WebSocket, RTP, HTTP chunked?        | TBD    |
| **Analysis-ready notification** | How does AI team tell us analysis is done — webhook to our API? Supabase Realtime? | TBD    |
| **Prospect data**               | Do we push contact data at call-start, or does AI team pull from our API?          | TBD    |

---

## Work Split (Backend Group — 3 members)

| Member  | Ownership                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abraham | Database setup, Supabase Auth, RLS policies, invite flow, phone_numbers table, DID lookup logic, Kamailio + Asterisk + FreePBX setup and configuration                            |
| Wil     | Billing tables, payment webhook receiver, idempotency logic, subscription tracking, crm_integrations table, OAuth token storage and refresh logic                                 |
| Kim     | Recordings table, call_queue table, agent_configs table, GPU job logging, contacts table (Apollo cache), crm_sync_log, outbound webhook firing, integration contract with AI team |

---

## Open Questions

- **Payment gateway**: Which provider specifically? Affects webhook payload format
- **Cloud storage**: S3 or GCS for audio files? Affects how `audio_url` is generated
- **DID provider**: VoIP.ms / Flowroute / other?
- **GPU compute units**: How is a billable unit defined — seconds of audio, LLM tokens, or per API call?
- **Overage policy**: What happens when an org hits their `gpu_quota`? Hard block or overage charges?
- **Admin billing access**: Exactly what can an Admin see — usage only, or also plan details?
- **CRM integrations for launch**: Are HubSpot and Zendesk both required for demo, or phased?
- **Zapier integration**: Required for launch or future feature?
- **Zendesk trigger**: What defines whether a call creates a ticket — any objection, or specific issue types?
- **sip_session_id**: Who generates it and what format?
- **AI team event system**: How does AI team signal analysis is complete — webhook, Supabase Realtime, or Redis?
- **Audio delivery to Deepgram**: WebSocket, RTP, or HTTP chunked stream from Asterisk?
