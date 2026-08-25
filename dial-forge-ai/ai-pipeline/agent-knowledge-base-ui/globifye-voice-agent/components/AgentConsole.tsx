"use client";
// components/AgentConsole.tsx
// The omnidim-style agent configuration console, styled to the DialForge design
// system (dark glass, fire-orange primary, Syne / DM Sans / JetBrains Mono).
// The Knowledge Base tab renders the real, backend-wired <KnowledgeBaseTab/>.
//
//   <AgentConsole organizationId={orgId} agentId={agentId} />
//
// Configure / Voice / Call state is in-memory for now; persisting the agent row
// is the next backend step. Knowledge Base is already live.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Settings, BookOpen, Mic, Phone, Plus, Trash2, ChevronUp, ChevronDown,
  GripVertical, MessageSquare, Sparkles, X, Save, Play, Info, CircleDot,
  PanelRightClose, PanelRightOpen, Check,
} from "lucide-react";
import KnowledgeBaseTab from "./KnowledgeBaseTab";

const TABS = [
  { id: "configure", label: "Configure", icon: Settings },
  { id: "knowledge", label: "Knowledge Base", icon: BookOpen },
  { id: "voice", label: "Voice & Model", icon: Mic },
  { id: "call", label: "Call Settings", icon: Phone },
] as const;

const VARIABLES = ["[name]", "[city]", "[university]", "[intake]"];

interface Section { id: string; title: string; instructions: string; }

const SEED_SECTIONS: Section[] = [
  { id: "s1", title: "Introduction", instructions: "Greet the prospect by name and confirm you're speaking with the right student. Introduce yourself as a GlobiFYE advisor. Keep it warm and under two sentences before asking permission to continue." },
  { id: "s2", title: "Qualify the student", instructions: "Find out their target country, degree level, intended intake term, and where they are in the process. Do not pitch yet — just listen and collect." },
  { id: "s3", title: "Explain value & handle objections", instructions: "Match GlobiFYE's services to what they said they need. Pull specifics (services, timelines, pricing) from the knowledge base rather than improvising. Address cost and 'I can do it myself' objections directly." },
  { id: "s4", title: "Book a consultation", instructions: "Propose a free 20-minute consultation with a senior advisor. Offer two concrete time slots. Collect their email to send the calendar invite. Confirm the timezone." },
  { id: "s5", title: "Wrap up", instructions: "Recap the agreed next step, confirm their contact details, thank them, and end the call politely." },
];

let uid = 100;
const nextId = () => `id${uid++}`;

