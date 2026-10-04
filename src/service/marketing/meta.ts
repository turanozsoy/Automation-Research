import { createHash } from 'node:crypto';
import type { ApplicationRow, ApplicationStore } from '../applications/store.js';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';

/**
 * Meta Pixel, server side (Conversions API). The browser pixel on the applicant pages fires PageView, Lead and
 * CompleteRegistration; this class sends Lead and CompleteRegistration from the server as well, with the same
 * event_id, so Meta deduplicates and the event still arrives when the applicant's page is gone (a verification
 * that happens minutes or hours later, a manual "Mark verified" by the operator).
 *
 * Same pixel id as the old site, same standard event names: the campaign history continues. Contact details are
 * hashed (SHA-256, Meta normalisation) before they leave the server. The access token is read from the environment
 * and never logged or stored. Nothing is sent when META_PIXEL_ID or META_CAPI_TOKEN is missing.
 */
export type PixelEvent = 'Lead' | 'CompleteRegistration';
export type PixelEventStatus = 'pending' | 'sent' | 'failed' | 'disabled';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const RETRY_MS = [2000, 8000, 30_000];

/** Meta's normalisation rules before hashing (lowercase, trimmed, digits only for phones with a country code). */
export const normalize = {
  email: (v: string) => v.trim().toLowerCase(),
  phone: (v: string) => { const d = v.replace(/\D/g, ''); return d.length === 10 ? `1${d}` : d; }, // US numbers without a country code
  name: (v: string) => v.trim().toLowerCase().replace(/[^\p{L}]/gu, ''),
  city: (v: string) => v.trim().toLowerCase().replace(/[^a-z]/g, ''),
  state: (v: string) => v.trim().toLowerCase().slice(0, 2),
  zip: (v: string) => v.trim().replace(/\D/g, '').slice(0, 5),
};

export interface UserData {
  em?: string[]; ph?: string[]; fn?: string[]; ln?: string[]; ct?: string[]; st?: string[]; zp?: string[]; country?: string[];
  client_ip_address?: string; client_user_agent?: string; fbp?: string; fbc?: string; external_id?: string[];
}

/** Hashed, normalised user data for one application. Only fields that are present are included. */
export function userDataFor(row: ApplicationRow): UserData {
  const u: UserData = {};
  const h = (key: keyof UserData, raw: string | null, norm: (v: string) => string) => { if (raw && norm(raw)) (u as Record<string, unknown>)[key] = [sha(norm(raw))]; };
  h('em', row.email, normalize.email);
  h('ph', row.phone, normalize.phone);
  h('fn', row.first_name, normalize.name);
  h('ln', row.last_name, normalize.name);
  h('ct', row.city, normalize.city);
  h('st', row.address_state, normalize.state);
  h('zp', row.zip, normalize.zip);
  u.country = [sha('us')];
  u.external_id = [sha(row.id)];
  if (row.client_ip) u.client_ip_address = row.client_ip;
  if (row.client_user_agent) u.client_user_agent = row.client_user_agent;
  if (row.meta_fbp) u.fbp = row.meta_fbp;
  if (row.meta_fbc) u.fbc = row.meta_fbc;
  return u;
}

/** Deterministic id shared by the browser pixel and the server event for deduplication. */
export const pixelEventId = (applicationId: string, event: PixelEvent) => `${applicationId}:${event}`;

export class MetaConversions {
  constructor(private settings: Settings, private store: ApplicationStore, private tl: Timeline, private fetchImpl: typeof fetch = fetch) {}

  get configured(): boolean { return !!this.settings.metaPixelId; }
  get enabled(): boolean { return !!this.settings.metaPixelId && !!this.settings.metaCapiToken; }

  /**
   * Record and send one event for an application. Idempotent per (application, event): a second call is a no-op.
   * Sending happens in the background with a few retries; the outcome is in pixel_events and the application events.
   */
  track(event: PixelEvent, row: ApplicationRow, eventTime = Date.now()): void {
    if (!this.configured) return;
    const eventId = pixelEventId(row.id, event);
    const inserted = this.store.pixelEventInsert(row.id, event, eventId, this.enabled ? 'pending' : 'disabled', eventTime);
    if (!inserted) return; // already recorded for this application
    if (!this.enabled) { this.tl.child(row.workflow_id ?? row.id).mark(`pixel ${event} (browser only)`, 'META_CAPI_TOKEN not set: no server-side event'); return; }
    void this.send(eventId, event, row, eventTime, 0);
  }

  /** Events that never left (service restart mid-send) are retried once at boot. */
  retryPending(): number {
    if (!this.enabled) return 0;
    const pending = this.store.pixelEventsPending();
    for (const p of pending) { const row = this.store.get(p.application_id); if (row) void this.send(p.event_id, p.event as PixelEvent, row, p.created_at, 0); }
    return pending.length;
  }

  payload(event: PixelEvent, row: ApplicationRow, eventId: string, eventTime: number): Record<string, unknown> {
    return {
      data: [{
        event_name: event,
        event_time: Math.floor(eventTime / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: row.event_source_url ?? undefined,
        user_data: userDataFor(row),
      }],
      ...(this.settings.metaTestEventCode ? { test_event_code: this.settings.metaTestEventCode } : {}),
    };
  }

  private async send(eventId: string, event: PixelEvent, row: ApplicationRow, eventTime: number, attempt: number): Promise<void> {
    const url = `${this.settings.metaGraphUrl.replace(/\/$/, '')}/${encodeURIComponent(this.settings.metaPixelId!)}/events`;
    let outcome: { ok: boolean; detail: string };
    try {
      const res = await this.fetchImpl(`${url}?access_token=${encodeURIComponent(this.settings.metaCapiToken!)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.payload(event, row, eventId, eventTime)), signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text().catch(() => '');
      outcome = res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `HTTP ${res.status} ${scrubToken(text, this.settings.metaCapiToken!).slice(0, 200)}` };
    } catch (e) {
      outcome = { ok: false, detail: scrubToken(e instanceof Error ? e.message : String(e), this.settings.metaCapiToken!).slice(0, 200) };
    }
    if (outcome.ok) {
      this.store.pixelEventUpdate(eventId, 'sent', attempt + 1, outcome.detail);
      this.store.event(row.id, 'pixel_event', { detail: `${event} sent to Meta (server), event_id ${eventId}` });
      this.tl.child(row.workflow_id ?? row.id).mark(`pixel ${event} sent`, `server event for application ${row.id.slice(0, 8)}`);
      return;
    }
    if (attempt + 1 < RETRY_MS.length + 1) {
      this.store.pixelEventUpdate(eventId, 'pending', attempt + 1, outcome.detail);
      setTimeout(() => void this.send(eventId, event, row, eventTime, attempt + 1), RETRY_MS[attempt] ?? 30_000);
      return;
    }
    this.store.pixelEventUpdate(eventId, 'failed', attempt + 1, outcome.detail);
    this.store.event(row.id, 'pixel_event', { detail: `${event} could NOT be sent to Meta after ${attempt + 1} attempts: ${outcome.detail}` });
    this.tl.child(row.workflow_id ?? row.id).mark(`pixel ${event} failed`, outcome.detail);
  }
}

function scrubToken(s: string, token: string): string {
  return token && token.length >= 8 ? s.split(token).join('<token>') : s;
}
