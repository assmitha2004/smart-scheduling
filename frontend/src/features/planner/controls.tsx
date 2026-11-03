import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Button, Input } from '../../components/ui';
import type { WeeklySlot } from '../../types';

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Toggle chips for weekdays (Mon first). */
export function DayChips({ value, onChange, label = 'Days' }: { value: number[]; onChange: (v: number[]) => void; label?: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {DAY_ORDER.map((d) => {
        const on = value.includes(d);
        return (
          <button key={d} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])}
            className={clsx('h-8 w-9 rounded-lg border text-xs font-medium transition-colors', on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-muted hover:border-accent')}>
            {DAY_SHORT[d]}
          </button>
        );
      })}
    </div>
  );
}

/** A big friendly tappable card for single-choice questions. */
export function ChoiceCard({ selected, onClick, emoji, title, blurb }: { selected: boolean; onClick: () => void; emoji: string; title: string; blurb?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={clsx('flex flex-1 flex-col items-start gap-1 rounded-xl border-2 p-4 text-left transition-all', selected ? 'border-accent bg-accent-soft shadow-sm' : 'border-border bg-surface hover:-translate-y-0.5 hover:border-accent/50')}>
      <span className="text-3xl" aria-hidden>{emoji}</span>
      <span className="font-semibold">{title}</span>
      {blurb && <span className="text-xs text-muted">{blurb}</span>}
    </button>
  );
}

export function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={!!on}
      className={clsx('rounded-full border px-3 py-1 text-sm transition-colors', on ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface hover:border-accent')}>
      {children}
    </button>
  );
}

export function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <Input type="time" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-28 py-1" />;
}

/** Rows of weekly commitments: name, days, start, end. */
export function SlotList({ items, onChange, placeholder, addLabel, ideas }: {
  items: WeeklySlot[];
  onChange: (v: WeeklySlot[]) => void;
  placeholder: string;
  addLabel: string;
  ideas?: WeeklySlot[];
}) {
  const update = (i: number, patch: Partial<WeeklySlot>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-2">
      {items.map((s, i) => (
        <div key={i} className="rounded-lg border border-border bg-surface-2/50 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={s.title} onChange={(e) => update(i, { title: e.target.value })} placeholder={placeholder} className="min-w-40 flex-1 py-1" aria-label="Name" />
            <TimeInput label="Start" value={s.start} onChange={(v) => update(i, { start: v })} />
            <span className="text-muted">–</span>
            <TimeInput label="End" value={s.end} onChange={(v) => update(i, { end: v })} />
            <button type="button" className="px-1 text-muted hover:text-danger" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
          </div>
          <div className="mt-2"><DayChips value={s.weekdays} onChange={(v) => update(i, { weekdays: v })} /></div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...items, { title: '', weekdays: [1, 3], start: '10:00', end: '11:00' }])}>+ {addLabel}</Button>
        {ideas?.filter((idea) => !items.some((x) => x.title === idea.title)).map((idea) => (
          <Chip key={idea.title} onClick={() => onChange([...items, { ...idea, weekdays: [...idea.weekdays] }])}>+ {idea.title}</Chip>
        ))}
      </div>
    </div>
  );
}

/** Generic editable list with an "add" button. */
export function ListEditor<T>({ items, onChange, render, blank, addLabel }: { items: T[]; onChange: (v: T[]) => void; render: (item: T, update: (p: Partial<T>) => void) => ReactNode; blank: () => T; addLabel: string }) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/50 p-2.5">
          {render(it, (p) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x))))}
          <button type="button" className="ml-auto px-1 text-muted hover:text-danger" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...items, blank()])}>+ {addLabel}</Button>
    </div>
  );
}

/** The planner's friendly assistant, Tempo, saying something. */
export function Tempo({ children, mood = '🦉' }: { children: ReactNode; mood?: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="tempo-bob flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xl shadow-sm" aria-hidden>{mood}</div>
      <div className="relative rounded-2xl rounded-tl-sm border border-border bg-surface px-4 py-3 text-[15px] leading-relaxed shadow-sm">{children}</div>
    </div>
  );
}
