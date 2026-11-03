import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, PriorityBadge, Select, StatusBadge, Textarea } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fromLocalInput, relativeDays } from '../lib/format';
import type { DraftTask, Priority, Task, Timeline as TimelineData } from '../types';
import { Timeline, TimelineLegend, type Zoom } from '../features/projects/Timeline';
import { useTaskPanel } from '../features/tasks/TaskPanel';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const { openTask } = useTaskPanel();
  const [zoom, setZoom] = useState<Zoom>('week');
  const [tab, setTab] = useState<'timeline' | 'tasks'>('timeline');
  const [addOpen, setAddOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [msOpen, setMsOpen] = useState(false);
  const timeline = useQuery({ queryKey: ['timeline', id], queryFn: async () => (await api.get<TimelineData>(`/projects/${id}/timeline`)).data });
  const [zoomTouched, setZoomTouched] = useState(false);
  // Default zoom follows the plan's span until the user picks one.
  useEffect(() => {
    if (zoomTouched || !timeline.data?.tasks.length) return;
    const times = timeline.data.tasks.flatMap((t) => [Date.parse(t.startAt), Date.parse(t.endAt)]);
    const days = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    setZoom(days <= 14 ? 'day' : days <= 90 ? 'week' : 'month');
  }, [timeline.data, zoomTouched]);

  if (timeline.isLoading) return <Loading />;
  if (timeline.error || !timeline.data) return <ErrorBox message={apiError(timeline.error).message} />;
  const { project, tasks } = timeline.data;
  const remaining = tasks.filter((t) => t.status !== 'DONE').reduce((s, t) => s + Math.max(0, t.estimatedMinutes - t.actualMinutes), 0);

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/app/projects" className="text-muted hover:text-fg">← Projects</Link></div>
      <PageHeader
        title={project.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {tasks.length} tasks · {fmtMinutes(remaining)} remaining
            {project.targetDate && <>· target {fmtDate(project.targetDate, tz)}</>}
            {timeline.data.projectedFinish && <>· projected finish {fmtDate(timeline.data.projectedFinish, tz)}</>}
            {project.targetDate && (timeline.data.targetAtRisk ? <Badge tone="danger">target at risk</Badge> : <Badge tone="ok">on track</Badge>)}
          </span>
        }
        actions={<>
          <Button variant="secondary" onClick={() => setMsOpen(true)}>Milestone</Button>
          <Button variant="secondary" onClick={() => setAiOpen(true)}>✨ Add from text</Button>
          <Button onClick={() => setAddOpen(true)}>Add task</Button>
        </>}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg border border-border bg-surface p-0.5 text-sm" role="tablist">
          {(['timeline', 'tasks'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 capitalize ${tab === t ? 'bg-accent-soft font-medium text-accent' : 'text-muted'}`}>{t}</button>)}
        </div>
        {tab === 'timeline' && (
          <div className="flex rounded-lg border border-border bg-surface p-0.5 text-sm" aria-label="Zoom">
            {(['day', 'week', 'month'] as const).map((z) => <button key={z} onClick={() => { setZoom(z); setZoomTouched(true); }} className={`rounded-md px-3 py-1 capitalize ${zoom === z ? 'bg-accent-soft font-medium text-accent' : 'text-muted'}`}>{z}</button>)}
          </div>
        )}
      </div>
      {!tasks.length ? <Empty title="No tasks yet">Add tasks manually or paste a description and let AI draft them.</Empty> : tab === 'timeline' ? (
        <div className="space-y-3">
          <Timeline data={timeline.data} tz={tz} zoom={zoom} onTaskClick={openTask} />
          <TimelineLegend />
        </div>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted"><tr>{['Task', 'Status', 'Priority', 'Estimate', 'Due', 'Depends on', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} onClick={() => openTask(t.id)} className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2 font-medium">{t.title}</td>
                  <td className="px-4 py-2"><StatusBadge s={t.status} /></td>
                  <td className="px-4 py-2"><PriorityBadge p={t.priority} /></td>
                  <td className="px-4 py-2 tabular-nums">{fmtMinutes(t.estimatedMinutes)}</td>
                  <td className="px-4 py-2">{t.dueAt ? <span title={fmtDateTime(t.dueAt, tz)}>{fmtDate(t.dueAt, tz)} <span className="text-xs text-muted">{relativeDays(t.dueAt)}</span></span> : '—'}</td>
                  <td className="px-4 py-2 text-xs text-muted">{(t.dependsOn ?? []).map((d) => tasks.find((x) => x.id === d)?.title).filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-4 py-2">{t.critical && <Badge tone="danger">critical</Badge>} {t.flags.blocked && <Badge tone="warn">blocked</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <AddTaskModal open={addOpen} onClose={() => setAddOpen(false)} projectId={project.id} tasks={tasks} tz={tz} />
      <AiExtractModal open={aiOpen} onClose={() => setAiOpen(false)} projectId={project.id} />
      <MilestoneModal open={msOpen} onClose={() => setMsOpen(false)} projectId={project.id} tz={tz} />
    </>
  );
}

function AddTaskModal({ open, onClose, projectId, tasks, tz }: { open: boolean; onClose: () => void; projectId: string; tasks: Task[]; tz: string }) {
  const qc = useQueryClient();
  const empty = { title: '', estimatedMinutes: 60, priority: 'MEDIUM' as Priority, dueAt: '', dependsOn: [] as string[], splittable: true };
  const [form, setForm] = useState(empty);
  const create = useMutation({
    mutationFn: () => api.post('/tasks', { projectId, title: form.title, estimatedMinutes: form.estimatedMinutes, priority: form.priority, dueAt: fromLocalInput(form.dueAt, tz), dependsOn: form.dependsOn, splittable: form.splittable }),
    onSuccess: () => { for (const k of ['timeline', 'projects', 'tasks', 'briefing']) qc.invalidateQueries({ queryKey: [k] }); setForm(empty); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Add task" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!form.title.trim()}>Add task</Button></>}>
      <div className="space-y-3">
        {create.error && <ErrorBox message={apiError(create.error).message} />}
        <Field label="Title"><Input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Build backend APIs" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimate (minutes)"><Input type="number" min={0} step={15} value={form.estimatedMinutes} onChange={(e) => setForm({ ...form, estimatedMinutes: Number(e.target.value) })} /></Field>
          <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}</Select></Field>
        </div>
        <Field label="Due (optional)"><Input type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></Field>
        {tasks.length > 0 && (
          <Field label="Depends on (finish-to-start)" hint="This task won't be scheduled until these finish.">
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {tasks.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.dependsOn.includes(t.id)} onChange={(e) => setForm({ ...form, dependsOn: e.target.checked ? [...form.dependsOn, t.id] : form.dependsOn.filter((x) => x !== t.id) })} />
                  {t.title}
                </label>
              ))}
            </div>
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.splittable} onChange={(e) => setForm({ ...form, splittable: e.target.checked })} /> Can be split across several blocks</label>
      </div>
    </Modal>
  );
}

function MilestoneModal({ open, onClose, projectId, tz }: { open: boolean; onClose: () => void; projectId: string; tz: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [due, setDue] = useState('');
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/milestones`, { name, dueAt: fromLocalInput(due, tz) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['timeline'] }); setName(''); setDue(''); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Add milestone" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={!name || !due} loading={create.isPending}>Add</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Date"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

interface ExtractResult {
  drafts: DraftTask[];
  dependencies: { taskTempId: string; dependsOnTempId: string }[];
  rejected: { index: number; title: string | null; reasons: string[] }[];
  warnings: string[];
  provider: string;
  externalAiUsed: boolean;
  consentGiven: boolean;
}

/** AI drafts tasks from text; the user edits and confirms. Nothing is saved before "Create tasks". */
function AiExtractModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [drafts, setDrafts] = useState<(DraftTask & { include: boolean; dueLocal: string })[]>([]);
  const [error, setError] = useState<{ message: string; manual?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setText(''); setResult(null); setDrafts([]); setError(null); };
  const close = () => { reset(); onClose(); };

  async function extract() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ExtractResult>('/ai/extract-tasks', { text });
      setResult(r.data);
      setDrafts(r.data.drafts.map((d) => ({ ...d, include: true, dueLocal: d.dueAt ? new Date(d.dueAt).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16).replace(' ', 'T') : '' })));
    } catch (e) {
      const err = apiError(e);
      setError({ message: err.message, manual: (err.details as { fallback?: string } | undefined)?.fallback === 'manual' });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const included = drafts.filter((d) => d.include);
      const ids = new Set(included.map((d) => d.tempId));
      await api.post('/ai/confirm-tasks', {
        projectId,
        tasks: included.map((d) => ({ tempId: d.tempId, title: d.title, estimatedMinutes: d.estimatedMinutes, priority: d.priority, dueAt: fromLocalInput(d.dueLocal, tz) })),
        dependencies: (result?.dependencies ?? []).filter((x) => ids.has(x.taskTempId) && ids.has(x.dependsOnTempId)),
      });
      for (const k of ['timeline', 'projects', 'tasks', 'briefing']) qc.invalidateQueries({ queryKey: [k] });
      close();
    } catch (e) {
      setError({ message: apiError(e).message });
    } finally {
      setBusy(false);
    }
  }

  const missingEstimate = drafts.some((d) => d.include && !d.estimatedMinutes);
  const title = (id: string) => drafts.find((d) => d.tempId === id)?.title ?? id;

  return (
    <Modal open={open} onClose={close} title="Add tasks from text" wide
      footer={!result
        ? <><Button variant="ghost" onClick={close}>Cancel</Button><Button onClick={extract} loading={busy} disabled={text.trim().length < 3}>Draft tasks</Button></>
        : <><Button variant="ghost" onClick={reset}>Start over</Button><Button onClick={confirm} loading={busy} disabled={!drafts.some((d) => d.include) || missingEstimate}>Create {drafts.filter((d) => d.include).length} task(s)</Button></>}>
      <div className="space-y-3">
        {error && <ErrorBox message={error.message} />}
        {error?.manual && <p className="text-sm text-muted">You can still add tasks with the <b>Add task</b> button.</p>}
        {!result ? (
          <>
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Prepare the project demo by Friday. Finish API tests first, then create slides. I need around two hours for slides." />
            <p className="text-xs text-muted">
              {user?.aiExternalConsent
                ? 'You allowed external AI processing in Settings; the text may be sent to the configured AI provider.'
                : 'Processed by the built-in parser. Your text is not sent to an external AI provider unless you allow it in Settings.'}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">Review the drafts. Nothing is saved until you click Create. {result.externalAiUsed ? 'Drafted by the AI provider.' : 'Drafted by the built-in parser.'}</p>
            {result.warnings.map((w, i) => <div key={i} className="rounded-md bg-warn-soft px-3 py-1.5 text-xs text-warn">{w}</div>)}
            {result.rejected.map((r) => <div key={r.index} className="rounded-md bg-danger-soft px-3 py-1.5 text-xs text-danger">Rejected suggestion {r.title ? `"${r.title}"` : `#${r.index + 1}`}: {r.reasons.join('; ')}</div>)}
            <div className="space-y-2">
              {drafts.map((d, i) => (
                <div key={d.tempId} className={`grid grid-cols-12 items-center gap-2 rounded-lg border border-border p-2 ${d.include ? '' : 'opacity-50'}`}>
                  <input type="checkbox" aria-label="Include" className="col-span-1 justify-self-center" checked={d.include} onChange={(e) => setDrafts(drafts.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                  <Input className="col-span-11 sm:col-span-5" aria-label="Title" value={d.title} onChange={(e) => setDrafts(drafts.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
                  <Input className={`col-span-4 sm:col-span-2 ${!d.estimatedMinutes && d.include ? 'border-warn' : ''}`} type="number" min={1} aria-label="Estimate minutes" placeholder="min?" value={d.estimatedMinutes ?? ''} onChange={(e) => setDrafts(drafts.map((x, j) => j === i ? { ...x, estimatedMinutes: e.target.value ? Number(e.target.value) : null } : x))} />
                  <Input className="col-span-8 sm:col-span-4" type="datetime-local" aria-label="Due" value={d.dueLocal} onChange={(e) => setDrafts(drafts.map((x, j) => j === i ? { ...x, dueLocal: e.target.value } : x))} />
                </div>
              ))}
            </div>
            {missingEstimate && <p className="text-xs text-warn">Confirm an estimate (in minutes) for each task so it can be scheduled.</p>}
            {result.dependencies.length > 0 && (
              <div className="text-sm"><span className="font-medium">Dependencies:</span> {result.dependencies.map((d) => `"${title(d.dependsOnTempId)}" before "${title(d.taskTempId)}"`).join('; ')}</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
