/* Accounts management page: add accounts, open a manual-login browser, save the session on Done. */
(() => {
  const $ = (s) => document.querySelector(s);
  const msg = (t, err) => { const el = $('#msg'); el.textContent = t; el.className = err ? 'err' : ''; };
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
  const api = async (path, opts) => {
    const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.reason || `HTTP ${r.status}`);
    return j;
  };

  let activeLogin = null;   // { id, name }
  let pollTimer = null;
  let accounts = [];

  async function load() {
    const j = await api('/api/accounts');
    accounts = j.accounts;
    render(j.logins || {});
    // Resume the panel if a login browser is already open for some account (e.g. after a page reload).
    const openId = Object.keys(j.logins || {})[0];
    if (openId && !activeLogin) { const a = accounts.find((x) => x.id === openId); if (a) showLoginPanel(a.id, a.name); }
  }

  function render(logins) {
    const tb = $('#rows');
    tb.innerHTML = '';
    if (!accounts.length) { tb.innerHTML = '<tr><td colspan="8">No accounts yet. Press "Add Account".</td></tr>'; return; }
    for (const a of accounts) {
      const tr = document.createElement('tr');
      const loginOpen = !!logins[a.id];
      tr.dataset.accountId = a.id;
      const sess = a.sessionStatus === 'none' ? '<span class="badge no">none</span>'
        : a.sessionStatus === 'current' ? '<span class="badge current">saved · current</span>'
        : a.sessionStatus === 'attention' ? `<span class="badge attention">saved · needs attention</span>${a.sessionNote ? `<br><small>${esc(a.sessionNote)}</small>` : ''}`
        : '<span class="badge expired">saved · expired</span>';
      tr.innerHTML = `
        <td><b>${esc(a.name)}</b></td>
        <td>${esc(a.email)}</td>
        <td>${sess}${loginOpen ? ' <small>(login browser open)</small>' : ''}</td>
        <td><span class="badge ${a.status}">${a.status}</span>${a.status === 'expired' && a.stateReason ? `<br><small>${esc(a.stateReason)}</small>` : ''}</td>
        <td>${fmt(a.createdAt)}</td>
        <td>${fmt(a.sessionSavedAt)}</td>
        <td>${fmt(a.lastWorkflowAt)}${a.lastUrl ? `<br><small>${esc(a.lastUrl)}</small>` : ''}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      const b1 = document.createElement('button');
      b1.textContent = a.hasSession ? 'Refresh Cookies' : 'Get Cookies';
      b1.onclick = () => startLogin(a.id, a.name);
      const b2 = document.createElement('button');
      b2.textContent = 'Remove';
      b2.onclick = async () => {
        if (!confirm(`Remove account "${a.name}" and its saved session?`)) return;
        try { await api(`/api/accounts/${a.id}`, { method: 'DELETE' }); msg(`Removed ${a.name}`); await load(); } catch (e) { msg(e.message, true); }
      };
      actions.appendChild(b1); actions.appendChild(b2);
      tb.appendChild(tr);
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- add account ----
  $('#btnAdd').onclick = () => { $('#addForm').style.display = 'block'; $('#newName').focus(); };
  $('#btnCancelAdd').onclick = () => { $('#addForm').style.display = 'none'; };
  $('#btnCreate').onclick = async () => {
    const name = $('#newName').value.trim();
    const email = $('#newEmail').value.trim();
    if (!name || !email) { msg('Enter the account name/number and the email.', true); return; }
    try {
      const { id } = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name, email }) });
      $('#addForm').style.display = 'none';
      $('#newName').value = ''; $('#newEmail').value = '';
      await load();
      await startLogin(id, name);
    } catch (e) { msg(e.message, true); }
  };

  // ---- manual login flow ----
  async function startLogin(id, name) {
    try {
      msg(`Opening a Chromium window for ${name}…`);
      await api(`/api/accounts/${id}/login/start`, { method: 'POST' });
      showLoginPanel(id, name);
      msg('');
    } catch (e) { msg(e.message, true); }
  }

  function showLoginPanel(id, name) {
    activeLogin = { id, name };
    $('#loginName').textContent = name;
    $('#loginPanel').style.display = 'block';
    $('#btnDone').disabled = false;
    clearInterval(pollTimer);
    pollTimer = setInterval(pollLogin, 1500);
    pollLogin();
  }

  async function pollLogin() {
    if (!activeLogin) return;
    try {
      const s = await api(`/api/accounts/${activeLogin.id}/login/status`);
      if (!s.open) { hideLoginPanel('The login browser was closed. Nothing was saved. Use Get/Refresh Cookies to try again.', true); await load(); return; }
      $('#loginUrl').textContent = `${s.currentUrl || '…'}${s.onLoginPage ? '  (still the login page)' : ''}`;
    } catch { /* transient */ }
  }

  function hideLoginPanel(text, err) {
    clearInterval(pollTimer); pollTimer = null;
    activeLogin = null;
    $('#loginPanel').style.display = 'none';
    if (text) msg(text, err);
  }

  $('#btnDone').onclick = async () => {
    if (!activeLogin) return;
    $('#btnDone').disabled = true;
    try {
      const r = await api(`/api/accounts/${activeLogin.id}/login/done`, { method: 'POST' });
      if (r.saved) { hideLoginPanel(`Session saved for ${activeLogin.name}. The login browser was closed.`); await load(); }
    } catch (e) {
      // 409: still on the login page, or no cookies yet. Keep the panel open so the user can finish and retry.
      msg(e.message, true);
      $('#btnDone').disabled = false;
    }
  };
  $('#btnCancelLogin').onclick = async () => {
    if (!activeLogin) return;
    try { await api(`/api/accounts/${activeLogin.id}/login/cancel`, { method: 'POST' }); } catch { /* ignore */ }
    hideLoginPanel('Login cancelled. Nothing was saved.');
    await load();
  };

  $('#btnReload').onclick = () => { load().catch((e) => msg(e.message, true)); loadVerified(true); };
  load().catch((e) => msg(e.message, true));

  // ---- verified applications ----
  const PAGE = 25;
  let vq = '';
  let vloaded = 0;
  let vtotal = 0;
  const ago = (ts) => {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };
  const sessionLabel = (p) => !p ? '—' : p.sessionStatus === 'current' ? 'Saved / Current' : p.sessionStatus === 'attention' ? `Saved / Needs attention${p.sessionNote ? ' (' + p.sessionNote + ')' : ''}` : p.sessionStatus === 'expired' ? 'Saved / Expired' : 'None';

  async function loadVerified(reset, extra) {
    if (reset) { vloaded = 0; $('#verifiedList').innerHTML = ''; }
    const limit = extra ? PAGE : Math.max(PAGE, vloaded);
    const offset = extra ? vloaded : 0;
    let j;
    try { j = await api(`/api/admin/applications/verified?q=${encodeURIComponent(vq)}&offset=${offset}&limit=${limit}`); } catch (e) { $('#verifiedMsg').innerHTML = `<small class="err">${esc(e.message)}</small>`; return; }
    if (!extra) { $('#verifiedList').innerHTML = ''; vloaded = 0; }
    vtotal = j.total;
    $('#verifiedCount').textContent = `${j.total} verified`;
    for (const it of j.items) $('#verifiedList').appendChild(renderVerified(it));
    vloaded += j.items.length;
    if (!vloaded) $('#verifiedList').innerHTML = `<div class="empty">${vq ? 'No verified applications match that search.' : 'No verified applications yet.'}</div>`;
    $('#btnMore').style.display = vloaded < vtotal ? '' : 'none';
    $('#verifiedMsg').innerHTML = `<small>Showing ${vloaded} of ${vtotal}</small>`;
  }

  function renderVerified(it) {
    const d = document.createElement('details');
    d.className = 'vrow';
    d.dataset.appId = it.id;
    const p = it.processedWith;
    const answers = Object.entries(it.answers || {}).map(([k, v]) => `${esc(k)}: ${esc(String(v))}`).join(', ') || '—';
    d.innerHTML = `
      <summary>
        <div><div class="name">${esc(it.fullName)}</div><div class="appid">${esc(it.displayId)} <button class="copy" type="button" title="Copy full application ID">Copy ID</button></div></div>
        <div>Verified ${ago(it.verifiedAt)}</div>
        <div>Processed with: ${p ? `<button class="acct-link" type="button" data-account="${esc(p.profileId)}" ${p.exists ? '' : 'disabled title="account removed"'}>${esc(p.label)}</button>` : '—'}</div>
        <div>Session: ${esc(sessionLabel(p))}<br><small>Session updated: ${ago(p && p.sessionSavedAt)}</small></div>
      </summary>
      <div class="detail">
        <div><span>Full name</span>${esc(it.fullName)}</div>
        <div><span>Application ID</span><code>${esc(it.id)}</code></div>
        <div><span>Email</span>${esc(it.email || '—')}</div>
        <div><span>Created</span>${fmt(it.createdAt)}</div>
        <div><span>Link ready</span>${fmt(it.generatedUrlReadyAt)}</div>
        <div><span>Final CTA clicked</span>${fmt(it.finalLinkClickedAt)}</div>
        <div><span>Visited</span>${fmt(it.visitedAt)}</div>
        <div><span>Verified</span>${fmt(it.verifiedAt)}</div>
        <div><span>Account used</span>${p ? esc(p.label) + (p.exists ? '' : ' (removed)') : '—'}</div>
        <div><span>Session last saved</span>${fmt(p && p.sessionSavedAt)}${it.sessionResult === 'failed' ? ' <span class="badge attention">SESSION_PERSIST_FAILED</span>' : it.sessionResult === 'refreshed' ? ' <span class="badge current">refreshed after this run</span>' : ''}</div>
        <div><span>Workflow ID</span><code>${esc(it.workflowId || '—')}</code></div>
        <div><span>Workflow outcome</span>${esc(it.workflowOutcome || '—')}</div>
        <div style="grid-column:1/-1"><span>Answers</span>${answers}</div>
      </div>`;
    d.querySelector('.copy').onclick = async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      try { await navigator.clipboard.writeText(it.id); ev.target.textContent = 'Copied'; setTimeout(() => { ev.target.textContent = 'Copy ID'; }, 1500); } catch { prompt('Application ID', it.id); }
    };
    const acct = d.querySelector('.acct-link');
    if (acct) acct.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); focusAccount(acct.dataset.account); };
    return d;
  }

  function focusAccount(id) {
    const tr = document.querySelector(`tr[data-account-id="${CSS.escape(id)}"]`);
    if (!tr) { msg('That account is no longer in the list.', true); return; }
    document.querySelectorAll('tr.highlight').forEach((r) => r.classList.remove('highlight'));
    tr.classList.add('highlight');
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => tr.classList.remove('highlight'), 4000);
  }

  let searchTimer = null;
  $('#verifiedSearch').addEventListener('input', (ev) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { vq = ev.target.value.trim(); loadVerified(true); }, 250); });
  $('#btnMore').onclick = () => loadVerified(false, true);
  loadVerified(true);

  // Live updates: the service nudges this page (no data on the wire); re-fetch what changed.
  function connectAdmin() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/admin`);
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'admin.changed') return;
      if (m.what === 'verified') loadVerified(false);
      if (m.what === 'accounts') { load().catch(() => {}); loadVerified(false); }
    };
    ws.onclose = () => setTimeout(connectAdmin, 3000);
  }
  connectAdmin();
})();
