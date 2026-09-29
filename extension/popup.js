/* Reads the session of the active tab's site (cookies for its registrable domain +
   the tab's localStorage), builds a Playwright storageState, and either downloads it
   or POSTs it to the automation service's /import endpoint. Own account, own site. */

const $ = (s) => document.querySelector(s);
const status = (text, cls) => { const el = $('#status'); el.textContent = text; el.className = cls || ''; };

let serviceUrl = 'http://localhost:3000';
let token = '';
let siteHost = null;       // host of the service's configured Website B (from GET /import)
let tab = null;

/** "app.example.co.uk" -> "example.co.uk" is not derivable without a suffix list; we take the last two labels,
    and ALSO include cookies of the exact host, which covers the common cases (example.com, www.example.com). */
function registrableDomain(host) {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

async function loadSettings() {
  const s = await chrome.storage.sync.get({ serviceUrl: 'http://localhost:3000', token: '', label: '', account: '' });
  serviceUrl = s.serviceUrl.replace(/\/+$/, '');
  token = s.token;
  $('#label').value = s.label || '';
  $('#account').value = s.account || '';
}

async function checkService() {
  try {
    const r = await fetch(`${serviceUrl}/import`, { method: 'GET' });
    const j = await r.json();
    siteHost = new URL(j.baseUrl).host;
    $('#site').textContent = `Service: ${serviceUrl}\nWebsite B: ${siteHost}${j.tokenRequired ? '  (token required)' : ''}`;
    return true;
  } catch (e) {
    $('#site').textContent = `Service not reachable at ${serviceUrl}. Start it (npm start) or fix the URL in options. Download still works.`;
    return false;
  }
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function collectSession() {
  tab = await activeTab();
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) throw new Error('Open a tab on Website B first.');
  const tabHost = new URL(tab.url).host;
  const host = siteHost || tabHost;
  if (siteHost && registrableDomain(tabHost) !== registrableDomain(siteHost)) {
    throw new Error(`Active tab is ${tabHost}, but the service expects ${siteHost}. Switch to a Website B tab.`);
  }
  const domain = registrableDomain(host);

  // Cookies for the registrable domain (covers the host and its subdomains, incl. ".domain" cookies).
  const cookies = await chrome.cookies.getAll({ domain });
  if (!cookies.length) throw new Error(`No cookies found for ${domain}. Are you logged in on that tab?`);

  // localStorage of the tab's origin (some sites keep tokens there).
  let localStorageEntries = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) })),
    });
    localStorageEntries = res?.result || [];
  } catch { /* page may forbid injection; cookies alone are usually enough */ }

  const storageState = {
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
      httpOnly: c.httpOnly, secure: c.secure,
      sameSite: c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'no_restriction' ? 'None' : 'Lax',
    })),
    origins: localStorageEntries.length ? [{ origin: new URL(tab.url).origin, localStorage: localStorageEntries }] : [],
  };
  return { storageState, cookieCount: cookies.length, lsCount: localStorageEntries.length, domain };
}

function readInputs() {
  const label = $('#label').value.trim();
  const account = $('#account').value.trim();
  if (!label || !account) throw new Error('Fill in the profile label and the account key.');
  chrome.storage.sync.set({ label, account });
  return { label, account };
}

$('#btnSend').onclick = async () => {
  try {
    const { label, account } = readInputs();
    status('Collecting session…');
    const { storageState, cookieCount, lsCount } = await collectSession();
    status(`Sending ${cookieCount} cookies, ${lsCount} localStorage entries…`);
    const r = await fetch(`${serviceUrl}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-import-token': token } : {}) },
      body: JSON.stringify({ label, accountKey: account, storageState }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    status(`${j.action === 'inserted' ? 'Imported' : 'Re-seeded'} profile "${j.label}"\n${j.detail}`, j.verified === false ? 'err' : 'ok');
  } catch (e) {
    status(`Error: ${e.message}`, 'err');
  }
};

$('#btnDownload').onclick = async () => {
  try {
    const { label, account } = readInputs();
    status('Collecting session…');
    const { storageState, cookieCount, lsCount } = await collectSession();
    const payload = { label, accountKey: account, exportedAt: new Date().toISOString(), storageState };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${label}.profile.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status(`Downloaded ${label}.profile.json (${cookieCount} cookies, ${lsCount} localStorage entries).\nDrop it into the service's data/inbox folder to import it.`, 'ok');
  } catch (e) {
    status(`Error: ${e.message}`, 'err');
  }
};

$('#openOptions').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

(async () => {
  await loadSettings();
  const reachable = await checkService();
  $('#btnSend').disabled = !reachable;
  $('#btnDownload').disabled = false;
})();
