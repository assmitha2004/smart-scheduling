import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../services/api';
import { useAuth } from '../../services/auth';
import { useCelebrate } from '../../components/Celebrate';
import { useToast } from '../../components/Toast';
import { Badge, Button, ErrorBox, Field, Input, Loading, Modal, PriorityBadge, Select, StatusBadge, Textarea } from '../../components/ui';
import { fmtDateTime, fmtMinutes, fromLocalInput, toLocalInput } from '../../lib/format';
import type { Priority, ReplanPreview, Task, TaskStatus } from '../../types';
import { SchedulePreviewView } from '../scheduling/SchedulePreview';

interface TaskDetail {
  task: Task;
  project: { id: string; name: string; color: string };
  dependencies: { id: string; task: { id: string; title: string; status: TaskStatus; dueAt: string | null } }[];
  dependents: { id: string; task: { id: string; title: string; status: TaskStatus } }[];
  blocks: { id: string; startAt: string; endAt: string; status: string }[];
  comments: { id: string; body: string; createdAt: string; author: { name: string } }[];
  activity: { id: string; action: string; createdAt: string; actor: { name: string }; metadata: unknown }[];
}

const Ctx = createContext<{ openTask(id: string): void }>({ openTask: () => undefined });
export const useTaskPanel = () => useContext(Ctx);

export function TaskPanelProvider({ children }: { children: ReactNode }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const openTask = useCallback((id: string) => setTaskId(id), []);
  return (
    <Ctx.Provider value={{ openTask }}>
      {children}
      {taskId && <TaskPanel taskId={taskId} onClose={() => setTaskId(null)} />}
    </Ctx.Provider>
  );
}

const ACTIONS: Record<string, string> = {
  'task.created': 'created the task', 'task.updated': 'updated the task', 'task.completed': 'completed the task',
  'dependency.added': 'added a dependency', 'dependency.removed': 'removed a dependency', 'comment.added': 'commented', 'time.logged': 'logged time',
};

