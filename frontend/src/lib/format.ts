/** Formatting in the user's timezone (timestamps are UTC on the wire). */
export function fmtMinutes(m: number | null | undefined): string {
  if (m == null) return '—';
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const r = total % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const cache = new Map<string, Intl.DateTimeFormat>();
function f(tz: string, opts: Intl.DateTimeFormatOptions) {
  const key = tz + JSON.stringify(opts);
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }));
  return cache.get(key)!;
}

export const fmtTime = (iso: string | null | undefined, tz: string) =>
  iso ? f(tz, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
export const fmtDate = (iso: string | null | undefined, tz: string) =>
  iso ? f(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)) : '—';
export const fmtDateTime = (iso: string | null | undefined, tz: string) =>
  iso ? f(tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
export const dayKey = (iso: string, tz: string) =>
  f(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  if (d < 0) return `${Math.ceil(-d)}d overdue`;
  if (d < 1) return 'today';
  if (d < 2) return 'tomorrow';
  return `in ${Math.floor(d)}d`;
}

/** Value for <input type="datetime-local"> in the user's timezone. */
export function toLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const parts = Object.fromEntries(
    f(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Inverse of toLocalInput: wall-clock time in `tz` -> ISO UTC. */
export function fromLocalInput(value: string, tz: string): string | null {
  if (!value) return null;
  const [d, t] = value.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  // Offset of tz at that instant, applied twice to settle around DST edges.
  const offset = (ms: number) => {
    const p = Object.fromEntries(f(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let ms = guess - offset(guess);
  ms = guess - offset(ms);
  return new Date(ms).toISOString();
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
