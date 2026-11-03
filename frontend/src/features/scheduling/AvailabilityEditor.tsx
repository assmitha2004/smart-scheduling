import { WEEKDAYS } from '../../lib/format';
import type { AvailabilityRule } from '../../types';
import { Button, Input } from '../../components/ui';

/** Weekly working hours: any number of slots per weekday (gaps = breaks). */
export function AvailabilityEditor({ rules, onChange }: { rules: AvailabilityRule[]; onChange: (r: AvailabilityRule[]) => void }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const update = (idx: number, patch: Partial<AvailabilityRule>) => onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {order.map((wd) => {
        const slots = rules.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === wd);
        return (
          <div key={wd} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="w-10 text-sm font-medium">{WEEKDAYS[wd]}</span>
            {!slots.length && <span className="text-sm text-muted">Unavailable</span>}
            {slots.map(({ r, i }) => (
              <span key={i} className="flex items-center gap-1">
                <Input type="time" aria-label={`${WEEKDAYS[wd]} start`} value={r.startTime} onChange={(e) => update(i, { startTime: e.target.value })} className="w-28 py-1" />
                <span className="text-muted">–</span>
                <Input type="time" aria-label={`${WEEKDAYS[wd]} end`} value={r.endTime} onChange={(e) => update(i, { endTime: e.target.value })} className="w-28 py-1" />
                <button type="button" className="px-1 text-muted hover:text-danger" aria-label="Remove slot" onClick={() => onChange(rules.filter((_, j) => j !== i))}>✕</button>
              </span>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...rules, { weekday: wd, startTime: slots.length ? '13:00' : '09:00', endTime: slots.length ? '17:00' : '12:00' }])}>+ slot</Button>
          </div>
        );
      })}
    </div>
  );
}

export function validateRules(rules: AvailabilityRule[]): string | null {
  for (const r of rules) if (r.endTime <= r.startTime) return `${WEEKDAYS[r.weekday]}: end time must be after start time`;
  for (let d = 0; d < 7; d++) {
    const day = rules.filter((r) => r.weekday === d).sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < day.length; i++) if (day[i].startTime < day[i - 1].endTime) return `${WEEKDAYS[d]}: slots overlap`;
  }
  return null;
}
