# Merging the SIP Demo Console into the DialForge Frontend

**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-24 (2026-07-23: re-validated against the 2026-07-22 frontend update, every binding target survived, all decisions hold, added section 5 gap analysis. 2026-07-24: added the "(SIP needed)" injection rule for flow-required controls the screens lack)
**Status: design only. Nothing in this doc is built.**
**Driver:** Danish, 2026-07-20: merge the demo UI into the frontend UI, after the frontend team delivered its newest code into the shared repo.
**Builds on:** [Step 5, the demo console](../design-docs-sip/sip-loop-mvp-step-by-step-guidence/step5-pm-demo-ui.md) and [Step 6, the Supabase sync](../design-docs-sip/sip-loop-mvp-step-by-step-guidence/step6-supabase-sync.md)
**Delivery record:** [`frontend-delivery-log.md`](./frontend-delivery-log.md)

**Goal:** the live SIP call demo runs inside the frontend team's real product screens, not inside a console we built for ourselves.

**Non-goals, stated up front so this does not grow:**

- Not converting the frontend to Next.js or React. That is a real project and it is not this one.
- Not making all 31 screens functional. Five screens carry the demo; the rest stay honest mockups.
- Not building real authentication. The demo login stays exactly as weak as it is today, with the same "do not expose this port" boundary.
- Not touching the voice path. Audio in, STT, LLM, TTS, audio out are untouched by everything below.

> **Sequencing note:** this work is independent of the RAG build. RAG Step 3 (call-time retrieval) changes what the agent *says*; this changes where you *watch* it say it. They touch different files and can run in either order. If both are in flight, do this one first: it is smaller, and it is what the PM actually sees.

---

## 1. Why this step: we are demoing the product inside a page that is not the product

Two things in this repo both look like DialForge, and neither one is the whole thing.

| | What it is | What it can do |
|---|---|---|
| **The frontend** (`dial-forge-front-end/`) | 31 static HTML screens, the real product design, delivered 2026-07-20 | Looks exactly right. Does nothing. There is not a single `fetch`, `EventSource`, or `WebSocket` in the entire set |
| **The demo console** (`dial-forge-ai/sip/demo-ui/`) | A small Python server plus four hand-written pages, built in Step 5 | Places real calls, streams a real transcript, runs real post-call analysis, mirrors to Supabase. Looks like a developer tool |

Every SIP demo so far has been given on the second one. That was the right call in Step 5: the frontend at that point was a set of design references, and coupling the SIP MVP to another team's build would have slowed both teams down. What changed on 7/20 is that the frontend is no longer a reference drop. It is committed to the shared repo as the frontend team's own working tree, and it covers the screens our demo needs.

So the ask is not cosmetic. It is: **stop asking the PM to imagine the product while looking at something else.** Everything Steps 5 and 6 proved should appear inside the screens the frontend team designed, and our own pages should stop being what anyone outside the AI team sees.

The trap to avoid is treating this as a copy-paste job. The demo console is not markup. It is a session layer, a live event stream, call control through Asterisk, and an on-demand analysis endpoint. The frontend is markup with no data path at all. The real question is which side becomes the shell and which side becomes the engine.

---

## 2. What each side actually is today

### 2.1 The frontend delivery

31 standalone HTML pages plus 3 image assets. No build step, no package file, no framework: every page is a complete document you can double-click. Tailwind arrives as a browser script from a CDN, fonts and icons come from Google, and pages navigate to each other with ordinary relative links in a duplicated sidebar.

The screens that matter for a call demo already exist and are already laid out for it:

| Screen | What it already shows |
|---|---|
| `login.html` | Sign-in form, styled, with a submit button that does not submit anywhere |
| `Dashboard.html` | Home, with the sidebar and header that every other page repeats |
| `activeCall.html` | The live call screen: a transcript panel with auto-scroll already written, a second compact transcript in the right rail, a call timer, a status indicator, a live badge, mute / hold / transfer / record / voicemail-drop controls, an objection-alerts panel, and an AI coaching bubble |
| `postCallSummary.html` | Call completed, AI call summary, final notes, next steps, update pipeline stage |
| `callHistory.html` | Call logs, sortable and filterable, with CSV export |

Two things about this delivery are worth knowing before planning against it.

**It is a real step up from the 0708 reference drop, not a re-export.** The five screens above grew four to six times in size. The reason is a shared application shell that was not in the 0708 delivery at all: a persistent header with a call timer, an incoming-call overlay, an active-call bar, a New Call dialog, a slide-out CRM rail, and a browser-side call state object that the pages share. The design language did not change at all. The machinery around it did.

**Every screen is wired to fake data, and some of it moves.** The live call screen ships three example transcript bubbles and, more importantly, a timer that appends another canned bubble every eight to twelve seconds, plus a coaching tip that rotates every fourteen seconds. The dashboard, call log, contacts, dialer, and coaching screens each render from a hardcoded array. This is exactly what a design deliverable should do, and it is also the single most dangerous thing in this merge: invented sentences arriving in the transcript during a real call, in front of the PM, is worse than no transcript at all. Decision E deals with it.

