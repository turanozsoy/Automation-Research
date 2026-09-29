/* Local Website A stand-in. Talks straight to the automation service over one WebSocket. */
(() => {
  const $ = (s) => document.querySelector(s);
  const logEl = $('#log');
  const fields = [...document.querySelectorAll('[data-field]')];
  let debounceMs = 150;
  let state = 'connecting';
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

  function setState(s, detail) {
    state = s;
    $('#state').textContent = s;
    $('#detail').textContent = detail ? `— ${detail}` : '';
    $('#btnStart').disabled = s !== 'awaiting_user';
    $('#btnSubmit').disabled = s !== 'ready';
  }

  const ws = new WebSocket(`ws://${location.host}/ws`);
  const send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

  ws.onopen = () => log(Date.now(), 'connected to automation service', 'local');
  ws.onclose = () => { log(Date.now(), 'disconnected from automation service (reload the page after restarting it)', 'err'); setState('disconnected'); };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello':
        debounceMs = m.debounceMs;
        $('#debounce').textContent = debounceMs;
        $('#target').textContent = m.targetUrl;
        writeOnly = m.writeOnlyFields || [];
        deferred = m.deferredFields || [];
        setState(m.state);
        log(m.ts, `hello — state=${m.state}, fields=${m.fields.join(',')}, write-only=${writeOnly.join(',') || '-'}, deferred=${deferred.join(',') || '-'}`, 'local');
        for (const f of fields) if (!m.fields.includes(f.dataset.field)) log(Date.now(), `WARNING: local field "${f.dataset.field}" has no mapping in config`, 'err');
        break;
      case 'state':
        setState(m.state, m.detail);
        log(m.ts, `state → ${m.state}${m.detail ? ` — ${m.detail}` : ''}`, 'state');
        break;
      case 'event':
        if (m.name.startsWith('state →')) break; // already logged via the 'state' message
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
        // The service's timeline event already logs this; only update the field marker here.
        const s = document.querySelector(`[data-sync="${m.field}"]`);
        if (s) s.textContent = '✓ saved (applied at submit)';
        break;
      }
      case 'field.error':
        log(m.ts, `field ${m.field} error: ${m.code} — ${m.message}`, 'err');
        break;
      case 'result':
        $('#result').innerHTML = '';
        { const a = document.createElement('a'); a.href = m.url; a.target = '_blank'; a.textContent = m.url; $('#result').appendChild(a); }
        log(Date.now(), `URL received by Website A — ${Date.now() - m.submitRequestedAt} ms after submit requested (source: ${m.source})`, 'ack');
        break;
      case 'error':
        log(m.ts, `${m.fatal ? 'FATAL ' : ''}ERROR ${m.code}: ${m.message}`, 'err');
        break;
    }
  };

  function sendField(f, force) {
    const name = f.dataset.field;
    clearTimeout(timers[name]);
    if (!force && lastSent[name] === f.value) return; // blur after a debounced send: nothing new
    lastSent[name] = f.value;
    seq[name] = (seq[name] || 0) + 1;
    const ts = Date.now();
    const s = document.querySelector(`[data-sync="${name}"]`);
    if (s) s.textContent = '… syncing';
    log(ts, `${name} changed locally → ${show(name, f.value)} (seq ${seq[name]})`, 'local');
    send({ type: 'field.update', ts, field: name, value: f.value, seq: seq[name] });
  }

  for (const f of fields) {
    const name = f.dataset.field;
    f.addEventListener('input', () => {
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => sendField(f), debounceMs);
    });
    // blur / select change: flush immediately, no need to wait for the debounce.
    f.addEventListener('change', () => sendField(f));
  }

  $('#btnStart').onclick = () => { log(Date.now(), 'start requested locally', 'local'); send({ type: 'start', ts: Date.now() }); };
  $('#btnSubmit').onclick = () => {
    const snapshot = {};
    for (const f of fields) { clearTimeout(timers[f.dataset.field]); snapshot[f.dataset.field] = f.value; }
    submitRequestedAt = Date.now();
    $('#result').textContent = '… waiting for generated URL';
    log(submitRequestedAt, 'submit requested (full snapshot sent)', 'local');
    send({ type: 'submit', ts: submitRequestedAt, snapshot });
  };
  $('#btnReset').onclick = () => { $('#result').textContent = '— no URL yet —'; send({ type: 'reset', ts: Date.now() }); };
  $('#btnClear').onclick = () => { logEl.innerHTML = ''; lastLogTs = null; };
})();
