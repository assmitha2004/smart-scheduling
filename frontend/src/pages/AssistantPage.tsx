import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, apiError } from '../services/api';
import { useToast } from '../components/Toast';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '../components/ui';
import { Timeline } from '../features/day/Timeline';
import type { DayPlanItem } from '../types';

// ---------- API shapes ----------
interface Option { id: string; label: string; hint?: string; recommended?: boolean }
interface Question { id: string; kind: 'PROFILE' | 'MEETING_INVITE' | 'MEETING_REQUEST'; text: string; detail: string | null; options: Option[] }
interface Action {
  id: string;
  kind: 'RSVP' | 'SCHEDULE_MEETING' | 'SEND_EMAIL';
  summary: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'REJECTED';
  error: string | null;
  email: { to: string; subject: string; body: string; draftedBy: string } | null;
  result: { meetUrl?: string } | null;
  executedAt: string | null;
}
interface Learned { peak: string | null; peakEvidence: string | null; estimateFactor: number | null; completionRate: number | null; insights: string[]; updatedAt: string | null }
interface Routine { wakeTime: string | null; sleepTime: string | null; workStart: string | null; workEnd: string | null; workDays: number[]; chronotype: string | null; focusMinutes: number | null }
interface Meetings { earliest: string | null; latest: string | null; bufferMinutes: number; maxPerDay: number | null; protectFocusTime: boolean }
interface State {
  ai: { provider: string; model: string | null; local: boolean; reachable: boolean; inUse: boolean };
  google: { configured: boolean; demoAvailable: boolean; connected: boolean; mode: 'google' | 'demo' | null; email: string | null; status: string | null; lastSyncAt: string | null; transport: 'http' | 'in-process' };
  profile: { summary: string[]; routine: Routine; meetings: Meetings; learned: Learned | null; decisions: number; notes: string[] };
  questions: Question[];
  actions: Action[];
  history: Action[];
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: string }[];
  today: { date: string; plan: { items: DayPlanItem[]; insights: string[] } | null; tasks: number; done: number };
}

const KEY = ['assistant'];
const KIND_LABEL: Record<Question['kind'], string> = { PROFILE: 'About you', MEETING_INVITE: 'Invite', MEETING_REQUEST: 'Email' };

export default function AssistantPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const state = useQuery({ queryKey: KEY, queryFn: async () => (await api.get<State>('/assistant')).data });
  const put = (s: State) => qc.setQueryData(KEY, s);
  const fail = (e: unknown) => toast.show(apiError(e).message, 'error');

  // Back from Google's consent screen.
  useEffect(() => {
    const g = params.get('google');
    if (!g) return;
    if (g === 'connected') toast.show(`Google connected${params.get('email') ? ` (${params.get('email')})` : ''}. Checking your calendar and inbox…`, 'success');
    else toast.show(params.get('message') ?? 'Google sign-in failed', 'error');
    setParams({}, { replace: true });
    if (g === 'connected') sync.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = useMutation({
    mutationFn: async () => (await api.post<{ sync: { newQuestions: number; meetings: number; notes: string[] }; state: State }>('/assistant/sync')).data,
    onSuccess: (r) => {
      put(r.state);
      toast.show(r.sync.newQuestions ? `${r.sync.newQuestions} new thing${r.sync.newQuestions === 1 ? '' : 's'} to decide` : 'All caught up', 'success');
      r.sync.notes.forEach((n) => toast.show(n, 'info'));
    },
    onError: fail,
  });
  const plan = useMutation({
    mutationFn: async (day: 'today' | 'tomorrow') => (await api.post<{ summary: string; state: State }>('/assistant/plan-day', { day })).data,
    onSuccess: (r) => {
      put(r.state);
      toast.show(r.summary, 'success');
      qc.invalidateQueries({ queryKey: ['day'] });
    },
    onError: fail,
  });
  const connect = useMutation({
    mutationFn: async () => (await api.get<{ url: string }>('/integrations/google/connect')).data,
    onSuccess: (r) => { window.location.href = r.url; },
    onError: fail,
  });
  const demo = useMutation({
    mutationFn: async () => (await api.post<{ state: State }>('/integrations/google/demo')).data,
    onSuccess: (r) => { put(r.state); sync.mutate(); },
    onError: fail,
  });
  const disconnect = useMutation({
    mutationFn: async () => (await api.delete<{ state: State }>('/integrations/google')).data,
    onSuccess: (r) => { put(r.state); toast.show('Google disconnected', 'info'); },
    onError: fail,
  });

  if (state.isLoading) return <Loading />;
  if (state.error || !state.data) return <ErrorBox message={apiError(state.error).message} />;
  const s = state.data;
  const busy = sync.isPending || plan.isPending;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Assistant"
        subtitle="Learns your routine, reads your calendar and email for meetings, asks you, then plans your day."
        actions={
          <>
            <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending} disabled={busy}>Check calendar & inbox</Button>
            <Button variant="secondary" onClick={() => plan.mutate('tomorrow')} disabled={busy}>Plan tomorrow</Button>
            <Button onClick={() => plan.mutate('today')} loading={plan.isPending} disabled={busy}>Plan my day</Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <ModelStatus ai={s.ai} />
        <GoogleStatus
          g={s.google}
          onConnect={() => connect.mutate()}
          onDemo={() => demo.mutate()}
          onDisconnect={() => disconnect.mutate()}
          busy={connect.isPending || demo.isPending || disconnect.isPending}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <QuestionsCard questions={s.questions} onState={put} onError={fail} />
          <ActionsCard actions={s.actions} onState={put} onError={fail} />
          <ChatCard messages={s.messages} onState={put} onError={fail} />
        </div>
        <div className="space-y-4">
          <TodayCard today={s.today} />
          <ProfileCard profile={s.profile} onState={put} onError={fail} />
          <HistoryCard history={s.history} />
        </div>
      </div>
    </div>
  );
}

