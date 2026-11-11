import { useState } from 'react';
import clsx from 'clsx';
import { Button } from '../../components/ui';

export const SUGGESTIONS = ['More breaks', 'Shorter sessions', 'Too much for today', 'Start an hour later', 'Finish an hour earlier'];

export interface FeedbackLog {
  text: string;
  changes: string[];
  notUnderstood: string[];
  help: string | null;
}

function Check() {
  return <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/**
 * "Adjust the plan": the person says what to change in their own words
 * ("move leetcode to 9pm", "I'm busy 3-4", "more breaks"); the plan updates
 * and every change is listed, with undo where it's offered.
 */
export function FeedbackPanel({ onSend, busy, log, onUndo, canUndo, title = 'Adjust the plan', hint }: {
  onSend: (text: string) => void;
  busy: boolean;
  log: FeedbackLog[];
  onUndo?: () => void;
  canUndo?: boolean;
  title?: string;
  hint?: string;
}) {
  const [text, setText] = useState('');
  const send = (t: string) => { if (t.trim() && !busy) { onSend(t.trim()); setText(''); } };
  const last = log[log.length - 1];
  return (
    <section className="rounded-xl border border-border bg-surface" aria-labelledby="adjust-title">
      <div className="border-b border-border px-4 py-3">
        <h3 id="adjust-title" className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-muted">{hint ?? 'Tell me what to change in your own words. The plan updates right away.'}</p>
      </div>
      <form className="px-4 pt-3" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label htmlFor="feedback-text" className="sr-only">What should change?</label>
        <textarea id="feedback-text" rows={2} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }}
          placeholder="e.g. move leetcode to 9pm, core takes 2 hours, I’m busy 3–4"
          className="block w-full resize-none rounded-lg border border-border bg-bg/40 px-3 py-2 text-sm outline-none placeholder:text-muted/80 focus:border-accent focus:ring-2 focus:ring-accent/15" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">Enter to apply · Shift+Enter for a new line</span>
          <Button size="sm" type="submit" loading={busy} disabled={!text.trim()}>Apply</Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-1.5 px-4 pb-3 pt-2.5">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" disabled={busy} onClick={() => send(s)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-fg disabled:opacity-50">
            {s}
          </button>
        ))}
      </div>
      {last && (
        <div className="border-t border-border px-4 py-3 text-sm" aria-live="polite">
          <p className="text-xs text-muted">You said: “{last.text}”</p>
          {last.changes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {last.changes.map((c, i) => <li key={i} className="flex gap-2"><Check /><span>{c}</span></li>)}
            </ul>
          )}
          {last.notUnderstood.length > 0 && (
            <p className={clsx('rounded-md bg-warn-soft/60 px-2.5 py-1.5 text-xs text-warn', last.changes.length ? 'mt-2' : 'mt-2')}>
              I didn’t understand: {last.notUnderstood.map((x) => `“${x}”`).join(', ')}. {last.help ?? ''}
            </p>
          )}
          {!last.changes.length && !last.notUnderstood.length && last.help && <p className="mt-2 text-xs text-muted">{last.help}</p>}
          {onUndo && canUndo && last.changes.length > 0 && (
            <button type="button" onClick={onUndo} className="mt-2 text-xs font-medium text-accent hover:underline">Undo this change</button>
          )}
        </div>
      )}
      {log.length > 1 && (
        <details className="border-t border-border px-4 py-2 text-xs text-muted">
          <summary className="cursor-pointer select-none">Earlier changes ({log.length - 1})</summary>
          <ul className="mt-1.5 space-y-1 pb-1">
            {log.slice(0, -1).reverse().map((l, i) => <li key={i}>“{l.text}”: {l.changes.length ? l.changes.join(' ') : 'no change'}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
