import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { useCelebrate } from '../components/Celebrate';
import { Button, ErrorBox } from '../components/ui';
import { Timeline } from '../features/day/Timeline';
import { clock, duration, toMin } from '../features/day/dayUtils';
import type { ChatDraft, ChatQuestion, ChatSuggestion, DayData, DayProgramInfo, PlanChatTurn, ProgramPreview } from '../types';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  question?: ChatQuestion | null;
  suggestions?: ChatSuggestion[];
  changes?: string[];
}
interface Saved { messages: Msg[]; draft: ChatDraft | null; preview: ProgramPreview | null }

const STORE = 'planner-chat-v1';
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WELCOME: Msg = {
  role: 'assistant',
  text: 'Hi! Tell me what you need to get done — for today, a week, a month, a year or any number of days. Times are optional. I’ll ask about anything unclear, suggest improvements, and when you’re happy I’ll turn it into your schedule.',
  question: { id: 'start', text: 'Some ways to start:', options: ['Plan my week: leetcode 1h daily, gym 3 times a week, project 10 hours total', 'Today: study 2h, gym, call mom at 7pm', 'This month I work 9 to 6 on weekdays. Learn React every day and revise DSA on weekends'] },
};

function load(): Saved | null {
  try { const raw = localStorage.getItem(STORE); return raw ? (JSON.parse(raw) as Saved) : null; } catch { return null; }
}
function save(s: Saved) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage unavailable: the chat just isn't remembered */ }
}
const hmText = (hm: string) => clock(hm === '24:00' ? 1440 : toMin(hm)).replace(':00 ', ' ');
const daysText = (days: number[]) => {
  const s = [...days].sort().join();
  return s === '1,2,3,4,5,6,7' ? 'every day' : s === '1,2,3,4,5' ? 'weekdays' : s === '6,7' ? 'weekends' : days.map((d) => DAY_SHORT[d]).join(', ');
};

function Bubble({ m }: { m: Msg }) {
  const mine = m.role === 'user';
  return (
    <div className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={clsx('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed', mine ? 'rounded-br-md bg-accent text-accent-fg' : 'rounded-bl-md border border-border bg-surface')}>
        <p className="whitespace-pre-wrap">{m.text}</p>
        {m.question && m.question.id !== 'start' && <p className="mt-2 font-medium">{m.question.text}</p>}
        {m.question?.id === 'start' && <p className="mt-2 text-xs text-muted">{m.question.text}</p>}
      </div>
    </div>
  );
}

