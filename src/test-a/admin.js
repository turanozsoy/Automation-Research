/*
 * Shipzora Operations (/admin/accounts, internal). Same API and live channel as before:
 *   GET/POST /api/accounts, /api/accounts/:id (DELETE), /api/accounts/:id/login/{start,status,done,cancel}
 *   GET /api/admin/applications/verified?q&offset&limit
 *   /ws/admin nudges ({type:'admin.changed', what:'verified'|'accounts'}) -> re-fetch
 * Never receives or renders cookies, storageState, verification codes or auth secrets.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (path, opts) => {
    const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
    if (r.status === 401) { location.href = `/admin/login?next=${encodeURIComponent(location.pathname)}`; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.reason || `HTTP ${r.status}`);
    return j;
  };

  // ---------- messages ----------
  let msgTimer = null;
  function msg(text, err) {
    const el = $('#msg');
    clearTimeout(msgTimer);
    if (!text) { el.hidden = true; return; }
    el.textContent = text; el.className = `toast${err ? ' err' : ''}`; el.hidden = false;
    msgTimer = setTimeout(() => { el.hidden = true; }, err ? 7000 : 3500);
  }

  // ---------- dates ----------
  const exact = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  function human(ts) {
    if (!ts) return '—';
    const d = new Date(ts), now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, now)) return `Today, ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return `Yesterday, ${time}`;
    const opts = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
    return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
  }
  const ago = (ts) => {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };
  const when = (ts) => (ts ? `<time datetime="${new Date(ts).toISOString()}" title="${esc(exact(ts))}">${esc(human(ts))}</time>` : '<span class="sub">—</span>');

  // ---------- badges ----------
  const SESSION = {
    current: ['ok', 'Current'], attention: ['warn', 'Needs attention'], expired: ['danger', 'Expired'], none: ['neutral', 'Not saved'],
  };
  const STATUS = { verified: ['ok', 'Verified'], visited: ['brand', 'Visited'], expired: ['danger', 'Expired'], none: ['neutral', 'None'] };
  const badge = (map, key) => { const [cls, label] = map[key] || ['neutral', key]; return `<span class="badge ${cls}">${esc(label)}</span>`; };

  // =====================================================================
  // accounts
  // =====================================================================
  let accounts = [];
  let logins = {};
  let accountQuery = '';
  let accountFilter = 'all';

  async function load() {
    const j = await api('/api/accounts');
    accounts = j.accounts;
    logins = j.logins || {};
    renderAccounts();
    renderStats();
    // Resume the login dialog if a login browser is already open (e.g. after a page reload).
    const openId = Object.keys(logins)[0];
    if (openId && !activeLogin) { const a = accounts.find((x) => x.id === openId); if (a) showLogin(a.id, a.name); }
  }

  function visibleAccounts() {
    const q = accountQuery.toLowerCase();
    return accounts.filter((a) => (accountFilter === 'all' || a.sessionStatus === accountFilter) && (!q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)));
  }

  function renderAccounts() {
    const tb = $('#rows');
    tb.innerHTML = '';
    const list = visibleAccounts();
    $('#accountsNote').textContent = accounts.length ? `${list.length} of ${accounts.length} account${accounts.length === 1 ? '' : 's'}` : '';
    if (!accounts.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty"><strong>No onboarding accounts yet.</strong>Add an account to capture its session; workflows will use it automatically.</td></tr>';
      return;
    }
    if (!list.length) { tb.innerHTML = '<tr><td colspan="9" class="empty"><strong>No accounts match.</strong>Try another search or filter.</td></tr>'; return; }
    for (const a of list) {
      const tr = document.createElement('tr');
      tr.dataset.accountId = a.id;
      const loginOpen = !!logins[a.id];
      const sessionSub = a.sessionStatus === 'attention' && a.sessionNote ? `<span class="sub">${esc(a.sessionNote)}</span>`
        : a.sessionStatus === 'expired' && a.stateReason ? `<span class="sub">${esc(a.stateReason)}</span>`
        : a.hasSession ? `<span class="sub">Last used ${esc(ago(a.lastUsedAt))}</span>` : '';
      tr.innerHTML = `
        <td data-label="Account"><span class="acct-name">${esc(a.name)}</span>${loginOpen ? '<span class="sub">Login browser open</span>' : ''}</td>
        <td data-label="Email">${esc(a.email)}</td>
        <td data-label="Session">${badge(SESSION, a.sessionStatus)}${sessionSub}</td>
        <td data-label="Proxy">${a.proxy ? `<span class="mono">${esc(a.proxy.label)}</span><span class="sub">${esc((EGRESS_STATE[a.proxy.state] || [0, a.proxy.state])[1])}${a.proxy.since ? ' · bound ' + esc(ago(a.proxy.since)) : ''}</span>` : '<span class="sub">none yet</span>'}</td>
        <td data-label="Status">${badge(STATUS, a.status)}</td>
        <td data-label="Created">${when(a.createdAt)}</td>
        <td data-label="Last session update">${when(a.sessionSavedAt)}</td>
        <td data-label="Last workflow">${when(a.lastWorkflowAt)}</td>
        <td data-label="Actions" class="td-actions"></td>`;
      const actions = tr.lastElementChild;
      const b1 = document.createElement('button');
      b1.type = 'button'; b1.className = 'btn btn-secondary btn-sm';
      b1.textContent = a.hasSession ? 'Refresh cookies' : 'Get cookies';
      b1.onclick = () => startLogin(a.id, a.name);
      const b2 = document.createElement('button');
      b2.type = 'button'; b2.className = 'btn-text-danger'; b2.textContent = 'Remove';
      b2.onclick = () => askRemove(a);
      actions.append(b1, document.createTextNode(' '), b2);
      tb.appendChild(tr);
    }
  }

  function renderStats() {
    const n = accounts.length;
    const current = accounts.filter((a) => a.sessionStatus === 'current').length;
    const attention = accounts.filter((a) => a.sessionStatus === 'attention' || a.sessionStatus === 'expired').length;
    const notSaved = accounts.filter((a) => a.sessionStatus === 'none').length;
    $('#statAccounts').textContent = n;
    $('#statAccountsNote').textContent = notSaved ? `${notSaved} without a saved session` : n ? 'All have a saved session' : 'Add the first account';
    $('#statCurrent').textContent = current;
    $('#statCurrentNote').textContent = n ? `of ${n} account${n === 1 ? '' : 's'}` : ' ';
    $('#statAttention').textContent = attention;
    $('#statAttentionNote').textContent = attention ? 'Sessions to check or refresh' : 'Nothing needs attention';
    $('#statAttention').closest('.card').classList.toggle('attention', attention > 0);
  }

  $('#accountSearch').addEventListener('input', (ev) => { accountQuery = ev.target.value.trim(); renderAccounts(); });
  for (const chip of document.querySelectorAll('.chip')) chip.onclick = () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active'); accountFilter = chip.dataset.filter; renderAccounts();
  };

  // ---------- add account (same create -> login/start flow) ----------
  $('#btnAdd').onclick = () => { $('#newName').value = ''; $('#newEmail').value = ''; $('#dlgAdd').showModal(); $('#newName').focus(); };
  $('#btnCancelAdd').onclick = () => $('#dlgAdd').close();
  $('#addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('#newName').value.trim();
    const email = $('#newEmail').value.trim();
    if (!name || !email) { msg('Enter the account name and the email.', true); return; }
    $('#btnCreate').disabled = true;
    try {
      const { id } = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name, email }) });
      $('#dlgAdd').close();
      await load();
      await startLogin(id, name);
    } catch (e) { msg(e.message, true); } finally { $('#btnCreate').disabled = false; }
  });

  // ---------- manual login flow (unchanged mechanics: start -> poll status -> done / cancel) ----------
  let activeLogin = null;
  let pollTimer = null;
  async function startLogin(id, name) {
    try {
      msg(`Opening a Chromium window for ${name}…`);
      await api(`/api/accounts/${id}/login/start`, { method: 'POST' });
      showLogin(id, name);
      msg(null);
    } catch (e) { msg(e.message, true); }
  }
  function showLogin(id, name) {
    activeLogin = { id, name };
    $('#loginName').textContent = name;
    $('#loginUrl').textContent = '…';
    $('#btnDone').disabled = false;
    if (!$('#dlgLogin').open) $('#dlgLogin').showModal();
    clearInterval(pollTimer);
    pollTimer = setInterval(pollLogin, 1500);
    pollLogin();
  }
  async function pollLogin() {
    if (!activeLogin) return;
    try {
      const s = await api(`/api/accounts/${activeLogin.id}/login/status`);
      if (!s.open) { hideLogin('The login browser was closed. Nothing was saved. Use Get or Refresh cookies to try again.', true); await load(); return; }
      $('#loginUrl').textContent = `${s.currentUrl || '…'}${s.onLoginPage ? '  (still the login page)' : ''}${s.egress ? `  ·  via ${s.egress}` : ''}`;
    } catch { /* transient */ }
  }
  function hideLogin(text, err) {
    clearInterval(pollTimer); pollTimer = null;
    activeLogin = null;
    if ($('#dlgLogin').open) $('#dlgLogin').close();
    if (text) msg(text, err);
  }
  $('#btnDone').onclick = async () => {
    if (!activeLogin) return;
    $('#btnDone').disabled = true;
    try {
      const r = await api(`/api/accounts/${activeLogin.id}/login/done`, { method: 'POST' });
      if (r.saved) { hideLogin(`Session saved for ${activeLogin.name}. The login browser was closed.`); await load(); }
    } catch (e) {
      // 409: still on the login page, or no cookies yet. Keep the dialog open so the user can finish and retry.
      msg(e.message, true);
      $('#btnDone').disabled = false;
    }
  };
  $('#btnCancelLogin').onclick = async () => {
    if (!activeLogin) return;
    try { await api(`/api/accounts/${activeLogin.id}/login/cancel`, { method: 'POST' }); } catch { /* ignore */ }
    hideLogin('Login cancelled. Nothing was saved.');
    await load();
  };
  $('#dlgLogin').addEventListener('cancel', (ev) => { ev.preventDefault(); }); // Esc must not silently drop the flow

  // ---------- remove (confirmation dialog, destructive styling) ----------
  let removing = null;
  function askRemove(a) { removing = a; $('#removeName').textContent = a.name; $('#dlgRemove').showModal(); $('#btnCancelRemove').focus(); }
  $('#btnCancelRemove').onclick = () => { removing = null; $('#dlgRemove').close(); };
  $('#btnConfirmRemove').onclick = async () => {
    if (!removing) return;
    const a = removing; removing = null;
    $('#dlgRemove').close();
    try { await api(`/api/accounts/${a.id}`, { method: 'DELETE' }); msg(`Removed ${a.name}.`); await load(); loadVerified(false); } catch (e) { msg(e.message, true); }
  };

  function focusAccount(id) {
    const tr = document.querySelector(`tr[data-account-id="${CSS.escape(id)}"]`);
    if (!tr) { msg('That account is no longer in the list, or is hidden by the current filter.', true); return; }
    document.querySelectorAll('tr.highlight').forEach((r) => r.classList.remove('highlight'));
    tr.classList.add('highlight');
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => tr.classList.remove('highlight'), 4000);
  }

  // =====================================================================
  // proxy egress
  // =====================================================================
  const EGRESS_STATE = { available: ['ok', 'Available'], in_use: ['brand', 'In use'], held: ['warn', 'Held'], down: ['danger', 'Down'], retired: ['neutral', 'Retired'] };
  const EGRESS_HEALTH = { healthy: ['ok', 'Healthy'], degraded: ['warn', 'Degraded'], down: ['danger', 'Down'], unknown: ['neutral', 'Unknown'] };
  let egressDirectAllowed = true;

  async function loadEgress() {
    let j;
    try { j = await api('/api/admin/egress'); } catch (e) { $('#egressNote').textContent = e.message; return; }
    egressDirectAllowed = j.directAllowed;
    const c = j.counts;
    $('#egressCount').textContent = `${c.total} session${c.total === 1 ? '' : 's'}`;
    $('#statProxies').textContent = c.available;
    $('#statProxiesNote').textContent = c.total ? `${c.inUse} in use · ${c.held} held · ${c.down} down` : 'Workflows use the server IP';
    $('#egressNote').textContent = egressDirectAllowed ? '' : 'Per-context proxy mode: the direct egress is unavailable; every workflow needs a proxy.';
    const tb = $('#egressRows');
    tb.innerHTML = '';
    for (const e of j.egress) tb.appendChild(renderEgress(e));
  }

  function renderEgress(e) {
    const tr = document.createElement('tr');
    tr.dataset.egressId = e.id;
    const isDirect = e.kind === 'direct';
    const where = isDirect ? '<span class="sub">The server\u2019s own outbound IP</span>' : `<span class="sub mono">${esc(e.kind)}://${esc(e.host)}:${esc(String(e.port))}${e.hasAuth ? ' · auth' : ''}</span>`;
    const stateBadge = badge(EGRESS_STATE, e.state);
    const stateSub = e.state === 'held' ? `<span class="sub">since ${esc(human(e.heldSince))}</span>`
      : e.state === 'in_use' ? `<span class="sub">${e.liveWorkflows} workflow${e.liveWorkflows === 1 ? '' : 's'}</span>`
      : e.state === 'available' && isDirect ? `<span class="sub">${e.liveWorkflows} live workflow${e.liveWorkflows === 1 ? '' : 's'}${egressDirectAllowed ? '' : ' · unavailable in per-context mode'}</span>`
      : e.state === 'available' && e.releasedAt ? `<span class="sub">released ${esc(human(e.releasedAt))}</span>`
      : e.stateReason ? `<span class="sub">${esc(e.stateReason)}</span>` : '';
    const healthBadge = isDirect ? '<span class="sub">—</span>' : badge(EGRESS_HEALTH, e.health);
    const healthSub = isDirect ? '' : `<span class="sub">${e.lastCheckAt ? 'checked ' + esc(ago(e.lastCheckAt)) : 'not checked yet'}${e.lastError ? ' · ' + esc(e.lastError) : ''}</span>`;
    const bound = isDirect ? '<span class="sub">shared</span>' : e.boundTo ? `<span class="acct-name">${esc(e.boundTo.label)}</span><span class="sub">bound ${esc(e.boundTo.since ? human(e.boundTo.since) : '')}</span>` : '<span class="sub">unused</span>';
    tr.innerHTML = `
      <td data-label="Proxy"><span class="acct-name">${esc(e.label)}</span>${where}</td>
      <td data-label="Account">${bound}</td>
      <td data-label="Status">${stateBadge}${stateSub}</td>
      <td data-label="Health">${healthBadge}${healthSub}</td>
      <td data-label="Used">${e.useCount} run${e.useCount === 1 ? '' : 's'}<span class="sub">${e.lastUsedAt ? 'last ' + esc(human(e.lastUsedAt)) : 'never'}</span></td>
      <td data-label="Actions" class="td-actions"></td>`;
    const actions = tr.lastElementChild;
    const btn = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = fn; actions.appendChild(b); return b; };
    const act = async (path, method, okMsg) => { try { await api(path, { method }); if (okMsg) msg(okMsg); await loadEgress(); } catch (err) { msg(err.message, true); } };
    if (e.state === 'held') btn('Release proxy', 'btn btn-primary btn-sm', () => { if (confirm(`Release ${e.label}${e.boundTo ? ` from ${e.boundTo.label}` : ''}?\n\nThis clears the account binding and makes the proxy available to a different account. Only do this after the provider confirms the session can be reused.`)) act(`/api/admin/egress/${e.id}/release`, 'POST', `${e.label} released${e.boundTo ? ` from ${e.boundTo.label}` : ''} and back in the unused pool.`); });
    if (e.state === 'down') btn('Restore', 'btn btn-secondary btn-sm', () => act(`/api/admin/egress/${e.id}/release`, 'POST', `${e.label} restored.`));
    if (e.state === 'retired') btn('Reinstate', 'btn btn-secondary btn-sm', () => act(`/api/admin/egress/${e.id}/release`, 'POST', `${e.label} reinstated.`));
    if (!isDirect) btn('Check now', 'btn btn-secondary btn-sm', () => act(`/api/admin/egress/${e.id}/check`, 'POST'));
    if (e.state !== 'retired' && e.state !== 'in_use') btn('Retire', 'btn btn-secondary btn-sm', () => act(`/api/admin/egress/${e.id}/retire`, 'POST', `${e.label} retired.`));
    if (!isDirect && e.state !== 'in_use') btn('Remove', 'btn-text-danger', () => { if (confirm(`Remove proxy ${e.label}? Its history stays on past workflows.`)) act(`/api/admin/egress/${e.id}`, 'DELETE', `${e.label} removed.`); });
    return tr;
  }

  $('#btnAddProxies').onclick = () => { $('#proxyLines').value = ''; $('#proxyResult').hidden = true; $('#dlgProxies').showModal(); $('#proxyLines').focus(); };
  $('#btnCancelProxies').onclick = () => $('#dlgProxies').close();
  $('#proxyForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const lines = $('#proxyLines').value;
    if (!lines.trim()) { msg('Paste at least one proxy.', true); return; }
    $('#btnImportProxies').disabled = true;
    try {
      const r = await api('/api/admin/egress', { method: 'POST', body: JSON.stringify({ lines }) });
      const box = $('#proxyResult');
      box.hidden = false;
      box.innerHTML = `<strong>${r.added} added / ${r.duplicates} duplicates / ${r.invalid.length} invalid</strong>${r.invalid.length ? '<ul>' + r.invalid.map((i) => `<li>Line ${i.line}: ${esc(i.reason)}</li>`).join('') + '</ul>' : ''}`;
      $('#proxyLines').value = '';
      await loadEgress();
    } catch (e) { msg(e.message, true); } finally { $('#btnImportProxies').disabled = false; }
  });

  // =====================================================================
  // verified applications
  // =====================================================================
  const PAGE = 25;
  let vq = '';
  let vloaded = 0;
  let vtotal = 0;
  let known = new Set();

  async function loadVerified(reset, extra) {
    if (reset) { vloaded = 0; $('#verifiedList').innerHTML = ''; }
    const limit = extra ? PAGE : Math.max(PAGE, vloaded);
    const offset = extra ? vloaded : 0;
    let j;
    try { j = await api(`/api/admin/applications/verified?q=${encodeURIComponent(vq)}&offset=${offset}&limit=${limit}`); }
    catch (e) { $('#verifiedMsg').textContent = e.message; return; }
    if (!extra) { $('#verifiedList').innerHTML = ''; vloaded = 0; }
    vtotal = j.total;
    $('#verifiedCount').textContent = `${j.total} verified`;
    $('#statVerified').textContent = vq ? vtotal : j.total;
    $('#statVerifiedNote').textContent = j.items[0] ? `Latest ${human(j.items[0].verifiedAt).toLowerCase()}` : 'None yet';
    const w = j.waitStats;
    if (w && w.withLink) {
      const secs = (ms) => (ms === null ? '—' : `${Math.round(ms / 1000)} s`);
      $('#statWait').textContent = `${secs(w.avgWaitMs)} avg`;
      $('#statWaitNote').textContent = `p90 ${secs(w.p90WaitMs)} · ${w.leftDuringWait} of ${w.withLink} left the screen while waiting · ${w.neverOpened} never opened the link`;
      $('#statWait').closest('.card').classList.toggle('attention', w.withLink >= 5 && w.leftDuringWait / w.withLink > 0.3);
    } else { $('#statWait').textContent = '–'; $('#statWaitNote').textContent = 'No links prepared yet'; }
    const fresh = new Set();
    for (const it of j.items) { fresh.add(it.id); $('#verifiedList').appendChild(renderVerified(it, known.size > 0 && !known.has(it.id))); }
    for (const id of fresh) known.add(id);
    vloaded += j.items.length;
    if (!vloaded) {
      $('#verifiedList').innerHTML = vq
        ? '<div class="vempty"><strong>No verified applications match.</strong>Search by the applicant’s full name or their application ID.</div>'
        : '<div class="vempty"><strong>No verified applications yet.</strong>Verified applicants will appear here automatically once onboarding is completed.</div>';
    }
    $('#btnMore').hidden = !(vloaded < vtotal);
    $('#verifiedMsg').textContent = vloaded ? `Showing ${vloaded} of ${vtotal}` : '';
  }

  function renderVerified(it, isNew) {
    const p = it.processedWith;
    const d = document.createElement('article');
    d.className = `vrow${isNew ? ' new' : ''}`;
    d.dataset.appId = it.id;
    d.innerHTML = `
      <div><div class="name">${esc(it.fullName)}</div><div class="appid"><code>${esc(it.displayId)}</code><button class="copy" type="button" title="Copy full application ID">Copy ID</button></div></div>
      <div><span class="label">Verified</span>${when(it.verifiedAt)}</div>
      <div><span class="label">Processed with</span>${p ? `<button class="link-btn acct-link" type="button" data-account="${esc(p.profileId)}" ${p.exists ? '' : 'disabled title="account removed"'}>${esc(p.label)}</button>` : '—'}</div>
      <div><span class="label">Session</span>${p ? badge(SESSION, p.sessionStatus) : '—'}<span class="sub">Updated ${esc(ago(p && p.sessionSavedAt))}</span></div>
      <div class="actions"><button class="btn btn-secondary btn-sm details" type="button">View details</button></div>`;
    d.querySelector('.copy').onclick = async (ev) => {
      try { await navigator.clipboard.writeText(it.id); ev.target.textContent = 'Copied'; setTimeout(() => { ev.target.textContent = 'Copy ID'; }, 1500); } catch { prompt('Application ID', it.id); }
    };
    const acct = d.querySelector('.acct-link');
    if (acct) acct.onclick = () => focusAccount(acct.dataset.account);
    d.querySelector('.details').onclick = () => showDetails(it);
    return d;
  }

  function showDetails(it) {
    const p = it.processedWith;
    $('#detName').textContent = it.fullName;
    const rows = [];
    const row = (k, v) => rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`);
    const group = (t) => rows.push(`<dd class="group">${esc(t)}</dd>`);
    group('Application');
    row('Application ID', `<code>${esc(it.id)}</code>`);
    row('Email', esc(it.email || '—'));
    row('Created', when(it.createdAt));
    row('Link ready', when(it.generatedUrlReadyAt));
    row('Final CTA clicked', when(it.finalLinkClickedAt));
    row('Visited', when(it.visitedAt));
    row('Verified', when(it.verifiedAt));
    group('Processing');
    row('Account used', p ? `${esc(p.label)}${p.exists ? '' : ' <span class="sub">(removed)</span>'}` : '—');
    row('Session', p ? `${badge(SESSION, p.sessionStatus)} <span class="sub">last saved ${esc(human(p.sessionSavedAt))}</span>` : '—');
    row('Session after this run', it.sessionResult === 'failed' ? badge({ f: ['warn', 'SESSION_PERSIST_FAILED'] }, 'f') : it.sessionResult === 'refreshed' ? badge({ r: ['ok', 'Refreshed'] }, 'r') : '—');
    row('Workflow ID', `<code>${esc(it.workflowId || '—')}</code>`);
    row('Workflow outcome', esc(it.workflowOutcome || '—'));
    if (it.wait) {
      const w = it.wait;
      const secs = (ms) => (ms === null ? '—' : `${Math.round(ms / 1000)} s`);
      row('Waited for the link', w.waitedMs === null ? '—' : `${secs(w.waitedMs)} after the code was handed over`);
      row('Left the waiting screen', w.left ? `${badge({ y: ['warn', 'Yes'] }, 'y')} <span class="sub">after ${secs(w.leftAfterMs)}${w.cameBack ? ', came back' : ', did not come back while waiting'}</span>` : badge({ n: ['ok', 'No'] }, 'n'));
      row('Page open when link became ready', w.unattendedAtReady ? badge({ n: ['warn', 'No'] }, 'n') : badge({ y: ['ok', 'Yes'] }, 'y'));
      row('Opened the link', w.openedLink ? badge({ y: ['ok', 'Yes'] }, 'y') : badge({ n: ['warn', 'Not yet'] }, 'n'));
    }
    row('Egress', it.egress ? esc(it.egress.label) : '—');
    group('Answers');
    const answers = Object.entries(it.answers || {});
    if (!answers.length) row('Answers', '<span class="sub">None recorded</span>');
    for (const [k, v] of answers) {
      const q = questionLabels[k];
      row(q ? q.label : k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), esc(q && q.options[String(v)] ? q.options[String(v)] : String(v)));
    }
    $('#detList').innerHTML = rows.join('');
    $('#dlgDetails').showModal();
  }
  $('#btnCloseDetails').onclick = () => $('#dlgDetails').close();
  for (const dlg of document.querySelectorAll('dialog')) dlg.addEventListener('click', (ev) => { if (ev.target === dlg && dlg.id !== 'dlgLogin') dlg.close(); });

  let searchTimer = null;
  $('#verifiedSearch').addEventListener('input', (ev) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { vq = ev.target.value.trim(); loadVerified(true); }, 250); });
  $('#btnMore').onclick = () => loadVerified(false, true);

  // =====================================================================
  // applicant page content (copy only): GET/PUT /api/admin/content
  // =====================================================================
  let content = { groups: [], fields: [] };
  let contentGroup = null;
  const contentEdits = new Map(); // key -> draft text (differs from the saved value)

  async function loadContent() {
    content = await api('/api/admin/content');
    if (!contentGroup || !content.groups.includes(contentGroup)) contentGroup = content.groups[0] || null;
    renderContent();
  }
  const fieldsIn = (g) => content.fields.filter((f) => f.group === g);
  const draftOf = (f) => (contentEdits.has(f.key) ? contentEdits.get(f.key) : f.value);
  const problemOf = (f) => {
    const v = draftOf(f);
    if (!v.trim()) return f.optional ? '' : 'cannot be empty';
    if (v.length > f.max) return `${v.length - f.max} over the limit`;
    return '';
  };

  function renderContent() {
    const tabs = $('#contentTabs');
    tabs.replaceChildren(...content.groups.map((g) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `content-tab${g === contentGroup ? ' active' : ''}${fieldsIn(g).some((f) => contentEdits.has(f.key)) ? ' edited' : ''}`;
      const custom = fieldsIn(g).filter((f) => f.custom).length;
      b.innerHTML = `<span>${esc(g)}</span><span class="n" title="Fields edited from the default">${custom ? `${custom} edited` : ''}</span>`;
      b.onclick = () => { contentGroup = g; renderContent(); };
      return b;
    }));
    const wrap = $('#contentFields');
    const fields = fieldsIn(contentGroup);
    wrap.replaceChildren(...fields.map((f) => {
      const row = document.createElement('div');
      const err = problemOf(f);
      row.className = `cfield${f.custom ? ' custom' : ''}${contentEdits.has(f.key) ? ' dirty' : ''}${err ? ' invalid' : ''}`;
      row.dataset.key = f.key;
      const vars = f.vars && f.vars.length ? `<span class="cvars">Placeholders: ${esc(f.vars.join(', '))}</span>` : '';
      row.innerHTML = `<label class="clabel" for="c-${esc(f.key)}">${esc(f.label)}<span class="ckey">${esc(f.key)}</span>${vars}</label>
        <div>${f.multiline ? `<textarea id="c-${esc(f.key)}" rows="${f.max > 1000 ? 18 : f.max > 200 ? 5 : 2}" maxlength="${f.max + 200}"></textarea>` : `<input id="c-${esc(f.key)}" type="text" maxlength="${f.max + 200}">`}
          <div class="cmeta"><span class="ccount"></span>${err ? `<span class="cerr">${esc(err)}</span>` : ''}<span class="cstate">${f.custom ? `edited${f.updatedAt ? ' ' + esc(ago(f.updatedAt)) : ''}` : 'default'}</span><button type="button" class="creset" ${f.custom || contentEdits.has(f.key) ? '' : 'disabled'}>Reset to default</button></div>
        </div>`;
      const input = row.querySelector('input, textarea');
      input.value = draftOf(f);
      const count = row.querySelector('.ccount');
      const updateCount = () => { count.textContent = `${input.value.length} / ${f.max}`; count.className = `ccount${input.value.length > f.max ? ' over' : ''}`; };
      updateCount();
      input.addEventListener('input', () => {
        if (input.value === f.value) contentEdits.delete(f.key); else contentEdits.set(f.key, input.value);
        updateCount();
        row.classList.toggle('dirty', contentEdits.has(f.key));
        row.querySelector('.creset').disabled = !(f.custom || contentEdits.has(f.key));
        updateContentActions();
      });
      row.querySelector('.creset').onclick = () => {
        if (f.custom) contentEdits.set(f.key, null); else contentEdits.delete(f.key);
        input.value = f.def; updateCount(); row.classList.toggle('dirty', contentEdits.has(f.key)); updateContentActions();
      };
      return row;
    }));
    if (!fields.length) wrap.innerHTML = '<p class="empty">No fields in this group.</p>';
    updateContentActions();
  }

  function updateContentActions() {
    const n = contentEdits.size;
    const bad = content.fields.some((f) => contentEdits.has(f.key) && contentEdits.get(f.key) !== null && problemOf(f));
    $('#contentDirty').textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}${bad ? ' · fix the highlighted field' : ''}` : '';
    $('#btnContentSave').disabled = !n || bad;
    for (const b of document.querySelectorAll('.content-tab')) {
      const g = b.querySelector('span').textContent;
      b.classList.toggle('edited', fieldsIn(g).some((f) => contentEdits.has(f.key)));
    }
  }

  async function saveContent() {
    const values = Object.fromEntries(contentEdits);
    if (!Object.keys(values).length) return;
    $('#btnContentSave').disabled = true;
    try {
      const r = await api('/api/admin/content', { method: 'PUT', body: JSON.stringify({ values }) });
      for (const k of r.saved) contentEdits.delete(k);
      const errs = Object.entries(r.errors || {});
      msg(errs.length ? `Saved ${r.saved.length}; ${errs.map(([k, e]) => `${k}: ${e}`).join('; ')}` : `Saved ${r.saved.length} change${r.saved.length === 1 ? '' : 's'}. Live on the next applicant page load.`, errs.length > 0);
    } catch (e) { msg(e.message, true); }
    await loadContent();
  }
  async function resetContentGroup() {
    const fields = fieldsIn(contentGroup);
    const custom = fields.filter((f) => f.custom);
    for (const f of fields) contentEdits.delete(f.key);
    if (!custom.length) { renderContent(); return; }
    if (!confirm(`Reset ${custom.length} edited field${custom.length === 1 ? '' : 's'} in “${contentGroup}” to the defaults?`)) { renderContent(); return; }
    try {
      await api('/api/admin/content', { method: 'PUT', body: JSON.stringify({ values: Object.fromEntries(custom.map((f) => [f.key, null])) }) });
      msg(`“${contentGroup}” reset to defaults.`);
    } catch (e) { msg(e.message, true); }
    await loadContent();
  }
  $('#btnContentSave').onclick = saveContent;
  $('#btnContentResetGroup').onclick = resetContentGroup;

  // =====================================================================
  // live updates + boot
  // =====================================================================
  function connectAdmin() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/admin`);
    ws.onopen = () => $('#liveDot').classList.add('on');
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'admin.changed') return;
      if (m.what === 'verified') loadVerified(false);
      if (m.what === 'accounts') { load().catch(() => {}); loadVerified(false); }
      if (m.what === 'egress') loadEgress();
    };
    ws.onclose = () => { $('#liveDot').classList.remove('on'); setTimeout(connectAdmin, 3000); };
  }
  async function pollMode() {
    try { const s = await (await fetch('/api/dev/browser')).json(); $('#automationMode').textContent = `Automation: ${s.mode === 'headless' ? 'Headless' : 'Visible'}${s.chromium === 'restarting' ? ' (restarting)' : ''}`; } catch { /* ignore */ }
  }

  // Question labels for the details drawer come from the same config the applicant site uses.
  let questionLabels = {};
  fetch('/api/apply/config').then((r) => r.json()).then((cfg) => {
    for (const screen of cfg.screens || []) for (const q of screen.questions || []) {
      questionLabels[q.key] = { label: q.label, options: Object.fromEntries((q.options || []).map((o) => [o.value, o.label])) };
    }
  }).catch(() => {});

  // operator session: show Sign out when a password protects this page; a 401 anywhere sends the operator to the login page
  fetch('/api/admin/session').then((r) => r.json()).then((s) => { if (s.authRequired) { $('#btnSignOut').hidden = false; if (!s.loggedIn) location.href = `/admin/login?next=${encodeURIComponent(location.pathname)}`; } }).catch(() => {});
  $('#btnSignOut').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); location.href = '/admin/login'; };

  load().catch((e) => msg(e.message, true));
  loadVerified(true);
  loadEgress();
  loadContent().catch((e) => msg(`Applicant content: ${e.message}`, true));
  connectAdmin();
  pollMode();
  setInterval(pollMode, 15000);
  setInterval(() => { renderAccounts(); }, 60000); // keep relative times fresh
})();
