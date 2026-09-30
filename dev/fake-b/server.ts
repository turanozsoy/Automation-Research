/**
 * Throwaway stand-in for Website B, used ONLY to verify the automation loop when
 * the real site is not reachable (e.g. automated testing). Mirrors the selectors
 * from config/site-b.fake.json: login redirect, "Recommended" link, the form,
 * a checkout iframe with a pre-checked box, primary -> secondary -> generated URL.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const port = Number(process.env.FAKE_B_PORT ?? 3001);
const autoLogin = process.env.FAKE_B_AUTOLOGIN === '1';
const noSuggest = process.env.FAKE_B_NO_SUGGEST === '1'; // simulate a widget that never opens
const enterSubmits = process.env.FAKE_B_ENTER_SUBMITS === '1'; // submit stays enabled, so Enter in the form submits it (real-site behaviour)
const noAgree = process.env.FAKE_B_NO_AGREE === '1';
const urlAsText = process.env.FAKE_B_URL_AS_TEXT === '1';
const urlRedirects = process.env.FAKE_B_URL_REDIRECTS === '1';
const returning = process.env.FAKE_B_RETURNING === '1'; // an account used before: no Agree screen, checkout without the pre-checked toggle
const cityError = process.env.FAKE_B_CITY_ERROR === '1'; // first submit: clear city, flag it red (data-accent-color) and refuse to advance // the first it-worked URL redirects to a different final one after loading // show the generated URL as plain text inside the iframe instead of navigating to it // no "Agree and continue" button: the agree step fails and the workflow pauses
const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Fake B</title>
<style>body{font-family:sans-serif;margin:24px}input,select{display:block;margin:4px 0 12px;padding:6px;width:280px}iframe{width:520px;height:320px;border:2px solid #888;margin-top:16px}</style>
</head><body>${body}</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const loggedIn = /(^|;\s*)fakeb=1/.test(req.headers.cookie ?? '');
  const page = (body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html(body)); };
  const redirect = (to: string, extra: Record<string, string> = {}) => { res.writeHead(302, { location: to, ...extra }); res.end(); };

  if (url.pathname === '/login/' && req.method === 'POST') return redirect('/', { 'set-cookie': 'fakeb=1; Path=/' });
  if (url.pathname === '/login/') {
    return page(`<h1>Fake B — Login</h1><form method="post" action="/login/"><button id="login">Log in</button></form>
      ${autoLogin ? '<script>setTimeout(()=>document.getElementById("login").click(),1200)</script>' : ''}`);
  }
  if (!loggedIn) return redirect('/login/');

  if (url.pathname === '/') return page(`<h1>Fake B — Home</h1><p><a href="/other">Other plan</a></p><p><a href="/form">Recommended</a></p>`);

  if (url.pathname === '/form') {
    return page(`<h1>Fake B — Form</h1>
      <form id="f">
        <button type="submit" style="display:none">hidden earlier submit</button>
        <label>First name<input id="first-name"></label>
        <label>Last name<input id="last-name"></label>
        <label>Date of birth<input id="date-of-birth" placeholder="MM/DD/YYYY"></label>
        <label>Mobile<input id="mobile-number"></label>
        <label>Address<input name="line1" id="base-ui-_r_f_" autocomplete="off"></label>
        <div id="ac" class="sugg" style="display:none;border:1px solid #888;width:280px;background:#fff"></div>
        <label>City<div id="city-wrap"><input name="city" id="base-ui-_r_g_" required></div></label>
        <div id="state-slot"></div>
        <label>ZIP<input name="zip" id="base-ui-_r_h_"></label>
        <label>Auth code<input id="test-authentification-code" placeholder="•••-••-••••" autocomplete="off"></label>
        <button type="submit" id="go" ${enterSubmits ? '' : 'disabled'}>Continue</button>
      </form>
      <div id="checkout"></div>
      <script>
        // Mask the auth code shortly after entry, like the real site does.
        const code = document.getElementById('test-authentification-code');
        code.addEventListener('input', () => { if (code.value && !code.value.startsWith('•')) { code.dataset.real = code.value; setTimeout(() => { code.value = '•••-••-••••'; }, 50); } });
        // Address autocomplete: suggestions appear ~300 ms after typing. Keyboard: ArrowDown highlights the
        // next option, Enter accepts the highlighted one (Enter with no list open submits the form, like a real form).
        // Accepting reveals the State select and populates city/state/zip.
        const cityIn = document.querySelector('input[name="city"]');
        cityIn.addEventListener('input', () => { if (cityIn.value.trim()) { cityIn.removeAttribute('data-accent-color'); document.getElementById('city-wrap').removeAttribute('data-accent-color'); } });
        const line1 = document.querySelector('input[name="line1"]');
        const ac = document.getElementById('ac');
        let acTimer, hi = -1;
        const closeAc = () => { ac.style.display = 'none'; ac.innerHTML = ''; hi = -1; };
        const accept = (o) => {
          line1.value = o.line1;
          if (!document.querySelector('select[name="state"]')) {
            document.getElementById('state-slot').innerHTML = '<label>State<select name="state"><option value="">--</option><option value="NY">New York</option><option value="CA">California</option><option value="FL">Florida</option><option value="TX">Texas</option></select></label>';
          }
          document.querySelector('input[name="city"]').value = o.city; document.querySelector('select[name="state"]').value = o.state; document.querySelector('input[name="zip"]').value = o.zip;
          document.getElementById('go').disabled = false;
          closeAc();
        };
        line1.addEventListener('input', () => {
          clearTimeout(acTimer); closeAc();
          if (!line1.value.trim() || ${noSuggest}) return;
          acTimer = setTimeout(() => {
            const v = line1.value.split(',')[0].trim();
            const opts = [
              { text: v + ', Springfield, NY 10099, USA', line1: v, city: 'Springfield', state: 'NY', zip: '10099' },
              { text: v + ' Apt 2, Springfield, NY 10099, USA', line1: v + ' Apt 2', city: 'Springfield', state: 'NY', zip: '10099' },
            ];
            for (const o of opts) {
              const d = document.createElement('div'); d.className = 'sugg-item'; d.textContent = o.text; d.style.padding = '4px'; d.dataset.o = JSON.stringify(o);
              d.onclick = () => accept(o);
              ac.appendChild(d);
            }
            ac.style.display = 'block';
          }, 300);
        });
        line1.addEventListener('focus', () => { if (line1.value.trim() && ac.style.display !== 'block') line1.dispatchEvent(new Event('input')); });
        line1.addEventListener('keydown', (e) => {
          const items = [...ac.querySelectorAll('.sugg-item')];
          if (ac.style.display !== 'block' || !items.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, items.length - 1); items.forEach((it, i) => it.style.background = i === hi ? '#cde' : ''); }
          else if (e.key === 'Enter') { e.preventDefault(); setTimeout(() => accept(JSON.parse(items[Math.max(hi, 0)].dataset.o)), 250); }
          else if (e.key === 'Escape') closeAc();
        });
        let submits = 0;
        document.getElementById('f').addEventListener('submit', (e) => {
          e.preventDefault();
          submits++;
          const cityEl = document.querySelector('input[name="city"]'), wrap = document.getElementById('city-wrap');
          if (${cityError} && submits === 1) { cityEl.value = ''; wrap.setAttribute('data-accent-color', 'red'); cityEl.setAttribute('data-accent-color', 'red'); return; }
          if (!cityEl.value.trim()) { wrap.setAttribute('data-accent-color', 'red'); cityEl.setAttribute('data-accent-color', 'red'); return; }
          wrap.removeAttribute('data-accent-color'); cityEl.removeAttribute('data-accent-color');
          // Test hooks: the session remembers who used it (proves which context a re-saved session came from);
          // a last name containing NOIFRAME makes the checkout iframe never appear (per-applicant failure injection).
          document.cookie = 'lastApplicant=' + encodeURIComponent(document.getElementById('first-name').value) + '; Path=/';
          const noIframe = /NOIFRAME/.test(document.getElementById('last-name').value);
          document.getElementById('checkout').innerHTML = '<p>Loading terms…</p>';
          if (${noAgree}) { setTimeout(() => { document.getElementById('checkout').innerHTML = '<iframe src="/checkout"></iframe>'; }, 900); return; }
          if (${returning}) { setTimeout(() => { document.getElementById('checkout').innerHTML = '<iframe src="/checkout?returning=1"></iframe>'; }, 900); return; }
          setTimeout(() => {
            document.getElementById('checkout').innerHTML = '<p>Terms…</p><button type="button" aria-label="Agree and continue" id="agree">I agree</button>';
            document.getElementById('agree').onclick = () => {
              document.getElementById('checkout').innerHTML = '<p>Loading checkout…</p>';
              if (noIframe) return; // test hook: the checkout iframe never appears for this applicant
              setTimeout(() => { document.getElementById('checkout').innerHTML = '<iframe src="/checkout"></iframe>'; }, 900);
            };
          }, 600);
        });
      </script>`);
  }

  if (url.pathname === '/checkout') {
    return page(`<h2>Checkout — step 1</h2>
      ${url.searchParams.has('returning') ? '' : '<label><input type="checkbox" id="v-0-0-0-0-0-0" checked> Add optional extra</label>'}
      <p><button data-variant="secondary" id="cancel">Cancel</button> <button data-variant="primary" id="pay">Continue to payment</button></p>
      <script>
        document.getElementById('pay').onclick = () => { document.getElementById('pay').disabled = true; setTimeout(() => location.href = '/checkout/step2', 700); };
        document.getElementById('cancel').onclick = () => alert('cancel clicked: WRONG BUTTON');
      </script>`);
  }
  if (url.pathname === '/checkout/step2') {
    return page(`<h2>Checkout — step 2</h2>
      <p><button data-variant="secondary" id="finish">Continue on phone</button></p>
      <script>
        document.getElementById('finish').onclick = () => { setTimeout(() => {
          ${urlAsText
            ? "document.body.innerHTML = '<h2>Done</h2><p>Scan or open: <span>http://localhost:" + port + "/test/it-worked/" + randomBytes(6).toString('hex') + "</span></p><p id=ok></p>'; setTimeout(() => { document.getElementById('ok').textContent = 'You’re good to go'; }, 2500);"
            : "location.href = '/test/it-worked/" + randomBytes(6).toString('hex') + "';"}
        }, 500); };
      </script>`);
  }
  if (url.pathname.startsWith('/test/it-worked/')) {
    if (urlRedirects && !url.searchParams.has('final')) {
      // intermediate page: loads, then navigates to the final URL a moment later (like a real handoff)
      return page(`<h2>Redirecting…</h2><script>setTimeout(() => location.replace('/test/it-worked/${randomBytes(6).toString('hex')}?final=1'), 700)</script>`);
    }
    return page(`<h2>It worked</h2><p>${url.pathname}${url.search}</p><p id="ok"></p>
      <script>setTimeout(() => { document.getElementById('ok').textContent = 'You’re good to go'; }, ${Number(process.env.FAKE_B_GOOD_TO_GO_MS ?? 2500)});</script>`);
  }
  if (url.pathname === '/other') return page(`<h1>Other plan</h1>`);

  res.writeHead(404); res.end('not found');
}).listen(port, () => console.log(`[fake-b] listening on http://localhost:${port}  autoLogin=${autoLogin}`));
