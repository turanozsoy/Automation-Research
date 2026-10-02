import type { Frame, Locator, Page } from 'playwright';
import type { FieldConfig, SiteBConfig } from './config.js';
import { AutomationError, type Timeline } from './timeline.js';

/** Normalise a value before it goes into Website B. */
export function normaliseValue(field: FieldConfig, value: string): string {
  const v = value.trim();
  if (field.format === 'MM/DD/YYYY') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  }
  return v;
}

/** Loose equality so masked inputs ("(555) 123-4567" vs "5551234567") still count as in sync. */
export function valuesEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (s: string) => s.replace(/[^0-9a-z]/gi, '').toLowerCase();
  const sa = strip(a), sb = strip(b);
  return sa.length > 0 && sa === sb;
}

/**
 * Everything that touches Website B's UI. Selectors come exclusively from the
 * config; nothing about the site is hardcoded here.
 */
export class SiteB {
  /** field name -> the selector (from config) that actually matched on the page */
  private resolved = new Map<string, string>();

  constructor(private page: Page, private cfg: SiteBConfig, private tl: Timeline) {}

  // ---------- navigation / auth ----------

  async openTarget(): Promise<void> {
    await this.page.goto(this.cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeouts.pageLoad });
  }

  currentUrl(): string {
    return this.page.url();
  }

  // ---------- initial action ----------

  async clickRecommended(): Promise<void> {
    const loc = this.page.locator(this.cfg.recommendedLink).filter({ visible: true }).first();
    try {
      await loc.click({ timeout: this.cfg.timeouts.action });
    } catch (e) {
      throw new AutomationError('RECOMMENDED_NOT_FOUND', `Could not click ${this.cfg.recommendedLink}: ${msg(e)}`);
    }
  }

  // ---------- fields ----------

  /** Resolve every configured field to a concrete selector. Waits for the first field to appear. */
  async resolveFields(): Promise<void> {
    this.resolved.clear();
    const names = Object.keys(this.cfg.fields);
    const first = this.cfg.fields[names[0]];
    // Wait for the form to exist at all (any selector of the first field), then resolve the rest immediately.
    try {
      await this.page.locator(first.selectors.join(', ')).first().waitFor({ state: 'visible', timeout: this.cfg.timeouts.action });
    } catch {
      throw new AutomationError('FIELD_NOT_FOUND', `Form did not appear: none of [${first.selectors.join(' | ')}] became visible`);
    }
    const missing: string[] = [];
    const later: string[] = [];
    for (const name of names) {
      const sel = await this.pickSelector(this.cfg.fields[name]);
      if (sel) this.resolved.set(name, sel);
      else if (this.cfg.fields[name].requiredAtStart) missing.push(`${name} [${this.cfg.fields[name].selectors.join(' | ')}]`);
      else later.push(name);
    }
    if (missing.length) throw new AutomationError('FIELD_NOT_FOUND', `Fields not found on page: ${missing.join('; ')}`);
    this.tl.mark('fields resolved', [...this.resolved].map(([k, v]) => `${k}=${v}`).join(', '));
    if (later.length) this.tl.mark('fields not on page yet (resolved later)', later.join(', '));
  }

  /** Try again to resolve a field that was not on the page at start. */
  private async resolveLater(name: string): Promise<boolean> {
    if (this.resolved.has(name)) return true;
    const sel = await this.pickSelector(this.cfg.fields[name]);
    if (!sel) return false;
    this.resolved.set(name, sel);
    return true;
  }

  isOnPage(name: string): Promise<boolean> {
    return this.resolveLater(name);
  }

  private async pickSelector(field: FieldConfig): Promise<string | null> {
    for (const sel of field.selectors) {
      try {
        if ((await this.page.locator(sel).count()) > 0) return sel;
      } catch { /* invalid selector -> try next */ }
    }
    return null;
  }

  private async fieldLocator(name: string): Promise<Locator> {
    if (!(await this.resolveLater(name))) {
      throw new AutomationError('FIELD_NOT_FOUND', `Field "${name}" is not on the page (${this.cfg.fields[name]?.selectors.join(' | ')})`, !this.cfg.fields[name] || this.cfg.fields[name].requiredAtStart);
    }
    return this.page.locator(this.resolved.get(name)!).first();
  }

  async readField(name: string): Promise<string> {
    return (await this.fieldLocator(name)).inputValue({ timeout: this.cfg.timeouts.action });
  }

  /**
   * Set one field and verify it stuck. Returns the value Website B now holds, or
   * "(masked)" for write-only fields whose value must never be read back or logged.
   */
  async setField(name: string, rawValue: string): Promise<string> {
    const field = this.cfg.fields[name];
    if (!field) throw new AutomationError('UNKNOWN_FIELD', `No config for field "${name}"`, false);
    const value = normaliseValue(field, rawValue);
    const loc = await this.fieldLocator(name);
    const t = this.cfg.timeouts.action;

    try {
      if (field.kind === 'select') {
        if (value === '') {
          await loc.selectOption({ value: '' }, { timeout: t }).catch(() => loc.selectOption([], { timeout: t }));
        } else {
          await loc.selectOption(value, { timeout: t });
        }
        return loc.inputValue({ timeout: t });
      }

      if (field.writeOnly) {
        await this.setWriteOnly(name, loc, value);
        return '(masked)';
      }

      await this.enterText(loc, value, field.inputMethod);
      let actual = await loc.inputValue({ timeout: t });
      if (valuesEquivalent(actual, value) || (value === '' && actual === '')) return actual;

      // Masked / controlled inputs sometimes reject fill(); fall back to real key presses (no artificial delay).
      await this.enterText(loc, value, 'type');
      actual = await loc.inputValue({ timeout: t });
      if (valuesEquivalent(actual, value) || (value === '' && actual === '')) return actual;

      throw new AutomationError('FIELD_FILL_FAILED', `Field "${name}" holds "${actual}" after trying to set "${value}"`, false);
    } catch (e) {
      if (e instanceof AutomationError) throw e;
      throw new AutomationError('FIELD_FILL_FAILED', `Field "${name}": ${msg(e)}`, false);
    }
  }

  private async enterText(loc: Locator, value: string, method: 'fill' | 'type'): Promise<void> {
    const t = this.cfg.timeouts.action;
    if (method === 'fill') {
      await loc.fill(value, { timeout: t });
      return;
    }
    await loc.click({ timeout: t });
    await loc.press('ControlOrMeta+a');
    await loc.press('Backspace');
    if (value !== '') await loc.pressSequentially(value, { timeout: t });
  }

  /**
   * Write-only field (Website B masks it after entry). Never compares the read-back
   * value and never puts the value in an error message. Checks only that the field
   * still exists, is non-empty, and is not flagged invalid.
   */
  private async setWriteOnly(name: string, loc: Locator, value: string): Promise<void> {
    await this.enterText(loc, value, this.cfg.fields[name].inputMethod);
    // Let Website B react (masking, validation) before checking. Playwright waits on the element, no fixed sleep.
    if (value !== '' && (await this.isEmpty(loc))) {
      await this.enterText(loc, value, 'type');
    }
    await this.checkWriteOnly(name, loc, value !== '');
  }

  private async isEmpty(loc: Locator): Promise<boolean> {
    const v = await loc.inputValue({ timeout: this.cfg.timeouts.action });
    return v.length === 0;
  }

  /** Validation for a write-only field without exposing its value. */
  async checkWriteOnly(name: string, loc: Locator, expectNonEmpty: boolean): Promise<void> {
    const t = this.cfg.timeouts.action;
    if ((await loc.count()) === 0) throw new AutomationError('FIELD_NOT_FOUND', `Field "${name}" disappeared after entry`, false);
    if (expectNonEmpty && (await this.isEmpty(loc))) {
      throw new AutomationError('FIELD_FILL_FAILED', `Field "${name}" is empty after entry`, false);
    }
    const state = await loc.evaluate((el) => {
      const invalid = el.getAttribute('aria-invalid') === 'true';
      const errId = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby');
      let errText: string | null = null;
      if (errId) {
        for (const id of errId.split(/\s+/)) {
          const n = document.getElementById(id);
          if (n && /error|invalid/i.test(n.className + ' ' + (n.getAttribute('role') ?? '')) && n.textContent?.trim()) errText = n.textContent.trim();
        }
      }
      return { invalid, errText };
    });
    if (state.invalid || state.errText) {
      throw new AutomationError('FIELD_FILL_FAILED', `Field "${name}" is flagged invalid by Website B${state.errText ? `: ${state.errText}` : ''}`, false);
    }
    void t;
  }

  /**
   * Bring the given fields on Website B in line with the snapshot. Returns the list
   * of fields that had to be corrected. Throws if any field cannot be corrected.
   * Write-only and deferred fields are skipped unless listed explicitly in `only`.
   */
  async reconcile(snapshot: Record<string, string>, only?: string[]): Promise<string[]> {
    const corrected: string[] = [];
    const failures: string[] = [];
    const names = only ?? Object.keys(this.cfg.fields).filter((n) => !this.cfg.fields[n].writeOnly && this.cfg.fields[n].syncMode === 'live');
    const skipped: string[] = [];
    for (const name of names) {
      if (!(name in snapshot) || !(name in this.cfg.fields)) continue;
      if (!this.cfg.fields[name].requiredAtStart && !(await this.isOnPage(name))) {
        skipped.push(name);
        continue;
      }
      const want = normaliseValue(this.cfg.fields[name], snapshot[name] ?? '');
      const have = await this.readField(name);
      if (valuesEquivalent(have, want) || (want === '' && have === '')) continue;
      try {
        await this.setField(name, want);
        corrected.push(name);
      } catch (e) {
        failures.push(`${name}: ${msg(e)}`);
      }
    }
    if (failures.length) throw new AutomationError('RECONCILE_MISMATCH', failures.join('; '));
    if (skipped.length) this.tl.mark('reconcile skipped fields not on page', skipped.join(', '));
    return corrected;
  }

  /**
   * Final check for a write-only field: fill it only if Website B shows it empty,
   * otherwise just validate. Never compares or logs the value.
   */
  async finaliseWriteOnly(name: string, value: string): Promise<'filled' | 'verified' | 'empty'> {
    const loc = await this.fieldLocator(name);
    if (value === '') return 'empty';
    if (await this.isEmpty(loc)) {
      await this.setField(name, value);
      return 'filled';
    }
    await this.checkWriteOnly(name, loc, true);
    return 'verified';
  }

  // ---------- address finalisation (Enter on the address input, then verify / repair) ----------

  /** Current Website B values of the address fields; null when a field is not on the page (e.g. state before acceptance). */
  async readAddress(fields: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const n of fields) {
      if (!(await this.isOnPage(n))) { out[n] = null; continue; }
      out[n] = await this.readField(n).catch(() => null);
    }
    return out;
  }

  /**
   * Compare Website B's address fields with Website A's snapshot. Normalised: trimmed,
   * case-insensitive, punctuation-insensitive; state compared by its two-letter value.
   * Returns the names of fields that are missing or materially different.
   */
  async verifyAddress(snapshot: Record<string, string>, fields: string[]): Promise<{ mismatches: string[]; current: Record<string, string | null> }> {
    const current = await this.readAddress(fields);
    const mismatches: string[] = [];
    for (const n of fields) {
      const want = normaliseValue(this.cfg.fields[n], snapshot[n] ?? '');
      if (want === '') continue; // nothing required from Website A for this field
      const have = current[n];
      if (have === null || have.trim() === '' || !valuesEquivalent(have, want)) mismatches.push(n);
    }
    return { mismatches, current };
  }

  /**
   * Bounded verify → repair (in field order) → verify. Returns true when every
   * address field matches Website A. Never loops: at most `rounds` repairs.
   */
  async verifyAndRepairAddress(snapshot: Record<string, string>, fields: string[], rounds: number, strict: boolean): Promise<boolean> {
    this.tl.mark('verifying final address');
    let { mismatches } = await this.verifyAddress(snapshot, fields);
    if (!mismatches.length) { this.tl.mark('final address verified'); return true; }
    for (let round = 1; round <= rounds && mismatches.length; round++) {
      for (const n of mismatches) this.tl.mark(`address mismatch detected: ${n}`);
      for (const n of fields) {
        if (!mismatches.includes(n)) continue;
        const want = snapshot[n] ?? '';
        try {
          await this.setField(n, want);
        } catch (e) {
          this.tl.mark(`address repair failed: ${n}`, msg(e));
        }
      }
      this.tl.mark('address fields repaired', `round ${round}: ${mismatches.join(', ')}`);
      ({ mismatches } = await this.verifyAddress(snapshot, fields));
    }
    if (!mismatches.length) { this.tl.mark('final address verified'); return true; }
    const { current } = await this.verifyAddress(snapshot, fields);
    const detail = mismatches.map((n) => `${n}: Website B has "${current[n] ?? '(missing)'}", Website A has "${snapshot[n] ?? ''}"`).join('; ');
    if (strict) throw new AutomationError('ADDRESS_MISMATCH', `Address still differs after ${rounds} repair round(s): ${detail}`);
    this.tl.mark('address still differs (will be re-checked at submit)', detail);
    return false;
  }

  /**
   * Focus the address input and press Enter so the site's autocomplete finalises the
   * address, then wait for the address fields to stop changing. Enter is only pressed
   * when a suggestion list is open (Enter into a closed list would submit the form);
   * if none is open, the list is re-triggered once with a harmless Space+Backspace.
   */
  async finalizeAddressWithEnter(snapshot: Record<string, string>): Promise<{ enterPressed: boolean; changed: string[] }> {
    const a = this.cfg.addressFinalize!;
    const input = await this.fieldLocator(a.inputField);
    const before = await this.readAddress(a.fields);
    const needle = addressNeedle(snapshot[a.inputField] ?? '');

    await this.markExistingElements();
    await input.click({ timeout: this.cfg.timeouts.action });
    await input.press('End').catch(() => {});
    let signal = await this.waitForSuggestionSignal(needle, a.suggestionsWaitMs);
    if (!signal) {
      // The list closed when other fields were filled; nudge the widget with real keys.
      await input.press('Space'); await input.press('Backspace');
      signal = await this.waitForSuggestionSignal(needle, a.suggestionsWaitMs);
    }
    if (!signal) {
      this.tl.mark('no suggestion list open, Enter NOT pressed on address1', 'address kept as typed');
      return { enterPressed: false, changed: [] };
    }
    this.tl.mark(`suggestions detected (${signal.kind})`, signal.detail);
    const focused = await input.evaluate((el) => document.activeElement === el || (el.getRootNode() instanceof ShadowRoot && (el.getRootNode() as ShadowRoot).activeElement === el), undefined, { timeout: 1000 }).catch(() => true);
    if (!focused) await input.focus({ timeout: 1000 }).catch(() => {});
    await this.page.keyboard.press('Enter');
    this.tl.mark('Enter pressed on address1');

    const after = await this.waitForAddressSettle(a.fields, a.settleQuietMs, a.settleMaxMs);
    const changed = a.fields.filter((n) => (before[n] ?? '') !== (after[n] ?? ''));
    this.tl.mark('address autocomplete finalized', changed.length ? `changed: ${changed.map((n) => `${n}="${after[n] ?? '(missing)'}"`).join(', ')}` : 'no field changed');
    return { enterPressed: true, changed };
  }

  /** Poll the address fields until their values are unchanged for `quietMs` (bounded by `maxMs`). */
  private async waitForAddressSettle(fields: string[], quietMs: number, maxMs: number): Promise<Record<string, string | null>> {
    const deadline = Date.now() + maxMs;
    let last = await this.readAddress(fields);
    let lastChange = Date.now();
    while (Date.now() < deadline && Date.now() - lastChange < quietMs) {
      await new Promise((r) => setTimeout(r, 100));
      const now = await this.readAddress(fields);
      if (fields.some((n) => now[n] !== last[n])) { last = now; lastChange = Date.now(); }
    }
    return last;
  }

  /** Tag every element (shadow roots included) so newly rendered ones can be told apart. */
  private markExistingElements(): Promise<void> {
    return this.page.evaluate(pageScript('mark', ''));
  }

  /**
   * Is a suggestion list open? Checks, in order: Google Places classic `.pac-container`
   * with items, ARIA listbox/option (Playwright locators pierce open shadow roots, which
   * covers the newer Google widget), aria-expanded on the focused input, then any NEW
   * visible element (shadow roots walked) whose text contains the typed street.
   */
  private async waitForSuggestionSignal(needle: string, maxMs: number): Promise<{ kind: string; detail: string } | null> {
    const deadline = Date.now() + maxMs;
    const pac = this.page.locator('.pac-container .pac-item').filter({ visible: true });
    const aria = this.page.locator('[role="option"]').filter({ visible: true });
    while (Date.now() < deadline) {
      try {
        const n1 = await pac.count();
        if (n1 > 0) return { kind: 'google pac-container', detail: `${n1} item(s): ${(await pac.first().innerText()).replace(/\s+/g, ' ').slice(0, 80)}` };
        const n2 = await aria.count();
        if (n2 > 0) return { kind: 'role=option', detail: `${n2} option(s): ${(await aria.first().innerText()).replace(/\s+/g, ' ').slice(0, 80)}` };
        const r = await this.page.evaluate<{ kind: string; detail: string } | null>(pageScript('signal', needle));
        if (r) return r;
      } catch { /* re-render */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  // ---------- field errors ----------

  /**
   * Fields Website B currently flags as invalid: the configured marker attribute on the
   * input or one of its ancestors (e.g. data-accent-color="red" on the wrapper), or
   * aria-invalid="true", or a required input left empty. Values are never returned.
   */
  async fieldsWithErrors(): Promise<{ field: string; reason: string }[]> {
    const fe = this.cfg.fieldErrors;
    const out: { field: string; reason: string }[] = [];
    for (const name of Object.keys(this.cfg.fields)) {
      if (!(await this.isOnPage(name))) continue;
      const loc = await this.fieldLocator(name);
      const r = await loc.evaluate((el, o: { attr: string; val: string; levels: number }) => {
        let n: Element | null = el;
        for (let i = 0; i <= o.levels && n; i++, n = n.parentElement) {
          if (n.getAttribute(o.attr) === o.val) return `${o.attr}=${o.val}${i ? ' on ancestor' : ''}`;
        }
        if (el.getAttribute('aria-invalid') === 'true') return 'aria-invalid';
        const i = el as HTMLInputElement;
        if (i.required && typeof i.value === 'string' && i.value.trim() === '') return 'required but empty';
        return null;
      }, { attr: fe.attribute, val: fe.value, levels: fe.ancestorLevels }, { timeout: 1500 }).catch(() => null);
      if (r) out.push({ field: name, reason: r });
    }
    return out;
  }

  /** Re-enter the given fields from the snapshot (write-only fields included). Returns the ones that failed. */
  async refillFields(names: string[], snapshot: Record<string, string>): Promise<string[]> {
    const failed: string[] = [];
    for (const name of names) {
      const value = snapshot[name] ?? '';
      if (value.trim() === '') { failed.push(name); this.tl.mark(`cannot re-fill ${name}: empty on Website A`); continue; }
      try {
        await this.setField(name, value);
        this.tl.mark(`field re-filled: ${name}`);
      } catch (e) {
        failed.push(name);
        this.tl.mark(`re-fill failed: ${name}`, msg(e));
      }
    }
    return failed;
  }

  /**
   * Right after the submit click, watch both outcomes at once until `timeout`:
   *   'advanced'  — the next step's element (agree button, else the checkout toggle) is visible
   *   'errors'    — the form is still on the page and Website B flags at least one field
   *   'form-still-here' — the form stayed with nothing flagged (the next step's own wait decides)
   *   'form-gone' — the form disappeared but the next step is not visible yet
   */
  async watchAfterSubmit(timeout: number): Promise<{ outcome: 'advanced' | 'errors' | 'form-still-here' | 'form-gone'; errors: { field: string; reason: string }[] }> {
    // "Advanced" = any of the next checkout controls is visible: Step 4 (Agree), Step 5 (toggle), Step 6 (primary
    // button) or Step 7 (secondary button). A previously-used account goes straight to Step 7, and must not sit
    // here until the timeout.
    const nextSels = [this.cfg.checkout.agreeButton, this.cfg.checkout.toggle, this.cfg.checkout.primaryButton, this.cfg.checkout.secondaryButton].filter((x): x is string => !!x);
    const firstField = Object.keys(this.cfg.fields)[0];
    const startedAt = Date.now();
    const deadline = startedAt + timeout;
    this.tl.mark('watching the page after submit', `up to ${timeout} ms for: a checkout control (Agree / toggle / primary / secondary) in any frame → "advanced"; the form gone → "form-gone"; a red field → "errors"`);
    let lastProgress = startedAt;
    while (Date.now() < deadline) {
      if (Date.now() - lastProgress > 3000) { this.tl.mark('still on the form after submit', `${Math.round((Date.now() - startedAt) / 100) / 10} s; frames: ${this.page.frames().map((f) => f.url() || 'about:blank').join(', ')}`); lastProgress = Date.now(); }
      for (const f of this.page.frames()) {
        for (const sel of nextSels) {
          const visible = await f.locator(sel).filter({ visible: true }).count().catch(() => 0);
          if (visible > 0) { this.tl.mark('page advanced after submit', `${sel} visible in ${f === this.page.mainFrame() ? 'main page' : 'iframe ' + f.url()} after ${Date.now() - startedAt} ms`); return { outcome: 'advanced', errors: [] }; }
        }
      }
      const formHere = await this.page.locator(this.cfg.fields[firstField].selectors.join(', ')).filter({ visible: true }).count().then((c) => c > 0).catch(() => false);
      if (!formHere) { this.tl.mark('form left the page after submit', `${Date.now() - startedAt} ms`); return { outcome: 'form-gone', errors: [] }; }
      const errors = await this.fieldsWithErrors();
      if (errors.length) return { outcome: 'errors', errors };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { outcome: 'form-still-here', errors: [] };
  }

  // ---------- submit ----------

  /**
   * Click the LAST visible + enabled button matching the configured submit selector.
   * If an overlay (e.g. an address-autocomplete dropdown) intercepts the click,
   * press Escape to dismiss it and retry once.
   */
  async clickLastSubmit(): Promise<void> {
    const all = this.page.locator(this.cfg.submitButton);
    const n = await all.count();
    for (let i = n - 1; i >= 0; i--) {
      const b = all.nth(i);
      if (!(await b.isVisible())) continue;
      if (!(await b.isEnabled())) this.tl.mark('submit button is disabled, waiting for it to enable');
      try {
        // click() waits for the button to be enabled and unobstructed, up to the action timeout.
        await b.click({ timeout: this.cfg.timeouts.action });
      } catch (e) {
        if (!(await b.isEnabled())) throw new AutomationError('SUBMIT_BUTTON_NOT_FOUND', `${this.cfg.submitButton} stayed disabled for ${this.cfg.timeouts.action} ms (form not valid?)`);
        this.tl.mark('submit click intercepted, dismissing overlay and retrying', msg(e));
        await this.page.keyboard.press('Escape');
        await b.click({ timeout: this.cfg.timeouts.action });
      }
      return;
    }
    throw new AutomationError('SUBMIT_BUTTON_NOT_FOUND', `No visible ${this.cfg.submitButton} among ${n} matches`);
  }

  // ---------- frames ----------

  /**
   * Find the frame (iframe or main frame) that currently shows a visible element
   * matching `selector`. Event-driven with a light poll fallback; never holds a
   * stale frame reference because it is re-run for every checkout step.
   */
  async findFrameWith(selector: string, timeout: number, code: import('../shared/messages.js').ErrorCode): Promise<Frame> {
    return (await this.findFrameWithAny([selector], timeout, code)).frame;
  }

  /**
   * Same search for several selectors at once: resolves with the first (selector, frame) pair that
   * becomes visible, in selector order within each check. Lets a step wait for "the element I want,
   * or the element of a later step that proves mine is not going to appear".
   */
  async findFrameWithAny(selectors: string[], timeout: number, code: import('../shared/messages.js').ErrorCode): Promise<{ frame: Frame; selector: string }> {
    const page = this.page;
    const urlFilter = this.cfg.checkout.frameUrlIncludes;
    const startedAt = Date.now();
    const deadline = startedAt + timeout;
    const frameName = (f: Frame) => (f === page.mainFrame() ? 'main page' : `iframe ${f.url() || 'about:blank'}`);
    const short = (sel: string) => (sel.length > 60 ? sel.slice(0, 57) + '…' : sel);
    let lastProgress = startedAt;
    let lastSummary = '';

    return new Promise<{ frame: Frame; selector: string }>((resolve, reject) => {
      let settled = false;
      let checking = false;

      const cleanup = () => {
        settled = true;
        clearInterval(iv);
        page.off('frameattached', kick);
        page.off('framenavigated', kick);
        page.off('domcontentloaded', kick);
      };
      const check = async () => {
        if (settled || checking) return;
        checking = true;
        // per selector: how many matches exist anywhere (attached) even if none is visible yet — says "it is there but hidden"
        const attached: Record<string, number> = {};
        try {
          for (const f of page.frames()) {
            if (settled) return;
            if (urlFilter && !f.url().includes(urlFilter)) continue;
            for (const selector of selectors) {
              try {
                const loc = f.locator(selector);
                if (await loc.filter({ visible: true }).first().isVisible()) {
                  cleanup();
                  this.tl.mark(`found ${short(selector)}`, `visible in ${frameName(f)} after ${Date.now() - startedAt} ms`);
                  resolve({ frame: f, selector });
                  return;
                }
                attached[selector] = (attached[selector] ?? 0) + (await loc.count().catch(() => 0));
              } catch { /* frame detached mid-check */ }
            }
          }
        } finally {
          checking = false;
        }
        if (settled) return;
        // narrate the wait every ~3 s (or at once when the picture changes) so /debug shows what the script sees
        const frames = page.frames().map((f) => frameName(f)).join(', ');
        const summary = `frames: ${frames}; present but not visible: ${Object.entries(attached).filter(([, n]) => n > 0).map(([sel, n]) => `${short(sel)} ×${n}`).join(', ') || 'none'}`;
        if (summary !== lastSummary || Date.now() - lastProgress > 3000) {
          this.tl.mark(`still waiting for ${selectors.map(short).join(' | ')}`, `${Math.round((Date.now() - startedAt) / 100) / 10} s of ${timeout / 1000} s — ${summary}`);
          lastProgress = Date.now();
          lastSummary = summary;
        }
        if (Date.now() > deadline) {
          cleanup();
          reject(new AutomationError(code, `No frame showed ${selectors.join(' | ')} within ${timeout} ms (${summary})`));
        }
      };
      const kick = () => { void check(); };

      page.on('frameattached', kick);
      page.on('framenavigated', kick);
      page.on('domcontentloaded', kick);
      const iv = setInterval(kick, 150);
      kick();
    });
  }

  // ---------- checkout steps ----------

  /** Ensure the configured toggle is OFF. Returns what was done. */
  async ensureToggleOff(frame: Frame): Promise<'already-off' | 'unchecked'> {
    const t = this.cfg.timeouts.checkoutStep;
    const loc = frame.locator(this.cfg.checkout.toggle).first();
    try {
      await loc.waitFor({ state: 'attached', timeout: t });
    } catch {
      throw new AutomationError('TOGGLE_NOT_FOUND', `Toggle ${this.cfg.checkout.toggle} not found in checkout frame`);
    }

    const info = await loc.evaluate((el) => {
      const i = el as HTMLInputElement;
      return {
        tag: el.tagName.toLowerCase(),
        type: i.type ?? null,
        checked: typeof i.checked === 'boolean' ? i.checked : null,
        role: el.getAttribute('role'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaPressed: el.getAttribute('aria-pressed'),
        dataState: el.getAttribute('data-state'),
        id: el.id,
      };
    });
    const isNativeCheckbox = info.tag === 'input' && (info.type === 'checkbox' || info.type === 'radio');
    const isOn = isNativeCheckbox
      ? info.checked === true
      : info.ariaChecked === 'true' || info.ariaPressed === 'true' || info.dataState === 'checked' || info.dataState === 'on';

    this.tl.mark('toggle inspected', `${info.tag}${info.type ? `[type=${info.type}]` : ''} role=${info.role ?? '-'} on=${isOn}`);
    if (!isOn) return 'already-off';

    if (isNativeCheckbox) {
      try {
        await loc.uncheck({ timeout: 2000 });
      } catch {
        // Visually hidden native input behind a styled label: click the label, or dispatch a click on the input.
        const label = info.id ? frame.locator(`label[for="${info.id}"]`).first() : null;
        if (label && (await label.count()) > 0) await label.click({ timeout: t });
        else await loc.evaluate((el) => (el as HTMLElement).click());
      }
      const nowChecked = await loc.evaluate((el) => (el as HTMLInputElement).checked);
      if (nowChecked) throw new AutomationError('TOGGLE_STATE_FAILED', 'Toggle is still checked after attempting to uncheck it');
      return 'unchecked';
    }

    // Custom toggle: one click, then verify state flipped.
    await loc.click({ timeout: t });
    const after = await loc.evaluate((el) => ({
      ariaChecked: el.getAttribute('aria-checked'),
      ariaPressed: el.getAttribute('aria-pressed'),
      dataState: el.getAttribute('data-state'),
    }));
    const stillOn = after.ariaChecked === 'true' || after.ariaPressed === 'true' || after.dataState === 'checked' || after.dataState === 'on';
    if (stillOn) throw new AutomationError('TOGGLE_STATE_FAILED', 'Custom toggle still reports ON after clicking it');
    return 'unchecked';
  }

  /** Click the first visible button matching `selector` inside `frame` (Playwright waits for it to be enabled). */
  async clickInFrame(frame: Frame, selector: string, code: import('../shared/messages.js').ErrorCode): Promise<void> {
    const loc = frame.locator(selector).filter({ visible: true }).first();
    const where = frame === this.page.mainFrame() ? 'main page' : `iframe ${frame.url() || 'about:blank'}`;
    const label = await loc.innerText({ timeout: 1000 }).then((t) => t.trim().replace(/\s+/g, ' ').slice(0, 40)).catch(() => '');
    this.tl.mark(`clicking ${selector.length > 60 ? selector.slice(0, 57) + '…' : selector}`, `${label ? `"${label}" ` : ''}in ${where}; waits for it to be enabled and unobstructed, up to ${this.cfg.timeouts.checkoutStep} ms`);
    const t0 = Date.now();
    try {
      await loc.click({ timeout: this.cfg.timeouts.checkoutStep });
      this.tl.mark('click done', `${Date.now() - t0} ms`);
    } catch (e) {
      throw new AutomationError(code, `Could not click ${selector}: ${msg(e)}`);
    }
  }
}

/**
 * Page-side scripts as source strings (evaluated in the browser). Kept as strings so
 * the TypeScript runner's helper wrappers (e.g. esbuild's __name) never leak into the page.
 */
function pageScript(kind: 'mark' | 'signal' | 'box' | 'describe', needle: string): string {
  const common = `
    const needleLc = ${JSON.stringify(needle.toLowerCase())};
    const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
    const everything = walk(document, []);
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const skip = ['INPUT', 'SELECT', 'TEXTAREA', 'SCRIPT', 'STYLE'];
    const fresh = everything.filter((el) => !el.__preAc && vis(el) && !skip.includes(el.tagName));
    const txt = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
    const hits = fresh.filter((el) => txt(el).toLowerCase().includes(needleLc) && txt(el).length < 400);
    const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') + (el.getRootNode() !== document ? '{shadow}' : '') + ' "' + txt(el).slice(0, 60) + '"';
  `;
  if (kind === 'mark') return `(() => { ${common} for (const el of everything) el.__preAc = true; })()`;
  if (kind === 'signal') {
    return `(() => { ${common}
      const active = document.activeElement;
      if (active && active.getAttribute('aria-expanded') === 'true') return { kind: 'aria-expanded', detail: '' };
      if (hits.length) return { kind: 'new element with typed street', detail: desc(hits[0]) };
      return null;
    })()`;
  }
  if (kind === 'box') {
    return `(() => { ${common}
      const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      const el = deepest[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: txt(el).slice(0, 80) };
    })()`;
  }
  return `(() => { ${common}
    const all = everything.filter((el) => !el.__preAc && vis(el) && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE');
    const top = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
    return 'new visible elements: ' + all.length + ' (' + hits.length + ' containing "' + needleLc + '")' + (top.length ? '; top-level: ' + top.slice(0, 6).map(desc).join(' | ') : '');
  })()`;
}

/** House number + first street word, e.g. "8655 Bay Pkwy f3" -> "8655 bay". */
function addressNeedle(address1: string): string {
  const tokens = address1.trim().split(/\s+/).filter(Boolean);
  return (tokens.length >= 2 ? tokens.slice(0, 2).join(' ') : tokens[0] ?? '').toLowerCase();
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}
