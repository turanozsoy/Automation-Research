/*
 * Shipzora Careers application (public, /). Vanilla JS on top of the application foundation:
 * POST /api/applications (session cookie) → /ws/app (this application only). The page never
 * sees workflow ids, profiles, pool state or automation telemetry; it renders ApplicationView.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const ICON = {
    check: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    checkBig: '<svg width="26" height="26" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5m0 3v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    lock: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    key: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="9" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 15h.5M12 15h.5M16 15h.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M8 9V6.5a4 4 0 0 1 8 0V9" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h12M8 12h12M8 17h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 7h.5M4 12h.5M4 17h.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 4v5h7V4M8 20v-6h8v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    cash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 12h.5M17.5 12h.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10v-6z" fill="currentColor"/><path d="M8.5 12l2.3 2.3L15.5 9.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lockFill: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5" fill="currentColor"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="15.5" r="1.6" fill="#fff"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="M12 7v5.5l3.5 2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const US_STATES = [['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']];

  // ---------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------
  let config = { verificationCode: { length: 6, groups: null, help: '' }, screens: [], content: {} };
  /** Digit groups of the code as shown in the SMS (e.g. [3, 2, 4] -> 482-16-7304). Display only: the code is sent as digits. */
  const codeGroups = () => { const g = config.verificationCode.groups; const n = config.verificationCode.length; return Array.isArray(g) && g.length && g.reduce((a, b) => a + b, 0) === n ? g : [n]; };
  const formatCode = (digitsOnly) => { const out = []; let i = 0; for (const g of codeGroups()) { if (i >= digitsOnly.length) break; out.push(digitsOnly.slice(i, i + g)); i += g; } return out.join('-'); };
  const codePlaceholder = () => codeGroups().map((g) => 'x'.repeat(g)).join('-');
  /** Applicant copy by key (config.content, defaults merged with edits made on the operations page); always rendered as text. */
  /** The company / site name, editable on the operations page (brand.name); every {brand} in the copy becomes it. */
  const brand = () => ((config.content && config.content['brand.name']) || 'Shipzora').trim() || 'Shipzora';
  const t = (key, vars = {}) => {
    let s = (config.content && typeof config.content[key] === 'string') ? config.content[key] : '';
    s = s.replace(/\{brand\}/g, brand());
    s = s.replace(/\{n\}/g, String(config.verificationCode.length));
    s = s.replace(/\{name\}/g, vars.name !== undefined ? vars.name : '');
    s = s.replace(/\{year\}/g, String(new Date().getFullYear()));
    return s;
  };
  /** Hero headline: text nodes per line, with the brand word highlighted (no HTML from the content). */
  const heroTitle = (text) => text.split('\n').flatMap((line, i) => {
    const b = brand().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = line.split(new RegExp(`(${b}\\.?)`, 'i')).filter(Boolean).map((part) => (new RegExp(`^${b}\\.?$`, 'i').test(part) ? el('span', { class: 'accent', text: part }) : part));
    return i ? [el('br'), ...parts] : parts;
  });
  /** Text with line breaks (multiline copy such as the hero headline), built from text nodes. */
  const lines = (text) => text.split('\n').flatMap((l, i) => (i ? [el('br'), l] : [l]));
  let app = null;          // latest ApplicationView from the server
  let step = 'landing';    // current screen id
  let ws = null;
  let wsRetry = 0;
  let outbox = [];         // messages to (re)send once the socket is open
  const local = { fields: {}, answers: {}, code: '', codeSubmitted: false };
  let lastProblemAt = null;
  // waiting screen (role details being prepared): when it was first shown, and the timer that swaps the note over time
  let waitStartedAt = null;
  let waitTimer = null;
  let waitHidden = false;

  const FIXED_STEPS = ['contact', 'dob', 'address', 'code'];
  const steps = () => [...FIXED_STEPS, ...config.screens.map((s) => s.id)];
  const FINAL = 'complete';
  const stepIndex = (id) => steps().indexOf(id);
  // Routes: the landing page is "/", the applicant steps are /step-2 … /step-n (the landing page counts as step 1),
  // the final screen is /preparing until the role-details link exists and /completed from then on.
  const linkReady = () => !!app && (app.state === 'link_ready' || app.state === 'completed');
  const pathFor = (id) => { if (id === 'landing') return '/'; if (id === FINAL) return linkReady() ? '/completed' : '/preparing'; const i = stepIndex(id); return i < 0 ? '/' : `/step-${i + 2}`; };
  function stepFromPath(path) {
    if (path === '/' || path === '') return 'landing';
    if (path === '/completed' || path === '/preparing') return FINAL;
    const m = /^\/step-(\d+)$/.exec(path);
    if (m) return steps()[Number(m[1]) - 2] || null;
    return null;
  }
  function syncUrl(replace) {
    const path = pathFor(step);
    if (location.pathname === path) return;
    try { history[replace ? 'replaceState' : 'pushState']({ step }, '', path); } catch { /* history unavailable */ }
    pixelPageView();
  }
  const nextStep = (id) => { const s = steps(); const i = s.indexOf(id); return i < 0 || i === s.length - 1 ? FINAL : s[i + 1]; };
  const prevStep = (id) => { const s = steps(); const i = s.indexOf(id); return i <= 0 ? null : s[i - 1]; };

  const codeReceived = () => !!app && (app.verificationStep === 'completed' || (app.automation && app.automation.phase === 'submitting') || app.state === 'link_ready' || app.state === 'completed' || (local.codeSubmitted && app.state === 'processing'));
  const codeNeededAgain = () => !!app && app.state === 'problem';

  // ---------------------------------------------------------------------------
  // transport
  // ---------------------------------------------------------------------------
  const send = (m) => {
    const msg = { ts: Date.now(), ...m };
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else outbox.push(msg);
  };

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/app`);
    ws.onopen = () => { wsRetry = 0; setNotice(null); const q = outbox; outbox = []; for (const m of q) ws.send(JSON.stringify(m)); sendAttribution(); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onServer(m); };
    ws.onclose = (ev) => {
      ws = null;
      if (ev.code === 1008 || ev.code === 4401) return;
      if (step !== 'landing') setNotice(t('notice.reconnecting'), 'warn');
      const delay = Math.min(15000, 800 * 2 ** wsRetry++);
      setTimeout(connect, delay);
    };
  }

  // ---------- Meta Pixel (browser side; the server sends the same Lead / CompleteRegistration with the same event id) ----------
  const landingUrl = location.href; // the page the applicant arrived on, with its query (fbclid etc.)
  const pixelFired = new Set();
  function setupPixel() {
    const px = config.pixel;
    if (!px || !px.id || window.fbq) return;
    // Meta's standard base code (loader), same pixel id as before: the campaign history continues.
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', px.id);
    window.fbq('track', 'PageView');
    setTimeout(sendAttribution, 2500); setTimeout(sendAttribution, 8000); // the _fbp / _fbc cookies appear once fbevents.js has loaded
  }
  function pixelPageView() { if (config.pixel && window.fbq) window.fbq('track', 'PageView'); }
  /** Standard event, once per page load; eventID = <application id>:<event> so Meta deduplicates it against the server event. */
  function pixelTrack(name) {
    if (!config.pixel || !window.fbq || pixelFired.has(name)) return;
    pixelFired.add(name);
    const opts = app && app.id ? { eventID: `${app.id}:${name}` } : undefined;
    window.fbq('track', name, {}, opts);
  }
  const cookie = (name) => { const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
  let attributionSent = '';
  function sendAttribution() {
    if (!config.pixel) return;
    const fbp = cookie('_fbp');
    let fbc = cookie('_fbc');
    if (!fbc) { let clid = null; try { clid = new URL(landingUrl).searchParams.get('fbclid'); } catch { /* ignore */ } if (clid) fbc = `fb.1.${Date.now()}.${clid}`; } // from the landing URL: the step routes drop the query
    const key = `${fbp}|${fbc}`;
    if (key === attributionSent) return;
    attributionSent = key;
    const msg = { type: 'app.attribution', url: landingUrl };
    if (fbp) msg.fbp = fbp;
    if (fbc) msg.fbc = fbc;
    send(msg);
  }

  function onServer(m) {
    if (m.type === 'app.state') {
      const prev = app;
      app = m.application;
      if (prev && prev.linkState !== 'verified' && app.linkState === 'verified') pixelTrack('CompleteRegistration');
      if (prev && prev.generatedUrl === null && app.generatedUrl !== null && step === FINAL) onLinkReady();
      // Server values fill gaps only; what the applicant is typing right now wins.
      for (const [k, v] of Object.entries(app.fields || {})) if (!local.fields[k]) local.fields[k] = v;
      for (const [k, v] of Object.entries(app.answers || {})) if (local.answers[k] === undefined) local.answers[k] = v;
      if (app.problem && app.problem.at !== lastProblemAt) { lastProblemAt = app.problem.at; local.codeSubmitted = false; local.code = ''; }
      if (step === 'complete' || step === 'code') { syncUrl(true); render(); }
      else if (prev && (prev.state !== app.state)) render();
      return;
    }
    if (m.type === 'app.error') onServerError(m);
  }

  function onServerError(m) {
    if (m.code === 'INFORMATION_REQUIRED') {
      const missing = m.missingFields || [];
      const target = missing.some((f) => ['firstName', 'lastName', 'mobileNumber', 'email'].includes(f)) ? 'contact' : missing.includes('dateOfBirth') ? 'dob' : 'address';
      go(target);
      setNotice(t('notice.missing'), 'warn');
      return;
    }
    if (m.code === 'INVALID_STATE' && step === 'code' && /already/i.test(m.message)) { render(); return; }
    if (m.code === 'UNAUTHENTICATED') { app = null; go('landing'); return; }
    if (m.code === 'BAD_REQUEST' || m.code === 'INVALID_FIELD') setNotice(t('notice.saveFailed'), 'error');
  }

  // ---------------------------------------------------------------------------
  // application lifecycle
  // ---------------------------------------------------------------------------
  async function loadExisting() {
    try {
      const r = await fetch('/api/applications/me', { credentials: 'same-origin' });
      if (r.status !== 200) return null;
      return (await r.json()).application;
    } catch { return null; }
  }

  async function startNew() {
    const r = await fetch('/api/applications', { method: 'POST', credentials: 'same-origin' });
    if (!r.ok) throw new Error('create failed');
    app = (await r.json()).application;
    Object.assign(local, { fields: {}, answers: {}, code: '', codeSubmitted: false });
    connect();
    go('contact', { completed: null, first: true });
  }

  function resumeFrom(a, requested, replace) {
    app = a;
    local.fields = { ...(a.fields || {}) };
    local.answers = { ...(a.answers || {}) };
    lastProblemAt = a.problem ? a.problem.at : null;
    connect();
    go(allowedStep(requested || a.currentStep), { silent: true, replace });
  }
  /**
   * The step an application may show: never beyond the step the applicant actually reached (the saved current
   * step, or the first incomplete one), and the application state decides the final screen.
   */
  function allowedStep(wanted, clamp = true) {
    if (linkReady()) return FINAL;
    if (app && app.state === 'problem') return 'code';
    const all = steps();
    // History entries were created by this page during the session, so Back/Forward only need the state checks above.
    if (!clamp) return wanted === FINAL || all.includes(wanted) ? wanted : firstIncompleteStep();
    const idx = (id) => (id === FINAL ? all.length : all.indexOf(id));
    const limit = Math.max(idx(firstIncompleteStep()), app ? idx(app.currentStep) : -1);
    const at = (i) => (i >= all.length ? FINAL : all[i]);
    const w = idx(wanted);
    if (w < 0) return at(limit);
    return w <= limit ? wanted : at(limit);
  }
  /** Browser Back/Forward: show the step the URL names without creating anything. */
  function onPopState() {
    const wanted = stepFromPath(location.pathname);
    if (wanted === 'landing' || wanted === null || !app || (app.state === 'completed' && wanted !== FINAL)) {
      landingExisting = app;
      step = 'landing';
      setNotice(null);
      syncUrl(true);
      render();
      return;
    }
    go(allowedStep(wanted, false), { completed: null, replace: true });
  }

  function firstIncompleteStep() {
    if (validateContact().length) return 'contact';
    if (validateDob().length) return 'dob';
    if (validateAddress().length) return 'address';
    if (!codeReceived()) return 'code';
    for (const s of config.screens) if (validateScreen(s).length) return s.id;
    return FINAL;
  }

  // ---------------------------------------------------------------------------
  // navigation
  // ---------------------------------------------------------------------------
  function go(target, opts = {}) {
    const from = step;
    step = target;
    if (config.pixel && target === config.pixel.leadStep) pixelTrack('Lead');
    if (!opts.silent && target !== 'landing') send({ type: 'app.step', step: target, completedStep: opts.completed === undefined ? from : opts.completed || undefined, final: target === FINAL || undefined });
    else if (opts.silent && target === FINAL) send({ type: 'app.step', step: target, final: true });
    setNotice(null);
    syncUrl(!!opts.replace);
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
    const h = $('#screen h1');
    if (h && !opts.first) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    else if (h) { const f = $('#screen .input, #screen .select, #screen input'); (f || h).focus({ preventScroll: true }); }
  }

  function back() { const p = prevStep(step); if (p) go(p, { completed: null }); }

  function setNotice(text, kind) {
    const n = $('#notice');
    if (!text) { n.hidden = true; n.textContent = ''; n.className = 'notice'; return; }
    n.hidden = false; n.textContent = text; n.className = `notice${kind ? ' ' + kind : ''}`;
  }

  function setProgress() {
    const wrap = $('#progressWrap');
    const all = steps();
    const i = all.indexOf(step);
    if (i < 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const n = i + 1, total = all.length;
    $('#progressLabel').textContent = `Step ${n} of ${total}`;
    const pct = Math.round((n / total) * 100);
    $('#progressFill').style.width = `${pct}%`;
    $('#progressBar').setAttribute('aria-valuenow', String(pct));
    $('#progressBar').setAttribute('aria-valuetext', `Step ${n} of ${total}`);
  }

  // ---------------------------------------------------------------------------
  // validation (natural language, next to the field)
  // ---------------------------------------------------------------------------
  const v = local.fields;
  const digits = (s) => (s || '').replace(/\D/g, '');
  function validateContact() {
    const e = [];
    if (!(v.firstName || '').trim()) e.push(['firstName', 'Enter your first name to continue.']);
    if (!(v.lastName || '').trim()) e.push(['lastName', 'Enter your last name to continue.']);
    if (digits(v.mobileNumber).length < 10) e.push(['mobileNumber', 'Enter a 10-digit mobile number.']);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((v.email || '').trim())) e.push(['email', 'Enter an email address we can reply to, like name@example.com.']);
    return e;
  }
  function validateDob() {
    const e = [];
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.dateOfBirth || '');
    if (!m) { e.push(['dateOfBirth', 'Enter your date of birth as month, day and year.']); return e; }
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const valid = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    if (!valid || +m[1] < 1900 || d.getTime() > Date.now()) e.push(['dateOfBirth', 'That date doesn’t look right. Please check the month, day and year.']);
    return e;
  }
  function validateAddress() {
    const e = [];
    if (!(v.address1 || '').trim()) e.push(['address1', 'Enter your street address to continue.']);
    if (!(v.city || '').trim()) e.push(['city', 'Enter your city to continue.']);
    if (!(v.state || '')) e.push(['state', 'Select your state.']);
    if (!/^\d{5}$/.test((v.zip || '').trim())) e.push(['zip', 'Enter a 5-digit ZIP code.']);
    return e;
  }
  function validateCode() {
    const n = config.verificationCode.length;
    return digits(local.code).length === n ? [] : [['code', t('code.invalid')]];
  }
  function validateScreen(screen) {
    return screen.questions.filter((q) => local.answers[q.key] === undefined || local.answers[q.key] === '').map((q) => [q.key, 'Choose one option to continue.']);
  }

  function showErrors(errors) {
    for (const [key, msg] of errors) {
      const field = $(`[data-field-wrap="${key}"]`);
      if (!field) continue;
      field.classList.add('invalid');
      const err = $(`#err-${key}`);
      if (err) { err.textContent = msg; err.hidden = false; }
      const input = field.querySelector('input, select');
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} err-${key}`.trim()); }
    }
    const first = errors[0] && ($(`[data-field-wrap="${errors[0][0]}"] input, [data-field-wrap="${errors[0][0]}"] select`));
    if (first) first.focus();
    send({ type: 'app.validation_failed', step, fields: errors.map((e) => e[0]) });
  }
  function clearError(key) {
    const field = $(`[data-field-wrap="${key}"]`);
    if (!field) return;
    field.classList.remove('invalid');
    const err = $(`#err-${key}`);
    if (err) { err.hidden = true; err.textContent = ''; }
    const input = field.querySelector('input, select');
    if (input) input.removeAttribute('aria-invalid');
  }

  // ---------------------------------------------------------------------------
  // building blocks
  // ---------------------------------------------------------------------------
  function textField({ key, label, help, type = 'text', autocomplete, inputmode, placeholder, maxlength, onInput }) {
    const id = `f-${key}`;
    const helpId = help ? `help-${key}` : null;
    const input = el('input', {
      class: 'input', id, name: key, type, autocomplete, inputmode, placeholder, maxlength, value: v[key] || '',
      'aria-describedby': helpId || undefined, autocapitalize: type === 'email' ? 'off' : undefined, spellcheck: 'false',
      oninput: (ev) => { v[key] = ev.target.value; clearError(key); if (onInput) onInput(ev); },
    });
    return el('div', { class: 'field', 'data-field-wrap': key },
      el('label', { for: id, text: label }),
      help ? el('span', { class: 'help', id: helpId, text: help }) : null,
      input,
      el('span', { class: 'error-text', id: `err-${key}`, role: 'alert', hidden: true }));
  }

  // Bottom action area. Back navigation lives in the header arrow (#headerBack), not next to the primary button.
  function actions({ primary, onPrimary, disabled = false }) {
    return el('div', { class: 'actions' },
      el('button', { type: 'submit', class: 'btn btn-primary', text: primary || t('common.continue'), disabled, onclick: onPrimary ? (ev) => { ev.preventDefault(); onPrimary(); } : undefined }));
  }
  const badge = (text) => el('p', { class: 'step-badge', text });

  function form(onSubmit, ...children) {
    return el('form', { novalidate: true, onsubmit: (ev) => { ev.preventDefault(); onSubmit(); } }, ...children);
  }

  // ---------------------------------------------------------------------------
  // screens
  // ---------------------------------------------------------------------------
  function renderLanding(existing) {
    const s = el('section', { class: 'landing' });
    const hero = document.importNode($('#tpl-hero').content, true);
    hero.querySelector('.hero-pill').append(el('span', { class: 'hero-pill-icon', html: ICON.cash, 'aria-hidden': 'true' }), el('span', { text: t('landing.pill') }));
    hero.querySelector('.hero-title').replaceChildren(...heroTitle(t('landing.title')));
    hero.querySelector('.hero-sub').textContent = t('landing.subtitle');
    const trust = (icon, text) => el('li', {}, el('span', { class: 'trust-icon', html: icon, 'aria-hidden': 'true' }), el('span', { text }));
    s.append(hero, el('ul', { class: 'trust', 'aria-label': 'About this application' }, trust(ICON.shield, t('landing.trust1')), trust(ICON.lockFill, t('landing.trust2')), trust(ICON.clock, t('landing.trust3'))));
    const legal = () => el('div', { class: 'legal' },
      el('p', { class: 'copyright', text: t('landing.copyright') }),
      el('nav', { class: 'legal-links', 'aria-label': 'Legal' }, el('a', { href: '/privacy', text: 'Privacy' }), el('a', { href: '/terms', text: 'Terms' }), el('a', { href: '/contact', text: 'Contact' })));
    const resumable = existing && existing.state !== 'completed';
    if (resumable) {
      const name = existing.fields && existing.fields.firstName;
      s.append(el('div', { class: 'landing-panel' },
        el('p', { class: 'eyebrow', text: t('landing.welcome.eyebrow') }),
        el('h2', { text: name ? `${t('landing.welcome.title')}, ${name}` : t('landing.welcome.title') }),
        el('p', { text: existing.state === 'link_ready' ? t('landing.welcome.ready') : t('landing.welcome.inProgress') }),
        el('button', { type: 'button', class: 'btn-link', text: t('landing.welcome.new'), onclick: () => startNew().catch(startFailed) })));
      s.append(el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-primary', text: existing.state === 'link_ready' ? t('landing.welcome.view') : t('landing.welcome.resume'), onclick: () => resumeFrom(existing) }),
        legal()));
    } else {
      s.append(el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-primary', id: 'btnStart', text: t('landing.cta'), onclick: (ev) => { ev.target.disabled = true; startNew().catch((e) => { ev.target.disabled = false; startFailed(e); }); } }),
        legal()));
    }
    return s;
  }
  const startFailed = () => setNotice(t('notice.startFailed'), 'error');

  function renderContact() {
    const submit = () => {
      const errors = validateContact();
      if (errors.length) return showErrors(errors);
      send({ type: 'app.update', fields: { firstName: v.firstName.trim(), lastName: v.lastName.trim(), mobileNumber: digits(v.mobileNumber), email: v.email.trim() } });
      go('dob');
    };
    return form(submit,
      el('h1', { text: t('contact.title') }),
      el('p', { class: 'lede', text: t('contact.intro') }),
      textField({ key: 'firstName', label: t('contact.firstName.label'), help: t('contact.firstName.help'), autocomplete: 'given-name' }),
      textField({ key: 'lastName', label: t('contact.lastName.label'), help: t('contact.lastName.help'), autocomplete: 'family-name' }),
      textField({ key: 'mobileNumber', label: t('contact.phone.label'), help: t('contact.phone.help'), type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '(555) 555-0123' }),
      textField({ key: 'email', label: t('contact.email.label'), type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'name@example.com' }),
      actions({}));
  }

  function renderDob() {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.dateOfBirth || '') || [null, '', '', ''];
    const p = { y: parts[1], m: parts[2], d: parts[3] };
    const sync = () => { v.dateOfBirth = p.y && p.m && p.d ? `${p.y}-${p.m.padStart(2, '0')}-${p.d.padStart(2, '0')}` : ''; clearError('dateOfBirth'); };
    const part = (id, label, key, max, ac, ph) => el('div', {},
      el('label', { for: `f-dob-${id}`, class: 'label', text: label }),
      el('input', { class: 'input', id: `f-dob-${id}`, inputmode: 'numeric', autocomplete: ac, maxlength: max, placeholder: ph, value: p[key],
        'aria-describedby': 'help-dateOfBirth err-dateOfBirth',
        oninput: (ev) => { ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, max); p[key] = ev.target.value; sync(); if (ev.target.value.length === max && ev.target.nextSibling === null) { const nx = ev.target.closest('div').nextElementSibling; const ni = nx && nx.querySelector('input'); if (ni) ni.focus(); } } }));
    const submit = () => {
      const errors = validateDob();
      if (errors.length) return showErrors(errors);
      send({ type: 'app.update', fields: { dateOfBirth: v.dateOfBirth } });
      go('address');
    };
    return form(submit,
      el('h1', { text: t('dob.title') }),
      el('p', { class: 'lede', id: 'help-dateOfBirth', text: t('dob.intro') }),
      el('fieldset', { class: 'field dob', 'data-field-wrap': 'dateOfBirth' },
        el('legend', { text: t('dob.legend') }),
        el('div', { class: 'row-3' }, part('m', 'Month', 'm', 2, 'bday-month', 'MM'), part('d', 'Day', 'd', 2, 'bday-day', 'DD'), part('y', 'Year', 'y', 4, 'bday-year', 'YYYY')),
        el('span', { class: 'error-text', id: 'err-dateOfBirth', role: 'alert', hidden: true })),
      actions({}));
  }

  function renderAddress() {
    // The browser is launched now, while the applicant types the address: the service reserves an account, opens
    // Website B and types the contact details and date of birth. The address is finalised after "Yes, it matches".
    if (!codeReceived() && !(app && app.automation && app.automation.active)) send({ type: 'app.prepare' });
    const select = el('select', { class: 'select', id: 'f-state', name: 'state', autocomplete: 'address-level1', onchange: (ev) => { v.state = ev.target.value; clearError('state'); } },
      el('option', { value: '', text: 'Select a state' }),
      ...US_STATES.map(([code, name]) => el('option', { value: code, text: name, selected: v.state === code })));
    // Continue -> a confirmation sheet: the address must match the applicant's ID. Only "Yes" saves it and starts
    // the onboarding preparation in the background; "Edit" returns to the fields. Nothing is sent before that.
    const confirmAndContinue = () => {
      send({ type: 'app.update', fields: { address1: v.address1.trim(), city: v.city.trim(), state: v.state, zip: v.zip.trim() } });
      if (!codeReceived()) send({ type: 'app.address_completed' });
      go('code');
    };
    const submit = () => {
      const errors = validateAddress();
      if (errors.length) return showErrors(errors);
      const stateName = (US_STATES.find(([c]) => c === v.state) || [v.state, v.state])[1];
      const sheet = el('div', { class: 'sheet-backdrop', id: 'addressConfirm', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'addressConfirmTitle' },
        el('div', { class: 'sheet' },
          el('p', { class: 'eyebrow', text: t('address.title') }),
          el('h2', { id: 'addressConfirmTitle', text: t('address.confirm.title') }),
          el('p', { class: 'sheet-text', text: t('address.confirm.text') }),
          el('div', { class: 'address-card' },
            el('span', { class: 'address-line', text: v.address1.trim() }),
            el('span', { class: 'address-line', text: `${v.city.trim()}, ${stateName} ${v.zip.trim()}` })),
          el('button', { type: 'button', class: 'btn btn-primary', id: 'btnAddressYes', text: t('address.confirm.yes'), onclick: () => { sheet.remove(); confirmAndContinue(); } }),
          el('button', { type: 'button', class: 'btn btn-secondary', id: 'btnAddressEdit', text: t('address.confirm.edit'), onclick: () => { sheet.remove(); const f = $('#f-address1'); if (f) f.focus(); } })));
      sheet.addEventListener('click', (ev) => { if (ev.target === sheet) { sheet.remove(); } });
      $('#screen').appendChild(sheet);
      $('#btnAddressYes').focus();
    };
    return form(submit,
      el('h1', { text: t('address.title') }),
      el('p', { class: 'lede', text: t('address.intro') }),
      textField({ key: 'address1', label: t('address.street.label'), help: t('address.street.help'), autocomplete: 'address-line1' }),
      textField({ key: 'city', label: t('address.city.label'), autocomplete: 'address-level2' }),
      el('div', { class: 'row' },
        el('div', { class: 'field', 'data-field-wrap': 'state' }, el('label', { for: 'f-state', text: t('address.state.label') }), select, el('span', { class: 'error-text', id: 'err-state', role: 'alert', hidden: true })),
        textField({ key: 'zip', label: t('address.zip.label'), inputmode: 'numeric', autocomplete: 'postal-code', maxlength: 5, onInput: (ev) => { ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, 5); v.zip = ev.target.value; } })),
      actions({}));
  }

  function renderCode() {
    const n = config.verificationCode.length;
    if (codeReceived() && !codeNeededAgain()) {
      return form(() => go(nextStep('code')),
        el('h1', { text: t('code.title') }),
        el('div', { class: 'code-received' }, el('span', { class: 'tick', html: ICON.check, 'aria-hidden': 'true' }), el('span', { text: t('code.received') })),
        actions({ primary: t('code.cta') }));
    }
    const submit = () => {
      const errors = validateCode();
      if (errors.length) return showErrors(errors);
      const code = digits(local.code);
      local.code = '';
      local.codeSubmitted = true;
      send({ type: 'app.verify', code });
      go(nextStep('code'));
    };
    const input = el('input', {
      // Shown as in the SMS (xxx-xx-xxxx): the dashes are inserted while typing or pasting and are display only;
      // local.code and the value sent are the digits. No maxlength: it would truncate a pasted "482-16-7304" before
      // the dashes are removed.
      class: 'input code-input', id: 'f-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9-]*',
      placeholder: codePlaceholder(), 'aria-describedby': 'help-code err-code', autocapitalize: 'off', spellcheck: 'false',
      value: formatCode(digits(local.code).slice(0, n)),
      oninput: (ev) => { const d = ev.target.value.replace(/\D/g, '').slice(0, n); ev.target.value = formatCode(d); local.code = d; clearError('code'); },
    });
    return form(submit,
      el('h1', { text: t('code.title') }),
      el('p', { class: 'lede', id: 'help-code', text: t('code.intro') }),
      codeNeededAgain() ? el('div', { class: 'notice warn', role: 'status', text: t('code.retry') }) : null,
      el('div', { class: 'field code-field', 'data-field-wrap': 'code' },
        el('label', { for: 'f-code', text: t('code.label') }),
        input,
        el('span', { class: 'error-text', id: 'err-code', role: 'alert', hidden: true })),
      el('p', { class: 'code-note' }, el('span', { html: ICON.lock, 'aria-hidden': 'true' }), el('span', { text: t('code.note') })),
      actions({ primary: t('code.cta') }));
  }

  function renderScreen(screen) {
    const submit = () => {
      const errors = validateScreen(screen);
      if (errors.length) return showErrors(errors);
      go(nextStep(screen.id));
    };
    return form(submit,
      el('h1', { text: t(`screen.${screen.id}.title`) || screen.title }),
      ...screen.questions.map((q) => el('fieldset', { class: 'question', 'data-field-wrap': q.key },
        el('legend', { text: t(`q.${q.key}.label`) || q.label }),
        el('div', { class: `choices${q.options.length === 4 && q.options.every((o) => !o.hint) ? ' choices-grid' : ''}`, role: 'presentation' }, ...q.options.map((o) => {
          const id = `q-${q.key}-${o.value}`;
          return el('div', { class: 'choice' },
            el('input', { type: 'radio', id, name: q.key, value: o.value, checked: local.answers[q.key] === o.value, onchange: () => { local.answers[q.key] = o.value; clearError(q.key); $(`[data-field-wrap="${q.key}"] .choices`).classList.remove('invalid'); send({ type: 'app.answers', answers: { [q.key]: o.value } }); } }),
            el('label', { for: id }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'txt' }, el('span', { text: t(`opt.${q.key}.${o.value}.label`) || o.label }), o.hint !== undefined ? el('span', { class: 'hint', text: t(`opt.${q.key}.${o.value}.hint`) || o.hint }) : null)));
        })),
        el('span', { class: 'error-text', id: `err-${q.key}`, role: 'alert', hidden: true }))),
      actions({}));
  }

  function renderComplete() {
    const first = (local.fields.firstName || (app && app.fields && app.fields.firstName) || '').trim();
    const card = el('section', { class: 'status' });
    const reassure = (text) => el('p', { class: 'reassure' }, el('span', { html: ICON.save, 'aria-hidden': 'true' }), el('span', { class: 'reassure-text', text }));
    if (!app) { card.append(badge('Application'), el('h1', { text: 'Your application' }), el('p', { class: 'lede', text: 'Loading…' })); return card; }
    if (app.state === 'link_ready' || app.state === 'completed') {
      const opened = !!app.finalLinkClickedAt;
      const done = (text) => el('li', {}, el('span', { class: 'done-tick', html: ICON.check, 'aria-hidden': 'true' }), el('span', { text }));
      card.classList.add('success');
      card.append(
        badge(app.state === 'completed' ? t('ready.badgeConfirmed') : t('ready.badge')),
        el('div', { class: 'success-mark', 'aria-hidden': 'true' }, el('span', { class: 'success-mark-ring' }), el('span', { class: 'success-mark-icon', html: ICON.checkBig })),
        el('h1', { text: first ? t('ready.title', { name: first }) : t('ready.titleNoName') }),
        el('p', { class: 'lede', text: t('ready.intro') }),
        el('ul', { class: 'done-list', 'aria-label': 'Progress' },
          done(t('ready.check1')),
          done(t('ready.check2')),
          el('li', { class: 'next' }, el('span', { class: 'done-tick next', 'aria-hidden': 'true' }), el('span', { text: t('ready.check3') }), el('span', { class: 'next-pill', text: t('ready.nextLabel') }))),
        el('p', { class: 'muted urgent', text: app.state === 'completed' ? t('ready.noteConfirmed') : opened ? t('ready.noteOpened') : t('ready.noteNew') }),
        el('div', { class: 'actions' },
          el('a', { class: 'btn btn-primary', id: 'btnViewRole', href: app.generatedUrl, target: '_blank', rel: 'noopener', text: opened ? t('ready.ctaAgain') : t('ready.cta'),
            onclick: () => { send({ type: 'app.link_opened' }); } })));
      return card;
    }
    if (app.state === 'problem') {
      card.append(
        badge(t('problem.badge')),
        el('div', { class: 'status-icon warn', html: ICON.warn }),
        el('h1', { text: t('problem.title') }),
        el('p', { class: 'lede', text: (app.problem && app.problem.message) || t('problem.fallback') }),
        reassure(t('problem.note')),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', text: t('problem.cta'), onclick: () => go('code', { completed: null }) })));
      return card;
    }
    if (app.state === 'processing') {
      const sp = document.importNode($('#tpl-spinner').content, true);
      startWait();
      // honest progress: three stages driven by the application's real state, no countdown
      const codeHandedOver = app.verificationStep === 'completed' || (app.automation && app.automation.phase === 'submitting');
      const stage = (text, state) => el('li', { class: `stage ${state}` },
        el('span', { class: 'stage-dot', 'aria-hidden': 'true', html: state === 'done' ? ICON.check : state === 'active' ? '<span class="mini-spinner"></span>' : '' }),
        el('span', { class: 'stage-text', text }),
        el('span', { class: 'sr-only', text: state === 'done' ? ' (done)' : state === 'active' ? ' (in progress)' : ' (next)' }));
      void sp;
      card.append(
        badge(t('preparing.badge')),
        el('h1', { text: t('preparing.title') }),
        el('p', { class: 'lede', text: t('preparing.intro', { name: first ? ', ' + first : '' }) }),
        el('ol', { class: 'stages', 'aria-label': 'Progress' },
          stage(t('preparing.stage1'), 'done'),
          stage(t('preparing.stage2'), codeHandedOver ? 'done' : 'active'),
          stage(t('preparing.stage3'), codeHandedOver ? 'active' : 'pending')),
        reassure(waitNote()));
      card.querySelector('.reassure').id = 'waitNote';
      return card;
    }
    // started: the applicant reached the end without the automation ever starting (missing information)
    card.append(
      badge(t('incomplete.badge')),
      el('div', { class: 'status-icon warn', html: ICON.warn }),
      el('h1', { text: t('incomplete.title') }),
      el('p', { class: 'lede', text: t('incomplete.intro') }),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', text: t('incomplete.cta'), onclick: () => go(firstIncompleteStep(), { completed: null }) })));
    return card;
  }

  // ---------------------------------------------------------------------------
  // waiting screen: time-aware note, and analytics of leaving / returning while waiting
  // ---------------------------------------------------------------------------
  const waitElapsed = () => (waitStartedAt === null ? 0 : Date.now() - waitStartedAt);
  const waitNote = () => { const s = waitElapsed() / 1000; return s >= 60 ? t('preparing.noteVeryLong') : s >= 20 ? t('preparing.noteLong') : t('preparing.note'); };
  function startWait() {
    if (waitStartedAt !== null) return;
    waitStartedAt = Date.now();
    sendWait('shown');
    waitTimer = setInterval(() => {
      const n = $('#waitNote .reassure-text');
      if (n) n.textContent = waitNote();
      if (!(app && app.state === 'processing' && step === FINAL)) stopWait();
    }, 1000);
  }
  function stopWait() { if (waitTimer) clearInterval(waitTimer); waitTimer = null; waitStartedAt = null; waitHidden = false; }
  /** Over the socket when it is open; otherwise a beacon, which survives the page being closed. */
  function sendWait(event) {
    const msg = { type: 'app.wait', ts: Date.now(), event, elapsedMs: waitElapsed() };
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return; }
    try { navigator.sendBeacon('/api/applications/me/wait', JSON.stringify(msg)); } catch { /* best effort */ }
  }
  function onVisibility(hiddenNow) {
    if (waitStartedAt === null || !(app && app.state === 'processing')) return;
    if (hiddenNow && !waitHidden) { waitHidden = true; sendWait('hidden'); }
    else if (!hiddenNow && waitHidden) { waitHidden = false; sendWait('visible'); }
  }
  function onLinkReady() {
    stopWait();
    try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch { /* unsupported */ }
    const original = document.title;
    document.title = t('preparing.readyTitle') || original;
    setTimeout(() => { document.title = original; }, 15000);
  }

  // ---------------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------------
  let landingExisting = null;
  function render() {
    const root = $('#screen');
    root.replaceChildren();
    setProgress();
    document.body.dataset.screen = step === 'landing' ? 'landing' : step === FINAL ? 'status' : 'step';
    $('#headerContext').replaceChildren(el('span', { class: 'brand-word', text: brand() }), ' ', step === 'landing' ? t('brand.headerLanding') : t('brand.headerSteps'));
    document.title = t('brand.tabTitle') || document.title;
    $('#headerBack').hidden = step === 'landing' || step === FINAL || !prevStep(step);
    if (step === 'landing') root.append(renderLanding(landingExisting));
    else if (step === 'contact') root.append(renderContact());
    else if (step === 'dob') root.append(renderDob());
    else if (step === 'address') root.append(renderAddress());
    else if (step === 'code') root.append(renderCode());
    else if (step === FINAL) root.append(renderComplete());
    else { const screen = config.screens.find((s) => s.id === step); root.append(screen ? renderScreen(screen) : renderComplete()); }
  }

  async function init() {
    $('#headerBack').addEventListener('click', back);
    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', () => onVisibility(document.visibilityState === 'hidden'));
    window.addEventListener('pagehide', () => onVisibility(true));
    try { config = await (await fetch('/api/apply/config')).json(); } catch { /* defaults */ }
    setupPixel();
    landingExisting = await loadExisting();
    const wanted = stepFromPath(location.pathname);
    if (wanted && wanted !== 'landing' && landingExisting && !(landingExisting.state === 'completed' && wanted !== FINAL)) {
      resumeFrom(landingExisting, wanted, true);
      return;
    }
    step = 'landing';
    syncUrl(true);
    render();
  }
  init();
})();
