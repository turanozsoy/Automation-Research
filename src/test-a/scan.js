/* Driver's license autofill: a downsized photo of the BACK of a U.S. license is sent to
   the service, which decodes the PDF417 barcode in memory, keeps only the fields the form
   needs, and discards the image and the raw record. The fields are filled here for review
   and reach the automation only through the normal field sync, as if typed. */
(() => {
  const $ = (s) => document.querySelector(s);
  const status = (t, cls) => { const el = $('#scanStatus'); el.textContent = t; el.className = cls || ''; };
  const WANTED = ['firstName', 'lastName', 'dateOfBirth', 'address1', 'city', 'state', 'zip'];

  // ---------- image handling: downsize in a canvas, post as JPEG, release the pixels ----------
  async function downsize(source, width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const c = document.createElement('canvas');
    c.width = Math.round(width * scale); c.height = Math.round(height * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    ctx.clearRect(0, 0, c.width, c.height); c.width = 0; c.height = 0;
    return blob;
  }
  async function decodeOnService(blob) {
    const r = await fetch('/api/scan/license', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob });
    return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })); // { ok, fields, missing } or { ok:false, error }
  }

  // ---------- fill the form (fires the same events as typing, so the normal sync picks the values up) ----------
  function fill(values) {
    const filled = [], missing = [];
    for (const name of WANTED) {
      const el = document.querySelector(`[data-field="${name}"]`);
      if (!el) continue;
      const v = values[name] || '';
      if (!v) { missing.push(name); el.classList.remove('autofilled'); continue; }
      el.value = v;
      if (el.tagName === 'SELECT' && el.value !== v) { missing.push(name); continue; }
      el.classList.add('autofilled');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push(name);
    }
    return { filled, missing };
  }

  function clearFields() {
    for (const el of document.querySelectorAll('[data-field]')) {
      el.value = '';
      el.classList.remove('autofilled');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    $('#result').textContent = '— no URL yet —';
    for (const s of document.querySelectorAll('[data-sync]')) s.textContent = '';
    status('Fields cleared.');
  }

  function handleResult(r) {
    if (!r || !r.ok) {
      const e = r && r.error;
      status(e === 'NO_BARCODE' ? 'No barcode found in that photo. Use the BACK of the license, fill the frame, avoid glare, keep it sharp.'
        : e === 'NOT_A_LICENSE' ? 'A barcode was read but it is not a U.S. license barcode. Try again with the back of the license.'
        : `Could not decode: ${e || 'unknown error'}`, 'err');
      return;
    }
    const { filled, missing } = fill(r.fields);
    status(`Filled from the license (${filled.length} field${filled.length === 1 ? '' : 's'}). Image discarded, nothing stored. Please CHECK every value before continuing.${missing.length ? ` Could not read: ${missing.join(', ')} — enter manually.` : ''}`, missing.length ? 'warn' : 'ok');
    if (window.__pageLog) window.__pageLog(`license scanned: filled ${filled.join(', ')}${missing.length ? '; missing ' + missing.join(', ') : ''}`);
  }

  // ---------- photo of the back (camera capture on phones, or upload) ----------
  async function decodeFile(file) {
    status('Decoding…');
    const bitmap = await createImageBitmap(file);
    try {
      return await decodeOnService(await downsize(bitmap, bitmap.width, bitmap.height, 1600));
    } finally {
      bitmap.close();
    }
  }

  // ---------- live camera scan (frames are posted until one decodes) ----------
  let stream = null, timer = null;
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('Live camera is not available here (needs HTTPS or localhost). Use "Take / upload photo" instead.', 'err'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) { status(`Camera not available: ${e.message}. Use "Take / upload photo" instead.`, 'err'); return; }
    const video = $('#scanVideo');
    video.srcObject = stream; await video.play();
    $('#scanLive').style.display = 'block';
    status('Point the camera at the BARCODE on the back of the license…');
    let busy = false;
    const tick = async () => {
      if (!stream) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        const r = await decodeOnService(await downsize(video, video.videoWidth, video.videoHeight, 1600)).catch(() => null);
        busy = false;
        if (!stream) return;
        if (r && r.ok) { stopCamera(); handleResult(r); return; }
      }
      timer = setTimeout(tick, 400);
    };
    tick();
  }
  function stopCamera() {
    if (timer) clearTimeout(timer); timer = null;
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    const video = $('#scanVideo'); video.pause(); video.srcObject = null;
    $('#scanLive').style.display = 'none';
  }

  // ---------- wiring ----------
  $('#btnScanCamera').onclick = () => (stream ? stopCamera() : startCamera());
  $('#btnScanStop').onclick = stopCamera;
  $('#scanFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // the file input keeps no reference to the photo
    if (!file) return;
    try { handleResult(await decodeFile(file)); } catch (err) { status(`Could not decode: ${err.message}`, 'err'); }
  });
  $('#btnClearFields').onclick = clearFields;
  $('#btnScanAnother').onclick = () => { clearFields(); $('#scanFile').click(); };
  window.addEventListener('pagehide', stopCamera);
})();