### 2.2 The demo console

Roughly 1,100 lines of Python and 1,900 lines of front-end, of which half is a stylesheet. No web framework and no build step, though the common shorthand "stdlib only" is not quite true: two libraries are imported, one for HTTP calls out and one for the analysis model.

Its whole external surface is small enough to write down: fifteen routes, one event stream, six event kinds. That is the thing worth preserving. Exact paths and payloads are in the appendix.

The parts that carry the demo:

| Capability | Where it lives |
|---|---|
| Sign in, session cookie, "who am I and which business am I" | Login endpoint plus an in-memory session table |
| Place a call, cancel a ring, hang up | Call and hangup endpoints, which reach Asterisk over ARI |
| Live everything: transcript turns, pipeline stage lamps, raw log lines, ring state | One event stream the browser opens once and the server pushes to |
| Post-call analysis, on demand only | Analysis endpoint, deliberately not automatic because it costs a paid model call |
| Call history, knowledge-base viewer | History and knowledge-base endpoints, reading local files |
| Supabase mirror | Best-effort, off the hot path, never affects the call |

> **What's the event stream:**
> The browser opens one long-lived HTTP connection and the server keeps writing lines into it. Simpler than a two-way socket, and one-way is all a display needs. Each line is a small JSON object with a `type` field saying what happened.

### 2.3 The one lucky fact: the two sides already fit

This merge is much smaller than it sounds, for three reasons that are worth stating plainly because they drive every decision below.

1. **The frontend already has the hooks.** Its live call screen names a transcript container, a compact transcript, a call timer, a status indicator, and a live badge, and it already ships the auto-scroll behaviour for the transcript and the function that builds a transcript bubble. We are filling elements that exist, not restructuring pages.
2. **The frontend already has a call state object.** The shared shell keeps call status, caller, and elapsed time in one browser-side object and exposes it globally, and the header timer and active-call bar read from it. That is an integration seam the frontend team built for themselves and we can use as-is: drive that object from live events and several pieces of the shell follow without being touched.
3. **The call log is the cleanest target in the delivery.** Its rows are not a table but a grid where every row carries its whole record on the element itself, as name, number, direction, status, duration, timestamp, and score attributes. The existing sort, filter, and CSV export all read those attributes. Emit rows in that shape and all three keep working with no changes.
4. **The frontend already navigates the way a served folder wants.** Sidebar links are plain relative links to sibling files, so serving the folder over HTTP works without touching a single link.
5. **The demo server already serves a folder of static pages.** Pointing it at a different folder is a small change, not an architecture change.

The mismatch is in the middle: the demo server hands out its four hand-written pages from a fixed list of filenames, and those four pages are the only things that know how to read the event stream.

---

## 3. The decisions, and why

### A. The frontend's HTML becomes the shell. The demo server stays the engine.

The requirement is that the PM sees the real product screens. The tension is that the frontend team owns those screens and ships new versions of them, while we own the only working data path and cannot stop demoing while a rewrite happens.

| Option | What it means | Why not, or why yes |
|---|---|---|
| **A. Restyle our console to look like DialForge** | Rewrite our two sales pages in the frontend's colours and type | Cheapest thing that looks right, most expensive thing to keep right. It creates a third copy of the design that drifts the day the frontend ships a new screen, and the PM is still not looking at the real product |
| **B. Serve the frontend's pages, bind live data into them (chosen)** | The demo server serves the frontend folder, and one added script fills the elements that already exist from the event stream that already exists | The PM sees the real product. The frontend team keeps owning the design. Cost is one new script file plus one line added to each live page |
| **C. Rebuild the frontend inside the Next.js app** | Convert 31 pages into components, with real routing and real auth | This is the right production answer and it is where we end up. But it is a conversion project against markup that is still changing week to week, and it puts the demo behind weeks of work that does not change what the demo shows |
| **D. Hand the frontend team an API and let them build the data layer** | We publish the contract, they consume it | The correct long-term division of labour. It is not available now: the frontend team has no server and no backend experience yet, so nothing is demo-able for weeks. Danish asked for a merge, not a handoff |

**Choosing B, and the reasoning chain:**

1. Danish's complaint is about what the PM sees, not about our architecture. B changes what the PM sees in days. C changes it in weeks and shows the same thing at the end.
2. The frontend markup already carries the element hooks we need, so most of the binding work has effectively already been scoped by the frontend team's own naming.
3. B produces exactly the artifact C needs later. Writing down the contract between "screens" and "live data" is the first step of any React conversion, and doing it in plain JavaScript first means C starts from a proven contract instead of a guess.
4. B keeps one owner per file. We never rewrite their HTML, so a new delivery does not create a merge conflict against work we did inside their markup.

