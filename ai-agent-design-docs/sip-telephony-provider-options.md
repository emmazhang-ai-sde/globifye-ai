# SIP / Telephony Provider Options
## For the GlobiFYE Sales Call System
**Created: June 16, 2026**
**Context: Danish sent 3 links (FreePBX, Asterisk, SignalWire) — analysis of where they fit and how they compare against prior direction**

---

## 1. Where This Fits in the Pipeline

Phase 1 today is:

```
Browser microphone → Deepgram WebSocket → live transcript
```

This only covers a sales rep talking into their own computer mic. It does **not** cover the actual telephony layer — placing/receiving real phone calls to a customer's phone number (PSTN), or the "AI dials a contact list" / "transfer to AI" / "AI voicemail" modes Danish described on June 10.

The three links Danish sent are all candidates for that missing layer — the **SIP / call connectivity layer**, which sits *before* the audio ever reaches Deepgram:

```
[Customer's phone] 
⇄ PSTN 
⇄ SIP trunk/provider 
⇄ (Asterisk / FreePBX / SignalWire) 
⇄ audio stream 
⇄ Deepgram 
→ ... (rest of pipeline unchanged)
```

This is the layer Abraham was assigned to research on June 10 ("Backend — Abraham: research open-source, self-hosted SIP protocol providers"). These links are very likely inputs to that task, not a new ask for the AI/LLM team — but worth understanding since it determines how audio actually reaches our pipeline.

---

## 2. The Three Options At a Glance

| | Asterisk | FreePBX | SignalWire |
|---|---|---|---|
| What it is | Open-source PBX/SIP engine (the core telephony software) | Open-source web GUI built on top of Asterisk | Cloud-hosted, paid, API-driven communications platform |
| Hosting | Self-hosted (you run the server) | Self-hosted (runs on top of an Asterisk install) | Fully managed cloud — no server to run |
| Cost | Free (software) + your own server cost | Free (software) + your own server cost | Pay-per-use (Twilio-style pricing) |
| Control level | Full, code/config-level | GUI on top of Asterisk's config | API calls only, no infra to manage |
| Ops burden | High — you maintain the server, SIP trunking, scaling | Medium — GUI reduces config pain, still self-hosted | Near zero — vendor manages everything |
| Comparable to | The raw "engine" | Asterisk + a dashboard | Twilio (founded by ex-Asterisk/FreePBX core team) |

---

## 3. Checking Against Danish's Prior Direction (June 10 meeting)

This is the key finding. On June 10, Danish gave Abraham an explicit research mandate:

> "Research **open-source, self-hosted SIP protocol providers** — **not Twilio or similar platforms** (those are software on top of SIP, not actual SIP providers). Criteria: **open-source + self-hostable + free.** SIP is just a protocol — we shouldn't pay for it."

Checking the three links against that exact criteria:

| Criteria (Danish, June 10) | Asterisk | FreePBX | SignalWire |
|---|---|---|---|
| Open-source | ✅ | ✅ | ❌ (proprietary cloud platform) |
| Self-hostable | ✅ | ✅ | ❌ (no self-host option — it *is* the host) |
| Free | ✅ | ✅ | ❌ (usage-based billing) |
| Not "Twilio or similar" | ✅ | ✅ | ❌ — SignalWire was literally built by the team that helped create FreePBX, positioned as a more flexible Twilio alternative |

**Asterisk and FreePBX cleanly satisfy all four criteria Danish set himself a week ago. SignalWire fails all four — it is the exact category of platform he told the team to avoid.**

This doesn't mean SignalWire is the "wrong" link to look at — it could be there as a **deliberate cost/ops-tradeoff comparison point**, not a literal candidate. But it's worth surfacing explicitly rather than assuming it's a drop-in option, since on paper it contradicts the standing direction.

---

## 4. Why Someone Might Still Consider SignalWire Anyway

Worth presenting both sides at the meeting:

- **For self-hosted (Asterisk/FreePBX):** Matches Danish's stated cost philosophy ("SIP is just a protocol — we shouldn't pay for it"), consistent with the broader "reduce APIs / reduce GPU / self-host where possible" theme from earlier PM direction (see also: AirLLM, self-hosted LLM discussion from June 9–10).
- **For SignalWire:** Zero ops burden — no server to provision, patch, or scale; could be meaningfully faster to get a working demo, especially relevant given recurring "show something by [deadline]" pressure on this team. Also worth noting our current architecture (Next.js + Vercel) already avoided self-hosting a persistent WebSocket server for Deepgram specifically *because* Vercel can't hold long-lived connections — a self-hosted Asterisk/FreePBX box reintroduces that same "we need a real, always-on server somewhere" problem that the rest of the stack was designed to avoid.

So the real tension isn't "open-source vs proprietary" in the abstract — it's the same infra tradeoff that already came up once before in this project (Option A vs Option B for the Deepgram WebSocket), just at the SIP layer this time.

---

## 5. Conclusion

1. All three links are candidates for the **SIP/call-connectivity layer** — the piece that gets a real phone call's audio into the pipeline, upstream of everything that exists today.
2. This is Abraham's assigned research area (June 10), not a new task for the AI/transcription pipeline — these links should likely be routed to him if not already.
3. **Asterisk and FreePBX match Danish's own stated criteria** (open-source, self-hostable, free, not Twilio-like). **SignalWire does not** — it's architecturally in the same category Danish explicitly said to avoid.
4. The open question to bring to Danish: is SignalWire on the list because (a) he's reconsidering the self-host requirement given the ops burden, or (b) it's just there as a cost/speed comparison baseline and the self-hosted route is still the actual target? Worth a direct confirmation before Abraham sinks time into one direction.

---

## 6. Reference Resources

| Resource | Link |
|----------|------|
| Asterisk | https://www.asterisk.org/ |
| FreePBX | https://www.freepbx.org/ |
| SignalWire | https://signalwire.com/ |
