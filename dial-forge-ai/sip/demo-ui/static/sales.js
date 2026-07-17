/* Sales dashboard — the business side of the call.
   Shows the live transcript, the raw pipeline log, and (only here) the
   post-call coaching analysis. Can place a call to a customer, and rings
   when a customer calls in. SSE stream is opened with role=sales, so the
   server sends analysis events to this page and not to the client phone. */

const MY_ROLE = 'sales';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- session

let me = null;

async function loadMe() {
  const res = await fetch('/api/me');
  if (!res.ok) { location.href = '/login.html'; return; }
  me = await res.json();
  $('user-name').textContent = me.name;
  $('company').textContent = me.company;
  $('cl-company').textContent = me.company;
}

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---------------------------------------------------------------- placing / ending calls

async function placeCall() {
  const note = $('dial-note');
  note.className = 'dial-note';
  note.textContent = 'Placing call…';
  const res = await fetch('/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: 'sales_to_client' }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    note.className = 'dial-note ok';
    note.textContent = 'Calling the customer — their phone is ringing.';
  } else {
    note.className = 'dial-note err';
    note.textContent = data.error || 'Call failed.';
  }
}

async function hangup() {
  await fetch('/api/hangup', { method: 'POST' }).catch(() => {});
}

$('call-customer').addEventListener('click', placeCall);
$('end-call').addEventListener('click', hangup);

// ---------------------------------------------------------------- call state

let viewingCallId = null;   // null = live view; otherwise a history call id
let timerInterval = null;
let callStartedAt = null;

function setStatus(mode, text) {
  const chip = $('status-chip');
  chip.className = 'status-chip' + (mode ? ' ' + mode : '');
  $('status-text').textContent = text;
}

function showEndCall(show) { $('end-call').hidden = !show; }

function startTimer(startMs) {
  callStartedAt = startMs || Date.now();
  stopTimer();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    $('call-timer').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 500);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function setCompany(name) { $('call-company').textContent = name || ''; }

function clearTranscript(emptyMessage) {
  const t = $('transcript');
  t.innerHTML = '';
  if (emptyMessage) {
    const p = document.createElement('p');
    p.className = 'transcript-empty';
    p.textContent = emptyMessage;
    t.appendChild(p);
  }
}

function addBubble(role, text, atSec) {
  const t = $('transcript');
  const empty = t.querySelector('.transcript-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'bubble ' + role;
  if (atSec != null) div.dataset.at = atSec;  // lets key-topic chips jump here
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'agent' ? 'AI Agent' : 'Client';
  div.appendChild(who);
  div.appendChild(document.createTextNode(text));
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}

// ---------------------------------------------------------------- stages

const STAGE_FOR_TAG = {
  'CALL': ['caller', 'asterisk'], 'ARI': ['asterisk'], 'RTP': ['asterisk'],
  'STT partial': ['stt'], 'STT final': ['stt'], 'STT': ['stt'],
  'LLM first-token': ['llm'], 'LLM reply': ['llm'],
  'TTS gen': ['tts'], 'TTS audio': ['tts'], 'TTS played': ['tts'], 'TTS': ['tts'],
};
const stageFlashTimers = {};

function flashStages(tag) {
  for (const name of STAGE_FOR_TAG[tag] || []) {
    const el = document.querySelector(`.stage[data-stage="${name}"]`);
    if (!el) continue;
    el.classList.add('hot');
    clearTimeout(stageFlashTimers[name]);
    stageFlashTimers[name] = setTimeout(() => el.classList.remove('hot'), 1200);
  }
}

// ---------------------------------------------------------------- log panel

let logCount = 0;

function addLogLine(raw) {
  const body = $('log-body');
  const line = document.createElement('div');
  const m = raw.match(/^\[([^\]]*?)( \+\d+ms)?\] ?(.*)$/);
  line.className = 'log-line';
  if (m) {
    if (m[1] === 'STT partial') line.classList.add('partial');
    if (m[1] === 'STT final' || m[1] === 'LLM reply') line.classList.add('final');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '[' + m[1] + ']';
    line.appendChild(tag);
    if (m[2]) {
      const ms = document.createElement('span');
      ms.className = 'ms';
      ms.textContent = m[2];
      line.appendChild(ms);
    }
    line.appendChild(document.createTextNode(' ' + (m[3] || '')));
  } else {
    line.textContent = raw;
  }
  body.appendChild(line);
  while (body.childElementCount > 400) body.firstElementChild.remove();
  body.scrollTop = body.scrollHeight;
  logCount += 1;
  $('log-count').textContent = logCount + ' events';
}

$('log-toggle').addEventListener('click', () => {
  const panel = $('log-panel');
  panel.classList.toggle('collapsed');
  $('log-toggle').setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
});

