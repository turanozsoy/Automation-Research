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

  // ---------- address autocomplete (keyboard only) ----------

  /** The search string typed into the autocomplete field, built from the snapshot in the configured order. */
  buildAddressSearch(snapshot: Record<string, string>): string {
    const a = this.cfg.addressSearch!;
    const parts: string[] = [];
    for (const name of a.order) {
      let v = (snapshot[name] ?? '').trim();
      if (!v) continue;
      if (name === 'state' && a.stateAs === 'name') v = US_STATE_NAMES[v.toUpperCase()] ?? v;
      parts.push(v);
    }
    return parts.join(a.separator);
  }

  /**
   * Type the search string, wait for a suggestion list (Google Places classic
   * `.pac-container`, the newer shadow-DOM widget, ARIA roles, or any newly
   * rendered element containing the typed street), then press the configured keys
   * with focus on the input.
   *
   * Outcomes:
   *   'accepted' — reveal fields visible and the input value changed (a place was picked)
   *   'advanced' — Enter submitted the form and the page moved on (submit button gone /
   *                agree button visible / URL changed); the caller skips the submit click
   * Falls back to a real mouse click on the first suggestion, retries, then throws.
   */
  async acceptAddressViaAutocomplete(snapshot: Record<string, string>): Promise<'accepted' | 'advanced'> {
    const a = this.cfg.addressSearch!;
    const search = this.buildAddressSearch(snapshot);
    if (!search) throw new AutomationError('ADDRESS_NOT_ACCEPTED', 'Address search string is empty');
    const loc = await this.fieldLocator(a.field);
    const t = this.cfg.timeouts.action;
    const needle = addressNeedle(snapshot[a.field] ?? search);
    const urlBefore = this.page.url();
    let lastDiag = '';

    for (let attempt = 1; attempt <= a.retries + 1; attempt++) {
      await this.markExistingElements();
      await loc.click({ timeout: t });
      await loc.press('ControlOrMeta+a');
      await loc.press('Backspace');
      await loc.pressSequentially(search, { timeout: t });
      this.tl.mark(attempt === 1 ? 'address search typed' : `address search retyped (attempt ${attempt})`, `"${search}"`);

      const signal = await this.waitForSuggestionSignal(needle, a.suggestionsWaitMs);
      if (signal) {
        this.tl.mark(`suggestions detected (${signal.kind})`, signal.detail);
        if (a.settleMs > 0) await new Promise((r) => setTimeout(r, a.settleMs));
      } else {
        lastDiag = await this.describeNewElements(needle);
        this.tl.mark(`no suggestion list detected within ${a.suggestionsWaitMs} ms`, lastDiag);
        if (!a.enterWithoutList) continue;
        this.tl.mark('pressing keys anyway (enterWithoutList=true)');
      }

      const focused = await loc.evaluate((el) => document.activeElement === el || (el.getRootNode() instanceof ShadowRoot && (el.getRootNode() as ShadowRoot).activeElement === el), undefined, { timeout: 1000 }).catch(() => true);
      if (!focused) await loc.focus({ timeout: 1000 }).catch(() => {});

      // If the widget already highlights a row (Google's newer widget does), ArrowDown would move to the
      // second row, so plain Enter is used instead.
      let keys = a.keySequences[Math.min(attempt - 1, a.keySequences.length - 1)] ?? ['ArrowDown', 'Enter'];
      if (keys[0] === 'ArrowDown' && (await this.optionAlreadyHighlighted())) {
        keys = keys.slice(1);
        this.tl.mark('a suggestion is already highlighted, skipping ArrowDown');
      }
      for (let k = 0; k < keys.length; k++) {
        if (k > 0 && a.keyDelayMs > 0) await new Promise((r) => setTimeout(r, a.keyDelayMs));
        await this.page.keyboard.press(keys[k]);
      }
      this.tl.mark(`${keys.join(' + ')} sent`);

      let outcome = await this.waitForOutcome(loc, search, a.revealFields, urlBefore, a.revealTimeoutMs);
      if (outcome === 'none') {
        this.tl.mark('keys did not accept a suggestion', `${a.field}="${await loc.inputValue({ timeout: 1000 }).catch(() => '?')}"`);
        // Mouse fallback: first visible suggestion (Google .pac-item / ARIA option, shadow DOM pierced), else the deepest new element with the street.
        const clicked = await this.clickFirstSuggestion(needle);
        if (clicked) {
          this.tl.mark('suggestion clicked with mouse', clicked);
          outcome = await this.waitForOutcome(loc, search, a.revealFields, urlBefore, a.revealTimeoutMs);
        }
      }
      if (outcome === 'accepted') {
        for (const name of a.revealFields) await this.resolveLater(name);
        this.tl.mark('address accepted', `${a.revealFields.join(', ')} on page; ${a.field}="${await loc.inputValue({ timeout: 1000 }).catch(() => '?')}"`);
        return 'accepted';
      }
      if (outcome === 'advanced') {
        this.tl.mark('form submitted by Enter, page advanced', `url=${this.page.url()}`);
        return 'advanced';
      }
      lastDiag = await this.describeNewElements(needle).catch(() => lastDiag);
      this.tl.mark('address not accepted on this attempt', lastDiag);
    }
    throw new AutomationError('ADDRESS_NOT_ACCEPTED', `Address suggestion could not be accepted after ${a.retries + 1} attempt(s). ${lastDiag}`);
  }

  /** 'accepted' (value changed + reveal fields visible), 'advanced' (form moved on), or 'none' after timeout. */
  private async waitForOutcome(input: Locator, typed: string, reveal: string[], urlBefore: string, timeout: number): Promise<'accepted' | 'advanced' | 'none'> {
    const deadline = Date.now() + timeout;
    const agree = this.cfg.checkout.agreeButton ? this.page.locator(this.cfg.checkout.agreeButton).filter({ visible: true }) : null;
    const submit = this.page.locator(this.cfg.submitButton).filter({ visible: true });
    while (Date.now() < deadline) {
      try {
        if (this.page.url() !== urlBefore) return 'advanced';
        if (agree && (await agree.count()) > 0) return 'advanced';
        const inputGone = (await input.count().catch(() => 0)) === 0;
        if (inputGone && (await submit.count()) === 0) return 'advanced';
        if (!inputGone) {
          const value = await input.inputValue({ timeout: 1000 });
          if (value.trim() !== typed.trim() && (await this.revealVisible(reveal))) return 'accepted';
        }
      } catch { /* re-render */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'none';
  }

  private async revealVisible(names: string[]): Promise<boolean> {
    for (const n of names) {
      const ok = await this.page.locator(this.cfg.fields[n].selectors.join(', ')).filter({ visible: true }).count().then((c) => c > 0).catch(() => false);
      if (!ok) return false;
    }
    return true;
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

  /** True when a suggestion row is already highlighted/selected (aria-selected, Google .pac-item-selected, or aria-activedescendant on the input). */
  private async optionAlreadyHighlighted(): Promise<boolean> {
    const sel = this.page.locator('[role="option"][aria-selected="true"], .pac-item-selected').filter({ visible: true });
    if ((await sel.count().catch(() => 0)) > 0) return true;
    return this.page.evaluate<boolean>(`(() => {
      const deep = (root) => { const a = root.activeElement; return a && a.shadowRoot ? deep(a.shadowRoot) : a; };
      const el = deep(document);
      return !!(el && el.getAttribute && el.getAttribute('aria-activedescendant'));
    })()`).catch(() => false);
  }

  /** Real mouse click on the first suggestion. Returns a description of what was clicked, or null. */
  private async clickFirstSuggestion(needle: string): Promise<string | null> {
    for (const sel of ['.pac-container .pac-item', '[role="option"]']) {
      const first = this.page.locator(sel).filter({ visible: true }).first();
      if ((await first.count()) > 0) {
        const text = (await first.innerText().catch(() => sel)).replace(/\s+/g, ' ').slice(0, 80);
        await first.click({ timeout: this.cfg.timeouts.action });
        return `${sel}: ${text}`;
      }
    }
    const box = await this.page.evaluate<{ x: number; y: number; w: number; h: number; text: string } | null>(pageScript('box', needle));
    if (!box) return null;
    await this.page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    return `element at (${Math.round(box.x)},${Math.round(box.y)}): ${box.text}`;
  }

  /** Human-readable list of elements that appeared since typing began, to identify the dropdown's DOM. */
  private describeNewElements(needle: string): Promise<string> {
    return this.page.evaluate(pageScript('describe', needle));
  }

  /** True once every reveal field's selector is visible on the page. */
  private async waitForReveal(names: string[], timeout: number): Promise<boolean> {
    try {
      await Promise.all(
        names.map((n) => this.page.locator(this.cfg.fields[n].selectors.join(', ')).first().waitFor({ state: 'visible', timeout })),
      );
      return true;
    } catch {
      return false;
    }
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
    const page = this.page;
    const urlFilter = this.cfg.checkout.frameUrlIncludes;
    const deadline = Date.now() + timeout;

    return new Promise<Frame>((resolve, reject) => {
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
        try {
          for (const f of page.frames()) {
            if (settled) return;
            if (urlFilter && !f.url().includes(urlFilter)) continue;
            try {
              if (await f.locator(selector).filter({ visible: true }).first().isVisible()) {
                cleanup();
                resolve(f);
                return;
              }
            } catch { /* frame detached mid-check */ }
          }
        } finally {
          checking = false;
        }
        if (!settled && Date.now() > deadline) {
          cleanup();
          reject(new AutomationError(code, `No frame showed ${selector} within ${timeout} ms (frames: ${page.frames().map(f => f.url() || 'about:blank').join(', ')})`));
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
    try {
      await loc.click({ timeout: this.cfg.timeouts.checkoutStep });
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

const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function msg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}
