import type { LifePlan } from '../../types';

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

const KIND_STYLE: Record<LifePlan['routine'][number]['kind'], { bg: string; label: string }> = {
  CLASS: { bg: '#8b5cf6', label: 'Classes' },
  WORK: { bg: '#0ea5e9', label: 'Work' },
  MEETING: { bg: '#f59e0b', label: 'Meetings' },
  ACTIVITY: { bg: '#ec4899', label: 'Activities' },
  MEAL: { bg: '#94a3b8', label: 'Meals' },
  COMMUTE: { bg: '#64748b', label: 'Commute' },
};

/** A compact weekly picture: fixed routine as coloured blocks, focus windows as striped areas. */
export function WeekGlance({ plan }: { plan: LifePlan }) {
  const all = [...plan.routine.map((r) => [toMin(r.start), toMin(r.end)]), ...plan.availability.map((a) => [toMin(a.startTime), toMin(a.endTime)])];
  const startH = Math.max(0, Math.floor(Math.min(6 * 60, ...all.map((x) => x[0])) / 60));
  const endH = Math.min(24, Math.ceil(Math.max(22 * 60, ...all.map((x) => x[1])) / 60));
  const span = (endH - startH) * 60;
  const pos = (s: string, e: string) => ({ top: `${((toMin(s) - startH * 60) / span) * 100}%`, height: `${Math.max(1.2, ((toMin(e) - toMin(s)) / span) * 100)}%` });
  const kinds = [...new Set(plan.routine.map((r) => r.kind))];
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i).filter((h) => h % 3 === 0);

  return (
    <div>
      <div className="flex gap-1">
        <div className="relative w-8 shrink-0 text-[10px] text-muted" style={{ height: 300 }}>
          {hours.map((h) => (
            <span key={h} className="absolute -translate-y-1/2" style={{ top: `${((h - startH) / (endH - startH)) * 100}%` }}>{String(h).padStart(2, '0')}</span>
          ))}
        </div>
        {DAY_ORDER.map((wd) => (
          <div key={wd} className="min-w-0 flex-1">
            <div className="relative overflow-hidden rounded-md border border-border bg-surface-2/60" style={{ height: 300 }}>
              {plan.availability.filter((a) => a.weekday === wd).map((a, i) => (
                <div key={`a${i}`} className="focus-window absolute inset-x-0" style={pos(a.startTime, a.endTime)} title={`Focus time ${a.startTime}–${a.endTime}`} />
              ))}
              {plan.routine.filter((r) => r.weekday === wd).map((r, i) => (
                <div key={`r${i}`} className="absolute inset-x-0.5 overflow-hidden rounded-sm px-0.5 text-[9px] leading-tight text-white"
                  style={{ ...pos(r.start, r.end), background: KIND_STYLE[r.kind].bg, opacity: r.kind === 'MEAL' ? 0.55 : 0.9 }} title={`${r.title} ${r.start}–${r.end}`}>
                  <span className="hidden sm:inline">{r.title}</span>
                </div>
              ))}
            </div>
            <div className="mt-1 text-center text-[11px] font-medium text-muted">{DAY_NAMES[wd]}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="focus-window inline-block h-3 w-4 rounded-sm border border-accent/40" /> Focus time for tasks</span>
        {kinds.map((k) => (
          <span key={k} className="flex items-center gap-1.5"><span className="inline-block h-3 w-4 rounded-sm" style={{ background: KIND_STYLE[k].bg }} /> {KIND_STYLE[k].label}</span>
        ))}
      </div>
    </div>
  );
}