**Why not A:** because the failure mode is silent. Nobody notices a restyled copy has drifted until the PM points at a screen and says that is not what the design looks like.

### B. One origin: the demo server serves the frontend folder

The frontend could run from any static file server, on its own port, calling our API. It should not, for now.

Our server sends no cross-origin headers at all today, so a second origin means adding cross-origin support, credentialed cookies, and preflight handling before anything works. That is real work whose only benefit is separating two things that are being merged. Serving both from one process removes the problem instead of solving it: same origin, cookies just work, no preflight, no configuration.

The change on our side is to stop serving pages from a fixed list of four filenames and serve the frontend folder instead, with the API paths kept exactly where they are.

**Why not two origins:** the moment the frontend team runs their own server, this is worth revisiting. Until then it is configuration nobody needs.

### C. Only five screens go live. The other 26 stay mockups.

The demo path is: sign in, land on the dashboard, place a call, watch it, hang up, read the summary, find it later in history. That is five screens.

| Screen | Goes live because |
|---|---|
| `login.html` | The session cookie has to come from somewhere, and every other page is behind it |
| `Dashboard.html` | It is where sign-in lands, and it holds the sidebar. Only the call entry point needs to be real |
| `activeCall.html` | This is the demo. Transcript, timer, status, and the hang-up control |
| `postCallSummary.html` | Where the on-demand analysis is read |
| `callHistory.html` | Proves calls persist, and is the way back into a past call |

Everything else, billing through team governance, stays a mockup. That is not a gap: they are honest mockups of features nobody has built. Naming the five is what keeps this from quietly becoming "wire up the product".

One navigation quirk to know before building the flow: the summary screen is not in the sidebar. The only way into it is the End Call button on the live call screen, which is a plain link, so it navigates whether or not a call actually ended. Getting back to a past summary has to go through the call log, which is a second reason the log is in the five.

The `powerDialer.html` and `callCoaching.html` screens are the obvious next two once the five work. They are deliberately not in the first pass.

### D. The frontend team owns the markup. We own one script file.

If we edit their HTML, every new delivery is a merge conflict against our work, and the merge cost grows with every screen. If we edit nothing, we cannot bind anything.

The line: we add exactly one script file, and one line per live page that loads it. The script itself lives in our folder, not theirs, and is served from the same origin as the pages, so their folder gains one script tag per live screen and nothing else. All binding happens by element name, from our side, at page load. Nothing we write lives inside their layout.

Two consequences that make this hold up:

- **Failure is soft.** If an element we bind to disappears in a new delivery, that piece stays a mockup and the rest of the page keeps working. Nothing throws, nothing goes blank. We find out because the transcript does not fill, not because the page dies in front of the PM.
- **The dependency is published.** The list of element names we rely on goes in the delivery log, so the frontend team knows which names are load-bearing and which they can rename freely. That is a one-table contract, not a process.

Re-applying our work to a new delivery is then one line per live page.

There are two narrow exceptions, and naming them is what keeps the rule honest. Some elements we need to fill have no name to bind to yet, so those names have to be added (section 7 lists them). And the fake-data timers on the live call screen have to be deleted rather than worked around, for the reason in decision E. Both are edits to the frontend team's files, so both are asks to that team, not changes we make quietly.

### E. The five live screens lose their fake data, and it is a delete, not an override

Decision D says we do not restructure the frontend's markup. This is the exception, and it is narrow: on the five live screens, the code that invents data has to be removed rather than worked around.

Three pieces matter, all on the live call screen:

| What it does | Why it cannot stay |
|---|---|
| Appends a canned transcript line every eight to twelve seconds | It writes into the same container we write into. During a real call the PM would watch invented customer sentences interleave with real ones, and nothing on screen would say which is which |
| Rotates a canned coaching tip every fourteen seconds | Same container as any live coaching output, and it overwrites on a timer we do not control |
| Generates a random inbound caller behind the test-inbound button | Puts the shared call state into a call that does not exist, which then disagrees with the real call state |

Turning them off from our side is not good enough. A timer started by the page's own code keeps running whatever we do afterwards, so the only reliable fix is that the code is not there. These are three small deletions in one file, and they are the one place where we do change the frontend's markup rather than adding to it. That has to be told to the frontend team rather than done quietly, because from their side it looks like their demo broke.

The other four screens render from hardcoded arrays rather than timers, so replacing the array contents is enough and nothing has to be deleted.

> **The distinction worth keeping:** a hardcoded array is a placeholder and placeholders are harmless, because the moment real data arrives it replaces them. A running timer is a second author writing to the same page, and two authors on one transcript is a correctness problem, not a cosmetic one.

### F. Fix the fragile seam now, because this merge doubles its consumers

Today the server works out what the call is doing by matching the beginning of the bridge's human-readable log text. Rewording one log line silently breaks the call state in the browser, with no error anywhere.

That has been survivable while one team owned both ends and four pages consumed it. After this merge, the frontend's screens consume the same state, and the people most likely to touch the log wording are the people least likely to know it is load-bearing.

