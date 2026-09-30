/* Developer debug harness (/debug). One workflow per page; talks to the automation service over the raw workflow WebSocket (/ws). Not an applicant page. */
(() => {
  const $ = (s) => document.querySelector(s);
  const logEl = $('#log');
  const fields = [...document.querySelectorAll('[data-field]')];
  let debounceMs = 150;
  let state = 'connecting';
  let workflowId = null;
  let submitRequestedAt = 0;
  let lastLogTs = null;
  const seq = {};
  const timers = {};
  const lastSent = {};
  let writeOnly = [];
  let deferred = [];
  const show = (name, v) => (writeOnly.includes(name) ? '(masked)' : `"${v}"`);

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmt = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };

  function log(ts, text, cls = 'srv') {
    const d = lastLogTs === null ? null : ts - lastLogTs;
    const delta = d === null ? '' : ` (${d >= 0 ? '+' : ''}${d} ms)`;
    lastLogTs = ts;
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = `${fmt(ts)} — ${text}${delta}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  window.__pageLog = (text) => log(Date.now(), text, 'local');

  function setState(s, detail) {
    state = s;
    $('#state').textContent = s;
    $('#detail').textContent = detail ? `— ${detail}` : '';
    const terminal = ['completed', 'failed', 'abandoned'].includes(s);
    if (s === 'completed') { const b = $('#result button'); if (b) { b.disabled = true; b.textContent = 'Verified ✓'; } }
    $('#btnStart').disabled = !(s === 'idle' || terminal);
    $('#btnSubmit').disabled = s !== 'ready';
    $('#btnEnd').disabled = !workflowId || terminal || s === 'idle';
    if (s !== 'paused') $('#pausePanel').style.display = 'none';
    if (terminal) workflowId = null;
  }
  const showPool = (p) => {
    const wait = p.available === 0 && p.nextAvailableInMs !== null ? ` — next account available in ${Math.ceil(p.nextAvailableInMs / 1000)} s` : '';
    const none = p.total === 0 ? ' — no accounts: add one on the accounts page' : p.available === 0 && p.cooldown === 0 && p.live === 0 && p.noSession > 0 ? ' — accounts have no saved session yet (Get Cookies)' : '';
    $('#pool').textContent = `${p.available} available / ${p.live} live / ${p.cooldown} cooldown / ${p.noSession} no session / ${p.expired + p.invalid} out / ${p.queued} queued (max ${p.maxWorkflows})${wait}${none}`;
  };

  const ws = new WebSocket(`ws://${location.host}/ws`);
  const send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const mine = (m) => !m.workflowId || m.workflowId === workflowId;

  ws.onopen = () => log(Date.now(), 'connected to automation service', 'local');
  ws.onclose = () => { log(Date.now(), 'disconnected from automation service (reload the page after restarting it)', 'err'); setState('disconnected'); };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'pool.status') { showPool(m.pool); return; }
    // The acceptance is the message that tells this page its workflow id, so it must pass before the ownership filter.
    if (m.type === 'workflow.accepted' && !workflowId) { /* handled below */ }
    else if (!mine(m)) return;
    switch (m.type) {
      case 'hello':
        debounceMs = m.debounceMs;
        $('#debounce').textContent = debounceMs;
        $('#target').textContent = m.targetUrl;
        writeOnly = m.writeOnlyFields || [];
        deferred = m.deferredFields || [];
        showPool(m.pool);
        setState('idle', 'press Start workflow');
        log(m.ts, `hello — fields=${m.fields.join(',')}, write-only=${writeOnly.join(',') || '-'}, deferred=${deferred.join(',') || '-'}`, 'local');
        for (const f of fields) if (!m.fields.includes(f.dataset.field)) log(Date.now(), `WARNING: local field "${f.dataset.field}" has no mapping in config`, 'err');
        break;
      case 'workflow.accepted':
        workflowId = m.workflowId;
        $('#wfid').textContent = workflowId.slice(0, 8);
        setState(m.queuePosition ? 'allocating' : 'allocating', m.queuePosition ? `queued, position ${m.queuePosition}` : 'profile reserved');
        log(m.ts, `workflow ${workflowId.slice(0, 8)} accepted${m.queuePosition ? ` (queue position ${m.queuePosition})` : ''}`, 'state');
        // Anything typed before Start is sent now so it is buffered and applied at READY.
        for (const f of fields) if (f.value) sendField(f, true);
        break;
      case 'state':
        setState(m.state, m.detail);
        log(m.ts, `state → ${m.state}${m.detail ? ` — ${m.detail}` : ''}`, 'state');
        break;
      case 'event':
        if (m.name.startsWith('state →')) break;
        log(m.ts, `${m.name}${m.detail ? ` — ${m.detail}` : ''}`);
        break;
      case 'field.ack': {
        const total = m.filledAt - m.sentAt;
        const queued = m.startedAt - m.receivedAt;
        log(m.ts, `Website B ${m.field} updated = ${show(m.field, m.value)} — transit ${m.receivedAt - m.sentAt} ms${queued > 5 ? `, queued ${queued} ms` : ''}, fill ${m.filledAt - m.startedAt} ms, total ${total} ms`, 'ack');
        const s = document.querySelector(`[data-sync="${m.field}"]`);
        if (s) s.textContent = `✓ synced (${total} ms)`;
        break;
      }
      case 'field.deferred': {
        const s = document.querySelector(`[data-sync="${m.field}"]`);
        if (s) s.textContent = '✓ saved (applied later)';
        break;
      }
      case 'field.error':
        log(m.ts, `field ${m.field} error: ${m.code} — ${m.message}`, 'err');
        break;
      case 'result': {
        $('#result').innerHTML = '';
        const btn = document.createElement('button');
        btn.textContent = 'Open link';
        btn.style.marginTop = '0';
        const wf = workflowId;
        btn.onclick = () => {
          window.open(m.url, '_blank');
          btn.disabled = true;
          btn.textContent = 'Link opened (visited)';
          log(Date.now(), 'link opened by user', 'local');
          send({ type: 'link.opened', ts: Date.now(), workflowId: wf });
        };
        const span = document.createElement('div'); span.textContent = m.url; span.style.fontSize = '12px';
        $('#result').appendChild(btn); $('#result').appendChild(span);
        log(Date.now(), `URL received by Website A — ${Date.now() - m.submitRequestedAt} ms after submit requested (source: ${m.source})`, 'ack');
        break;
      }
      case 'error':
        log(m.ts, `${m.fatal ? 'FATAL ' : ''}ERROR ${m.code}: ${m.message}`, 'err');
        break;
      case 'paused':
        $('#pauseStep').textContent = m.step;
        $('#pauseMsg').textContent = `${m.code}: ${m.message}`;
        $('#pauseSteps').textContent = m.steps.map((st, i) => (i < m.stepIndex ? '✓ ' : i === m.stepIndex ? '✗ ' : '· ') + st).join('   ');
        $('#pausePanel').style.display = 'block';
        log(m.ts, `PAUSED at step "${m.step}" — ${m.code}: ${m.message}`, 'err');
        break;
    }
  };

  let hinted = false;
  function sendField(f, force) {
    const name = f.dataset.field;
    clearTimeout(timers[name]);
    if (!workflowId) { // typed before Start: kept in the inputs, sent in bulk on workflow.accepted
      if (!hinted) { hinted = true; log(Date.now(), 'no active workflow yet — press "Start workflow"; what you type now is sent once it is accepted', 'local'); }
      return;
    }
    if (state === 'allocating' || state === 'preparing') { /* accepted: the service buffers these until READY */ }
    if (!force && lastSent[name] === f.value) return;
    lastSent[name] = f.value;
    seq[name] = (seq[name] || 0) + 1;
    const ts = Date.now();
    const s = document.querySelector(`[data-sync="${name}"]`);
    if (s) s.textContent = '… syncing';
    log(ts, `${name} changed locally → ${show(name, f.value)} (seq ${seq[name]})`, 'local');
    send({ type: 'field.update', ts, workflowId, field: name, value: f.value, seq: seq[name] });
  }

  for (const f of fields) {
    const name = f.dataset.field;
    f.addEventListener('input', (ev) => {
      // The authentication code triggers the address finalisation on the service: make sure every
      // other field's pending (debounced) value is sent BEFORE the first code update.
      if (writeOnly.includes(name)) for (const o of fields) if (o !== f && timers[o.dataset.field]) sendField(o);
      clearTimeout(timers[name]); timers[name] = setTimeout(() => sendField(f), debounceMs);
    });
    f.addEventListener('change', () => sendField(f));
  }

  $('#btnStart').onclick = () => {
    $('#result').textContent = '— no URL yet —';
    for (const s of document.querySelectorAll('[data-sync]')) s.textContent = '';
    for (const k of Object.keys(lastSent)) delete lastSent[k];
    log(Date.now(), 'workflow start requested', 'local');
    send({ type: 'workflow.start', ts: Date.now() });
  };
  $('#btnSubmit').onclick = () => {
    const snapshot = {};
    for (const f of fields) { clearTimeout(timers[f.dataset.field]); snapshot[f.dataset.field] = f.value; }
    submitRequestedAt = Date.now();
    $('#result').textContent = '… waiting for generated URL';
    log(submitRequestedAt, 'submit requested (full snapshot sent)', 'local');
    send({ type: 'submit', ts: submitRequestedAt, workflowId, snapshot });
  };
  $('#btnEnd').onclick = () => { if (workflowId) send({ type: 'workflow.end', ts: Date.now(), workflowId, reason: 'user ended it' }); };
  $('#btnRetry').onclick = () => { log(Date.now(), 'retry step requested', 'local'); send({ type: 'resume', ts: Date.now(), workflowId, mode: 'retry' }); };
  $('#btnSkip').onclick = () => { log(Date.now(), 'skip step requested (done manually)', 'local'); send({ type: 'resume', ts: Date.now(), workflowId, mode: 'skip' }); };
  $('#btnAbort').onclick = () => { send({ type: 'resume', ts: Date.now(), workflowId, mode: 'abort' }); };
  $('#btnClear').onclick = () => { logEl.innerHTML = ''; lastLogTs = null; };

  // ---- automation browser mode (development control) ----
  function showBrowserMode(st) {
    const modeEl = $('#bmMode');
    modeEl.textContent = st.chromium === 'restarting' ? 'restarting…' : st.mode;
    modeEl.className = `bm-mode ${st.chromium === 'restarting' ? 'restarting' : st.mode}`;
    $('#bmStatus').textContent = st.message;
    $('#bmChromium').textContent = st.chromium;
    $('#bmActive').textContent = st.activeWorkflows;
    $('#bmVisible').classList.toggle('active', st.mode === 'visible' && !st.pendingMode);
    $('#bmHeadless').classList.toggle('active', st.mode === 'headless' && !st.pendingMode);
    $('#bmVisible').disabled = st.chromium === 'restarting';
    $('#bmHeadless').disabled = st.chromium === 'restarting';
  }
  async function pollBrowserMode() {
    try { showBrowserMode(await (await fetch('/api/dev/browser')).json()); } catch { /* service restarting */ }
  }
  async function requestBrowserMode(mode) {
    $('#bmStatus').textContent = 'Requesting…';
    try {
      const r = await fetch('/api/dev/browser', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
      const st = await r.json();
      if (!r.ok) { $('#bmStatus').textContent = st.error || 'request failed'; return; }
      showBrowserMode(st);
      log(Date.now(), `browser mode requested: ${mode} — ${st.message}`, 'local');
    } catch (e) { $('#bmStatus').textContent = String(e); }
  }
  $('#bmVisible').onclick = () => requestBrowserMode('visible');
  $('#bmHeadless').onclick = () => requestBrowserMode('headless');
  pollBrowserMode();
  setInterval(pollBrowserMode, 2000);
})();
