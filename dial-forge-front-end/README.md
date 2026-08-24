# Front-End Overview

This folder contains the work of the GlobiFYE front-end subteam for the DialForge platform.
This document provides an overview of the tech stack, project structure, and key components.

## 1. Product overview
DialForge is a sales‑focused VoIP platform for:
- Sales teams (SDRs/AEs) – power dialer, AI live coaching, CRM pipeline.
- Support teams – inbound queue, IVR, SLA, CSAT.
- Solopreneurs – simple setup, one number, basic AI.

Core value: Reduce time to first call to <30 seconds, increase connect rates by 40% with real‑time AI coaching, and increase pipeline conversion by 25%.

## 2. Features
Note: All pages have navigation, usage tracking, test calling, new calls, CRM side panel, dial pad, and theme switching features. The theme switching has not been implemented yet, but will be soon.

| Page | Features on page |
| -------- | -------- |
| Landing page | &bull; Persona cards<br>&bull; Integrations strip<br>&bull; Pricing table |
| Login | &bull; Username and password fields<br>&bull; Sign up option |
| Onboarding | &bull; 7 onboarding steps: persona selection, create account, company setup, number selection, integration selection, and audio setup |
| Dashboard | &bull; Recent activity<br>&bull; Call statistics<br>&bull; Leaderboard<br>&bull; Tasks |
| Active Call| &bull; Live transcript<br>&bull; AI coach<br>&bull; Call controls such as mute, hold, transfer, screen share, camera, notes, VM studio, recording, and VM drop |
| Support Queue | &bull; Live queue with sorting and pick up or assign functionalities<br>&bull; Agent status queue<br>&bull; IVR builder module |
| Call Coaching | &bull; KPI card detailing talk ratio, patience, objective handling, and close signals<br>&bull; List of past connected calls<br>&bull; Playback recording functionality with waveform bars, speed controls, key moments, and full transcript |
| Power Dialer | &bull; Prospect queue<br>&bull; Contact importing which includes CSV parsing and duplication detection<br>&bull; Search/filtering<br>&bull; Calling states<br>&bull; VM drop<br>&bull; Call controls such as hang up, skip, and record |
| CRM Sales Pipeline | &bull; Deals<br>&bull; Deal stages<br>&bull; Deal values<br>&bull; New deal modal functionality |
| Call History | &bull; Call records such as call duration, Call status<br>&bull; Synchronization with Dashboard and Active Call<br>&bull; Calling functionality |
| Contacts | &bull; Contact management<br>&bull; Contact details such as notes, email and deal logging<br>&bull; Calling Contacts |
| Integrations | &bull; Third-party integrations<br>&bull; API connections including API stats cards |
| Numbers | &bull; Number management<br>&bull; Number assignment and configuration<br>&bull; Buy number module |
| Billing & Subscription | &bull; Subscription management<br>&bull; Invoice history with downloading functionality |
| Team & Roles | &bull; Team management<br>&bull; Member invite management <br>&bull; Role-based access control<br>&bull; Team member performance tracking |
| Settings | &bull; User preferences such as appearance and audio<br>&bull; calling settings such as recording and routing<br>&bull; Compliance settings such as DNC protection and regulatory preferences<br>&bull; Teams settings such as access protocols<br>&bull; Security settings such as authentication and access control<br>&bull; API & webhooks settings such as API access and Webhooks endpoint URL<br>&bull; Notification settings such as real time alerts and delivery preferences |
| Notifications | &bull; Notification categories<br>&bull; Load more functionality |
| Profile | &bull; User information including profile picture, name, and company information<br>&bull; cross-page synchronization |

## 3. Local Development Setup
### Prerequisites
- Python 3.x
- A modern web browser
- The DialForge front-end files