The fix is small and does not change any wording: the bridge tags each call-state event with an explicit kind alongside the text it already sends, and the server reads the kind. The text keeps flowing for the raw log panel, unchanged. Keep the old text-matching path as a fallback for one release so a stale bridge and a new server still work together.

**Why now and not later:** this is the cheapest it will ever be. It is a handful of lines while there is one consumer, and it is a coordination problem once there are two.

### G. Vendor the external assets before this demo is load-bearing

Every page loads its CSS framework, its fonts, and its icon set from public CDNs, and 28 of the 31 pages load their imagery from the design tool's own hosting. That is normal for a design deliverable and a genuine risk for a live demo: bad conference Wi-Fi, a corporate network that blocks a CDN, or an expired image URL all break the demo in a way that looks like our bug in the middle of our demo.

Keep local copies of the framework, the fonts, and the images, and serve them from the same origin as everything else. This does not block the first build, and it should land before the merged UI is what anyone demos to someone outside the team.

Separately, and not urgent: the browser build of the CSS framework is explicitly a development tool and is not meant to ship to production. That is a real constraint on the eventual React conversion, not on this demo. Note also that the three image files shipped in the delivery are referenced by no page, so they are not part of the vendoring problem; the imagery that matters is all remote.

### H. The client phone page stays ours

The frontend set has no screen for the person receiving the call, and it should not: DialForge is a product for sales teams, and the customer never logs into it.

So the client phone page stays the demo console's own page. It is a demo prop, not a product screen. Restyle it in the frontend's colours so two windows side by side read as one demo, and leave it at that. Building a customer-facing screen into the product's design system would be inventing a product surface nobody asked for.

---

## 4. What to change, and where

**Build status (2026-07-24): the first build landed.** Server serves the frontend as site root; real sign-in; the live layer exists (event stream, transcript, call controls, history, injected Run-analysis button, tooling overlay); the three fake generators are deleted. Verified end-to-end with a simulated call over the internal event route plus a real Groq analysis (see the failures log for the Supabase caution from that test). Still pending: the vendor/ folder (decision G), the client-page restyle (decision H), the bridge explicit event kinds (decision F), and a browser-level walkthrough of all five screens.

| Where | What | New / Change |
|---|---|---|
| `dial-forge-ai/sip/demo-ui/demo_ui_server.py` | Serve the frontend delivery folder as the site root, instead of handing out four pages from a fixed filename list. API paths stay exactly where they are | Change |
| `dial-forge-ai/sip/demo-ui/demo_ui_server.py` | Send logged-out visitors to the frontend's sign-in page, and logged-in ones to the dashboard, replacing the redirect to our own chooser | Change |
| `dial-forge-ai/sip/demo-ui/live/dialforge-live.js` | The entire live layer: open the event stream, fill the transcript, drive the timer and status, render the analysis, load history, and wire the call, hang-up, and analysis buttons. Bind by element name, skip silently when an element is absent. Lives in our folder, served by our server at a path the frontend's pages can load | **New** |
| `dial-forge-ai/sip/demo-ui/live/dialforge-live.js` | Also inject the tooling overlay (raw pipeline log, stage lamps, KB viewer; section 5.1), hidden by default, and surface bridge-not-running and answer-on-the-softphone messages through the frontend's toast machinery | **New** |
| `dial-forge-front-end/login.html` | Point the sign-in form at the real login endpoint, and give the two inputs names so a password can actually be read off the form. Today the submit button wraps a plain link straight to the dashboard, so any password works | Change |
| `dial-forge-front-end/Dashboard.html` | Add the one script line, and make the call entry point place a real call | Change |
| `dial-forge-front-end/activeCall.html` | Add the one script line. Transcript, timer, status, live badge, and hang-up bind to elements that already exist. The End Call click is intercepted so the call actually ends before the page navigates to the summary | Change |
| `dial-forge-front-end/activeCall.html` | Delete the three fake-data generators: the transcript appender, the coaching-tip rotation, and the random inbound caller. See decision E | Change |
| `dial-forge-front-end/activeCall.html` | Name the contact heading and the lead-score value, which currently have no identifiers to bind to | Change |
| `dial-forge-front-end/postCallSummary.html` | Add the one script line, and make the summary panels read the on-demand analysis. The summary bullet list needs an identifier added first. The Run analysis button, which no screen has, is injected by the live layer labeled "SIP needed" until the frontend ships a designed one (section 5.1) | Change |
| `dial-forge-front-end/callHistory.html` | Add the one script line, and emit call-log rows carrying the same per-row attributes the existing sort, filter, and export already read | Change |
| `dial-forge-ai/sip/scripts/step2_stt_bridge.py` | Tag each call-state event with an explicit kind, so state is no longer inferred from log wording. Leave the existing text untouched for the log panel | Change |
| `dial-forge-ai/sip/demo-ui/demo_ui_server.py` | Read the explicit kind, keeping the text-matching path as a fallback for one release | Change |
| `dial-forge-ai/sip/demo-ui/static/` | Keep the client phone page and the stylesheet it needs. The sales pages, the chooser, and our sign-in page are replaced by the frontend's screens | Change |
| `dial-forge-ai/sip/demo-ui/demo_ui_server.py` | Delete the company-directory endpoint, which no page calls | Change |
| `dial-forge-ai/sip/demo-ui/static/style.css` | Delete the keypad and directory rules, which no page uses | Change |
| `dial-forge-ai/design-docs/frontend-sync/frontend-delivery-log.md` | Record the 2026-07-20 delivery, note that deliveries now arrive through the repo rather than as reference copies, and publish the list of element names the live layer depends on | Change |
| `dial-forge-ai/design-docs/frontend-sync/README.md` | Say that this folder is now historical reference plus this doc, and that the live frontend is at the repo root | Change |
| `dial-forge-ai/design-docs/design-docs-sip/sip-loop-mvp-step-by-step-guidence/step5-pm-demo-ui.md` | Point the demo flow at the merged screens, and correct the port, which still reads 8090 in three places | Change |
| `dial-forge-ai/sip/demo-ui/README.md` | Correct the sign-in path in the check command, and the claim that the account decides which interface you land on. Neither is true today | Change |
| `dial-forge-front-end/vendor/` | Local copies of the CSS framework, fonts, and mockup images so the demo survives a bad network. Deferred, see decision G | **New** |

