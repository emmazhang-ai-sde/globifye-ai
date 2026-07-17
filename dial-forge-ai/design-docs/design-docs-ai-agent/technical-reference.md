# Technical Reference — AI Agent

---

## 1. Reference Products

| Product | What it is |
|---|---|
| **OmniDim** (`omnidim.io`) | Autonomous voice AI agent platform — AI makes/receives real phone calls, handles objections, books appointments, no human in the loop |
| **Sim.ai** (`sim.ai`) | Multi-step agent orchestration — visual workflow builder, tool-use, multi-model LLM routing |
| **GitReverse** (`gitreverse.com`) | Dev utility — converts a GitHub repo into an AI-readable prompt to accelerate development |

---

## 2. SIP (Session Initiation Protocol)

### What is SIP?

**SIP (Session Initiation Protocol)** is the standard signaling protocol used to set up, manage, and tear down real-time communication sessions — phone calls, video calls, and voice-over-IP (VoIP). It is the same protocol that powers most business phone systems and cloud telephony platforms (Twilio, Vonage, Amazon Connect, etc.).

SIP itself does **not carry audio**. It only handles the control plane: "call this number," "call is ringing," "call was accepted," "call has ended." The actual audio travels separately over **RTP (Real-time Transport Protocol)**.

```
SIP  →  signaling only  (who, where, when — call setup / teardown)
RTP  →  audio only      (the actual voice data, streamed in real-time)
```

### Why This Project Uses SIP

The current MVP has a human sales rep making calls from a browser (browser mic → Deepgram → transcript). When we move to an AI agent that makes calls autonomously, we need a real phone call stack — not a browser. SIP is how you place and receive actual phone calls programmatically.

Abraham's team owns and operates the SIP layer. They handle:
- Dialing a prospect's phone number via a SIP trunk (a telephony carrier connection)
- Maintaining the call session state (ringing → active → ended)
- Delivering the raw audio stream from the call to our AI pipeline
- Accepting TTS audio back from our system and playing it to the prospect

### Key Terms

| Term | Meaning |
|---|---|
| **SIP Session** | A single call from start to end. Identified by a unique Call-ID. This maps to our `recordings` table row. |
| **SIP URI** | An address like `sip:prospect@carrier.com` — the "phone number" in SIP format. |
| **SIP trunk** | The connection between Abraham's SIP server and the public phone network (PSTN). Calls to real phone numbers go through here. |
| **RTP stream** | The audio channel. Bidirectional: prospect's voice comes in, AI's TTS voice goes out. |
| **INVITE / BYE** | Core SIP messages. `INVITE` starts a call; `BYE` ends it. Abraham's system sends us an event on each. |
| **PSTN** | Public Switched Telephone Network — the regular phone network. SIP bridges VoIP to PSTN. |

### Where SIP Touches Our System

Our AI pipeline only interacts with SIP at two points — everything else is Abraham's responsibility:

```
Abraham's SIP Layer                    Our AI Pipeline
─────────────────────                  ───────────────────────────────
Call connects (INVITE resolved)   →    call-started event → create recordings row, start agent loop
RTP audio stream (prospect voice) →    audio in → Deepgram STT → transcript
                                  ←    TTS audio out → send to prospect via RTP
Call ends (BYE)                   →    call-ended event → trigger post-call agent loop
```

We never write SIP code. We receive audio and events from Abraham's layer; we send audio back. The format of that handoff (WebSocket? RTP direct? HTTP chunked stream?) is an open question — see Open Question #10 in `ai-agent-pipeline-design.md`.

---

## 3. AirLLM — Self-Hosted LLM Option

**GitHub:** https://github.com/lyogavin/airllm  
**Recommended by:** Danish Parray (June 9, 2026)

### The core problem it solves

The current AI pipeline calls Groq's API — the model runs in the cloud and memory management is invisible to us. But if we ever want to switch the LLM to a locally-deployed open-source model (Llama 3 70B, Qwen, etc.), we hit a hard wall: a 70B model normally requires 40 GB+ of GPU VRAM, which is out of reach for most development machines and small cloud instances.

AirLLM eliminates this constraint by slicing the model into individual transformer layers on disk and loading one layer at a time into VRAM during inference — computing it, then swapping in the next. This means a 70B model can run inference on a single 4 GB GPU, and Llama 3.1 405B can run on 8 GB VRAM, with no quantization, distillation, or pruning required.

### What it is

AirLLM is an open-source Python library that runs large LLMs on consumer-grade GPUs without quantization, distillation, or pruning. It uses **layer-wise model decomposition** — loading one transformer layer at a time into VRAM — so the active memory footprint stays small regardless of model size.

| Capability | Detail |
|---|---|
| 70B model | Runs on a single 4GB GPU |
| 405B Llama 3.1 | Runs on 8GB VRAM |
| Speed option | 3× faster with optional 4-bit/8-bit block quantization |
| Supported models | Llama 2/3/3.1, Qwen/Qwen2.5, Mistral, Mixtral, ChatGLM, Baichuan, InternLM |
| Platform | Python; MacOS via MLX |

### Why it's relevant to this project

Two recurring tensions make AirLLM worth tracking:

1. **No API budget** — Danish recommends specific models but hasn't provided credits. AirLLM enables running a capable open-source model (e.g., Llama 3.1 70B) on our own hardware at zero per-token cost.
2. **"Reduce APIs / reduce GPU usage"** — self-hosted inference gives full control over rate limits, cost, and data privacy without third-party quota constraints.

### Concrete scenarios where AirLLM applies

**Scenario 1 — Replace Groq with a local model**  
The agent loop is currently bound to the Groq API. If the decision is made to switch to a locally-deployed open-source model — for data privacy, cost reduction, or offline operation — AirLLM makes it possible on a regular developer machine without renting expensive A100 instances.

**Scenario 2 — Scale up the knowledge base**  
If the prospect/product knowledge base grows significantly (tens of thousands of entries), we may want a larger local model capable of more complex multi-step reasoning, rather than relying on repeated API calls with rate limits and per-token costs.

**Scenario 3 — GlobiFYE's internal AI pipeline**  
The team currently uses Ollama for local inference. AirLLM and Ollama occupy a similar niche — both run large models locally — but AirLLM specifically targets severely VRAM-constrained hardware (4–8 GB GPUs), which Ollama cannot support at 70B+ scale. AirLLM is the right tool when the model is simply too large to load even with Ollama.

### Relationship to the current LLM stack

The current pipeline uses **Groq (Llama 3.3 70B)** via API on the free tier. That remains the right choice for now.

AirLLM becomes relevant if:
- Danish provides a GPU instance or hardware budget
- Groq free-tier rate limits become a bottleneck during testing or demos
- Data privacy requirements prevent sending transcript data to a third-party API

### Infrastructure requirement

AirLLM is a Python library — it cannot run inside the current Next.js + Vercel stack. Adopting it would require a separate inference server (e.g., Modal, RunPod, or a self-managed VM with a GPU). This adds infrastructure complexity and is not needed until the above conditions are met.
