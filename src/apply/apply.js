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
  };
  const US_STATES = [['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']];

  // ---------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------
  let config = { verificationCode: { length: 6, help: '' }, screens: [] };
  let app = null;          // latest ApplicationView from the server
  let step = 'landing';    // current screen id
  let ws = null;
  let wsRetry = 0;
  let outbox = [];         // messages to (re)send once the socket is open
  const local = { fields: {}, answers: {}, code: '', codeSubmitted: false };
  let lastProblemAt = null;

  const FIXED_STEPS = ['contact', 'dob', 'address', 'code'];
  const steps = () => [...FIXED_STEPS, ...config.screens.map((s) => s.id)];
  const FINAL = 'complete';
  const stepIndex = (id) => steps().indexOf(id);
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
    ws.onopen = () => { wsRetry = 0; setNotice(null); const q = outbox; outbox = []; for (const m of q) ws.send(JSON.stringify(m)); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onServer(m); };
    ws.onclose = (ev) => {
      ws = null;
      if (ev.code === 1008 || ev.code === 4401) return;
      if (step !== 'landing') setNotice('Reconnecting… your progress is saved.', 'warn');
      const delay = Math.min(15000, 800 * 2 ** wsRetry++);
      setTimeout(connect, delay);
    };
  }

  function onServer(m) {
    if (m.type === 'app.state') {
      const prev = app;
      app = m.application;
      // Server values fill gaps only; what the applicant is typing right now wins.
      for (const [k, v] of Object.entries(app.fields || {})) if (!local.fields[k]) local.fields[k] = v;
      for (const [k, v] of Object.entries(app.answers || {})) if (local.answers[k] === undefined) local.answers[k] = v;
      if (app.problem && app.problem.at !== lastProblemAt) { lastProblemAt = app.problem.at; local.codeSubmitted = false; local.code = ''; }
      if (step === 'complete' || step === 'code') render();
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
      setNotice('Please complete the highlighted information to continue.', 'warn');
      return;
    }
    if (m.code === 'INVALID_STATE' && step === 'code' && /already/i.test(m.message)) { render(); return; }
    if (m.code === 'UNAUTHENTICATED') { app = null; go('landing'); return; }
    if (m.code === 'BAD_REQUEST' || m.code === 'INVALID_FIELD') setNotice('Something in this step could not be saved. Please check your entries and try again.', 'error');
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

  function resumeFrom(a) {
    app = a;
    local.fields = { ...(a.fields || {}) };
    local.answers = { ...(a.answers || {}) };
    lastProblemAt = a.problem ? a.problem.at : null;
    connect();
    let target = a.currentStep;
    if (a.state === 'link_ready' || a.state === 'completed') target = FINAL;
    else if (a.state === 'problem') target = 'code';
    else if (!steps().includes(target) && target !== FINAL) target = firstIncompleteStep();
    go(target, { silent: true });
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
    if (!opts.silent && target !== 'landing') send({ type: 'app.step', step: target, completedStep: opts.completed === undefined ? from : opts.completed || undefined, final: target === FINAL || undefined });
    else if (opts.silent && target === FINAL) send({ type: 'app.step', step: target, final: true });
    setNotice(null);
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
    return digits(local.code).length === n ? [] : [['code', `Enter the ${n}-digit verification code.`]];
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

  function actions({ primary = 'Continue', onPrimary, showBack = true, disabled = false }) {
    return el('div', { class: 'actions' },
      showBack && prevStep(step) ? el('button', { type: 'button', class: 'btn btn-secondary btn-back', onclick: back, text: 'Back' }) : null,
      el('button', { type: 'submit', class: 'btn btn-primary', text: primary, disabled, onclick: onPrimary ? (ev) => { ev.preventDefault(); onPrimary(); } : undefined }));
  }

  function form(onSubmit, ...children) {
    return el('form', { novalidate: true, onsubmit: (ev) => { ev.preventDefault(); onSubmit(); } }, ...children);
  }

  // ---------------------------------------------------------------------------
  // screens
  // ---------------------------------------------------------------------------
  function renderLanding(existing) {
    const s = el('section', { class: 'landing' });
    s.append(
      el('h1', { text: 'Start your Shipzora application' }),
      el('p', { class: 'lede', text: 'Apply online for logistics and delivery opportunities with Shipzora. It takes a few minutes, and your progress is saved automatically as you go.' }),
      el('ul', { class: 'facts' },
        fact('You’ll be asked for your contact details and address.'),
        fact(`You’ll need your ${config.verificationCode.length}-digit verification code.`),
        fact('A few short questions about your experience and schedule.')));
    if (existing && existing.state !== 'completed') {
      const name = existing.fields && existing.fields.firstName;
      s.append(el('div', { class: 'landing-panel' },
        el('h2', { text: name ? `Welcome back, ${name}` : 'Welcome back' }),
        el('p', { text: existing.state === 'link_ready' ? 'Your role details are ready to view.' : 'You have an application in progress. Pick up where you left off.' }),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn btn-primary', text: existing.state === 'link_ready' ? 'View role details' : 'Continue application', onclick: () => resumeFrom(existing) })),
        el('button', { type: 'button', class: 'btn-link', text: 'Start a new application instead', onclick: () => startNew().catch(startFailed) })));
    } else {
      s.append(el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-primary', id: 'btnStart', text: 'Start Application', onclick: (ev) => { ev.target.disabled = true; startNew().catch((e) => { ev.target.disabled = false; startFailed(e); }); } })));
    }
    return s;
  }
  const fact = (text) => el('li', {}, el('span', { html: ICON.check }), el('span', { text }));
  const startFailed = () => setNotice('We couldn’t start your application just now. Please try again in a moment.', 'error');

  function renderContact() {
    const submit = () => {
      const errors = validateContact();
      if (errors.length) return showErrors(errors);
      send({ type: 'app.update', fields: { firstName: v.firstName.trim(), lastName: v.lastName.trim(), mobileNumber: digits(v.mobileNumber), email: v.email.trim() } });
      go('dob');
    };
    return form(submit,
      el('h1', { text: 'Tell us about yourself' }),
      el('p', { class: 'lede', text: 'We’ll use these details to contact you about your application.' }),
      textField({ key: 'firstName', label: 'First name', help: 'Use your full first name.', autocomplete: 'given-name' }),
      textField({ key: 'lastName', label: 'Last name', help: 'As it appears on your ID.', autocomplete: 'family-name' }),
      textField({ key: 'mobileNumber', label: 'Mobile phone', help: 'A number we can text or call.', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '(555) 555-0123' }),
      textField({ key: 'email', label: 'Email', type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'name@example.com' }),
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
      el('h1', { text: 'Your date of birth' }),
      el('p', { class: 'lede', id: 'help-dateOfBirth', text: 'We need this to set up your onboarding record. It isn’t used to evaluate your application.' }),
      el('fieldset', { class: 'field', 'data-field-wrap': 'dateOfBirth' },
        el('legend', { text: 'Date of birth' }),
        el('div', { class: 'row-3' }, part('m', 'Month', 'm', 2, 'bday-month', 'MM'), part('d', 'Day', 'd', 2, 'bday-day', 'DD'), part('y', 'Year', 'y', 4, 'bday-year', 'YYYY')),
        el('span', { class: 'error-text', id: 'err-dateOfBirth', role: 'alert', hidden: true })),
      actions({}));
  }

  function renderAddress() {
    const select = el('select', { class: 'select', id: 'f-state', name: 'state', autocomplete: 'address-level1', onchange: (ev) => { v.state = ev.target.value; clearError('state'); } },
      el('option', { value: '', text: 'Select a state' }),
      ...US_STATES.map(([code, name]) => el('option', { value: code, text: name, selected: v.state === code })));
    const submit = () => {
      const errors = validateAddress();
      if (errors.length) return showErrors(errors);
      send({ type: 'app.update', fields: { address1: v.address1.trim(), city: v.city.trim(), state: v.state, zip: v.zip.trim() } });
      // Onboarding preparation starts in the background; the applicant moves straight on.
      if (!codeReceived()) send({ type: 'app.address_completed' });
      go('code');
    };
    return form(submit,
      el('h1', { text: 'Your home address' }),
      el('p', { class: 'lede', text: 'Enter the address where you currently live.' }),
      textField({ key: 'address1', label: 'Address line 1', help: 'Street address, including apartment or unit.', autocomplete: 'address-line1' }),
      textField({ key: 'city', label: 'City', autocomplete: 'address-level2' }),
      el('div', { class: 'row' },
        el('div', { class: 'field', 'data-field-wrap': 'state' }, el('label', { for: 'f-state', text: 'State' }), select, el('span', { class: 'error-text', id: 'err-state', role: 'alert', hidden: true })),
        textField({ key: 'zip', label: 'ZIP code', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: 5, onInput: (ev) => { ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, 5); v.zip = ev.target.value; } })),
      actions({}));
  }

  function renderCode() {
    const n = config.verificationCode.length;
    if (codeReceived() && !codeNeededAgain()) {
      return form(() => go(nextStep('code')),
        el('h1', { text: 'Verification code' }),
        el('div', { class: 'code-received' }, el('span', { html: ICON.check }), el('span', { text: 'Your verification code has been received. You can continue with your application.' })),
        actions({}));
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
      class: 'input code-input', id: 'f-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: n, pattern: '[0-9]*',
      'aria-describedby': 'help-code err-code', autocapitalize: 'off', spellcheck: 'false',
      oninput: (ev) => { ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, n); local.code = ev.target.value; clearError('code'); },
    });
    return form(submit,
      el('h1', { text: 'Verification code' }),
      codeNeededAgain()
        ? el('div', { class: 'notice warn', role: 'status', text: 'We couldn’t finish the previous step. Your details are saved. Enter your verification code again to try again.' })
        : el('p', { class: 'lede', text: 'One more detail while we get your application ready.' }),
      el('div', { class: 'field', 'data-field-wrap': 'code' },
        el('label', { for: 'f-code', text: `${n}-digit verification code` }),
        el('span', { class: 'help', id: 'help-code', text: config.verificationCode.help }),
        input,
        el('span', { class: 'error-text', id: 'err-code', role: 'alert', hidden: true })),
      actions({}));
  }

  function renderScreen(screen) {
    const submit = () => {
      const errors = validateScreen(screen);
      if (errors.length) return showErrors(errors);
      go(nextStep(screen.id));
    };
    return form(submit,
      el('h1', { text: screen.title }),
      ...screen.questions.map((q) => el('fieldset', { 'data-field-wrap': q.key },
        el('legend', { text: q.label }),
        el('div', { class: 'choices', role: 'presentation' }, ...q.options.map((o) => {
          const id = `q-${q.key}-${o.value}`;
          return el('div', { class: 'choice' },
            el('input', { type: 'radio', id, name: q.key, value: o.value, checked: local.answers[q.key] === o.value, onchange: () => { local.answers[q.key] = o.value; clearError(q.key); $(`[data-field-wrap="${q.key}"] .choices`).classList.remove('invalid'); send({ type: 'app.answers', answers: { [q.key]: o.value } }); } }),
            el('label', { for: id }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'txt' }, el('span', { text: o.label }), o.hint ? el('span', { class: 'hint', text: o.hint }) : null)));
        })),
        el('span', { class: 'error-text', id: `err-${q.key}`, role: 'alert', hidden: true }))),
      actions({}));
  }

  function renderComplete() {
    const first = (local.fields.firstName || (app && app.fields && app.fields.firstName) || '').trim();
    const card = el('section', { class: 'status-card' });
    if (!app) { card.append(el('h1', { text: 'Your application' }), el('p', { class: 'lede', text: 'Loading…' })); return card; }
    if (app.state === 'link_ready' || app.state === 'completed') {
      const opened = !!app.finalLinkClickedAt;
      card.append(
        el('div', { class: 'status-icon ok', html: ICON.checkBig }),
        el('h1', { text: 'Your role details are ready' }),
        el('p', { class: 'lede', text: `Thanks${first ? ', ' + first : ''}. You can now review the role information prepared for your application.` }),
        el('div', { class: 'actions' },
          el('a', { class: 'btn btn-primary', id: 'btnViewRole', href: app.generatedUrl, target: '_blank', rel: 'noopener', text: opened ? 'Open Role Details again' : 'View Role Details',
            onclick: () => { send({ type: 'app.link_opened' }); } })),
        el('p', { class: 'muted', text: app.state === 'completed' ? 'Your role details have been confirmed.' : opened ? 'You’ve opened your role details. You can come back to this page any time.' : 'Opens in a new tab. You can come back to this page any time.' }));
      return card;
    }
    if (app.state === 'problem') {
      card.append(
        el('div', { class: 'status-icon warn', html: ICON.warn }),
        el('h1', { text: 'We couldn’t finish preparing your role details' }),
        el('p', { class: 'lede', text: (app.problem && app.problem.message) || 'We couldn’t finish this step. Please try again.' }),
        el('p', { class: 'muted', text: 'Your answers are saved. To try again, enter your verification code once more.' }),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', text: 'Try again', onclick: () => go('code', { completed: null }) })));
      return card;
    }
    if (app.state === 'processing') {
      const sp = document.importNode($('#tpl-spinner').content, true);
      card.append(
        el('div', { class: 'status-icon wait' }, sp),
        el('h1', { text: 'Preparing your role details…' }),
        el('p', { class: 'lede', text: `Thanks${first ? ', ' + first : ''}. We’re getting your role information ready. This page will update on its own when it’s available.` }),
        el('p', { class: 'muted', text: 'You can keep this page open. If you leave, you can return and pick up where you left off.' }));
      return card;
    }
    // started: the applicant reached the end without the automation ever starting (missing information)
    card.append(
      el('div', { class: 'status-icon warn', html: ICON.warn }),
      el('h1', { text: 'Almost there' }),
      el('p', { class: 'lede', text: 'Some information is still missing before we can prepare your role details.' }),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', text: 'Review my application', onclick: () => go(firstIncompleteStep(), { completed: null }) })));
    return card;
  }

  // ---------------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------------
  let landingExisting = null;
  function render() {
    const root = $('#screen');
    root.replaceChildren();
    setProgress();
    $('#headerContext').textContent = step === 'landing' ? 'Careers' : step === FINAL ? 'Application' : 'Application';
    if (step === 'landing') root.append(renderLanding(landingExisting));
    else if (step === 'contact') root.append(renderContact());
    else if (step === 'dob') root.append(renderDob());
    else if (step === 'address') root.append(renderAddress());
    else if (step === 'code') root.append(renderCode());
    else if (step === FINAL) root.append(renderComplete());
    else { const screen = config.screens.find((s) => s.id === step); root.append(screen ? renderScreen(screen) : renderComplete()); }
  }

  async function init() {
    try { config = await (await fetch('/api/apply/config')).json(); } catch { /* defaults */ }
    landingExisting = await loadExisting();
    step = 'landing';
    render();
  }
  init();
})();