---

## 5. What the SIP flow needs that the screens do not have

The merge decision says the screens become the shell. This section checks the shell against everything the SIP demo actually does, in both directions: capabilities our flow needs that no screen offers, and controls the screens offer that nothing real sits behind. The check was run against the 2026-07-22 frontend update.

The voice loop itself needs nothing from any of this. Audio, transcription, the agent's reply, and playback never touch the browser; the pages are a renderer of the event stream plus a remote control. The remote control carries exactly three commands: place a call, hang up, run the analysis. Two of the three have a home in the frontend's screens. The third does not, and it is the one gap below that blocks the flow rather than polishing it.

### 5.1 Missing from the screens

| SIP capability | In the demo console | In the frontend screens | Blocks the flow? | Resolution |
|---|---|---|---|---|
| Trigger the analysis | A Run analysis button on the sales dashboard | **No trigger anywhere.** The summary screen assumes the summary already exists | **Yes.** Analysis is deliberately on demand because every run is a paid model call. With no button, the choice is auto-run on hangup, which reverses that decision, or no analysis at all | The live layer injects the button on the summary screen, labeled "SIP needed" (the injection rule below) |
| A hang-up that hangs up | The end-call control calls the hang-up endpoint | The End Call button is a plain link to the summary screen. It navigates whether or not the call ended | **Yes.** The page moves on while the call is still live | The live layer intercepts the click: end the call first, navigate on success |
| Honest answer semantics | The ring overlay's Accept is visual; the real answer happens on the softphone | The incoming-call widget's Accept looks like it answers | Partly. Nothing breaks, but the person clicking assumes it did | On click, show "answer on the softphone" using the toast machinery the 2026-07-22 update added |
| The bridge-liveness guard | Placing a call fails with a clear message when the bridge is not running | No system-status surface exists | **Must survive.** The guard was paid for in the Step 5 debugging session | The guard stays server-side; the live layer surfaces the error in a toast |
| The raw pipeline log | A collapsible panel showing every STT partial with millisecond stamps | Nothing like it | No, but it is the debugging window, and keeping partials visible was an explicit requirement | Injected by the live layer as a collapsible overlay, hidden by default. No frontend file changes |
| The pipeline stage lamps | The five-lamp strip that flashes as each stage fires | Nothing like it | No. Pure demo effect | Fold into the same overlay, or drop |
| The knowledge-base viewer | A KB button showing exactly what the agent answers from | No KB or business-information screen exists | No, but it is how a demo shows grounding | Short term, the overlay. Long term this is the product's planned sales-script and business-information input fields (PM direction, 7/16) |
| The client's phone | Our client page | None, correctly: customers never log into DialForge | No | Decision H: the client page stays ours |

The overlay in the middle rows is a small decision in its own right. The log panel, the stage lamps, and the KB viewer are developer and demo tooling, not product screens, so asking the frontend team to design homes for them would put our tooling in their design system. Instead the live layer injects one collapsible overlay for all three, hidden until opened, and no frontend file knows it exists.

**The injection rule for missing but required controls (added 2026-07-24).** When a control the SIP flow cannot run without is missing from the screens, we do not wait for the frontend team and we do not edit their files. The live layer injects the control itself: working, styled to sit naturally in the surrounding design, and visibly labeled **"(SIP needed)"**. The label is the point. It turns every injected control into a standing, on-screen to-do that says "this belongs in the design and is not in it yet", so the AI team can walk the frontend team through the list instead of describing gaps from memory. When a screen ships its own designed version of a labeled control, the live layer binds to theirs and stops injecting ours, and the label disappears with it.

