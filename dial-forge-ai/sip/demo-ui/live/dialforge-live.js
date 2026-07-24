/*
 * DialForge live layer -- the AI team's one script (merge design doc,
 * decision D). Loaded by the five live screens of dial-forge-front-end/
 * via a single <script> tag each. Everything here binds by element name
 * and skips silently when an element is absent, so a renamed element
 * degrades that piece back into a mockup instead of breaking the page.
 *
 * Served by demo_ui_server.py at /live/dialforge-live.js.
 * Contract with the server: design doc appendix A1 (routes) + A2 (SSE).
 */
(function () {
  'use strict';

  var PAGE = (location.pathname.split('/').pop() || 'Dashboard.html');
  var ME = null;              // /api/me payload
  var currentCall = null;     // live call record (from SSE)
  var ringing = false;
  var timerHandle = null;
  var transcriptCleared = false;
  var LOG_CAP = 400;

  // ---------------------------------------------------------------- utils

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function fmtClock(totalSeconds) {
    var m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    var s = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
    return m + ':' + s;
  }

  // Replace a node with a clone of itself: drops every listener the
  // page's own scripts attached, so the fake handler cannot fire.
  function takeOver(el) {
    if (!el || !el.parentNode) return null;
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return clone;
  }

  // Self-contained toast (activeCall has its own showToast; other pages
  // do not, so we bring our own and use it everywhere for consistency).
  function toast(msg, kind) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;bottom:2rem;right:2rem;z-index:99999;' +
      'padding:12px 18px;border-radius:12px;font:600 13px DM Sans,sans-serif;' +
      'color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.45);max-width:340px;' +
      'background:' + (kind === 'error' ? '#B3261E' : 'rgba(30,31,39,.95)') +
      ';border:1px solid rgba(255,255,255,.12)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        location.href = './login.html';
        throw new Error('not logged in');
      }
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // ------------------------------------------------- shared call-state UI

  // Drives the shell's header timer pill + active call bar (present on
  // every app page) and activeCall's center-stage timer. The shell's own
  // interval only starts from its fake flows, which the live pages no
  // longer trigger, so ours is the only writer.
  function renderCallState() {
    var secs = 0;
    if (currentCall && currentCall.started_at) {
      secs = Math.max(0, Math.round(Date.now() / 1000 - currentCall.started_at));
    }
    var text = fmtClock(secs);
    if ($('callTimerText')) $('callTimerText').textContent = text;
    if ($('call-timer')) $('call-timer').textContent = text;
    if ($('activeCallDuration')) $('activeCallDuration').textContent = text;

    var dot = $('callTimerDot');
    if (dot) {
      dot.classList.remove('bg-white/20', 'bg-tertiary', 'active-orb', 'bg-fire-accent');
      dot.classList.add(currentCall ? 'bg-tertiary' : 'bg-white/20');
      if (currentCall) dot.classList.add('active-orb');
    }
  }

  function setShellBar(visible, name, company, label) {
    var bar = $('activeCallBar');
    if (!bar) return;
    bar.classList.toggle('hidden', !visible);
    if ($('activeCallName') && name) $('activeCallName').textContent = name;
    if ($('activeCallCompany') && company) $('activeCallCompany').textContent = company;
    if ($('activeCallStatusLabel')) $('activeCallStatusLabel').textContent = label || 'Active Call';
  }

  function syncWindowCall(status) {
    // Keep the frontend's shared state object truthful (their VM-drop
    // gate and any future shell code reads it).
    if (!window.CALL) return;
    window.CALL.status = status;
    if (status === 'active' && currentCall) {
      window.CALL.caller = {
        name: currentCall.caller || 'Client',
        company: currentCall.company || (ME && ME.company) || '',
        number: '', avatar: '',
      };
      window.CALL.direction =
        currentCall.direction === 'sales_to_client' ? 'outbound' : 'inbound';
    }
    if (status === 'idle') window.CALL.caller = null;
  }

  function callConnected(call) {
    currentCall = call;
    ringing = false;
    localStorage.setItem('df-last-call', call.id);
    if (!timerHandle) timerHandle = setInterval(renderCallState, 1000);
    renderCallState();
    syncWindowCall('active');
    setShellBar(true, call.caller || 'Client', call.company || '', 'Active Call');
    if ($('badge-live')) $('badge-live').classList.remove('hidden');
    if ($('contact-name')) $('contact-name').textContent = call.caller || 'Client';
    if ($('contact-company')) $('contact-company').textContent = call.company || '';
    if (PAGE === 'activeCall.html') {
      // The example bubbles leave and the whole call replays, so an SSE
      // reconnect mid-call cannot duplicate turns.
      var feed = $('transcript-feed');
      if (feed) feed.innerHTML = '';
      var rail = $('right-transcript');
      if (rail) rail.innerHTML = '';
      transcriptCleared = true;
    }
    (call.turns || []).forEach(function (t) {
      addBubble(t.role, t.text, t.at_sec);
    });
  }

  function callOver(kind) {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    var ended = currentCall;
    currentCall = null;
    ringing = false;
    renderCallState();
    syncWindowCall('idle');
    setShellBar(false);
    if ($('badge-live')) $('badge-live').classList.add('hidden');
    if (kind === 'ended' && ended) {
      toast('Call ended. Open the summary to run the analysis.');
    }
  }

  // ------------------------------------------------- transcript rendering

  // Bubble markup mirrors the frontend's own builder in activeCall.html
  // so live turns are indistinguishable from the designed mock ones.
  function addBubble(role, text, atSec) {
    var feed = $('transcript-feed');
    if (feed) {
      var isAgent = role === 'agent';
      var stamp = (atSec != null) ? ('+' + fmtClock(atSec)) : '';
      var who = isAgent ? 'AI Agent' : 'Client';
      var el = document.createElement('div');
      el.className = 'space-y-2';
      el.innerHTML =
        '<div class="flex ' + (isAgent ? 'justify-end' : 'justify-between') + ' items-center px-1">' +
          '<span class="text-[10px] text-' + (isAgent ? 'ai-purple' : 'gray-500') + ' font-bold uppercase">' +
            esc(stamp + ' • ' + who) + '</span>' +
        '</div>' +
        '<div class="bg-' + (isAgent ? 'fire-accent/5' : 'white/5') + ' p-4 rounded-2xl rounded-' +
          (isAgent ? 'tr' : 'tl') + '-none border border-' +
          (isAgent ? 'fire-accent/10' : 'white/10') + ' text-sm leading-relaxed">' +
          esc(text) +
        '</div>';
      feed.appendChild(el);
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    }
    var rail = $('right-transcript');
    if (rail) {
      var line = document.createElement('p');
      line.className = 'text-gray-400';
      line.innerHTML = '<span class="font-bold text-gray-500 uppercase">' +
        (role === 'agent' ? 'AI' : 'Client') + ':</span> ' + esc(text);
      rail.appendChild(line);
      rail.scrollTop = rail.scrollHeight;
    }
  }

  // --------------------------------------------------------- SIP overlay
  // Collapsible tooling overlay: raw pipeline log + stage lamps + KB.
  // Ours forever (design doc section 5.1) -- deliberately not part of
  // the product design, so it is injected, not asked of the frontend.

  var overlayBody = null;
  var lamps = {};

  function buildOverlay() {
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<button id="df-log-toggle" style="position:fixed;bottom:1rem;left:1rem;z-index:99990;' +
        'padding:8px 14px;border-radius:999px;font:700 11px JetBrains Mono,monospace;' +
        'background:rgba(30,31,39,.92);color:#9aa0ac;border:1px solid rgba(255,255,255,.12);cursor:pointer">' +
        'SIP LOG</button>' +
      '<div id="df-log-panel" style="display:none;position:fixed;bottom:3.4rem;left:1rem;z-index:99990;' +
        'width:520px;max-width:90vw;background:#0d0e15;border:1px solid rgba(255,255,255,.12);' +
        'border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5)">' +
        '<div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.08)">' +
          '<span style="font:700 10px JetBrains Mono,monospace;color:#9aa0ac;letter-spacing:.15em">PIPELINE</span>' +
          '<span id="df-lamps" style="display:flex;gap:6px"></span>' +
          '<button id="df-kb-btn" style="margin-left:auto;font:700 10px JetBrains Mono,monospace;' +
            'color:#FFAD1C;background:none;border:1px solid rgba(255,173,28,.35);border-radius:6px;' +
            'padding:3px 8px;cursor:pointer">KB</button>' +
        '</div>' +
        '<div id="df-log-body" style="max-height:38vh;overflow:auto;padding:10px 12px;' +
          'font:11px JetBrains Mono,monospace;color:#8b93a2;white-space:pre-wrap"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    overlayBody = $('df-log-body');

    ['caller', 'asterisk', 'stt', 'llm', 'tts'].forEach(function (k) {
      var s = document.createElement('span');
      s.textContent = k.toUpperCase();
      s.style.cssText = 'font:700 9px JetBrains Mono,monospace;color:#555c68;' +
        'padding:2px 6px;border-radius:4px;transition:all .3s';
      lamps[k] = s;
      $('df-lamps').appendChild(s);
    });

    $('df-log-toggle').addEventListener('click', function () {
      var p = $('df-log-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });

    $('df-kb-btn').addEventListener('click', function () {
      if (!ME) return;
      api('/api/knowledge-base/' + ME.company_key).then(function (data) {
        overlayBody.textContent =
          '--- Knowledge base: ' + data.company + ' (what the agent answers from) ---\n\n' +
          data.markdown + '\n\n--- end of knowledge base ---';
        $('df-log-panel').style.display = 'block';
      }).catch(function (e) { toast('KB: ' + e.message, 'error'); });
    });
  }

  var STAGE_FOR_TAG = {
    'CALL': 'asterisk', 'ARI': 'asterisk', 'RTP': 'caller',
    'STT partial': 'stt', 'STT final': 'stt', 'STT': 'stt',
    'LLM first-token': 'llm', 'LLM reply': 'llm',
    'TTS gen': 'tts', 'TTS audio': 'tts', 'TTS played': 'tts', 'TTS': 'tts',
  };

  function flashLamp(tag) {
    var key = STAGE_FOR_TAG[tag];
    var lamp = key && lamps[key];
    if (!lamp) return;
    lamp.style.color = '#FFAD1C';
    lamp.style.background = 'rgba(255,173,28,.15)';
    setTimeout(function () {
      lamp.style.color = '#555c68';
      lamp.style.background = 'none';
    }, 1200);
  }

  function addLogLine(raw) {
    if (!overlayBody) return;
    var line = document.createElement('div');
    line.textContent = raw;
    overlayBody.appendChild(line);
    while (overlayBody.childNodes.length > LOG_CAP) {
      overlayBody.removeChild(overlayBody.firstChild);
    }
    overlayBody.scrollTop = overlayBody.scrollHeight;
  }

  // ----------------------------------------------------------------- SSE

  function connectSSE() {
    var es = new EventSource('/api/events?role=sales');
    es.onmessage = function (msg) {
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      handleEvent(data);
    };
    // EventSource reconnects on its own; nothing to do on error.
  }

  function handleEvent(data) {
    switch (data.type) {
      case 'snapshot':
        (data.recent_log || []).forEach(addLogLine);
        if (data.current_call) callConnected(data.current_call);
        else if (data.ringing) { ringing = true; setShellBar(true, data.ringing.caller || 'Client', data.ringing.company || '', 'Ringing…'); }
        break;
      case 'pipeline_event':
        addLogLine(data.raw);
        flashLamp(data.tag);
        if (currentCall && data.tag === 'STT final') addBubble('customer', data.text, data.at_sec);
        else if (currentCall && data.tag === 'LLM reply') addBubble('agent', data.text, data.at_sec);
        else if (data.tag === 'AGENT' && currentCall) {
          currentCall.company = data.text;
          if ($('contact-company')) $('contact-company').textContent = data.text;
        }
        break;
      case 'incoming_call':
        ringing = true;
        if (data.target_role === 'sales') {
          toast('Incoming call from ' + (data.caller || 'a client') +
                '. Answer it on the softphone.');
          setShellBar(true, data.caller || 'Client', data.company || '', 'Incoming…');
        } else {
          setShellBar(true, 'Client', data.company || '', 'Ringing…');
        }
        break;
      case 'call_connected':
        callConnected(data.call);
        break;
      case 'call_ended':
        callOver('ended');
        if (PAGE === 'callHistory.html') loadHistory();
        break;
      case 'call_cancelled':
        callOver('cancelled');
        break;
      case 'analysis_ready':
        if (PAGE === 'postCallSummary.html') renderAnalysis(data.call);
        break;
    }
  }

  // ------------------------------------------------------- place / end

  function placeCall() {
    post('/api/call', { direction: 'sales_to_client' }).then(function (r) {
      toast(r.message || 'Ringing the softphone.');
      if (PAGE !== 'activeCall.html') {
        setTimeout(function () { location.href = './activeCall.html'; }, 600);
      }
    }).catch(function (e) {
      toast(e.message, 'error');   // incl. "Bridge script isn't running..."
    });
  }

  function hangup(thenNavigate) {
    var lastId = (currentCall && currentCall.id) || localStorage.getItem('df-last-call');
    post('/api/hangup').catch(function () {}).then(function () {
      if (thenNavigate) {
        location.href = './postCallSummary.html' + (lastId ? ('?call=' + lastId) : '');
      }
    });
  }

  function wireCallControls() {
    // The fake local-call paths lose their listeners; the buttons place
    // and end real calls instead (merge doc, section 5.1).
    var startBtn = takeOver($('startCallBtn'));
    if (startBtn) startBtn.addEventListener('click', function () {
      var modal = $('newCallModal');
      if (modal) modal.classList.add('hidden');
      placeCall();
    });

    var headerStart = takeOver($('startCallHeaderBtn'));
    if (headerStart) headerStart.addEventListener('click', placeCall);

    var endBar = takeOver($('endCallBtn'));
    if (endBar) endBar.addEventListener('click', function () { hangup(false); });

    var endLink = $('endCallLink');
    if (endLink) endLink.addEventListener('click', function (e) {
      e.preventDefault();
      hangup(true);
    });

    // The random-caller demo path (decision E, third generator).
    var testBtn = $('testInboundBtn');
    if (testBtn) testBtn.remove();

    // Ring overlay: Accept cannot answer a SIP call from the browser;
    // the honest behavior is to say where the answer happens.
    var accept = takeOver($('acceptCallBtn'));
    if (accept) accept.addEventListener('click', function () {
      var ov = $('incomingCallOverlay');
      if (ov) ov.classList.add('hidden');
      toast('Answer the call on the softphone (Linphone).');
    });
    var decline = takeOver($('declineCallBtn'));
    if (decline) decline.addEventListener('click', function () {
      var ov = $('incomingCallOverlay');
      if (ov) ov.classList.add('hidden');
      hangup(false);
    });
  }

  // ------------------------------------------------------- call history

  function initialsBadge(name) {
    var initials = (name || '??').split(/\s+/).map(function (w) { return w[0]; })
      .join('').slice(0, 2).toUpperCase();
    return '<div class="w-10 h-10 rounded-full border-2 border-fire-orange/30 ' +
      'flex items-center justify-center bg-white/5 font-syne font-bold text-xs text-fire-accent">' +
      esc(initials) + '</div>';
  }

  function loadHistory() {
    var body = $('tableBody');
    if (!body) return;
    api('/api/calls').then(function (data) {
      body.innerHTML = '';
      data.calls.forEach(function (c) {
        var outbound = c.direction === 'sales_to_client';
        var connected = c.turns > 0;
        var dur = c.duration_seconds || 0;
        var durLabel = Math.floor(dur / 60) + 'm ' + (dur % 60) + 's';
        var when = new Date(c.started_at * 1000);
        var name = c.contact_name || c.caller || 'Client';
        var row = document.createElement('div');
        row.className = 'grid grid-cols-[2fr_1.5fr_0.6fr_1fr_1.5fr_1.5fr_1fr] px-6 py-5 ' +
          'items-center hover:bg-white/[0.03] transition-all group cursor-pointer';
        row.setAttribute('data-name', name);
        row.setAttribute('data-number', c.extension || '');
        row.setAttribute('data-direction', outbound ? 'outbound' : 'inbound');
        row.setAttribute('data-status', connected ? 'connected' : 'missed');
        row.setAttribute('data-duration', String(dur));
        row.setAttribute('data-duration-label', durLabel);
        row.setAttribute('data-timestamp', when.toISOString());
        row.setAttribute('data-date-label', when.toLocaleString());
        row.setAttribute('data-score', '');
        row.innerHTML =
          '<div class="flex items-center gap-3">' + initialsBadge(name) +
            '<div><p class="font-syne font-bold text-white text-sm">' + esc(name) + '</p>' +
            '<p class="text-xs text-on-surface-variant">' + esc(c.company || '') + '</p></div></div>' +
          '<span class="font-mono text-xs text-on-surface-variant">' + esc('line ' + (c.extension || '?')) + '</span>' +
          '<div class="flex justify-center"><div class="w-8 h-8 rounded-full bg-connected-green/10 ' +
            'flex items-center justify-center text-connected-green">' +
            '<span class="material-symbols-outlined text-[18px]">' +
            (outbound ? 'call_made' : 'call_received') + '</span></div></div>' +
          '<div><span class="bg-connected-green/10 text-connected-green border border-connected-green/20 ' +
            'px-2.5 py-0.5 rounded-full text-[10px] font-black tracking-tighter">' +
            (connected ? 'CONNECTED' : 'NO TURNS') + '</span></div>' +
          '<div class="flex flex-col"><span class="text-sm font-medium text-white">' + durLabel + '</span>' +
            '<span class="text-[11px] text-on-surface-variant">' + esc(when.toLocaleString()) + '</span></div>' +
          '<div class="pr-8 text-[11px] text-on-surface-variant">' +
            (c.has_analysis ? 'Analyzed' : '—') + '</div>' +
          '<div class="text-right"><span class="material-symbols-outlined text-on-surface-variant/50">chevron_right</span></div>';
        row.addEventListener('click', function () {
          location.href = './postCallSummary.html?call=' + encodeURIComponent(c.id);
        });
        body.appendChild(row);
      });
      var count = $('resultsCount');
      if (count) count.textContent = data.calls.length + ' calls';
    }).catch(function (e) { toast('History: ' + e.message, 'error'); });
  }

  // ---------------------------------------------------- post-call summary

  var summaryCallId = null;

  function summaryTarget() {
    // The heading is the stable anchor; the list right after it is the
    // designed placeholder we replace.
    var heads = document.querySelectorAll('h3');
    for (var i = 0; i < heads.length; i++) {
      if (/AI Call Summary/i.test(heads[i].textContent)) {
        var section = heads[i].closest('section') || heads[i].parentNode;
        return { section: section, list: section ? section.querySelector('ul') : null, head: heads[i] };
      }
    }
    return { section: null, list: null, head: null };
  }

  function li(text, strongText) {
    return '<li class="flex items-start">' +
      '<span class="material-symbols-outlined text-fire-amber text-xl mr-4 mt-0.5" ' +
        'style="font-variation-settings: \'FILL\' 1">check_circle</span>' +
      '<p class="text-lg text-text-primary leading-relaxed">' + text +
      (strongText ? ' <span class="text-white font-semibold">' + strongText + '</span>' : '') +
      '</p></li>';
  }

  function renderAnalysis(call) {
    var t = summaryTarget();
    if (!t.list) return;
    var a = call.analysis;
    if (!a) {
      t.list.innerHTML = li('No analysis for this call yet. Click <span class="text-white font-semibold">Run analysis</span> above.');
      return;
    }
    var html = li(esc(a.summary));
    (a.key_topics || []).forEach(function (k) {
      html += li('Topic: ', esc(k.name) + ' <span class="font-mono text-xs text-on-surface-variant">(+' + fmtClock(k.start_time || 0) + ')</span>');
    });
    t.list.innerHTML = html;

    var extra = $('df-analysis-extra');
    if (!extra) {
      extra = document.createElement('div');
      extra.id = 'df-analysis-extra';
      extra.className = 'mt-6 space-y-4';
      t.section.appendChild(extra);
    }
    function block(title, items, render) {
      if (!items || !items.length) return '';
      return '<div><h4 class="font-mono text-xs uppercase tracking-widest text-on-surface-variant mb-2">' +
        title + '</h4><div class="space-y-3">' + items.map(render).join('') + '</div></div>';
    }
    extra.innerHTML =
      block('Objections & coaching', a.objections, function (o) {
        return '<div class="p-4 rounded-xl bg-white/5 border border-white/10 text-sm">' +
          '<p class="text-white">“' + esc(o.exact_quote) + '” ' +
          '<span class="font-mono text-xs text-on-surface-variant">(+' + fmtClock(o.timestamp || 0) + ', ' + esc(o.speaker || '') + ')</span></p>' +
          '<p class="mt-1 text-on-surface-variant">' + esc(o.reason || '') + '</p>' +
          (o.suggestion ? '<p class="mt-1 text-fire-accent">Try: ' + esc(o.suggestion) + '</p>' : '') +
          '</div>';
      }) +
      block('What went well', a.what_went_well, function (w) {
        return '<div class="p-4 rounded-xl bg-tertiary/5 border border-tertiary/20 text-sm">' +
          '<p class="text-white">“' + esc(w.exact_quote) + '” ' +
          '<span class="font-mono text-xs text-on-surface-variant">(+' + fmtClock(w.timestamp || 0) + ')</span></p>' +
          '<p class="mt-1 text-on-surface-variant">' + esc(w.reason || '') + '</p></div>';
      });
  }

  function initSummaryPage() {
    var params = new URLSearchParams(location.search);
    summaryCallId = params.get('call') || localStorage.getItem('df-last-call');
    var t = summaryTarget();
    if (!t.head || !summaryCallId) return;

    // The Run analysis trigger exists on no screen; injected under the
    // "(SIP needed)" rule (design doc, section 5.1) until the frontend
    // ships a designed one.
    var btn = document.createElement('button');
    btn.id = 'df-run-analysis';
    btn.innerHTML = 'Run analysis <span style="color:#9B6DFF;font-weight:700">(SIP needed)</span>';
    btn.className = 'ml-auto px-4 py-2 rounded-xl bg-fire-gradient text-white text-xs font-bold hover:brightness-110 transition-all';
    t.head.parentNode.appendChild(btn);

    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Analyzing…';
      post('/api/analyze/' + encodeURIComponent(summaryCallId)).then(function (data) {
        btn.textContent = 'Analysis complete';
        renderAnalysis(data.call);
      }).catch(function (e) {
        btn.disabled = false;
        btn.innerHTML = 'Run analysis <span style="color:#9B6DFF;font-weight:700">(SIP needed)</span>';
        toast('Analysis: ' + e.message, 'error');
      });
    });

    api('/api/calls/' + encodeURIComponent(summaryCallId)).then(function (data) {
      renderAnalysis(data.call);
      if (data.call.analysis) btn.textContent = 'Re-run analysis';
    }).catch(function () { /* keep the designed mockup if the id is stale */ });
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    api('/api/me').then(function (me) {
      ME = me;
      buildOverlay();
      wireCallControls();
      connectSSE();
      renderCallState();
      if ($('badge-live')) $('badge-live').classList.add('hidden');
      if (PAGE === 'callHistory.html') loadHistory();
      if (PAGE === 'postCallSummary.html') initSummaryPage();
    }).catch(function () { /* api() already redirected to login */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
