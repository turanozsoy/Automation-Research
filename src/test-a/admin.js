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
      tr.innerHTML = `
        <td><b>${esc(a.name)}</b></td>
        <td>${esc(a.email)}</td>
        <td><span class="badge ${a.hasSession ? 'yes' : 'no'}">${a.hasSession ? 'saved' : 'none'}</span>${loginOpen ? ' <small>(login browser open)</small>' : ''}</td>
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

  $('#btnReload').onclick = () => load().catch((e) => msg(e.message, true));
  load().catch((e) => msg(e.message, true));
})();
