import clsx from 'clsx';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { Priority, RiskStatus, TaskStatus } from '../types';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'primary', size = 'md', loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-surface text-fg hover:bg-surface-2',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        className,
      )}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Card({ className, children, title, action }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={clsx('rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]', className)}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', className ?? 'h-5 w-5')} aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted"><Spinner className="h-4 w-4" />{label}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{message}</div>;
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
      tone === 'neutral' && 'bg-surface-2 text-muted', tone === 'accent' && 'bg-accent-soft text-accent',
      tone === 'ok' && 'bg-ok-soft text-ok', tone === 'warn' && 'bg-warn-soft text-warn', tone === 'danger' && 'bg-danger-soft text-danger', className)}>
      {children}
    </span>
  );
}

export function PriorityBadge({ p }: { p: Priority }) {
  const tone: Record<Priority, Tone> = { LOW: 'neutral', MEDIUM: 'accent', HIGH: 'warn', URGENT: 'danger' };
  return <Badge tone={tone[p]}>{p.toLowerCase()}</Badge>;
}

export function StatusBadge({ s }: { s: TaskStatus }) {
  const tone: Record<TaskStatus, Tone> = { TODO: 'neutral', IN_PROGRESS: 'accent', DONE: 'ok', CANCELLED: 'neutral' };
  return <Badge tone={tone[s]}>{s.replace('_', ' ').toLowerCase()}</Badge>;
}

export function RiskBadge({ s }: { s: RiskStatus }) {
  const map: Record<RiskStatus, [Tone, string]> = {
    ON_TRACK: ['ok', 'on track'], AT_RISK: ['warn', 'at risk'], INFEASIBLE: ['danger', 'not feasible'], OVERDUE: ['danger', 'overdue'], DONE: ['neutral', 'done'],
  };
  const [tone, label] = map[s];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputCls = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={clsx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={clsx(inputCls, p.className)} />;

export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-10" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
        className={clsx('w-full rounded-xl border border-border bg-surface shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close">✕</button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-danger', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