export default function AgentConsole({
  organizationId,
  agentId,
}: {
  organizationId: string;
  agentId?: string;
}) {
  const [agentName, setAgentName] = useState("GlobiFYE Admissions Outreach");
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("configure");
  const [showPrev, setShowPrev] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const [welcomeMode, setWelcomeMode] = useState<"static" | "dynamic">("static");
  const [welcome, setWelcome] = useState(
    "Hi [name], this is Maya from GlobiFYE — we help international students get into U.S. universities. Do you have a quick minute to talk about your applications?"
  );
  const welcomeRef = useRef<HTMLTextAreaElement>(null);

  const [sections, setSections] = useState<Section[]>(SEED_SECTIONS);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const [stt, setStt] = useState("Modulate");
  const [llm, setLlm] = useState("Groq · llama-3.1-8b-instant");
  const [tts, setTts] = useState("Deepgram Aura-2");
  const [voice, setVoice] = useState("Aura-2 · Thalia (en-US)");
  const [temp, setTemp] = useState("0.4");

  const [ambient, setAmbient] = useState(true);
  const [transfer, setTransfer] = useState(true);
  const [maxDur, setMaxDur] = useState(12);
  const [endIdle, setEndIdle] = useState(true);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const editSection = (id: string, key: keyof Section, val: string) =>
    setSections((s) => s.map((x) => (x.id === id ? { ...x, [key]: val } : x)));
  const delSection = (id: string) => setSections((s) => s.filter((x) => x.id !== id));
  const addSection = () =>
    setSections((s) => [...s, { id: nextId(), title: "New stage", instructions: "" }]);
  const move = (i: number, dir: number) =>
    setSections((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const c = [...s];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setSections((s) => {
      const from = s.findIndex((x) => x.id === dragId);
      const to = s.findIndex((x) => x.id === targetId);
      const c = [...s];
      const [m] = c.splice(from, 1);
      c.splice(to, 0, m);
      return c;
    });
    setDragId(null);
    setOverId(null);
  };

  const insertVar = (v: string) => {
    setWelcome((w) => `${w}${w.endsWith(" ") || !w ? "" : " "}${v}`);
    welcomeRef.current?.focus();
  };

  const compiled = useMemo(() => {
    const parts: [string | null, string][] = [];
    parts.push(["k", "# Identity\n"]);
    parts.push([null, "You are Maya, an outbound admissions advisor for GlobiFYE. Speak naturally, warmly, and concisely for a phone call.\n\n"]);
    parts.push(["k", "# Grounding\n"]);
    parts.push([null, "Answer facts about services, pricing, and timelines ONLY from the attached knowledge-base documents. If a fact isn't there, offer to follow up by email.\n\n"]);
    parts.push(["k", "# Opening line\n"]);
    parts.push([null, welcomeMode === "dynamic" ? "(generated per call)\n\n" : welcome + "\n\n"]);
    parts.push(["k", "# Conversation flow\n"]);
    sections.forEach((s, i) => {
      parts.push([null, "\n"]);
      parts.push(["k", `## Stage ${i + 1} — ${s.title}\n`]);
      parts.push([null, (s.instructions || "(no instructions)") + "\n"]);
    });
    if (transfer) {
      parts.push([null, "\n"]);
      parts.push(["s", "# Escalation\n"]);
      parts.push([null, "If the caller asks for a human or is upset, trigger transfer_to_human.\n"]);
    }
    return parts;
  }, [welcome, welcomeMode, sections, transfer]);

  return (
    <div className="df-app">
      <style>{CSS}</style>

      {/* top bar */}
      <header className="df-top">
        <div className="df-mark"><Phone size={17} /></div>
        <div className="df-brandwrap">
          <input className="df-name" value={agentName} onChange={(e) => setAgentName(e.target.value)} aria-label="Agent name" />
          <span className="df-brandsub">GlobiFYE · Voice Agent</span>
        </div>
        <span className="df-pill">Draft</span>
        <div className="df-spacer" />
        <span className="df-chip"><span className="df-live" />≈ 1.2s e2e</span>
        <button className="df-btn ghost" onClick={() => setToast("Starting test call…")}>
          <Play size={15} /> Test call
        </button>
        <button className="df-btn fire" onClick={() => setToast("Agent configuration saved")}>
          <Save size={15} /> Save
        </button>
      </header>

      <div className="df-body">
        {/* rail */}
        <nav className="df-rail">
          <p className="df-rail-label">Agent</p>
          {TABS.map((t) => (
            <button key={t.id} className={`df-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              <t.icon size={17} /> <span>{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="df-main">
          {tab === "configure" && (
            <div className="df-editor">
              <p className="df-eyebrow">Conversation</p>
              <h1 className="df-h">Configure the agent</h1>
              <p className="df-sub">The welcome line and stages below compile into the system prompt your STT→LLM→TTS loop runs on.</p>

              {/* welcome */}
              <div className="df-card">
                <div className="df-card-head">
                  <MessageSquare size={16} className="df-accent" />
                  <span className="df-card-title">Welcome message</span>
                  <div className="df-spacer" />
                  <div className="df-seg">
                    <button className={welcomeMode === "static" ? "on" : ""} onClick={() => setWelcomeMode("static")}>Static</button>
                    <button className={welcomeMode === "dynamic" ? "on" : ""} onClick={() => setWelcomeMode("dynamic")}>Dynamic</button>
                  </div>
                </div>
                <p className="df-card-desc">
                  {welcomeMode === "static" ? "Played exactly as written — fastest and most consistent." : "Generated fresh each call. Slightly higher latency."}
                </p>
                <textarea ref={welcomeRef} className="df-textarea" value={welcome} onChange={(e) => setWelcome(e.target.value)} placeholder="What the caller hears first…" />
                <div className="df-vars">
                  <span className="df-vars-label">Insert:</span>
                  {VARIABLES.map((v) => (
                    <button key={v} className="df-var" onClick={() => insertVar(v)}>{v}</button>
                  ))}
                </div>
              </div>

              {/* flow */}
              <div className="df-card">
                <div className="df-card-head">
                  <Sparkles size={16} className="df-accent" />
                  <span className="df-card-title">Conversational flow</span>
                  <div className="df-spacer" />
                  <span className="df-count">{sections.length} stages</span>
                </div>
                <p className="df-card-desc">Ordered stages of the call. Drag to reorder, or use the arrows.</p>

                <div className="df-flow">
                  {sections.map((s, i) => (
                    <div className="df-stage" key={s.id}>
                      <div className="df-node">{i + 1}</div>
                      <div
                        className={`df-stage-card ${dragId === s.id ? "drag" : ""} ${overId === s.id ? "over" : ""}`}
                        onDragOver={(e) => { e.preventDefault(); setOverId(s.id); }}
                        onDragLeave={() => setOverId((o) => (o === s.id ? null : o))}
                        onDrop={() => onDrop(s.id)}
                      >
                        <div className="df-stage-top">
                          <span className="df-grip" draggable onDragStart={() => setDragId(s.id)} onDragEnd={() => { setDragId(null); setOverId(null); }} aria-label="Drag to reorder">
                            <GripVertical size={16} />
                          </span>
                          <input className="df-stage-title" value={s.title} onChange={(e) => editSection(s.id, "title", e.target.value)} aria-label="Stage title" />
                          <button className="df-icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ChevronUp size={16} /></button>
                          <button className="df-icon-btn" onClick={() => move(i, 1)} disabled={i === sections.length - 1} aria-label="Move down"><ChevronDown size={16} /></button>
                          <button className="df-icon-btn danger" onClick={() => delSection(s.id)} aria-label="Delete stage"><Trash2 size={15} /></button>
                        </div>
                        <div className="df-stage-body">
                          <textarea className="df-textarea" value={s.instructions} onChange={(e) => editSection(s.id, "instructions", e.target.value)} placeholder="What should the agent do at this stage?" />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button className="df-add" onClick={addSection}><Plus size={16} /> Add stage</button>
                </div>
              </div>

              <button className="df-btn ghost sm" style={{ marginTop: 18 }} onClick={() => setShowPrev((v) => !v)}>
                {showPrev ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                {showPrev ? "Hide" : "Show"} compiled prompt
              </button>
            </div>
          )}

          {tab === "knowledge" && (
            <div className="df-editor">
              <KnowledgeBaseTab organizationId={organizationId} agentId={agentId} />
            </div>
          )}

          {tab === "voice" && (
            <div className="df-editor">
              <p className="df-eyebrow">Pipeline</p>
              <h1 className="df-h">Voice & model</h1>
              <p className="df-sub">The models behind each hop of the real-time loop. Latency compounds across all three.</p>

              <div className="df-card">
                <div className="df-grid">
                  <Field label="Speech-to-text (STT)"><Select value={stt} onChange={setStt} options={["Modulate", "Deepgram Nova-3"]} /></Field>
                  <Field label="Language model (LLM)"><Select value={llm} onChange={setLlm} options={["Groq · llama-3.1-8b-instant", "Groq · llama-3.3-70b-versatile"]} /></Field>
                  <Field label="Text-to-speech (TTS)"><Select value={tts} onChange={setTts} options={["Deepgram Aura-2", "ElevenLabs Turbo v2"]} /></Field>
                  <Field label="Voice"><Select value={voice} onChange={setVoice} options={["Aura-2 · Thalia (en-US)", "Aura-2 · Orion (en-US)", "Aura-2 · Luna (en-US)"]} /></Field>
                  <Field label={`LLM temperature · ${temp}`}>
                    <input className="df-range" type="range" min="0" max="1" step="0.1" value={temp} onChange={(e) => setTemp(e.target.value)} />
                  </Field>
                </div>
              </div>

              <div className="df-card df-info">
                <Info size={16} className="df-accent" />
                <div>Estimated response silence <b className="df-mono df-accent">≈ 1.2s</b> — under the 1.5s target. Budget = STT endpointing + LLM + TTS time-to-first-byte.</div>
              </div>
            </div>
          )}

          {tab === "call" && (
            <div className="df-editor">
              <p className="df-eyebrow">Behavior</p>
              <h1 className="df-h">Call settings</h1>
              <p className="df-sub">How calls start, escalate, and end.</p>

              <div className="df-card">
                <Row title="Initial ringing sound" desc="Play a ring while the agent boots — masks first-response latency.">
                  <Switch on={ambient} onClick={() => setAmbient((v) => !v)} />
                </Row>
                <Row title="Transfer to human" desc="Hand the call to a salesperson over SIP when asked or on escalation.">
                  <Switch on={transfer} onClick={() => setTransfer((v) => !v)} />
                </Row>
                <Row title="Max call duration" desc="Auto-end the call after this many minutes.">
                  <input className="df-num df-mono" type="number" min={1} max={60} value={maxDur} onChange={(e) => setMaxDur(Number(e.target.value))} />
                </Row>
                <Row title="End on prolonged silence" desc="Hang up if the caller goes quiet for 20 seconds.">
                  <Switch on={endIdle} onClick={() => setEndIdle((v) => !v)} />
                </Row>
              </div>
            </div>
          )}
        </div>

        {tab === "configure" && showPrev && (
          <aside className="df-preview">
            <div className="df-prev-head">
              <span className="df-prev-title"><CircleDot size={15} className="df-accent" /> Compiled system prompt</span>
              <button className="df-icon-btn" onClick={() => setShowPrev(false)} aria-label="Close preview"><X size={16} /></button>
            </div>
            <div className="df-prompt">
              {compiled.map((p, i) => (
                <span key={i} className={p[0] === "k" ? "k" : p[0] === "s" ? "s" : ""}>{p[1]}</span>
              ))}
            </div>
            <div className="df-prev-note">
              <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>This feeds your <span className="df-mono">ChatPromptTemplate</span> in <span className="df-mono">lib/agent-llm.ts</span>. Retrieved KB chunks inject above the flow at call time.</span>
            </div>
          </aside>
        )}
      </div>

      {toast && (<div className="df-toast"><Check size={15} className="df-mint" /> {toast}</div>)}
    </div>
  );
}

/* ---- small presentational helpers ---- */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (<div><label className="df-label">{label}</label>{children}</div>);
}
function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="df-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (<option key={o}>{o}</option>))}
    </select>
  );
}
function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="df-row">
      <div className="df-row-txt"><div className="df-row-title">{title}</div><div className="df-row-desc">{desc}</div></div>
      {children}
    </div>
  );
}
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={`df-switch ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on} />;
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@500;700&display=swap');
.df-app{
  --bg:#07080F; --surface:#12131a; --surface-container:#1e1f27;
  --on-surface:#e3e1ec; --on-surface-variant:#e5beb4; --outline:#ac8980;
  --primary:#ffb4a2; --primary-container:#ff562a; --on-primary:#611200;
  --secondary:#7cffa3; --danger:#ff5a6b;
  --glass-bg:rgba(20,21,34,.55); --glass-border:rgba(255,255,255,.07);
  --fire:linear-gradient(135deg,#FF4D1C 0%,#FF8A00 100%);
  font-family:'DM Sans',system-ui,sans-serif; color:var(--on-surface);
  min-height:100vh;
  background:
    radial-gradient(40% 40% at 6% -5%, rgba(255,77,28,.10), transparent 60%),
    radial-gradient(34% 46% at 104% 38%, rgba(124,255,163,.05), transparent 60%),
    var(--bg);
  font-size:14px; -webkit-font-smoothing:antialiased;
}
.df-app *{box-sizing:border-box;margin:0;padding:0}
.df-app button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
.df-app input,.df-app textarea,.df-app select{font-family:inherit;color:inherit}
.df-app :focus-visible{outline:2px solid var(--primary-container);outline-offset:2px;border-radius:6px}
.df-mono{font-family:'JetBrains Mono',monospace}
.df-accent{color:var(--primary)} .df-mint{color:var(--secondary)}

/* top bar */
.df-top{display:flex;align-items:center;gap:14px;padding:12px 22px;position:sticky;top:0;z-index:30;
  background:rgba(7,8,15,.7);backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border)}
.df-mark{width:38px;height:38px;border-radius:11px;flex-shrink:0;display:grid;place-items:center;color:#fff;background:var(--fire);box-shadow:0 6px 18px rgba(255,77,28,.35)}
.df-brandwrap{display:flex;flex-direction:column;gap:1px;min-width:0}
.df-name{font-family:'Syne',sans-serif;font-weight:700;font-size:16px;background:transparent;border:1px solid transparent;border-radius:8px;padding:3px 7px;max-width:300px;color:var(--on-surface)}
.df-name:hover{background:rgba(255,255,255,.05)}
.df-name:focus{background:var(--surface);border-color:rgba(255,255,255,.15);outline:none}
.df-brandsub{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--on-surface-variant);padding-left:7px}
.df-pill{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px;background:rgba(255,180,162,.12);color:var(--primary)}
.df-spacer{flex:1}
.df-chip{display:inline-flex;align-items:center;gap:7px;font-family:'JetBrains Mono',monospace;font-size:12px;padding:7px 11px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid var(--glass-border);color:var(--on-surface-variant)}
.df-live{width:7px;height:7px;border-radius:50%;background:var(--secondary);box-shadow:0 0 0 3px rgba(124,255,163,.15)}
.df-btn{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;padding:9px 15px;border-radius:999px;transition:.15s;white-space:nowrap}
.df-btn.fire{background:var(--fire);color:#fff;box-shadow:0 4px 14px rgba(255,77,28,.3)}
.df-btn.fire:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(255,77,28,.4)}
.df-btn.ghost{background:rgba(255,255,255,.05);color:var(--on-surface);border:1px solid rgba(255,255,255,.12)}
.df-btn.ghost:hover{background:rgba(255,255,255,.09)}
.df-btn.sm{padding:7px 12px;font-size:12px}

/* layout */
.df-body{display:flex;align-items:flex-start}
.df-rail{width:224px;flex-shrink:0;padding:20px 12px;position:sticky;top:63px;height:calc(100vh - 63px);border-right:1px solid var(--glass-border)}
.df-rail-label{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--on-surface-variant);padding:0 12px 10px}
.df-tab{display:flex;align-items:center;gap:11px;width:100%;text-align:left;padding:10px 12px;border-radius:11px;font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--on-surface-variant);transition:.13s;margin-bottom:3px}
.df-tab:hover{background:rgba(255,255,255,.05);color:var(--on-surface)}
.df-tab.active{background:rgba(255,86,42,.12);color:var(--primary)}
.df-tab.active svg{color:var(--primary)}
.df-tab svg{flex-shrink:0}

.df-main{flex:1;min-width:0;display:flex;align-items:flex-start}
.df-editor{flex:1;min-width:0;padding:30px 32px;max-width:780px}
.df-preview{width:410px;flex-shrink:0;padding:26px 24px;position:sticky;top:63px;height:calc(100vh - 63px);border-left:1px solid var(--glass-border);overflow-y:auto}

.df-eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--primary);margin-bottom:7px}
.df-h{font-family:'Syne',sans-serif;font-weight:800;font-size:30px;letter-spacing:-.015em}
.df-sub{color:var(--on-surface-variant);font-size:14px;line-height:1.6;margin-top:5px;max-width:62ch}

/* cards */
.df-card{background:var(--glass-bg);backdrop-filter:blur(20px);border:1px solid var(--glass-border);border-radius:20px;padding:20px;margin-top:18px;box-shadow:0 8px 32px rgba(0,0,0,.25)}
.df-card-head{display:flex;align-items:center;gap:10px}
.df-card-title{font-weight:700;font-size:15px}
.df-card-desc{color:var(--on-surface-variant);font-size:13px;margin:5px 0 13px}
.df-count{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--on-surface-variant)}

.df-label{display:block;font-family:'JetBrains Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--on-surface-variant);margin-bottom:7px}
.df-textarea,.df-select,.df-num{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:11px 13px;font-size:13.5px;color:var(--on-surface);transition:.13s}
.df-textarea{resize:vertical;min-height:76px;line-height:1.55}
.df-textarea:focus,.df-select:focus,.df-num:focus{outline:none;border-color:var(--primary-container);box-shadow:0 0 0 3px rgba(255,86,42,.18)}
.df-select{appearance:none;cursor:pointer;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23e5beb4' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>");background-repeat:no-repeat;background-position:right 12px center;padding-right:36px}
.df-select option{background:var(--surface-container);color:var(--on-surface)}
.df-grid{display:grid;gap:16px}
.df-range{width:100%;accent-color:var(--primary-container)}

.df-vars{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px;align-items:center}
.df-vars-label{font-size:11.5px;color:var(--on-surface-variant)}
.df-var{font-family:'JetBrains Mono',monospace;font-size:11.5px;padding:5px 9px;border-radius:8px;background:rgba(255,180,162,.08);color:var(--primary);border:1px solid rgba(255,180,162,.18);transition:.13s}
.df-var:hover{background:rgba(255,180,162,.16)}

/* flow spine */
.df-flow{position:relative;margin-top:16px;padding-left:36px}
.df-flow::before{content:"";position:absolute;left:13px;top:10px;bottom:28px;width:2px;background:linear-gradient(rgba(255,86,42,.5),rgba(255,138,0,.15))}
.df-stage{position:relative;margin-bottom:13px}
.df-node{position:absolute;left:-36px;top:14px;width:28px;height:28px;border-radius:50%;background:var(--surface);border:2px solid var(--primary-container);color:var(--primary);display:grid;place-items:center;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px;z-index:2}
.df-stage-card{background:rgba(30,31,39,.5);border:1px solid var(--glass-border);border-radius:14px;overflow:hidden;transition:.14s}
.df-stage-card.drag{opacity:.4}
.df-stage-card.over{border-color:var(--primary-container);box-shadow:0 0 0 3px rgba(255,86,42,.15)}
.df-stage-top{display:flex;align-items:center;gap:8px;padding:11px 11px 11px 13px}
.df-grip{color:rgba(255,255,255,.2);cursor:grab;display:flex;flex-shrink:0}
.df-grip:hover{color:var(--on-surface-variant)}
.df-stage-title{flex:1;background:transparent;border:1px solid transparent;border-radius:8px;padding:5px 8px;font-weight:700;font-size:14px;color:var(--on-surface)}
.df-stage-title:hover{background:rgba(255,255,255,.04)}
.df-stage-title:focus{background:var(--surface);border-color:rgba(255,255,255,.15);outline:none}
.df-stage-body{padding:0 13px 13px}
.df-icon-btn{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:var(--on-surface-variant);transition:.13s}
.df-icon-btn:hover{background:rgba(255,255,255,.06);color:var(--on-surface)}
.df-icon-btn.danger:hover{background:rgba(255,90,107,.14);color:var(--danger)}
.df-icon-btn:disabled{opacity:.3;cursor:not-allowed}
.df-add{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px;border:1.5px dashed rgba(255,255,255,.14);border-radius:14px;color:var(--on-surface-variant);font-weight:700;font-size:13px;transition:.14s}
.df-add:hover{border-color:var(--primary-container);color:var(--primary);background:rgba(255,86,42,.06)}

/* rows */
.df-row{display:flex;align-items:center;gap:16px;padding:15px 0;border-top:1px solid var(--glass-border)}
.df-row:first-child{border-top:none}
.df-row-txt{flex:1}
.df-row-title{font-weight:500;font-size:14px}
.df-row-desc{font-size:12.5px;color:var(--on-surface-variant);margin-top:2px}
.df-num{width:84px;text-align:center}
.df-info{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--on-surface-variant)}

/* switch */
.df-switch{width:42px;height:24px;border-radius:999px;position:relative;flex-shrink:0;background:rgba(255,255,255,.14);transition:.16s}
.df-switch.on{background:var(--fire)}
.df-switch::after{content:"";position:absolute;top:2.5px;left:2.5px;width:19px;height:19px;border-radius:50%;background:#fff;transition:.16s}
.df-switch.on::after{transform:translateX(18px)}

/* seg */
.df-seg{display:inline-flex;background:rgba(255,255,255,.05);border-radius:11px;padding:3px;gap:2px}
.df-seg button{padding:6px 14px;border-radius:8px;font-size:12.5px;font-weight:700;color:var(--on-surface-variant);transition:.12s}
.df-seg button.on{background:var(--surface-container);color:var(--on-surface)}

/* preview */
.df-prev-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}
.df-prev-title{font-family:'Syne',sans-serif;font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
.df-prompt{font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.75;color:var(--on-surface-variant);background:rgba(0,0,0,.3);border:1px solid var(--glass-border);border-radius:14px;padding:16px;white-space:pre-wrap;word-break:break-word}
.df-prompt .k{color:var(--primary);font-weight:700}
.df-prompt .s{color:var(--secondary);font-weight:700}
.df-prev-note{display:flex;gap:8px;font-size:11.5px;color:var(--on-surface-variant);margin-top:13px;line-height:1.55}

/* toast */
.df-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface-container);border:1px solid var(--glass-border);color:var(--on-surface);padding:12px 17px;border-radius:999px;font-size:13px;font-weight:500;display:flex;align-items:center;gap:9px;z-index:60;box-shadow:0 12px 32px rgba(0,0,0,.5);animation:dfup .22s ease}
@keyframes dfup{from{opacity:0;transform:translateX(-50%) translateY(8px)}}

@media(max-width:1180px){.df-preview{display:none}}
@media(max-width:860px){.df-rail{display:none}.df-editor{padding:22px 18px}}
@media(prefers-reduced-motion:reduce){.df-app *{animation:none!important;transition:none!important}}
`;
