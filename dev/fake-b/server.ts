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
        <div id="ac" role="listbox" style="display:none;border:1px solid #888;width:280px;background:#fff"></div>
        <label>City<input name="city" id="base-ui-_r_g_"></label>
        <label>State<select name="state"><option value="">--</option><option value="NY">New York</option><option value="CA">California</option><option value="FL">Florida</option><option value="TX">Texas</option></select></label>
        <label>ZIP<input name="zip" id="base-ui-_r_h_"></label>
        <label>Auth code<input id="test-authentification-code" placeholder="•••-••-••••" autocomplete="off"></label>
        <button type="submit">Continue</button>
      </form>
      <div id="checkout"></div>
      <script>
        // Mask the auth code shortly after entry, like the real site does.
        const code = document.getElementById('test-authentification-code');
        code.addEventListener('input', () => { if (code.value && !code.value.startsWith('•')) { code.dataset.real = code.value; setTimeout(() => { code.value = '•••-••-••••'; }, 50); } });
        // Address autocomplete: suggestions appear ~300 ms after typing; picking one overwrites city/state/zip.
        const line1 = document.querySelector('input[name="line1"]');
        const ac = document.getElementById('ac');
        let acTimer;
        line1.addEventListener('input', () => {
          clearTimeout(acTimer); ac.style.display = 'none'; ac.innerHTML = '';
          if (!line1.value.trim()) return;
          acTimer = setTimeout(() => {
            const v = line1.value.trim();
            const opts = [
              { text: v + ' Apt 2, Springfield, NY 10099', line1: v + ' Apt 2', city: 'Springfield', state: 'NY', zip: '10099' },
              { text: v + ', Springfield, NY 10099', line1: v, city: 'Springfield', state: 'NY', zip: '10099' },
              { text: '99 Elsewhere Rd, Miami, FL 33101', line1: '99 Elsewhere Rd', city: 'Miami', state: 'FL', zip: '33101' },
            ];
            for (const o of opts) {
              const d = document.createElement('div'); d.setAttribute('role', 'option'); d.textContent = o.text; d.style.padding = '4px';
              d.onclick = () => { line1.value = o.line1; document.querySelector('input[name="city"]').value = o.city; document.querySelector('select[name="state"]').value = o.state; document.querySelector('input[name="zip"]').value = o.zip; ac.style.display = 'none'; ac.innerHTML = ''; };
              ac.appendChild(d);
            }
            ac.style.display = 'block';
          }, 300);
        });
        document.getElementById('f').addEventListener('submit', (e) => {
          e.preventDefault();
          document.getElementById('checkout').innerHTML = '<p>Loading checkout…</p>';
          setTimeout(() => { document.getElementById('checkout').innerHTML = '<iframe src="/checkout"></iframe>'; }, 900);
        });
      </script>`);
  }

  if (url.pathname === '/checkout') {
    return page(`<h2>Checkout — step 1</h2>
      <label><input type="checkbox" id="v-0-0-0-0-0-0" checked> Add optional extra</label>
      <p><button data-variant="secondary" id="cancel">Cancel</button> <button data-variant="primary" id="pay">Continue to payment</button></p>
      <script>
        document.getElementById('pay').onclick = () => { document.getElementById('pay').disabled = true; setTimeout(() => location.href = '/checkout/step2', 700); };
        document.getElementById('cancel').onclick = () => alert('cancel clicked: WRONG BUTTON');
      </script>`);
  }
  if (url.pathname === '/checkout/step2') {
    return page(`<h2>Checkout — step 2</h2>
      <p><button data-variant="secondary" id="finish">Finish</button></p>
      <script>
        document.getElementById('finish').onclick = () => { setTimeout(() => location.href = '/test/it-worked/${randomBytes(6).toString('hex')}', 500); };
      </script>`);
  }
  if (url.pathname.startsWith('/test/it-worked/')) return page(`<h2>It worked</h2><p>${url.pathname}</p>`);
  if (url.pathname === '/other') return page(`<h1>Other plan</h1>`);

  res.writeHead(404); res.end('not found');
}).listen(port, () => console.log(`[fake-b] listening on http://localhost:${port}  autoLogin=${autoLogin}`));