// ---------------------------------------------------------------- knowledge base

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function renderMarkdown(md) {
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^### /.test(line)) { closeList(); html += `<h4>${esc(line.slice(4))}</h4>`; }
    else if (/^## /.test(line)) { closeList(); html += `<h3>${esc(line.slice(3))}</h3>`; }
    else if (/^# /.test(line)) { closeList(); html += `<h2>${esc(line.slice(2))}</h2>`; }
    else if (/^- /.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${esc(line.slice(2))}</li>`; }
    else if (line === '') { closeList(); }
    else { closeList(); html += `<p>${esc(line)}</p>`; }
  }
  closeList();
  return html;
}

async function openKb() {
  if (!me) return;
  const res = await fetch('/api/knowledge-base/' + encodeURIComponent(me.company_key));
  if (!res.ok) return;
  const data = await res.json();
  $('kb-title').textContent = data.company + ' — knowledge base';
  $('kb-content').innerHTML = renderMarkdown(data.markdown);
  $('kb-modal').hidden = false;
}
function closeKb() { $('kb-modal').hidden = true; }

$('view-kb').addEventListener('click', openKb);
$('kb-close').addEventListener('click', closeKb);
$('kb-backdrop').addEventListener('click', closeKb);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKb(); });

// ---------------------------------------------------------------- ring overlay

function showRing(name) {
  $('ring-label').textContent = 'Incoming call';
  $('ring-name').textContent = name || 'Client';
  $('ring-modal').hidden = false;
}
function hideRing() { $('ring-modal').hidden = true; }

$('ring-accept').addEventListener('click', () => {
  hideRing();
  setStatus('calling', 'CONNECTING');
  $('dial-note').className = 'dial-note';
  $('dial-note').textContent = 'Answer the softphone to connect the audio.';
});
$('ring-decline').addEventListener('click', () => { hideRing(); hangup(); resetIdle(); });

function resetIdle() {
  setStatus('', 'IDLE');
  setCompany('');
  showEndCall(false);
  stopTimer();
  $('call-timer').textContent = '';
}

// ---------------------------------------------------------------- analysis

function renderAnalysis(call) {
  const card = $('analysis-card');
  const body = $('analysis-body');
  card.hidden = false;

  // On-demand: nothing runs until the sales user asks for it.
  if (!call.analysis && !call.analysis_error) {
    body.innerHTML = `<p class="analysis-pending">Post-call analysis hasn't been run for this call yet.</p>
      <button class="btn-analyze" id="run-analysis">Run analysis</button>`;
    $('run-analysis').onclick = () => runAnalysis(call.id);
    return;
  }
  if (call.analysis_error) {
    body.innerHTML = `<p class="analysis-error">Analysis failed: ${esc(call.analysis_error)}</p>
      <button class="btn-analyze" id="run-analysis">Try again</button>`;
    $('run-analysis').onclick = () => runAnalysis(call.id);
    return;
  }

  const a = call.analysis;
  let html = `<p class="analysis-summary">${esc(a.summary)}</p>`;
  if (a.key_topics && a.key_topics.length) {
    html += '<h3>Key topics <span class="h3-hint">click to jump to that moment</span></h3><div class="topics">';
    for (const t of a.key_topics) {
      html += `<button class="topic-chip" data-start="${esc(t.start_time)}">${esc(t.name)} <span class="t">${esc(t.start_time)}–${esc(t.end_time)}s</span></button>`;
    }
    html += '</div>';
  }
  html += '<h3>Objections</h3>';
  if (a.objections && a.objections.length) {
    for (const o of a.objections) {
      html += `<div class="finding objection">
        <div class="quote">“${esc(o.exact_quote)}”</div>
        <div class="meta">${esc(o.speaker)} · ${esc(o.timestamp)}s — ${esc(o.reason)}</div>
        <div class="suggestion"><b>Coach:</b> ${esc(o.suggestion)}</div>
      </div>`;
    }
  } else {
    html += '<p class="analysis-pending">No objections detected.</p>';
  }
  html += '<h3>What went well</h3>';
  if (a.what_went_well && a.what_went_well.length) {
    for (const w of a.what_went_well) {
      html += `<div class="finding good">
        <div class="quote">“${esc(w.exact_quote)}”</div>
        <div class="meta">${esc(w.speaker)} · ${esc(w.timestamp)}s — ${esc(w.reason)}</div>
      </div>`;
    }
  } else {
    html += '<p class="analysis-pending">Nothing notable flagged.</p>';
  }
  body.innerHTML = html;

  // Key topics navigate the transcript to the moment they start.
  body.querySelectorAll('.topic-chip[data-start]').forEach((chip) => {
    chip.addEventListener('click', () => navigateToTime(Number(chip.dataset.start)));
  });
}

async function runAnalysis(callId) {
  $('analysis-body').innerHTML = '<p class="analysis-pending">Analyzing the call…</p>';
  const res = await fetch('/api/analyze/' + encodeURIComponent(callId), { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    renderAnalysis(data.call);
    loadHistory();
  } else {
    $('analysis-body').innerHTML =
      `<p class="analysis-error">${esc(data.error || 'Analysis failed.')}</p>
       <button class="btn-analyze" id="run-analysis">Try again</button>`;
    $('run-analysis').onclick = () => runAnalysis(callId);
  }
}

// Scroll the transcript to the first turn at or after `sec` and flash it.
function navigateToTime(sec) {
  const bubbles = [...$('transcript').querySelectorAll('.bubble[data-at]')];
  if (!bubbles.length) return;
  const target = bubbles.find((b) => Number(b.dataset.at) >= sec) || bubbles[bubbles.length - 1];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('bubble-flash');
  setTimeout(() => target.classList.remove('bubble-flash'), 1600);
}

// ---------------------------------------------------------------- history

async function loadHistory() {
  const res = await fetch('/api/calls');
  if (!res.ok) return;
  const { calls } = await res.json();
  const list = $('history-list');
  list.innerHTML = '';
  $('history-empty').hidden = calls.length > 0;
  for (const c of calls) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    if (c.id === viewingCallId) btn.classList.add('active');
    const when = new Date(c.started_at * 1000);
    btn.innerHTML = `<span class="history-dot${c.has_analysis ? ' analyzed' : ''}"></span>
      <span class="history-when">${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="history-meta">${c.company ? esc(c.company) : when.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${c.turns} turns</span>`;
    btn.addEventListener('click', () => openHistoryCall(c.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function openHistoryCall(id) {
  const res = await fetch('/api/calls/' + encodeURIComponent(id));
  if (!res.ok) return;
  const { call } = await res.json();
  viewingCallId = id;
  setStatus('ended', 'PAST CALL');
  setCompany(call.company);
  showEndCall(false);
  stopTimer();
  $('call-timer').textContent = new Date(call.started_at * 1000).toLocaleString();
  $('transcript-title').textContent = 'Transcript';
  clearTranscript(call.turns.length ? null : 'No speech was transcribed in this call.');
  for (const turn of call.turns) addBubble(turn.role, turn.text, turn.at_sec);
  renderAnalysis(call);
  loadHistory();
}

function backToLive() {
  viewingCallId = null;
  $('transcript-title').textContent = 'Live transcript';
  loadHistory();
}

// ---------------------------------------------------------------- SSE

function goLive(call) {
  backToLive();
  hideRing();
  setStatus('live', 'LIVE');
  setCompany(call && call.company);
  showEndCall(true);
  const startMs = call ? Date.now() - (Date.now() - call.started_at * 1000) : Date.now();
  startTimer(startMs);
  clearTranscript(null);
  if (call) for (const turn of call.turns) addBubble(turn.role, turn.text, turn.at_sec);
  $('analysis-card').hidden = true;
  $('dial-note').className = 'dial-note';
  $('dial-note').textContent = 'Rings the softphone; the AI answers as your business.';
}

function handleEvent(ev) {
  const data = JSON.parse(ev.data);

  if (data.type === 'snapshot') {
    $('log-body').innerHTML = ''; logCount = 0;
    for (const raw of data.recent_log || []) addLogLine(raw);
    if (data.current_call) goLive(data.current_call);
    else if (data.ringing && data.ringing.target_role === MY_ROLE) showRing(data.ringing.caller);
    return;
  }

  if (data.type === 'incoming_call') {
    if (data.target_role === MY_ROLE) {
      showRing(data.caller);                 // a customer is calling in
    } else {
      setStatus('calling', 'CALLING');       // we are the caller
      showEndCall(true);
    }
    return;
  }

  if (data.type === 'call_connected') { goLive(data.call); return; }
  if (data.type === 'call_cancelled') { if (viewingCallId === null) resetIdle(); loadHistory(); return; }

  if (data.type === 'pipeline_event') {
    addLogLine(data.raw);
    flashStages(data.tag);
    if (data.tag === 'CALL' && data.text.startsWith('arrived:')) {
      // call_connected handles the transition; nothing extra here
    } else if (data.tag === 'AGENT') {
      if (viewingCallId === null) setCompany(data.text);
    } else if (viewingCallId === null) {
      if (data.tag === 'STT final') addBubble('customer', data.text, data.at_sec);
      if (data.tag === 'LLM reply') addBubble('agent', data.text, data.at_sec);
    }
    return;
  }

  if (data.type === 'call_ended') {
    stopTimer();
    showEndCall(false);
    if (viewingCallId === null) {
      setStatus('ended', 'CALL ENDED');
      renderAnalysis(data.call);  // "Analyzing the call…"
    }
    loadHistory();
    return;
  }

  if (data.type === 'analysis_ready') {
    if (viewingCallId === null || viewingCallId === data.call.id) renderAnalysis(data.call);
    loadHistory();
  }
}

function connectSSE() {
  const es = new EventSource('/api/events?role=sales');
  es.onmessage = handleEvent;
  es.onerror = () => { es.close(); setTimeout(connectSSE, 2000); };
}

// ---------------------------------------------------------------- boot

loadMe();
loadHistory();
connectSSE();
