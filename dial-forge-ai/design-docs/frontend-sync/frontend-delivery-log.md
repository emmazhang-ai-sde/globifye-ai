# Frontend Delivery Log

Tracks when the frontend team sends us new HTML deliverables, so we always know what's current vs. historical.

---

## Deliveries

| Date | Delivery | Sender | File / Folder |
|------|----------|--------|----------------|
| 2026-06-01 | "Stitch" — Power Dialer + Active Queue design reference | Kahlan | [`Stitch.html`](Stitch.html) |
| 2026-06-05 | Live transcription — real-time transcription + analysis screen | Kahlan | [`liveTranscription.html`](liveTranscription.html) |
| 2026-07-08 | Full DialForge UI (36 files: dashboard, onboarding, active call, settings, etc.) | Kahlan | [`GlobiFYE-Front-end-DialForge-main-0708/`](GlobiFYE-Front-end-DialForge-main-0708/) |
| 2026-07-20 | Full DialForge UI, pushed into the shared repo rather than handed over as a copy: 31 HTML pages + 3 image assets | Kahlan | [`dial-forge-front-end/`](../../../dial-forge-front-end/) at the repo root |
| 2026-07-22 | **Current.** Incremental update, 5 commits touching 5 pages (login, landing, activeCall, postCallSummary, powerDialer) | Kahlan | same folder, commits `ccb6236..0a3e5f8` |

---

## Notes

- `Stitch.html` and `liveTranscription.html` are treated as original design references and are not to be modified.
- Both files now live in this `frontend-sync/` folder (moved from their earlier location on the frontend side). This log is the source of truth for where each delivery currently lives.
- **How deliveries arrive changed on 2026-07-20.** Everything up to and including 0708 was a copy dropped into `frontend-sync/` as read-only reference. The 0720 delivery is the frontend team's own working tree, committed to the shared `dial-forge` repo at the root, next to `dial-forge-ai/`. Future deliveries land there as commits, so this log records *what changed* rather than *where the copy was put*.

## What changed in the 2026-07-20 delivery

Compared with 0708. Full analysis in [`demo-ui-frontend-merge-design-doc.md`](./demo-ui-frontend-merge-design-doc.md).

| Change | Detail |
|---|---|
| Filenames cleaned | `Dashbaord` → `Dashboard` (typo), `callLogs` → `callHistory`, `myNums` → `numbers`, and the `_x` / `_y` working suffixes dropped from every file |
| Pages removed | The camera-configuration, screen-sharing, and warm-transfer variants of the active-call screen, plus the voicemail-drop variant of the dialer. All four became in-page dialogs on their parent screen |
| Duplicate removed | The second copy of the team-governance page |
| Added | Three image assets, currently referenced by no page |
| Materially bigger | The five demo-path screens grew four to six times. The cause is a new shared application shell: persistent header with a call timer, incoming-call overlay, active-call bar, New Call dialog, CRM rail, and a shared browser-side call state object |
| Unchanged | The design language. Same fonts, same colours, same glass cards. The active-call layout and its example transcript lines are byte-identical to 0708 |

## What changed in the 2026-07-22 update

Checked 2026-07-23 against the merge design doc. **Every element name in the binding contract below survived, and the design doc's decisions all still hold.**

| Change | Detail |
|---|---|
| Sign-up placeholder fixed | The unreplaced `{{DATA:SCREEN:SCREEN_61}}` template link on the sign-in page now navigates to onboarding step 1, via a new persona-state script (localStorage `dialforgeState`) |
| Dead code deleted | The ~600 commented-out lines in the dialer and the commented-out modals on the active-call and summary screens are gone. Cleanup only, no behavior change |
| Voicemail drop added | The VM Studio dialog on the active-call screen got a working Drop button. It checks the shared call-state object for an active call, then shows a **simulated** "dropped successfully" toast. No real voicemail is dropped |
| Link and spacing fixes | Landing-page links, `./#` placeholder links, call-banner spacing |
| Still open from our asks | Sign-in inputs still have no name, and the submit button still wraps a plain link to the dashboard (any password works). The 18 broken sidebar links are still broken. All three fake-data generators on the active-call screen are still there, including the transcript appender on its 8-12 s timer |

## Element names the AI team's live layer depends on

Published so the frontend team knows which names are load-bearing. Renaming one of these silently turns that piece back into a mockup. Everything not listed here is free to change.

`transcript-feed`, `right-transcript`, `coach-title`, `coach-text`, `objection-alerts`, `badge-live`, `endCallBtn`, `callTimerContainer`, `callTimerText`, `activeCallBar`, `activeCallName`, `activeCallCompany`, `activeCallDuration`, `activeCallStatusLabel`, `tableBody`, `loginForm`, and the shared browser-side call state object.

Also load-bearing: the per-row attributes on call-log rows (name, number, direction, status, duration, timestamp, score). The page's own sort, filter, and CSV export read them.