Today exactly one control qualifies: the Run analysis button on the summary screen. The tooling overlay above is deliberately **not** labeled this way, because it is not meant to enter the product design at all. The distinction: "SIP needed" marks product controls the frontend should eventually own; the overlay is ours forever.

### 5.2 Present on the screens, with nothing real behind them

The reverse direction matters for a different reason: not the correctness of the flow, but the credibility of the demo.

| Control | Today | Risk |
|---|---|---|
| Mute, hold, record, camera, screen share | Decorative. Clicking does nothing | Low. At worst awkward |
| Voicemail drop, added 2026-07-22 | Clicking shows a simulated "dropped successfully" message | **Worse than decorative: it claims an action happened.** A viewer will believe it |
| Transfer | A button exists; AI-to-human switching is a Step 7 design, not built | Medium. Clicking does nothing |
| The New Call dialog asks for a number | The demo dials one fixed line per business | Low. The live layer can ignore the field or preselect the demo contact |

The principle, in one line: **nothing on the demo path may claim success it did not have.** Decorative is acceptable; fake success is not. The voicemail-drop message is the one control that crosses that line today, and neutralizing it is an ask to the frontend team, since it lives in their file.

---

## 6. Deliverable, and how to verify it

**The observable outcome:** one browser window, signed in through the frontend's own sign-in screen, sitting on the frontend's own active-call screen, showing a real call in progress. No page in that window was written by the AI team.

Verification is the Step 5 demo flow run against the merged UI, checking the things that could plausibly break:

1. Sign in with a demo account on the frontend's sign-in page. A wrong password must be refused. Today it is not, because the button is a link.
2. Land on the dashboard. Confirm the sidebar navigates between screens without falling out of the session.
3. Place a call from the dashboard. The softphone rings.
4. Answer it. The active-call screen shows the live badge, the timer counting, and transcript turns appearing as they are spoken, in the frontend's own transcript panel.
5. Sit on the call for two silent minutes without speaking. **Nothing new may appear in the transcript.** This is the decision E check, and it is the one most likely to be forgotten, because the fake appender only fires every eight to twelve seconds and looks entirely plausible.
6. Click End Call. The call must actually end, on the softphone too, before the page reaches the summary screen. Today the button is a plain link and would navigate with the call still live.
7. The call appears in the call log, and the log's sort, filter, and CSV export still work on the real row.
8. Open it and click Run analysis: the injected button carrying the "(SIP needed)" label, until the frontend ships its own. Summary, topics, objections, and what went well render in the frontend's summary panels.
9. Click every control that has no real path behind it (mute, hold, record, transfer, voicemail drop). Nothing may claim success. Decorative silence is acceptable; a success message is a failure of this step.
10. Kill the bridge and try to place a call. The UI must still say the bridge is not running, rather than ringing into silence. That guard was paid for in Step 5's debugging session and must survive the merge.
11. Disconnect from the network and reload. Note what breaks. That is the size of the decision G problem, measured rather than guessed.

---

## 7. What this needs from the frontend team

These are asks, not blockers: the first build can proceed without them by binding to what exists today.

| Ask | Why |
|---|---|
| Treat the published element names as a contract, and tell us before renaming one | It is the entire coupling between their screens and live data |
| Adopt the "(SIP needed)" controls into the design | Any control carrying that label on a live screen is ours, injected because the flow cannot run without it (section 5.1 injection rule). Each label is a request for a designed replacement; when theirs ships, ours disappears. First on the list: the Run analysis button on the summary screen |
| Agree that the three fake-data generators on the live call screen get deleted | Decision E. From their side this looks like their demo stopped working, so it has to be agreed rather than discovered |
| Neutralize the voicemail-drop success message | Added 2026-07-22: clicking Drop shows a simulated "dropped successfully" toast with nothing behind it. On a demo path, fake success is worse than a decorative button (section 5.2). Disable it or label it coming soon until there is a real path |
| The sign-in submit should be a real form submit, not a link inside a button, and the two inputs need names | A link cannot carry a password anywhere. Today any password signs you in |
| Identifiers on the summary bullet list, the contact heading, the lead-score value, and the dashboard stat tiles | These are the places where live data has nowhere to go. Everything else we need is already named |
| Eighteen broken sidebar links | Nine pages link to a call-log path that lost its file extension, and nine to a support-queue path with an old suffix. Unrelated to this merge, and it will look like our bug once we serve these pages |
| ~~An unreplaced template placeholder in the sign-up link on the sign-in page~~ | Resolved in the 2026-07-22 update: it now navigates to onboarding |
| A repeatable way to know what changed in a delivery | Right now we diff folders. A short note per delivery is enough |
| Eventually: pull the header and sidebar out of the twenty copies | Not needed for this merge, and the biggest cost in every future frontend change. The shared shell is already forked three ways across pages that were meant to be identical |

