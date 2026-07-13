/* Customer phone — the client side of the call.
   A phone screen: place a call to the business, or receive one. Shows the
   live conversation only. No pipeline log, no post-call analysis (the server
   never sends analysis to role=client). */

const MY_ROLE = 'client';
const $ = (id) => document.getElementById(id);

let me = null;
let timerInterval = null;

// ---------------------------------------------------------------- session

async function loadMe() {
  const res = await fetch('/api/me');
  if (!res.ok) { location.href = '/login.html'; return; }
  me = await res.json();
  const initials = me.company.replace(/[^A-Za-z ]/g, '').split(/\s+/)
    .map(w => w[0]).join('').slice(0, 2).toUpperCase() || '•';
  for (const id of ['avatar', 'avatar-calling', 'avatar-incoming']) $(id).textContent = initials;
  for (const id of ['contact-name', 'calling-name', 'incoming-name', 'active-name']) {
    $(id).textContent = me.company;
  }
}

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---------------------------------------------------------------- views

function showView(name) {
  for (const v of ['idle', 'calling', 'incoming', 'active']) {
    $('view-' + v).hidden = (v !== name);
  }
}

function startTimer(startMs) {
  stopTimer();
  const base = startMs || Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - base) / 1000);
    $('active-timer').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 500);
}
function stopTimer() { if (timerInterval) clearInterval(timerInterval); timerInterval = null; }

// ---------------------------------------------------------------- transcript

function clearTranscript() {
  $('phone-transcript').innerHTML =
    '<p class="phone-transcript-empty">Say hello — the conversation will appear here.</p>';
}

function addBubble(role, text) {
  const t = $('phone-transcript');
  const empty = t.querySelector('.phone-transcript-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  // On the customer's phone, the "customer" turns are the person holding it.
  div.className = 'pbubble ' + (role === 'agent' ? 'agent' : 'you');
  const who = document.createElement('span');
  who.className = 'pwho';
  who.textContent = role === 'agent' ? (me ? me.company : 'Agent') : 'You';
  div.appendChild(who);
  div.appendChild(document.createTextNode(text));
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}

// ---------------------------------------------------------------- call control

async function callBusiness() {
  showView('calling');
  const res = await fetch('/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: 'client_to_sales' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    $('calling-name').textContent = data.error || 'Call failed';
    setTimeout(() => { showView('idle'); loadMe(); }, 2500);
  }
}

async function hangup() {
  await fetch('/api/hangup', { method: 'POST' }).catch(() => {});
}

function goActive(call) {
  showView('active');
  clearTranscript();
  $('active-name').textContent = (call && call.company) || (me && me.company) || 'Business';
  const startMs = call ? Date.now() - (Date.now() - call.started_at * 1000) : Date.now();
  startTimer(startMs);
  if (call) for (const turn of call.turns) addBubble(turn.role, turn.text);
}

function goIdle() { stopTimer(); showView('idle'); }

$('call-business').addEventListener('click', callBusiness);
$('calling-end').addEventListener('click', () => { hangup(); goIdle(); });
$('active-end').addEventListener('click', () => { hangup(); });
$('incoming-decline').addEventListener('click', () => { hangup(); goIdle(); });
$('incoming-accept').addEventListener('click', () => {
  showView('active');
  clearTranscript();
  $('active-timer').textContent = '…';
});

// ---------------------------------------------------------------- SSE

function handleEvent(ev) {
  const data = JSON.parse(ev.data);

  if (data.type === 'snapshot') {
    if (data.current_call) goActive(data.current_call);
    else if (data.ringing && data.ringing.target_role === MY_ROLE) {
      $('incoming-name').textContent = data.ringing.caller || (me && me.company);
      showView('incoming');
    }
    return;
  }

  if (data.type === 'incoming_call') {
    if (data.target_role === MY_ROLE) {
      $('incoming-name').textContent = data.caller || (me && me.company);
      showView('incoming');                 // the business is calling this phone
    } else {
      $('calling-name').textContent = data.company || (me && me.company);
      showView('calling');                  // this phone is the caller
    }
    return;
  }

  if (data.type === 'call_connected') { goActive(data.call); return; }
  if (data.type === 'call_cancelled') { goIdle(); return; }

  if (data.type === 'pipeline_event') {
    if (data.tag === 'STT final') addBubble('customer', data.text);
    else if (data.tag === 'LLM reply') addBubble('agent', data.text);
    return;
  }

  if (data.type === 'call_ended') {
    stopTimer();
    $('active-name').textContent = 'Call ended';
    $('active-timer').textContent = '';
    $('active-end').textContent = 'Close';
    $('active-end').onclick = () => { $('active-end').textContent = 'End call'; $('active-end').onclick = null; goIdle(); };
    return;
  }
  // analysis_ready never reaches this page (server filters by role)
}

function connectSSE() {
  const es = new EventSource('/api/events?role=client');
  es.onmessage = handleEvent;
  es.onerror = () => { es.close(); setTimeout(connectSSE, 2000); };
}

// ---------------------------------------------------------------- boot

loadMe();
connectSSE();
