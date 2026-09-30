import { randomUUID } from 'node:crypto';
import type { ErrorCode, FieldUpdateMsg, PoolStatus, ServerMsg } from '../shared/messages.js';
import type { BrowserManager } from './browser/manager.js';
import type { SiteBConfig } from './config.js';
import type { ProfileStore, ReleaseOutcome } from './profiles/store.js';
import type { Settings } from './settings.js';
import { AutomationError, type Timeline } from './timeline.js';
import { Workflow, toAutomationError, type TerminalOutcome } from './workflow.js';

interface Queued { workflowId: string; clientIp?: string; applicationId?: string; enqueuedAt: number; timer: NodeJS.Timeout }
const workflowId = (m: FieldUpdateMsg) => m.workflowId;

/**
 * Owns every live workflow: allocates a profile, creates the isolated context,
 * prepares Website B, routes messages by workflowId, renews leases, reaps idle
 * workflows, and releases profiles with the right outcome when a workflow ends.
 */
export class WorkflowRegistry {
  private live = new Map<string, Workflow>();
  private queue: Queued[] = [];
  /** Workflow ids accepted but without a runtime yet (queued or preparing) and the updates received meanwhile. */
  private early = new Map<string, FieldUpdateMsg[]>();
  /** Snapshot to carry into the next runtime when a workflow switches profile. */
  private carry = new Map<string, Record<string, string>>();
  private timers: NodeJS.Timeout[] = [];
  private send: (msg: ServerMsg) => void = () => {};

  constructor(
    private settings: Settings,
    private cfg: SiteBConfig,
    private store: ProfileStore,
    private browser: BrowserManager,
    private tl: Timeline,
  ) {
    browser.setDisconnectHandler(() => void this.onBrowserLost());
  }

  setSender(fn: (msg: ServerMsg) => void): void { this.send = fn; }
  /** Told after a successful run whether the account's refreshed session was persisted (never the session itself). */
  setSessionHandler(fn: (workflowId: string, profileId: string, result: 'refreshed' | 'failed') => void): void { this.onSession = fn; }
  private onSession: (workflowId: string, profileId: string, result: 'refreshed' | 'failed') => void = () => {};

  start(): void {
    const { leaseMs, cooldownMs } = this.settings;
    this.timers.push(setInterval(() => { for (const id of this.live.keys()) this.store.renewLease(id, leaseMs); }, Math.max(1000, leaseMs / 3)));
    this.timers.push(setInterval(() => {
      const promoted = this.store.promoteCooledDown();
      const reaped = this.store.reapExpiredLeases(cooldownMs).filter((id) => !this.live.has(id));
      if (promoted || reaped.length) { this.tl.mark('pool maintenance', `${promoted} profile(s) back to available, ${reaped.length} stale assignment(s) reaped`); }
      const st = this.poolStatus();
      if (promoted || reaped.length || st.cooldown > 0 || st.queued > 0) this.broadcastPool();
      if (promoted) void this.processQueue();
      for (const wf of this.live.values()) {
        if (!wf.isTerminal() && (wf.state === 'ready' || wf.state === 'paused') && Date.now() - wf.lastActivityAt > this.settings.idleTimeoutMs) wf.end('idle timeout');
        // link_ready / visited are bounded by verification.timeoutMs inside the workflow
      }
    }, 5000));
  }