---

## 8. Open questions

| Question | Notes |
|---|---|
| Does the merged UI replace the demo console, or run beside it during the transition? | Running both for one week is cheap insurance and costs one extra port. Beyond that it recreates the two-UIs problem this doc exists to remove |
| Which business is "mine" on the dashboard? | The demo binds each account to exactly one business, and the frontend's screens do not have that concept. The simplest answer is that the sidebar shows the signed-in account's business and there is no switcher |
| Speaker labels are written three different ways across the stack | The stored transcript, the analysis prompt, and the rendered bubbles each use their own words for the same two speakers. The merge is a natural moment to settle on one vocabulary, and a bad moment to do it silently |
| Does the frontend team keep working in the shared repo? | This doc assumes yes, since that is what the 7/20 delivery did. If deliveries go back to being copies, decision D still holds but the re-apply cost goes up |

---

## Failures log

Fill during the build: symptom, cause, fix. The Step 5 debugging table is the model, and it is the reason the bridge-liveness guard is in the verification list above.

| Date | Symptom | Cause | Fix |
|---|---|---|---|
| 2026-07-24 | Simulated test calls (curl to the internal event route) appeared in the shared Supabase project as real recordings | The mirror does not know a test from a call: any event stream that reaches the server syncs when the mirror is on | Deleted the test rows (topics, analysis, transcript, sip_calls, recordings, in that order, child tables first). **Caution for future testing: simulate with the mirror off, or clean up after** |
| 2026-07-24 | A design risk caught before it shipped: on an SSE reconnect mid-call, the browser would have replayed the whole call's turns on top of the ones already rendered | The connect-time snapshot replays the full call, and the live events had already drawn some of it | The live layer clears the transcript and replays from the snapshot every time a call connects, so a reconnect redraws instead of duplicating |

---

## Appendix - build-time specifics (skip on a first read)

### A1. The demo server's HTTP surface

Runs on port **8400**, bound to all interfaces. Only GET and POST are implemented.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | no | Redirects to the chooser when signed in, otherwise to sign-in |
| GET | `/login.html`, `/home.html`, `/sales.html`, `/client.html`, `/style.css`, `/sales.js`, `/client.js`, `/home.js` | mixed | Hardcoded filename allowlist, not a directory mount. This is what decision B replaces |
| GET | `/app.html` | no | Legacy redirect to `/sales.html` |
| GET | `/api/me` | yes | `{name, company, company_key, extension}` |
| GET | `/api/companies` | yes | Dead: no page calls it |
| GET | `/api/knowledge-base/<company_key>` | yes | `{company, markdown}`. No ownership check: any signed-in user can read any company's knowledge base |
| GET | `/api/calls` | yes | List. `turns` here is a count, not the array |
| GET | `/api/calls/<call_id>` | yes | Full record |
| GET | `/api/events?role=sales\|client` | yes | The event stream |
| POST | `/internal/events` | loopback IP only | `{tag, text, ms}` from the bridge |
| POST | `/api/login` | no | `{email, password}`, sets `demo_session` cookie |
| POST | `/api/logout` | yes | |
| POST | `/api/call` | yes | `{direction: "sales_to_client" \| "client_to_sales"}`. 502 if the bridge heartbeat is stale |
| POST | `/api/hangup` | yes | |
| POST | `/api/analyze/<call_id>` | yes | Runs the paid analysis, returns the record with `analysis` filled |

No cross-origin headers, no preflight handler, no cross-site request token. The session cookie is `demo_session`, HttpOnly, SameSite=Lax, no Secure flag, sessions held in memory so a restart signs everyone out.

### A2. The event stream

`GET /api/events?role=sales|client`. Every frame is an unnamed `data:` frame carrying JSON with a `type` field. An idle stream emits a comment every 15 seconds so the connection stays open; the browser reconnects on its own after 2 seconds.

| `type` | When | Fields |
|---|---|---|
| `snapshot` | once, on connect | `current_call`, `ringing`, `recent_log` |
| `pipeline_event` | every bridge log line except the heartbeat | `tag`, `text`, `ms`, `raw`, plus `at_sec` on transcript turns |
| `incoming_call` | a call is placed | `direction`, `caller`, `target_role`, `company` |
| `call_connected` | the bridge reports the call arrived | `call` |
| `call_ended` | the bridge reports the call ended | `call` |
| `call_cancelled` | hang-up while only ringing | none |
| `analysis_ready` | analysis finished | `call`, sent to `role=sales` only |

Role filtering is exactly one line of server code, on `analysis_ready`. Everything else, transcripts included, reaches both roles and is hidden in the browser. That is a display separation, not an access boundary, and the merge does not change it.

### A3. Stored shapes

Call record, one JSON file per call under `call-history/`:

```
id, channel_id, started_at, ended_at, dialed_by, company, direction,
caller, turns[], analysis, analysis_error, recording_id, analysis_synced,
contact_name
```