function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const { celebrate } = useCelebrate();
  const [error, setError] = useState<string | null>(null);
  const [replanSuggested, setReplanSuggested] = useState(false);
  const [delayOpen, setDelayOpen] = useState(false);

  const detail = useQuery({ queryKey: ['task', taskId], queryFn: async () => (await api.get<TaskDetail>(`/tasks/${taskId}`)).data });
  const projectTasks = useQuery({
    queryKey: ['tasks', 'project', detail.data?.project.id],
    enabled: !!detail.data,
    queryFn: async () => (await api.get<{ tasks: Task[] }>(`/projects/${detail.data!.project.id}/tasks`)).data.tasks,
  });
  const suggestions = useQuery({
    queryKey: ['task', taskId, 'suggestions'],
    enabled: !!detail.data && !['DONE', 'CANCELLED'].includes(detail.data.task.status),
    queryFn: async () => (await api.get<{ blocks: { startAt: string; endAt: string }[]; reason?: string; unscheduled?: { reason: string } | null; explanation?: { reasons: string[] } | null }>(`/tasks/${taskId}/suggestions`)).data,
  });

  const [form, setForm] = useState<Partial<Task>>({});
  useEffect(() => { if (detail.data) setForm(detail.data.task); }, [detail.data]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !delayOpen && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, delayOpen]);

  const refresh = () => {
    for (const k of ['task', 'tasks', 'timeline', 'projects', 'briefing', 'calendar', 'risk']) qc.invalidateQueries({ queryKey: [k] });
  };

  const save = useMutation({
    mutationFn: async (patch: Partial<Task>) => (await api.patch(`/tasks/${taskId}`, { ...patch, version: detail.data!.task.version })).data,
    onSuccess: (d, patch) => {
      setError(null);
      if (d.replanSuggested) setReplanSuggested(true);
      if (patch.status === 'DONE' && detail.data?.task.status !== 'DONE') celebrate({ title: detail.data?.task.title });
      refresh();
    },
    onError: (e) => { const err = apiError(e); setError(err.message); if (err.code === 'STALE_TASK') refresh(); },
  });
  const addDep = useMutation({
    mutationFn: (dependsOnTaskId: string) => api.post(`/tasks/${taskId}/dependencies`, { dependsOnTaskId }),
    onSuccess: () => { setError(null); setReplanSuggested(true); refresh(); },
    onError: (e) => setError(apiError(e).message),
  });
  const removeDep = useMutation({
    mutationFn: (depTaskId: string) => api.delete(`/tasks/${taskId}/dependencies/${depTaskId}`),
    onSuccess: refresh,
  });
  const [comment, setComment] = useState('');
  const addComment = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/comments`, { body: comment }),
    onSuccess: () => { setComment(''); refresh(); },
  });
  const [logMinutes, setLogMinutes] = useState(30);
  const logTime = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/log-time`, { minutes: logMinutes }),
    onSuccess: () => { toast.show(`Logged ${fmtMinutes(logMinutes)}`, 'success'); refresh(); },
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/tasks/${taskId}`),
    onSuccess: () => { refresh(); onClose(); },
  });

  const d = detail.data;
  const t = d?.task;
  const dirty = t && (['title', 'description', 'estimatedMinutes', 'priority', 'dueAt', 'earliestStartAt', 'splittable'] as const).some((k) => form[k] !== t[k]);
  const candidates = (projectTasks.data ?? []).filter((x) => x.id !== taskId && !d?.dependencies.some((dep) => dep.task.id === x.id));

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={onClose}>
      <aside role="dialog" aria-label="Task details" className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-muted">
            {d && <><span className="h-2.5 w-2.5 rounded-full" style={{ background: d.project.color }} />{d.project.name}</>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close">✕</button>
        </header>
        {!d || !t ? <Loading /> : (
          <div className="space-y-6 px-5 py-4">
            <div>
              <Input aria-label="Title" className="border-transparent px-0 text-lg font-semibold focus:border-border focus:px-2" value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge s={t.status} /><PriorityBadge p={t.priority} />
                {t.dueAt && <Badge>due {fmtDateTime(t.dueAt, tz)}</Badge>}
                {d.dependencies.some((x) => x.task.status !== 'DONE' && x.task.status !== 'CANCELLED') && <Badge tone="warn">blocked</Badge>}
              </div>
            </div>
            {error && <ErrorBox message={error} />}
            {replanSuggested && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent-soft px-3 py-2 text-sm">
                <span>This change may affect your committed schedule.</span>
                <Button size="sm" onClick={() => setDelayOpen(true)}>Preview replan</Button>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {t.status !== 'DONE' ? (
                <>
                  {t.status === 'TODO' && <Button variant="secondary" size="sm" onClick={() => save.mutate({ status: 'IN_PROGRESS' })}>Start</Button>}
                  <Button size="sm" onClick={() => save.mutate({ status: 'DONE' })}>Mark complete</Button>
                  <Button variant="secondary" size="sm" onClick={() => setDelayOpen(true)}>Report a delay…</Button>
                </>
              ) : <Button variant="secondary" size="sm" onClick={() => save.mutate({ status: 'TODO' })}>Reopen</Button>}
            </div>

            <section className="grid grid-cols-2 gap-3">
              <Field label="Estimate (minutes)"><Input type="number" min={0} value={form.estimatedMinutes ?? 0} onChange={(e) => setForm({ ...form, estimatedMinutes: Number(e.target.value) })} /></Field>
              <Field label="Priority">
                <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>
                  {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
                </Select>
              </Field>
              <Field label="Due"><Input type="datetime-local" value={toLocalInput(form.dueAt, tz)} onChange={(e) => setForm({ ...form, dueAt: fromLocalInput(e.target.value, tz) })} /></Field>
              <Field label="Earliest start"><Input type="datetime-local" value={toLocalInput(form.earliestStartAt, tz)} onChange={(e) => setForm({ ...form, earliestStartAt: fromLocalInput(e.target.value, tz) })} /></Field>
              <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.splittable ?? true} onChange={(e) => setForm({ ...form, splittable: e.target.checked })} /> Can be split across several work blocks</label>
              <div className="col-span-2"><Field label="Description"><Textarea rows={3} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value || null })} /></Field></div>
              {dirty && (
                <div className="col-span-2 flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setForm(t)}>Cancel</Button>
                  <Button size="sm" loading={save.isPending} onClick={() => {
                    const patch: Partial<Task> = {};
                    for (const k of ['title', 'description', 'estimatedMinutes', 'priority', 'dueAt', 'earliestStartAt', 'splittable'] as const) if (form[k] !== t[k]) (patch as Record<string, unknown>)[k] = form[k];
                    save.mutate(patch);
                  }}>Save changes</Button>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Progress</h3>
              <div className="mb-2 h-2 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent" style={{ width: `${t.status === 'DONE' ? 100 : Math.min(100, (t.actualMinutes / Math.max(1, t.estimatedMinutes)) * 100)}%` }} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                {fmtMinutes(t.actualMinutes)} logged of {fmtMinutes(t.estimatedMinutes)}
                {t.status !== 'DONE' && (
                  <span className="ml-auto flex items-center gap-1">
                    <Input type="number" min={1} className="w-20 py-1" aria-label="Minutes to log" value={logMinutes} onChange={(e) => setLogMinutes(Number(e.target.value))} />
                    <Button variant="secondary" size="sm" onClick={() => logTime.mutate()}>Log time</Button>
                  </span>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Depends on <span className="font-normal text-muted">(must finish first)</span></h3>
              <ul className="space-y-1">
                {d.dependencies.map((x) => (
                  <li key={x.id} className="flex items-center gap-2 text-sm">
                    <StatusBadge s={x.task.status} /><span className="flex-1">{x.task.title}</span>
                    <button className="text-xs text-muted hover:text-danger" onClick={() => removeDep.mutate(x.task.id)}>Remove</button>
                  </li>
                ))}
                {!d.dependencies.length && <li className="text-sm text-muted">No prerequisites.</li>}
              </ul>
              {candidates.length > 0 && (
                <Select className="mt-2" value="" aria-label="Add prerequisite" onChange={(e) => e.target.value && addDep.mutate(e.target.value)}>
                  <option value="">+ Add a prerequisite…</option>
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </Select>
              )}
              {d.dependents.length > 0 && (
                <p className="mt-2 text-xs text-muted">Blocks: {d.dependents.map((x) => x.task.title).join(', ')}</p>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Time blocks</h3>
              {d.blocks.length > 0 ? (
                <ul className="space-y-1 text-sm">{d.blocks.map((b) => <li key={b.id} className="flex gap-2"><Badge tone={b.status === 'COMPLETED' ? 'ok' : 'accent'}>{b.status.toLowerCase()}</Badge>{fmtDateTime(b.startAt, tz)} – {fmtDateTime(b.endAt, tz).split(', ').pop()}</li>)}</ul>
              ) : <p className="text-sm text-muted">Not on your calendar yet.</p>}
              {suggestions.data && !d.blocks.some((b) => b.status === 'CONFIRMED') && (
                <div className="mt-2 rounded-lg bg-surface-2 p-3 text-sm">
                  <div className="mb-1 font-medium">Suggested</div>
                  {suggestions.data.blocks.length
                    ? <ul className="space-y-0.5 text-muted">{suggestions.data.blocks.map((b, i) => <li key={i}>{fmtDateTime(b.startAt, tz)} – {fmtDateTime(b.endAt, tz).split(', ').pop()}</li>)}</ul>
                    : <p className="text-muted">{suggestions.data.unscheduled?.reason ?? suggestions.data.reason ?? 'No slot available.'}</p>}
                  {suggestions.data.explanation && <p className="mt-1 text-xs text-muted">Why: {suggestions.data.explanation.reasons.join('; ')}</p>}
                  <p className="mt-1 text-xs text-muted">Use Smart planning to put it on your calendar.</p>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Comments</h3>
              <ul className="mb-2 space-y-2">
                {d.comments.map((c) => (
                  <li key={c.id} className="rounded-lg bg-surface-2 px-3 py-2 text-sm"><div className="text-xs text-muted">{c.author.name} · {fmtDateTime(c.createdAt, tz)}</div>{c.body}</li>
                ))}
              </ul>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) addComment.mutate(); }}>
                <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" aria-label="Comment" />
                <Button type="submit" variant="secondary" disabled={!comment.trim()}>Post</Button>
              </form>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Activity</h3>
              <ul className="space-y-1 text-xs text-muted">
                {d.activity.map((a) => <li key={a.id}>{fmtDateTime(a.createdAt, tz)} — {a.actor.name} {ACTIONS[a.action] ?? a.action}</li>)}
              </ul>
            </section>

            <div className="border-t border-border pt-4">
              <Button variant="ghost" size="sm" className="text-danger" onClick={() => { if (confirm('Delete this task? This cannot be undone.')) del.mutate(); }}>Delete task</Button>
            </div>
          </div>
        )}
      </aside>
      {delayOpen && t && <div onMouseDown={(e) => e.stopPropagation()}><DelayDialog task={t} onClose={() => { setDelayOpen(false); setReplanSuggested(false); refresh(); }} /></div>}
    </div>
  );
}

/** Scenario C: a task slips → preview downstream impact before committing. */
function DelayDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const tomorrow = toLocalInput(new Date(Date.now() + 86_400_000).toISOString(), tz).slice(0, 11) + '09:00';
  const [delayUntil, setDelayUntil] = useState(tomorrow);
  const [estimate, setEstimate] = useState<number>(task.estimatedMinutes);
  const [preview, setPreview] = useState<ReplanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const change: Record<string, unknown> = { taskId: task.id };
      if (delayUntil) change.delayUntil = fromLocalInput(delayUntil, tz);
      if (estimate !== task.estimatedMinutes) change.estimatedMinutes = estimate;
      const r = await api.post<ReplanPreview>('/schedules/replan', change.delayUntil || change.estimatedMinutes != null ? { changes: [change] } : { taskIds: [task.id] });
      setPreview(r.data);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Replan "${task.title}"`} wide>
      {!preview ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Tell us what changed. We'll recalculate this task and everything downstream of it, keep unaffected blocks in place, and show you a before/after preview first.</p>
          {error && <ErrorBox message={error} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Can't start before" hint="Leave empty if only the estimate changed"><Input type="datetime-local" value={delayUntil} onChange={(e) => setDelayUntil(e.target.value)} /></Field>
            <Field label="New estimate (minutes)"><Input type="number" min={0} value={estimate} onChange={(e) => setEstimate(Number(e.target.value))} /></Field>
          </div>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={run} loading={busy}>Preview impact</Button></div>
        </div>
      ) : (
        <SchedulePreviewView preview={preview} onDone={onClose} onRegenerate={() => { setPreview(null); void run(); }} />
      )}
    </Modal>
  );
}
