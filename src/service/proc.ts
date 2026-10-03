import { readFileSync } from 'node:fs';

/** Linux: the process start time (clock ticks since boot) from /proc; the pair (pid, start) survives pid reuse. */
export function pidStartOf(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after "(comm) "
    return rest[19] ?? null; // field 22 overall = starttime
  } catch { return null; }
}

export type Liveness = boolean | 'unknown';

/**
 * Is the recorded owner process alive? false when it is dead or when the pid now belongs to a different process
 * (start time differs); 'unknown' without a pid. A pid we may not signal (EPERM) counts as alive (fail closed).
 */
export function ownerAlive(pid: number | null, pidStart: string | null): Liveness {
  if (!pid) return 'unknown';
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' ? true : false; }
  if (pidStart) { const now = pidStartOf(pid); if (now !== null && now !== pidStart) return false; }
  return true;
}
