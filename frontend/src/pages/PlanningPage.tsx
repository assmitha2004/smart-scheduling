import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select } from '../components/ui';
import { fmtDateTime, fromLocalInput, toLocalInput } from '../lib/format';
import type { ReplanPreview, SchedulePreview, Task } from '../types';
import { SchedulePreviewView } from '../features/scheduling/SchedulePreview';

export default function PlanningPage() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const [preview, setPreview] = useState<SchedulePreview | ReplanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState('');
  const [delay, setDelay] = useState(toLocalInput(new Date(Date.now() + 86_400_000).toISOString(), tz).slice(0, 11) + '09:00');
  const tasks = useQuery({ queryKey: ['tasks', 'mine'], queryFn: async () => (await api.get<{ tasks: Task[] }>('/tasks', { params: { assignee: 'me', status: 'TODO,IN_PROGRESS' } })).data.tasks });
  const recs = useQuery({ queryKey: ['recommendations'], queryFn: async () => (await api.get<{ recommendations: { id: string; recommendationType: string; reason: string; status: string; createdAt: string }[] }>('/schedules/recommendations')).data.recommendations });

  async function run(fn: () => Promise<SchedulePreview | ReplanPreview>) {
    setBusy(true);
    setError(null);
    try { setPreview(await fn()); } catch (e) { setError(apiError(e).message); } finally { setBusy(false); }
  }
  const build = () => run(async () => (await api.post<SchedulePreview>('/schedules/preview')).data);
  const replanDelay = () => run(async () => (await api.post<ReplanPreview>('/schedules/replan', { changes: [{ taskId, delayUntil: fromLocalInput(delay, tz) }] })).data);
  const replanAll = () => run(async () => (await api.post<ReplanPreview>('/schedules/replan', { full: true })).data);

  return (
    <>
      <PageHeader title="Smart planning" subtitle="Generate a dependency-aware plan from your tasks and availability. Review it, reject anything you don't want, then accept." />
      {!preview ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <h2 className="text-lg font-semibold">Build my schedule</h2>
            <p className="mt-1 text-sm text-muted">Places every open task with an estimate into your free working time over the next 4 weeks: prerequisites first, higher-priority and more urgent work earlier, critical-path tasks get extra weight, and fixed events are never touched. If something doesn't fit, you'll be told why rather than it being squeezed in.</p>
            {error && <div className="mt-3"><ErrorBox message={error} /></div>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={build} loading={busy}>Build my schedule</Button>
              <Button variant="secondary" onClick={replanAll} loading={busy}>Replan everything (keep preview)</Button>
            </div>
          </Card>
          <Card title="Something slipped?">
            <p className="mb-3 text-sm text-muted">Delay a task and preview the effect on everything downstream. Unaffected blocks stay where they are.</p>
            <div className="space-y-3">
              <Field label="Task">
                <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                  <option value="">Choose a task…</option>
                  {(tasks.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                </Select>
              </Field>
              <Field label="Can't start before"><Input type="datetime-local" value={delay} onChange={(e) => setDelay(e.target.value)} /></Field>
              <Button variant="secondary" className="w-full" disabled={!taskId || !delay} loading={busy} onClick={replanDelay}>Preview impact</Button>
            </div>
          </Card>
          {!!recs.data?.length && (
            <Card title="Recent plans" className="lg:col-span-3">
              <ul className="divide-y divide-border text-sm">
                {recs.data.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{r.reason}</span><span className="text-xs text-muted">{r.status.toLowerCase()} · {fmtDateTime(r.createdAt, tz)}</span></li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : (
        <Card>
          <SchedulePreviewView preview={preview} onDone={() => { setPreview(null); recs.refetch(); }} onRegenerate={build} />
        </Card>
      )}
    </>
  );
}
