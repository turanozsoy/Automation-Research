import type { EventMsg } from '../shared/messages.js';

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type Listener = (ev: EventMsg) => void;

/**
 * Timestamped event log. Every mark is printed to the terminal and forwarded to
 * listeners (the WebSocket layer broadcasts it to the test page).
 */
export class Timeline {
  private lastTs: number | null = null;
  private listeners: Listener[] = [];

  onEvent(fn: Listener): void {
    this.listeners.push(fn);
  }

  mark(name: string, detail?: string): number {
    const ts = Date.now();
    const sinceLastMs = this.lastTs === null ? undefined : ts - this.lastTs;
    this.lastTs = ts;
    const delta = sinceLastMs === undefined ? '' : ` (+${sinceLastMs} ms)`;
    console.log(`${fmtTime(ts)} — ${name}${detail ? ` — ${detail}` : ''}${delta}`);
    const ev: EventMsg = { type: 'event', ts, name, detail, sinceLastMs };
    for (const fn of this.listeners) fn(ev);
    return ts;
  }
}

export class AutomationError extends Error {
  constructor(public code: import('../shared/messages.js').ErrorCode, message: string, public fatal = true) {
    super(message);
    this.name = 'AutomationError';
  }
}