export default function PlannerChat() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { celebrate } = useCelebrate();
  const saved = useRef(load()).current;
  const [messages, setMessages] = useState<Msg[]>(saved?.messages?.length ? saved.messages : [WELCOME]);
  const [draft, setDraft] = useState<ChatDraft | null>(saved?.draft ?? null);
  const [preview, setPreview] = useState<ProgramPreview | null>(saved?.preview ?? null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'chat' | 'finalize' | 'page' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [source, setSource] = useState<'ai' | 'rules' | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const programs = useQuery({ queryKey: ['programs'], queryFn: async () => (await api.get<{ programs: DayProgramInfo[] }>('/day/programs')).data.programs });

  useEffect(() => { save({ messages, draft, preview }); }, [messages, draft, preview]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  const last = messages[messages.length - 1];
  const options = last.role === 'assistant' ? last.question?.options ?? [] : [];
  const spec = draft?.spec;
  const summary = preview?.summary ?? null;
  const days = preview?.days ?? [];
  const shown = days[Math.min(tab, Math.max(0, days.length - 1))];

  async function finalize(d: ChatDraft) {
    setBusy('finalize');
    setError(null);
    try {
      const r = await api.post<{ program: DayProgramInfo; day: DayData; replaced: number }>('/day/plan-chat/finalize', { spec: d.spec });
      for (const k of ['day', 'programs', 'progress', 'day-progress', 'tasks']) qc.invalidateQueries({ queryKey: [k] });
      try { localStorage.removeItem(STORE); } catch { /* ignore */ }
      celebrate({ emoji: '🗓️', line: r.data.program.totalDays > 1 ? `Your ${r.data.program.totalDays}-day plan is set. One day at a time!` : 'Your plan is set. You’ve got this!' });
      navigate(`/app?date=${r.data.program.startDate}`);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(null);
    }
  }

  async function send(raw: string) {
    const message = raw.trim();
    if (!message || busy) return;
    setText('');
    setError(null);
    const history = messages.filter((m) => m !== WELCOME).map((m) => ({ role: m.role, text: m.question && m.question.id !== 'start' ? `${m.text}\n${m.question.text}` : m.text })).slice(-20);
    setMessages((ms) => [...ms, { role: 'user', text: message }]);
    setBusy('chat');
    try {
      const r = (await api.post<PlanChatTurn>('/day/plan-chat', { message, draft, history })).data;
      setDraft(r.draft);
      setPreview(r.preview);
      setSource(r.source);
      setTab((t) => (r.preview && t < r.preview.days.length ? t : 0));
      setMessages((ms) => [...ms, { role: 'assistant', text: r.note ? `${r.reply}\n\n(${r.note})` : r.reply, question: r.question, suggestions: r.suggestions, changes: r.changes }]);
      if (r.finalize) await finalize(r.draft);
    } catch (e) {
      setError(apiError(e).message);
      setMessages((ms) => ms.slice(0, -1));
      setText(message);
    } finally {
      setBusy((b) => (b === 'chat' ? null : b));
      inputRef.current?.focus();
    }
  }

  async function page(from: number) {
    if (!spec) return;
    setBusy('page');
    try {
      const r = await api.post<{ preview: ProgramPreview }>('/day/plan-chat/preview', { spec, from, count: 14 });
      setPreview({ days: r.data.preview.days, summary: summary ?? r.data.preview.summary });
      setTab(0);
    } catch (e) { setError(apiError(e).message); } finally { setBusy(null); }
  }
  const firstShownIndex = summary && days.length ? Math.round((Date.parse(days[0].date) - Date.parse(summary.start)) / 86_400_000) : 0;

  function reset() {
    setMessages([WELCOME]);
    setDraft(null);
    setPreview(null);
    setTab(0);
    setError(null);
    try { localStorage.removeItem(STORE); } catch { /* ignore */ }
  }

  async function stop(p: DayProgramInfo) {
    try { await api.delete(`/day/programs/${p.id}`); programs.refetch(); qc.invalidateQueries({ queryKey: ['day'] }); } catch (e) { setError(apiError(e).message); }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Planner</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Plan with a chat</h1>
          <p className="mt-1 text-sm text-muted">A day, a week, a month, a year, or any number of days — the same routine or different every day.</p>
        </div>
        <div className="flex gap-2">
          <Link to="/app/tracker"><Button variant="ghost" size="sm">Progress calendar</Button></Link>
          <Button variant="secondary" size="sm" onClick={reset} disabled={!!busy}>New plan</Button>
        </div>
      </header>

      {programs.data && programs.data.length > 0 && (
        <div className="mb-4 space-y-2">
          {programs.data.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm">
              <span className="h-2 w-2 rounded-full bg-ok" aria-hidden />
              <span><span className="font-medium">{p.title}</span>{p.dayNumber && p.dayNumber > 0 ? <span className="text-muted"> · day {p.dayNumber} of {p.totalDays}</span> : <span className="text-muted"> · starts {p.startDate}</span>}</span>
              <span className="ml-auto flex gap-1">
                <Link to="/app"><Button size="sm" variant="ghost">Today</Button></Link>
                <Button size="sm" variant="ghost" onClick={() => stop(p)}>Stop plan</Button>
              </span>
            </div>
          ))}
          <p className="text-xs text-muted">A new plan that overlaps replaces the current one from its start date.</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* ---------- chat ---------- */}
        <section className="flex h-[75vh] min-h-[480px] flex-col rounded-2xl lg:h-[calc(100vh-11rem)] border border-border bg-surface-2/40" aria-label="Planner chat">
          <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5" aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className="space-y-2">
                <Bubble m={m} />
                {m.role === 'assistant' && m.suggestions && m.suggestions.length > 0 && i === messages.length - 1 && (
                  <div className="ml-1 space-y-2">
                    {m.suggestions.map((s, j) => (
                      <div key={j} className="flex max-w-[85%] items-start gap-3 rounded-xl border border-amber-300/50 bg-amber-50/60 px-3 py-2 text-sm dark:border-amber-500/20 dark:bg-amber-500/5">
                        <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">Tip</span>
                        <p className="flex-1">{s.text}</p>
                        <Button size="sm" variant="secondary" onClick={() => send(s.action)} disabled={!!busy}>Apply</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy === 'chat' && <div className="flex"><div className="rounded-2xl rounded-bl-md border border-border bg-surface px-4 py-3 text-sm text-muted"><span className="inline-flex gap-1"><span className="animate-pulse">●</span><span className="animate-pulse [animation-delay:150ms]">●</span><span className="animate-pulse [animation-delay:300ms]">●</span></span></div></div>}
            <div ref={endRef} />
          </div>

          <div className="border-t border-border bg-surface p-3 sm:p-4">
            {options.length > 0 && !busy && (
              <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Quick answers">
                {options.map((o) => (
                  <button key={o} type="button" onClick={() => (o === 'Other…' ? inputRef.current?.focus() : send(o))}
                    className={clsx('rounded-full border px-3 py-1.5 text-left text-sm transition-colors', o === 'Finalise' ? 'border-accent bg-accent text-accent-fg hover:opacity-90' : 'border-border bg-surface hover:border-accent hover:text-accent')}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            {error && <div className="mb-3"><ErrorBox message={error} /></div>}
            <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex items-end gap-2">
              <label htmlFor="chat-input" className="sr-only">Message</label>
              <textarea id="chat-input" ref={inputRef} rows={2} value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }}
                placeholder={draft?.ready ? 'Tell me a change, or say “finalise”…' : 'Type your answer or tell me your tasks…'}
                className="min-h-[44px] flex-1 resize-none rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
              <Button type="submit" loading={busy === 'chat'} disabled={!text.trim() || !!busy}>Send</Button>
            </form>
            <p className="mt-2 text-[11px] text-muted">
              {source === 'ai' ? 'Answered by Claude.' : 'Built-in planner.'}{' '}
              {!user?.aiExternalConsent && <>Turn on AI in <Link to="/app/settings" className="text-accent">Settings</Link> to chat with Claude (it also needs to be enabled on the server).</>}
            </p>
          </div>
        </section>

        {/* ---------- live plan ---------- */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start" aria-label="Plan preview">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Your plan</p>
                <p className="mt-0.5 font-semibold">{summary ? summary.label : spec?.tasks.length ? 'Period not set yet' : 'Nothing yet'}</p>
                {summary && <p className="text-xs text-muted">{summary.days} day{summary.days > 1 ? 's' : ''} · about {duration(summary.avgMinutesPerDay)} of tasks a day</p>}
              </div>
              <Button size="sm" onClick={() => draft && finalize(draft)} loading={busy === 'finalize'} disabled={!spec?.tasks.length || !!busy}>Finalise</Button>
            </div>
            {spec && spec.tasks.length > 0 && (
              <ul className="mt-3 divide-y divide-border text-sm">
                {(summary?.perTask ?? spec.tasks.map((t) => ({ key: t.key, title: t.title, when: t.repeat ? '' : 'to decide', times: 0, minutesEach: t.minutes, totalMinutes: 0 }))).map((t) => {
                  const pt = spec.tasks.find((x) => x.key === t.key);
                  return (
                    <li key={t.key} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        {t.title}
                        {pt?.top && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">Top</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted">{duration(t.minutesEach)}{t.when ? ` · ${t.when}` : ''}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {spec && (spec.commitments.length > 0 || spec.restDays.length > 0) && (
              <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted">
                {spec.commitments.map((c, i) => <p key={i}><span className="font-medium text-fg/80">{c.title}</span> {hmText(c.start)}–{hmText(c.end)} · {daysText(c.days)}</p>)}
                {spec.restDays.length > 0 && <p>Rest: {daysText(spec.restDays)}</p>}
                <p>Day runs {hmText(spec.dayStart)}–{hmText(spec.dayEnd)}</p>
              </div>
            )}
            {summary && summary.overloaded.length > 0 && (
              <p className="mt-3 rounded-lg bg-warn-soft/60 px-3 py-2 text-xs">{summary.overloaded.length} day{summary.overloaded.length > 1 ? 's' : ''} too full: {summary.overloaded.slice(0, 3).map((o) => o.label).join(', ')}{summary.overloaded.length > 3 ? '…' : ''}. Whatever doesn’t fit carries over to the next day.</p>
            )}
          </div>

          {days.length > 0 && shown && (
            <div className="rounded-2xl border border-border bg-surface p-4">
              <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Days">
                {days.map((d, i) => (
                  <button key={d.date} role="tab" aria-selected={i === tab} onClick={() => setTab(i)}
                    className={clsx('shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium', i === tab ? 'bg-fg text-bg' : 'text-muted hover:bg-surface-2', d.rest && i !== tab && 'opacity-60')}>
                    {d.label.split(' ').slice(0, 2).join(' ')}
                  </button>
                ))}
              </div>
              {summary && summary.days > 14 && (
                <div className="mb-3 flex items-center justify-between text-xs text-muted">
                  <button className="hover:text-fg disabled:opacity-40" disabled={firstShownIndex <= 0 || !!busy} onClick={() => page(Math.max(0, firstShownIndex - 14))}>← Earlier</button>
                  <span>Days {firstShownIndex + 1}–{firstShownIndex + days.length} of {summary.days}</span>
                  <button className="hover:text-fg disabled:opacity-40" disabled={firstShownIndex + days.length >= summary.days || !!busy} onClick={() => page(firstShownIndex + 14)}>Later →</button>
                </div>
              )}
              <p className="mb-2 text-sm font-semibold">{shown.label}{shown.rest ? ' · rest day' : ''}</p>
              {shown.items.length ? (
                <div className="max-h-[55vh] overflow-y-auto pr-1">
                  <Timeline entries={shown.items.map((item) => ({ item }))} />
                </div>
              ) : <p className="text-sm text-muted">Nothing planned this day.</p>}
              {shown.overflow.length > 0 && <p className="mt-2 text-xs text-warn">Doesn’t fit: {shown.overflow.map((o) => `${o.title} (${duration(o.minutes)})`).join(', ')}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