A transcript turn: `{role: "customer" | "agent", text, at_sec}`, where `at_sec` is seconds from the start of the call, used to jump the transcript from a topic chip.

Analysis object: `summary`, `caller_name`, `caller_phone`, `key_topics[{name, start_time, end_time}]`, `objections[{timestamp, speaker, exact_quote, reason, suggestion}]`, `what_went_well[{timestamp, speaker, exact_quote, reason}]`.

Two naming traps worth knowing before writing the render code: `objections` is stored in Supabase under a different column name, and the model sometimes writes a speaker label that does not match the one the prompt asked for.

### A4. Frontend binding contract

From the 2026-07-20 delivery. This list is what goes in the delivery log as the published contract, split by whether the name already exists.

**Exists today, bind directly:**

| Screen | Name | Filled with |
|---|---|---|
| `activeCall.html` | `transcript-feed` | Transcript turns. Auto-scroll and a bubble-builder are already written by the frontend, so match their bubble markup rather than inventing one |
| `activeCall.html` | `right-transcript` | Compact transcript in the right rail. Note the frontend's own simulator never writes here, so it is currently static |
| `activeCall.html` | `coach-title`, `coach-text` inside `ai-coach-bubble` | Live coaching output, once there is any. Empty until then |
| `activeCall.html` | `objection-alerts` | Objections, once detection is live. Empty until then |
| `activeCall.html` | `badge-live`, `status-badges` | Connected or idle state |
| `activeCall.html` | `endCallBtn` | Real hang-up. Today it is wrapped in a link straight to the summary screen, so the navigation happens whether or not the call ended |
| `activeCall.html` | `btn-mute`, `btn-hold`, `btn-transfer`, `btn-record`, `btn-vm-drop` | Stay decorative in the first pass. Transfer is the Step 7 handover design and is not in scope here |
| shared shell | `callTimerContainer`, `callTimerText`, `activeCallBar`, `activeCallName`, `activeCallCompany`, `activeCallDuration`, `activeCallStatusLabel` | The persistent header timer and call bar, repeated on about twenty pages |
| shared shell | the browser-side call state object | Preferred seam: set status, caller, and elapsed time on it and the header timer and call bar follow |
| `callHistory.html` | `tableBody`, `resultsCount`, `noResultsRow` | Rows. Each row must carry name, number, direction, status, duration, duration label, timestamp, date label, and score as attributes, or sort, filter, and CSV export stop working |
| `login.html` | `loginForm` | Real sign-in |

**Missing, has to be added before it can be bound:**

| Screen | What needs a name |
|---|---|
| `login.html` | The email and password inputs. Neither has an identifier or a form name today |
| `activeCall.html` | The contact heading and company subtitle, and the lead-score value and its bar |
| `postCallSummary.html` | The AI call summary bullet list, the duration and time stamps in the header |
| `Dashboard.html` | The four stat tiles |

**Two notes for whoever writes the render code:**

The dialer and the call log use attribute selectors rather than identifiers for their live values. Respect that: their existing logic reads the attributes, so filling the attributes is what makes their features keep working.

The coaching screen's per-call object is, by accident, close to the shape of our post-call analysis: a scored breakdown, a mood, a talk-to-listen ratio, key moments with timestamps and quotes, notes, and a full transcript with speaker and time. If that screen ever goes live it is worth mapping our analysis onto their shape rather than inventing a third one.

Design tokens, for restyling the client phone page to match: `fire-orange #FF7A1C`, `fire-red #FF2200`, `fire-accent #FFAD1C`, `ai-purple #9B6DFF` for anything the AI produced, `#00e478` for connected and positive, `#FF3B30` for hang-up and alerts, surface `#12131a` with cards at `#1a1b23`, body text `#e3e1ec`. Dark theme only: a light toggle exists but there are no light styles behind it. Headings in Syne, body in DM Sans, numbers in JetBrains Mono. Cards are glass: translucent dark fill, heavy backdrop blur, a one-pixel white border at five percent.

### A5. Running it, unchanged by this merge

Two terminals, both from `dial-forge-ai/`, both on the repo virtual environment. Using the system Python instead is what caused the Step 5 debugging session.

```bash
# terminal 1 - the voice pipeline
venv/bin/python -u sip/scripts/step2_stt_bridge.py

# terminal 2 - the server
venv/bin/python sip/demo-ui/demo_ui_server.py
```

Check it is up:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8400/login.html
```

Expected: `200`. Note the path: `/login` alone returns 404, which the demo console's own README currently gets wrong.

Demo accounts, password `demo123` for all: `alice@pacificbeef.com`, `dana@pacificbeef.com` for Pacific Beef Trading on line 1000; `bob@globifye.com`, `marcus@globifye.com` for GlobiFYE on line 2000.

---

## Next

No follow-on doc yet. The natural sequel, once the five screens are live and stable, is the React conversion described as option C in decision A, which should start from the contract in A1 through A4 rather than from the markup.