### Project Structure
Note: This is given in more detail in the [Main Navigation](#6-navigation-and-page-relationships) section of this document.

```text
dial-forge/
└── dial-forge-front-end/
    ├── localHost/
    │   └── dial_forge_front_end_server.py
    ├── landingPage.html
    ├── Dashboard.html
    ├── activeCall.html
    └── ...
```
### Starting the local server
From the main dial-forge root:
```bash
python3 dial-forge-front-end/localHost/dial_forge_front_end_sever.py
```

Then open http://localhost:8000 in a browser.

**Verify it is up:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/landingPage.html
```

Expected output: `200`

### Stopping the server
Press:
```text
Ctrl + c
```
in the terminal running the server.

**Verify it is down:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/landingPage.html
```

Expected output: `000`

## 4. Application Architecture
The overall structure of the pages, such as shared state and local storage.

### Shared State
| Page (Writes) | Storage Keys | Used By (Reads) |
|------|-----------------|---------|
| Onboarding & landing page | dialforgeState | Dashboard, Onboarding 1-6, Profile |
| Active Call | dialforgeCallState | Active Call, Profile, Call History, Post Call, Dashboard |
| Dashboard (All pages) | dialforge-crm-panel-open | All pages with a CRM side panel |
| Dashboard (All pages) | dialforgeDialPadNumber | Active Call |
| Dashboard & Post Call | dialforge-dashboard-tasks | Dashboard, Post Call |
| Active Call & Post Call | dialforgeLastCompletedCall | Post Call Summary, Call History, Dashboard, Sales Pipeline |
| Post Call & Dashboard| dialforgeCallHistory | Call History and Post Call |
| Post Call | dialForgeState | All pages |
| Sales pipeline & Post Call | dialforge_pipeline_deals_v1 | Sales Pipeline, Dashboard, and Post Call |
| Power Dialer | dialforge-voicemails and dialforge-active-voicemail | Power Dialer (the voicemails came from the Active Call VM drop modal as the source of truth) |
| Power Dialer to Active Call | powerDialerState | Power Dialer and Active Call |
| Power Dialer & Contacts | dialforgeCallAutoStart | Active Call |
| Power Dialer & Contacts | dialforgePowerDialerProspect | Active Call |
| Profile | dialforge-profile-picture | All pages with the left navigation |
| All pages | storageKey | All pages with a CRM side panel |


Note: Look at the table below for more information. dialforgeState and dialForgeState are different keys.

### Local Storage
| Page (Writes) | Storage Key | Variables | Purpose | Used By (Reads) |
|------|-------------|-----------|---------|---------|
| Onboarding & Landing page | dialforgeState | &bull; onboarding: firstName, lastName, password, teamSize, industry, specializations<br>&bull; selectedPersona<br>&bull; user: company, email, name, role, tier | &bull; onboarding: what the user fills in<br>&bull; selectedPersona: the first step of the onboarding process and from the landing page if the persona cards are clicked<br>&bull; user: default user information |Dashboard, Onboarding 2-6, Profile |
| Dashboard (All pages) | dialforge-crm-panel-open | true or false | to keep the CRM side panel open or closed when navigating between pages | All pages with the CRM side panel |
| Dashboard (All pages) | dialforgeDialPadNumber | &bull; number | &bull; to save the number typed in the dial pad for Active call | Active call |
| Dashboard & Post Call | dialforge-dashboard-tasks | &bull; 0: id, title, description, dueTime, priority, completed | &bull; to keep track of the tasks that need to get done | Dashboard, Post Call |
| Active Call | dialforgeCallState | &bull; Call: contact: name, number, company, jobtitle, location, avatar, email, dealValue, pipelineStage, recentCalls, topDeals<br>&bull; S: cameraModalOpen, cameraPiPVisible, quickNoteModalOpen, screenShareModalOpen, screenSharePreviewVisible, transferModalOpen, vmStudioModalOpen<br>&bull; aiCoachIndex<br>&bull; callHistory | &bull; Call: contact: to display the contact information of the person that is being called<br>&bull; S: to keep track of what modal is open or the PiP that is being displayed<br>&bull; aiCoachIndex: to keep track of what hardcoded message to display next<br>&bull; callHistory: for call information that Call History can read | Active Call, Post Call Summary, Call History, Dashboard |
| Active Call & Post Call | dialforgeLastCompletedCall | &bull; callData: duration, durationFormatted, timestamp<br>&bull; contact: avatar, dealValue, email, jobTitle, name, number, pipelinestage | &bull; callData: to store the data of the last completed call<br>&bull; contact: to store the contact information of the person that was called (this is the shared state from Active Call) | Post Call Summary, Call History, Dashboard, Sales Pipeline |
| Post Call & Dashboard| dialforgeCallHistory | &bull; 0: avatar, company, dateLabel, direction, duration, durationLabel, name, number, score, status, timestamp | &bull; information about the call to be added to the Call History log | Call History and Post Call |
| Post Call | dialForgeState | &bull; APP_STATE: callHistory, usageMinutes, maxUsagesMinutes | &bull; used to store and update the usage minutes | all pages |
| Post Call | dialforgeCallDraft | &bull; draftData; contact, callData, finalNotes, syncToCRM, savedAt | &bull; to have the note that the user wrote persist after reloading | Post Call |
| Sales Pipeline & Post Call | dialforge_pipeline_deals_v1 | &bull; 0: company, contactEmail, contactPhone, dateCreated, id, jobTitle, logo, name, stage, value, winProb | &bull; information about the caller to be added to the Sales Pipeline page | Sales Pipeline, Dashboard, and Post Call |
| Power Dialer | dialforge-voicemails and dialforge-active-voicemail | &bull; 0: id, title, createdAt, duration, isActive, notes 1: id, title, createdAt, duration, isActive, notes 2: id, title, createdAt, duration, isActive, notes<br>&bull; id, title, createdAt, duration, isActive, notes | &bull; voicemails: a list of voicemails that can be used<br>&bull; activeVoicemail: the currently active voicemail | Power Dialer (the voicemails came from the Active Call VM drop modal as the source of truth) |
| Power Dialer | powerDialerState | &bull; CALLS: avgWaitTime, connectedTotal, currentProspectIndex, currentTimer, demosSetTotal, dialedTotal, isDialing, sessionDuration, sessionDuration, sessionInerterval, sessionStartTime, timerInterval<br>&bull; callHistory:<br>&nbsp;&nbsp;&nbsp;&nbsp;- 0: avatar, company, connectedAt, duration, id, name, phone, priority, status, title<br>&bull; dialQueue:<br>&nbsp;&nbsp;&nbsp;&nbsp;- avatar, company, connectedAt, duration, id, name, phone, priority, status, title<br>&bull; avgCallDuration, callsAttempted, connectedCalls, sessionTime, skippedCalls, voicemails | &bull; CALLS: total call values and current calling time<br>&bull; the current call information<br>&bull; dialQueue: a list of all of the caller information from the Power Dialer, including the imported contacts<br>&bull; sessionStats: current session stats from the Power Dialer | Power Dialer and Active Call |
| Power Dialer & Contacts | dialforgeCallAutoStart | true | &bull; a flag that tells Active Call that the caller information is from Power Dialer | Active Call |
| Power Dialer & Contacts | dialforgePowerDialerProspect | &bull; activeCallContact: name, number, company, jobTitle, location, avatar, email, dealValue, pipelineStage | &bull; to map the Power Dialer's contact information to the contact layout of Active Call | Active Call |
| Profile | dialforge-profile-picture | &bull; image | &bull; the changed profile picture | All pages with the left navigation |
| All pages | storageKey | true or false | to open or close the CRM panel | All pages with a CRM side panel |


## 5. Data Flow
 This section explains how the data moves through the pages (the important relationships).

### Landing page and onboarding data
```text
Landing page (persona)
    ↓
Onboarding (1-5)
    ↓
Shared User State
    ↓
Profile/Dashboard
```

### Dial pad
```text
Dial Pad
    ↓
dialforgeDialPadNumber
    ↓
Active Call
```

### Power Dialer
```text
Power Dialer
    ↓
powerDialerState
    ↓
Active Call
    ↓
dialforgeLastCompletedCall
    ↓
Post Call
    ↓
Call History/Sales Pipeline
```

#### Import
```text
Import modal
    ↓
Prospect queue
    ↓
Active Call 
```

### Pipeline
```text
Sales Pipeline
    ↓
dialforge_pipeline_deals_v1
    ↓
Dashboard/Post Call
```

### Post Call
#### Schedule Follow-up button
```text
Post Call
    ↓
dialforge-dashboard-tasks
    ↓
Dashboard Today's Tasks
```
#### Call completed button
```text
Post Call
    ↓
dialForgeState
    ↓
Top bar usage minutes (for all pages)/Call History
```

### Profile
#### Start Call button
```text
Profile (Start call button)
    ↓
Power Dialer
```
#### Log Out button
```text
Profile (Log Out)
    ↓
Landing page
```

### Call Data
```text
Active Call
    ↓
Post Call
    ↓
Call History/Sales Pipeline
    ↓
Dashboard (Recent Activity & Pipeline Velocity)
```

## 6. Navigation and Page Relationships
 This section explains how pages are connected.
### Main navigation (The side navigation on each page)
```text
Landing page
    ↓
Login or Onboarding
    ↓
Dashboard
    ├── Active Call
    |   └── Post Call
    ├── Support Queue
    ├── Call Coaching
    ├── Power Dialer
    ├── Sales Pipeline
    ├── Call History
    ├── Contacts
    ├── Integrations
    ├── Numbers
    ├── Billing & Subscription
    ├── Team Governance
    ├── Settings
    |   ├── General
    |   ├── Calling
    |   ├── Compliance
    |   ├── Team & Roles
    |   ├── Security & SSO
    |   ├── API & Webhooks
    |   └── Notifications
    ├── Notifications
    └── Profile
```

### Other special navigation paths 
```text
Dial pad → Active Call
Power Dialer → Active Call
Call History → Active Call
Contacts → Active Call
Profile → Power Dialer
Profile → Landing page
Post Call → Power Dialer
```


## 7. UI/Design System
 This section details what visual conventions are used.

- Visual style: Glassmorphism + liquid glass (backdrop‑filter blur(20px), semi‑transparent backgrounds, subtle borders, soft gradients).
- Colors:
  <br>Primary: fire (#FF4D1C), fire2 (#FF7A1C), fire3 (#FFAD1C)
  <br>Secondary: green (#00E87A), blue (#1C8AFF), purple (#9B6DFF), red (#FF3B30), teal (#00D4C8).
  <br>Background: dark palette (#07080F, #0B0C16, #0E0F1B, etc.)
  <br>Text: #EDEDFA (primary), #7878A0 (secondary), #3C3C5A (muted).
- Typography: Syne (headings), DM Sans (body), JetBrains Mono (numbers/durations).
- Spacing: 4px grid – use 4, 6, 8, 12, 16, 20, 24, 32px.
- Borders: radius 4px, 8px, 12px, 16px, 100px.
- Shadows: subtle, medium, large (glass‑friendly).
- Animations: 0.22s ease, spring transitions for interactive elements.
- Responsive breakpoints: 900px and 600px.

### Responsiveness
- On screens <900px, grid layouts adjust, and the right CRM panel is hidden
- On screens <600px, everything on the page is stacked

### Accessibility 
- Keyboard shortcuts: Esc closes all modals, Cmd/Ctrl+K opens dial pad, M toggles mute (during call), H toggles hold, Space toggles play/pause in call coaching
- ARIA labels for interactive elements
- Focused outlines
- Proper heading hierarchy

## 8. Persistence & Synchronization
Detailed explanation of what persists after refresh, what persists between pages, what is in local storage, which pages share the same state, and what page is the source of truth for each data type.

### Local storage
Local storage values persist across page refreshes until they are explicitly overwritten, removed, or cleared by the application.

### Cross-page Synchronization
The following data is currently synchronized between pages through localStorage:

- Profile picture - updated on Profile and used by pages with the shared navigation
- Usage minutes - updated after calls and displayed across the application
- Caller information - shared between Power Dialer, Active Call, Post Call, Call History, Dashboard, Contacts, and Sales Pipeline
- Call History - shared between Post Call, Call History, and Dashboard
- Tasks - shared between Post Call and Dashboard
- Pipeline deals - shared between Sales Pipeline, Post Call, and Dashboard 

### Source of truth
| Data | Source of truth |
|------| ----------------|
| Dial Pad | Dashboard |
| VM Drop in Power Dialer | Active Call |
| Profile Picture | Profile |
| Power Dialer prospects | Power Dialer |
| Call state | Active Call |
| Pipeline deals | Sales Pipeline |

Note: Call History reads and displays the data that Post Call creates.

## 9. Pages requiring additional development/integration
The following pages have planned functionality that requires additional development beyond the current front-end implementation.

| Page | Additional development needed |
|------|-------------------------------|
| Active Call | AI functionality |
| Call Coaching | AI functionality |
| Power Dialer | Voicemail integration |
| Call History | Backend/database integration |
| Integrations | API integration |
| Profile | Recording playback integration |

## 10. Known Limitations
- Theme switching is not yet implemented
- Some pages don't have responsive logic yet
- Some Stitch-provided image links may become unavailable
- Settings changes are not yet connected to application behavior
- The Landing page needs a demo video and additional pages such as About Us and Help Center (these pages are under the SUPPORT, PRODUCT, and COMPANY subheadings in the footer of the landing page)

## 11. Future Work

### Planned integrations
- Connect Integrations to actual APIs
- Connect the Profile Playback button to call recordings
- Connect the VM drop voicemails and recordings 
- Connect Settings to the pages affected by each setting
- Connect Notifications to application events and data

### Standalone pages
The following pages currently function primarily as standalone front-end interfaces and do not yet share application data beyond existing shared state such as profile picture and usage minutes:

- Support Queue
- Integrations
- Numbers
- Billing & Subscription
- Team Governance
- Settings
- Notifications