  /**
   * Shutdown: end every live workflow and WAIT for their terminal handling (session export on a
   * successful run, context close, release) before the caller closes Chromium. Bounded so a hung
   * export cannot block the process exit.
   */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const q of this.queue) clearTimeout(q.timer);
    this.stopping = true;
    for (const wf of this.live.values()) wf.end('service shutting down');
    const pending = [...this.terminals.values()];
    if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 15_000))]);
  }
  private stopping = false;
  private terminals = new Map<string, Promise<void>>();

  poolStatus(): PoolStatus {
    return { ...this.store.status(), queued: this.queue.length, maxWorkflows: this.settings.maxWorkflows };
  }

  private broadcastPool(): void {
    this.send({ type: 'pool.status', ts: Date.now(), pool: this.poolStatus() });
  }

  // ---------- start / queue ----------

  /** Create a workflow id, allocate a profile (or queue), and prepare the context. */
  startWorkflow(clientIp?: string, applicationId?: string): { workflowId: string; queuePosition?: number } {
    const workflowId = randomUUID();
    this.early.set(workflowId, []);
    if (this.live.size >= this.settings.maxWorkflows || !this.tryAllocate(workflowId, clientIp, applicationId)) {
      const timer = setTimeout(() => this.queueTimeout(workflowId), this.settings.queueTimeoutMs);
      this.queue.push({ workflowId, clientIp, applicationId, enqueuedAt: Date.now(), timer });
      this.tl.child(workflowId).mark('queued for a profile', `position ${this.queue.length}, ${this.poolStatus().available} available, ${this.live.size}/${this.settings.maxWorkflows} live`);
      this.broadcastPool();
      return { workflowId, queuePosition: this.queue.length };
    }
    return { workflowId };
  }

  private queueTimeout(workflowId: string): void {
    const i = this.queue.findIndex((q) => q.workflowId === workflowId);
    if (i < 0) return;
    this.queue.splice(i, 1);
    this.early.delete(workflowId);
    this.send({ type: 'error', ts: Date.now(), workflowId, code: 'NO_PROFILE_AVAILABLE', message: `No profile became available within ${this.settings.queueTimeoutMs} ms`, fatal: true });
    this.send({ type: 'state', ts: Date.now(), workflowId, state: 'failed', detail: 'NO_PROFILE_AVAILABLE' });
    this.broadcastPool();
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length && this.live.size < this.settings.maxWorkflows) {
      const next = this.queue[0];
      if (!this.tryAllocate(next.workflowId, next.clientIp, next.applicationId)) return;
      clearTimeout(next.timer);
      this.queue.shift();
      this.send({ type: 'workflow.accepted', ts: Date.now(), workflowId: next.workflowId });
    }
  }

  /** Reserve a profile and kick off preparation. Returns false when no profile is available. */
  private tryAllocate(workflowId: string, clientIp?: string, applicationId?: string): boolean {
    let r: ReturnType<ProfileStore['reserve']>;
    try { r = this.store.reserve(workflowId, this.settings.leaseMs, clientIp, applicationId); }
    catch (e) {
      // e.g. the unique index refused a second live workflow for the same application
      this.tl.child(workflowId).mark('reservation refused', e instanceof Error ? e.message.split('\n')[0] : String(e));
      return false;
    }
    if (!r) return false;
    void this.prepare(workflowId, r.profile.id, r.profile.label, 0);
    return true;
  }

  private async prepare(workflowId: string, profileId: string, label: string, attempt: number): Promise<void> {
    const tl = this.tl.child(workflowId);
    tl.mark('profile assigned', `${label} (attempt ${attempt + 1})`);
    this.broadcastPool();
    let wf: Workflow | null = null;
    try {
      const profile = this.store.get(profileId)!;
      let storageState: string;
      try {
        storageState = this.store.decryptStorageState(profile);
        JSON.parse(storageState);
      } catch (e) {
        this.store.release(workflowId, 'invalid', this.settings.cooldownMs, { reason: 'storageState unreadable', reassign: true });
        tl.mark('profile invalid', `${label}: storageState unreadable`);
        return this.reassign(workflowId, attempt, 'storageState unreadable');
      }
      const asg = this.store.getAssignment(workflowId);
      const proxy = asg?.egress_id ? this.store.egress.proxyOptions(asg.egress_id) : null;
      if (asg?.egress_id && asg.egress_id !== 'direct') tl.mark('egress', this.store.egress.get(asg.egress_id)?.label ?? asg.egress_id);
      const bundle = await this.browser.createContext(workflowId, storageState, proxy);
      wf = new Workflow(workflowId, bundle, this.cfg, tl, this.send);
      this.live.set(workflowId, wf);
      wf.setTerminalHandler((outcome, code) => {
        const p = this.onTerminal(workflowId, outcome, code).finally(() => { if (this.terminals.get(workflowId) === p) this.terminals.delete(workflowId); });
        this.terminals.set(workflowId, p);
      });
      wf.setLinkStateHandler((state) => { this.store.setLinkState(workflowId, state); this.tl.child(workflowId).mark(`link state stored: ${state}`); });
      wf.setSubmitStateHandler((state, url) => this.store.recordSubmit(workflowId, state, url ? { resultUrl: url } : {}));
      // Values that arrived before this runtime existed: previous profile's snapshot, then early updates.
      const carried = this.carry.get(workflowId);
      if (carried) { wf.seedSnapshot(carried); this.carry.delete(workflowId); }
      const buffered = this.early.get(workflowId) ?? [];
      this.early.delete(workflowId);
      for (const u of buffered) wf.handleFieldUpdate(u);
      this.store.setAssignmentState(workflowId, 'preparing');
      await wf.prepare();
      if (wf.isTerminal()) return;
      this.store.setAssignmentState(workflowId, 'ready');
      this.store.markVerified(profileId);
      this.broadcastPool();
    } catch (e) {
      let ae = toAutomationError(e);
      // A network failure while opening Website B through a proxy egress is the egress's fault, not the account's.
      if (/ERR_(PROXY|TUNNEL|SOCKS)|ERR_PROXY_AUTH|ERR_NO_SUPPORTED_PROXIES|ERR_HTTP_RESPONSE_CODE_FAILURE/.test(ae.message)) {
        const asg = this.store.getAssignment(workflowId);
        if (asg?.egress_id && asg.egress_id !== 'direct') {
          this.store.egress.recordWorkflowFailure(asg.egress_id, workflowId, ae.message.replace(/https?:\/\/\S+/g, '<url>'));
          ae = new AutomationError('EGRESS_FAILED', `Egress ${this.store.egress.get(asg.egress_id)?.label ?? asg.egress_id} failed: ${ae.message.split(' at ')[0]}`);
          tl.mark('egress failed', ae.message);
        }
      }
      if (ae.code === 'LOGIN_REQUIRED' && wf && !wf.isTerminal()) {
        // Profile session is dead: retire it and try another profile under the same workflow id.
        tl.mark('profile expired', `${label}: ${ae.message}`);
        this.live.delete(workflowId);
        this.carry.set(workflowId, wf.getSnapshot());
        this.early.set(workflowId, []);
        wf.detach();
        await this.browser.closeContext(workflowId);
        this.store.release(workflowId, 'auth_expired', this.settings.cooldownMs, { reason: ae.message, reassign: true });
        this.send({ type: 'event', ts: Date.now(), workflowId, name: 'profile expired, reassigning', detail: label });
        return this.reassign(workflowId, attempt, ae.message);
      }
      if (wf && !wf.isTerminal()) wf.fail(ae);
      else if (!wf) {
        this.send({ type: 'error', ts: Date.now(), workflowId, code: ae.code, message: ae.message, fatal: true });
        this.send({ type: 'state', ts: Date.now(), workflowId, state: 'failed', detail: ae.message });
        this.store.release(workflowId, 'failed', this.settings.cooldownMs, { reason: ae.message, outcomeCode: ae.code });
        this.broadcastPool();
      }
    }
  }

  private reassign(workflowId: string, attempt: number, why: string): void {
    if (attempt + 1 > this.settings.maxReassign) {
      this.early.delete(workflowId); this.carry.delete(workflowId);
      this.send({ type: 'error', ts: Date.now(), workflowId, code: 'NO_PROFILE_AVAILABLE', message: `Gave up after ${attempt + 1} profile(s): ${why}`, fatal: true });
      this.send({ type: 'state', ts: Date.now(), workflowId, state: 'failed', detail: 'NO_PROFILE_AVAILABLE' });
      this.broadcastPool();
      return;
    }
    const r = this.store.reserve(workflowId, this.settings.leaseMs);
    if (!r) {
      this.early.delete(workflowId); this.carry.delete(workflowId);
      this.send({ type: 'error', ts: Date.now(), workflowId, code: 'NO_PROFILE_AVAILABLE', message: `No other profile available after: ${why}`, fatal: true });
      this.send({ type: 'state', ts: Date.now(), workflowId, state: 'failed', detail: 'NO_PROFILE_AVAILABLE' });
      this.broadcastPool();
      return;
    }
    void this.prepare(workflowId, r.profile.id, r.profile.label, attempt + 1);
  }

  // ---------- routing ----------

  get(workflowId: string): Workflow | undefined { return this.live.get(workflowId); }

  /** An operator released an egress or an account: try to serve the queue now. */
  kick(): Promise<void> { return this.processQueue(); }
  isPerContextProxy(): boolean { return this.browser.isPerContextProxy(); }

  /** Workflows that hold or are about to hold a browser context (live, preparing or queued). */
  activeCount(): number { return this.live.size + this.early.size; }

  /** Development: save what the page rendered when a step failed (no-op without a live context). */
  captureFailure(workflowId: string, stage: string, code: string, message: string): void {
    if (this.live.has(workflowId)) this.browser.captureFailure(workflowId, stage, code, message);
  }

  /** True for ids that were accepted and have not ended (live, queued, or preparing). */
  isKnown(workflowId: string): boolean { return this.live.has(workflowId) || this.early.has(workflowId); }

  /** Field updates are accepted from the moment the workflow is accepted; before the runtime exists they are buffered. */
  handleFieldUpdate(m: FieldUpdateMsg): 'handled' | 'buffered' | 'unknown' {
    const wf = this.live.get(workflowId(m));
    if (wf) { wf.handleFieldUpdate(m); return 'handled'; }
    const buf = this.early.get(m.workflowId);
    if (!buf) return 'unknown';
    buf.push(m);
    this.tl.child(m.workflowId).mark(`update buffered (no browser context yet): ${m.field}`);
    return 'buffered';
  }

  end(workflowId: string, reason: string): void {
    const wf = this.live.get(workflowId);
    this.early.delete(workflowId);
    if (wf) { wf.end(reason); return; }
    const i = this.queue.findIndex((q) => q.workflowId === workflowId);
    if (i >= 0) { clearTimeout(this.queue[i].timer); this.queue.splice(i, 1); this.broadcastPool(); }
  }

  // ---------- release ----------

  private async onTerminal(workflowId: string, outcome: TerminalOutcome, code?: ErrorCode): Promise<void> {
    const wf = this.live.get(workflowId);
    this.live.delete(workflowId);
    this.early.delete(workflowId);
    this.carry.delete(workflowId);
    const release: ReleaseOutcome =
      outcome === 'completed' ? 'completed' : outcome === 'abandoned' ? 'abandoned' : outcome === 'auth_expired' ? 'auth_expired'
      : outcome === 'browser_lost' ? 'lost' : outcome === 'uncertain' ? 'uncertain' : 'failed';
    const a = this.store.getAssignment(workflowId);
    // A good run (verified, or the URL was captured and only the verification wait ended) leaves the context with
    // the account's newest cookies / storage: persist them on the SAME account before the context is closed.
    const successful = !!a && (outcome === 'completed' || (outcome === 'abandoned' && a.submit_state === 'succeeded'));
    if (successful && a) {
      const fresh = await this.browser.exportStorageState(workflowId);
      let saved = false;
      if (fresh) {
        try { this.store.refreshStorageState(a.profile_id, fresh, workflowId); saved = true; } catch (e) { this.tl.child(workflowId).mark('session persist failed', e instanceof Error ? e.message.split('\n')[0] : String(e)); }
      }
      if (saved) this.tl.child(workflowId).mark('session refreshed from the workflow context', 'saved encrypted on the same account');
      else { this.store.markSessionPersistFailed(a.profile_id, workflowId, fresh ? 'encrypt/save failed' : 'storageState export failed'); this.tl.child(workflowId).mark('SESSION_PERSIST_FAILED', 'account flagged for attention'); }
      this.onSession(workflowId, a.profile_id, saved ? 'refreshed' : 'failed');
    }
    await this.browser.closeContext(workflowId);
    this.store.release(workflowId, release, this.settings.cooldownMs, { outcomeCode: code, reason: outcome });
    const p = a ? this.store.get(a.profile_id) : undefined;
    this.tl.child(workflowId).mark('profile released', `${p?.label ?? '?'} → ${p?.state ?? '?'} (${release})`);
    void wf;
    this.broadcastPool();
    void this.processQueue();
  }

  private async onBrowserLost(): Promise<void> {
    if (this.stopping) return; // Chromium is being closed on purpose
    this.tl.mark('browser lost, failing all live workflows');
    for (const wf of [...this.live.values()]) wf.fail(new AutomationError('BROWSER_CLOSED', 'Chromium disconnected'));
    try {
      await this.browser.launch();
      void this.processQueue();
    } catch (e) {
      this.tl.mark('browser relaunch failed', String(e));
    }
  }
}
