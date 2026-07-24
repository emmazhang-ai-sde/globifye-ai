# Frontend Sync (the AI team's view of the frontend)

**Last updated:** 2026-07-21

> **The live frontend is no longer in this folder.** Since 2026-07-20 the frontend team commits directly to the shared repo, at [`dial-forge-front-end/`](../../../dial-forge-front-end/) at the root, next to `dial-forge-ai/`. That is the current UI. Everything in *this* folder is either historical reference or AI-team analysis of it.

Nothing here runs as a server and there is no build step: **open any `.html` file directly in a browser** (double-click, or `open <file>.html` from a terminal).

| File | What it is |
|---|---|
| [`frontend-delivery-log.md`](./frontend-delivery-log.md) | What was delivered when, what changed in each delivery, and the element names our live layer depends on. Start here |
| [`demo-ui-frontend-merge-design-doc.md`](./demo-ui-frontend-merge-design-doc.md) | Design for merging the SIP demo console into the frontend's screens (Danish, 2026-07-20). Status: design only |
| `GlobiFYE-Front-end-DialForge-main-0708/` | The 2026-07-08 delivery, superseded. Kept for diffing |
| `Stitch.html`, `liveTranscription.html` | June single-page references. `liveTranscription.html` is a competing take on the live call screen and uses different element names from the shipped one; do not write code against it |

Historical deliveries are reference material, not the frontend team's live codebase. Do not edit them.