// ---------- status ----------

function ModelStatus({ ai }: { ai: State['ai'] }) {
  const off = ai.provider === 'rules';
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">AI model</p>
          <p className="mt-1 text-sm font-semibold">{off ? 'Built-in rules' : ai.model ?? ai.provider}</p>
          <p className="mt-0.5 text-xs text-muted">
            {off
              ? 'No model configured. The assistant still works with its built-in rules.'
              : ai.local
                ? 'Open-source model on your own server. Your calendar and emails never leave it.'
                : 'External provider, only used if you allowed it in Settings.'}
          </p>
        </div>
        {off ? <Badge>Rules</Badge> : !ai.reachable ? <Badge tone="warn">Offline</Badge> : ai.inUse ? <Badge tone="ok">{ai.local ? 'Self-hosted' : 'In use'}</Badge> : <Badge>Not allowed</Badge>}
      </div>
    </Card>
  );
}

function GoogleStatus({ g, onConnect, onDemo, onDisconnect, busy }: { g: State['google']; onConnect: () => void; onDemo: () => void; onDisconnect: () => void; busy: boolean }) {
  const [tools, setTools] = useState<{ calendar: string[]; gmail: string[] } | null>(null);
  const showTools = async () => {
    if (tools) return setTools(null);
    setTools((await api.get<{ tools: { calendar: string[]; gmail: string[] } | null }>('/assistant/tools')).data.tools);
  };
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Google Calendar, Meet & Gmail</p>
          {g.connected ? (
            <>
              <p className="mt-1 truncate text-sm font-semibold">{g.mode === 'demo' ? 'Sample account' : g.email}</p>
              <p className="mt-0.5 text-xs text-muted">
                Through MCP servers ({g.transport === 'http' ? 'separate service' : 'in-process'}).{' '}
                {g.lastSyncAt ? `Checked ${new Date(g.lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Not checked yet.'}{' '}
                <button className="text-accent underline-offset-2 hover:underline" onClick={showTools}>{tools ? 'Hide tools' : 'Show tools'}</button>
              </p>
              {tools && (
                <p className="mt-1 font-mono text-[11px] text-muted">calendar: {tools.calendar.join(', ')} · gmail: {tools.gmail.join(', ')}</p>
              )}
            </>
          ) : g.status === 'NEEDS_RECONNECT' ? (
            <p className="mt-1 text-sm text-warn">Google access expired. Please reconnect.</p>
          ) : (
            <p className="mt-1 text-xs text-muted">Connect to read invites and meeting requests. Nothing is sent or accepted without your approval.</p>
          )}
        </div>
        {g.connected ? <Badge tone={g.mode === 'demo' ? 'accent' : 'ok'}>{g.mode === 'demo' ? 'Demo' : 'Connected'}</Badge> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {(!g.connected || g.mode === 'demo') && g.configured && <Button size="sm" onClick={onConnect} disabled={busy}>Connect Google</Button>}
        {!g.connected && g.demoAvailable && <Button size="sm" variant="secondary" onClick={onDemo} disabled={busy}>Try with a sample inbox</Button>}
        {g.connected && <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={busy}>Disconnect</Button>}
        {!g.configured && !g.connected && <span className="self-center text-[11px] text-muted">Google sign-in isn’t set up on this server.</span>}
      </div>
    </Card>
  );
}

// ---------- questions & approvals ----------

function QuestionsCard({ questions, onState, onError }: { questions: Question[]; onState: (s: State) => void; onError: (e: unknown) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const answer = async (q: Question, optionId: string) => {
    setPending(`${q.id}:${optionId}`);
    try {
      onState((await api.post<{ state: State }>(`/assistant/questions/${q.id}/answer`, { optionId })).data.state);
    } catch (e) {
      onError(e);
    } finally {
      setPending(null);
    }
  };
  const dismiss = async (q: Question) => {
    try {
      onState((await api.post<{ state: State }>(`/assistant/questions/${q.id}/dismiss`)).data.state);
    } catch (e) {
      onError(e);
    }
  };
  return (
    <Card title={<>Needs your answer {questions.length > 0 && <Badge tone="accent">{questions.length}</Badge>}</>}>
      {!questions.length ? (
        <Empty title="Nothing to decide right now">Check your calendar & inbox, or tell me about your routine below.</Empty>
      ) : (
        <ul className="space-y-3">
          {questions.map((q) => (
            <li key={q.id} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Badge tone={q.kind === 'PROFILE' ? 'neutral' : 'accent'}>{KIND_LABEL[q.kind]}</Badge>
                  <p className="mt-1.5 text-sm font-medium">{q.text}</p>
                  {q.detail && <p className="mt-0.5 text-xs text-muted">{q.detail}</p>}
                </div>
                <button className="text-xs text-muted hover:text-fg" onClick={() => dismiss(q)} aria-label="Skip this question">Skip</button>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {q.options.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => answer(q, o.id)}
                    disabled={!!pending}
                    title={o.hint}
                    className={clsx(
                      'rounded-lg border px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50',
                      o.recommended ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:bg-surface-2',
                    )}
                  >
                    <span className="font-medium">{pending === `${q.id}:${o.id}` ? 'Working…' : o.label}</span>
                    {o.hint && <span className="block text-[11px] opacity-75">{o.recommended ? '★ ' : ''}{o.hint}</span>}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ActionsCard({ actions, onState, onError }: { actions: Action[]; onState: (s: State) => void; onError: (e: unknown) => void }) {
  if (!actions.length) return null;
  return (
    <Card title={<>Ready to send — needs your approval <Badge tone="warn">{actions.length}</Badge></>}>
      <p className="-mt-1 mb-3 text-xs text-muted">Nothing goes to Google until you approve it. You can edit emails first.</p>
      <ul className="space-y-3">
        {actions.map((a) => <ActionItem key={a.id} a={a} onState={onState} onError={onError} />)}
      </ul>
    </Card>
  );
}

function ActionItem({ a, onState, onError }: { a: Action; onState: (s: State) => void; onError: (e: unknown) => void }) {
  const [body, setBody] = useState(a.email?.body ?? '');
  const [working, setWorking] = useState<'approve' | 'reject' | null>(null);
  const run = async (kind: 'approve' | 'reject') => {
    setWorking(kind);
    try {
      const payload = kind === 'approve' && a.email && body !== a.email.body ? { body } : {};
      onState((await api.post<{ state: State }>(`/assistant/actions/${a.id}/${kind}`, payload)).data.state);
    } catch (e) {
      onError(e);
    } finally {
      setWorking(null);
    }
  };
  const icon = a.kind === 'RSVP' ? '📅' : a.kind === 'SCHEDULE_MEETING' ? '🎥' : '✉️';
  return (
    <li className="rounded-lg border border-border p-3">
      <p className="text-sm font-medium">{icon} {a.summary}</p>
      {a.error && <p className="mt-1 text-xs text-danger">Last try failed: {a.error}</p>}
      {a.email && (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-muted">To <span className="text-fg">{a.email.to}</span> · {a.email.subject} {a.email.draftedBy === 'ai' && <Badge>drafted by AI</Badge>}</p>
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email text" />
          {a.kind === 'SCHEDULE_MEETING' && <p className="text-[11px] text-muted">The Google Meet link is added automatically.</p>}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => run('approve')} loading={working === 'approve'} disabled={!!working || a.status === 'RUNNING' || (!!a.email && !body.trim())}>
          {a.kind === 'RSVP' ? 'Approve' : 'Approve & send'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => run('reject')} disabled={!!working || a.status === 'RUNNING'}>Don’t send</Button>
      </div>
    </li>
  );
}

// ---------- chat ----------

function ChatCard({ messages, onState, onError }: { messages: State['messages']; onState: (s: State) => void; onError: (e: unknown) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, optimistic]);
  const send = async (e?: FormEvent, preset?: string) => {
    e?.preventDefault();
    const message = (preset ?? text).trim();
    if (!message || sending) return;
    setSending(true);
    setOptimistic(message);
    setText('');
    try {
      const r = (await api.post<{ state: State; note: string | null }>('/assistant/chat', { message })).data;
      onState(r.state);
    } catch (err) {
      onError(err);
      setText(message);
    } finally {
      setSending(false);
      setOptimistic(null);
    }
  };
  const suggestions = ['Plan my day', 'What’s on tomorrow?', 'Check my inbox', 'I wake up at 7 and work 10 to 6', 'No meetings before 11', 'Add gym 1h'];
  return (
    <Card title="Chat">
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1" aria-live="polite">
        {!messages.length && !optimistic && <p className="text-sm text-muted">Tell me about your routine, or ask me to plan your day.</p>}
        {messages.map((m) => <Bubble key={m.id} role={m.role} text={m.text} />)}
        {optimistic && <Bubble role="user" text={optimistic} />}
        {sending && <Bubble role="assistant" text="…" />}
        <div ref={end} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button key={s} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg" onClick={() => send(undefined, s)} disabled={sending}>{s}</button>
        ))}
      </div>
      <form onSubmit={send} className="mt-2 flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message your assistant…" maxLength={2000} aria-label="Message" />
        <Button type="submit" loading={sending} disabled={!text.trim()}>Send</Button>
      </form>
    </Card>
  );
}

function Bubble({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  return (
    <div className={clsx('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div className={clsx('max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm', role === 'user' ? 'bg-accent text-accent-fg' : 'bg-surface-2')}>{text}</div>
    </div>
  );
}

// ---------- side column ----------

function TodayCard({ today }: { today: State['today'] }) {
  const items = today.plan?.items ?? [];
  const now = new Date();
  return (
    <Card title="Today" action={today.tasks ? <Badge>{today.done}/{today.tasks} done</Badge> : undefined}>
      {items.length ? (
        <div className="max-h-[28rem] overflow-y-auto">
          <Timeline entries={items.map((item) => ({ item }))} nowMin={now.getHours() * 60 + now.getMinutes()} />
        </div>
      ) : (
        <Empty title="No plan yet">Press “Plan my day” and I’ll fit your tasks around your meetings.</Empty>
      )}
    </Card>
  );
}

const CHRONO: Record<string, string> = { EARLY_BIRD: 'Mornings', DAYTIME: 'Afternoons', NIGHT_OWL: 'Evenings' };

function ProfileCard({ profile, onState, onError }: { profile: State['profile']; onState: (s: State) => void; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const learned = profile.learned;
  const forget = async () => {
    if (!window.confirm('Forget everything the assistant learned and was told about you?')) return;
    try {
      onState((await api.delete<{ state: State }>('/assistant/memory')).data.state);
    } catch (e) {
      onError(e);
    }
  };
  return (
    <Card title="What I know about you" action={<Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
      {profile.summary.length ? (
        <ul className="space-y-1 text-sm">{profile.summary.map((l) => <li key={l}>• {l}</li>)}</ul>
      ) : (
        <p className="text-sm text-muted">Nothing yet. Answer a few questions or tell me in chat.</p>
      )}
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Learned from what you do</p>
        {learned?.insights.length ? (
          <ul className="mt-1.5 space-y-1.5 text-sm">{learned.insights.map((i) => <li key={i}>💡 {i}</li>)}</ul>
        ) : (
          <p className="mt-1 text-xs text-muted">I learn your real peak hours, how long tasks really take and which meeting times you prefer once there’s enough history ({profile.decisions} meeting decision{profile.decisions === 1 ? '' : 's'} so far).</p>
        )}
      </div>
      <button className="mt-3 text-[11px] text-muted hover:text-danger" onClick={forget}>Forget what you know</button>
      {editing && <ProfileEditor profile={profile} onClose={() => setEditing(false)} onState={onState} onError={onError} />}
    </Card>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ProfileEditor({ profile, onClose, onState, onError }: { profile: State['profile']; onClose: () => void; onState: (s: State) => void; onError: (e: unknown) => void }) {
  const r = profile.routine;
  const m = profile.meetings;
  const [f, setF] = useState({
    wakeTime: r.wakeTime ?? '07:00',
    sleepTime: r.sleepTime ?? '23:00',
    workStart: r.workStart ?? '09:00',
    workEnd: r.workEnd ?? '18:00',
    workDays: r.workDays,
    chronotype: r.chronotype ?? 'DAYTIME',
    focusMinutes: r.focusMinutes ?? 60,
    meetingsEarliest: m.earliest ?? r.workStart ?? '09:00',
    meetingsLatest: m.latest ?? r.workEnd ?? '18:00',
    meetingBufferMinutes: m.bufferMinutes,
    maxMeetingsPerDay: m.maxPerDay,
    protectFocusTime: m.protectFocusTime,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      onState((await api.patch<{ state: State }>('/assistant/profile', f)).data.state);
      onClose();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Your routine & meeting preferences" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Wake up"><Input type="time" value={f.wakeTime} onChange={(e) => set('wakeTime', e.target.value)} /></Field>
        <Field label="Go to sleep"><Input type="time" value={f.sleepTime} onChange={(e) => set('sleepTime', e.target.value)} /></Field>
        <Field label="Work starts"><Input type="time" value={f.workStart} onChange={(e) => set('workStart', e.target.value)} /></Field>
        <Field label="Work ends"><Input type="time" value={f.workEnd} onChange={(e) => set('workEnd', e.target.value)} /></Field>
        <div className="col-span-2">
          <Field label="Work days">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <button key={d} type="button" onClick={() => set('workDays', f.workDays.includes(i) ? f.workDays.filter((x) => x !== i) : [...f.workDays, i])}
                  className={clsx('rounded-md border px-2 py-1 text-xs', f.workDays.includes(i) ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted')}>{d}</button>
              ))}
            </div>
          </Field>
        </div>
        <Field label="Best focus">
          <Select value={f.chronotype} onChange={(e) => set('chronotype', e.target.value)}>
            {Object.entries(CHRONO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Focus session (min)"><Input type="number" min={20} max={180} value={f.focusMinutes} onChange={(e) => set('focusMinutes', Number(e.target.value))} /></Field>
        <Field label="Meetings from"><Input type="time" value={f.meetingsEarliest} onChange={(e) => set('meetingsEarliest', e.target.value)} /></Field>
        <Field label="Meetings until"><Input type="time" value={f.meetingsLatest} onChange={(e) => set('meetingsLatest', e.target.value)} /></Field>
        <Field label="Gap between meetings (min)"><Input type="number" min={0} max={60} value={f.meetingBufferMinutes} onChange={(e) => set('meetingBufferMinutes', Number(e.target.value))} /></Field>
        <Field label="Max meetings a day"><Input type="number" min={1} max={15} placeholder="No limit" value={f.maxMeetingsPerDay ?? ''} onChange={(e) => set('maxMeetingsPerDay', e.target.value ? Number(e.target.value) : null)} /></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.protectFocusTime} onChange={(e) => set('protectFocusTime', e.target.checked)} />
          Keep meetings out of my best focus hours when possible
        </label>
      </div>
    </Modal>
  );
}

function HistoryCard({ history }: { history: Action[] }) {
  if (!history.length) return null;
  return (
    <Card title="Recently">
      <ul className="space-y-2 text-sm">
        {history.map((a) => (
          <li key={a.id} className="flex items-start gap-2">
            <span>{a.status === 'DONE' ? '✅' : '⏭️'}</span>
            <span className={clsx(a.status === 'REJECTED' && 'text-muted line-through')}>
              {a.summary}
              {a.result?.meetUrl && <> · <a className="text-accent hover:underline" href={a.result.meetUrl} target="_blank" rel="noreferrer">Meet link</a></>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
