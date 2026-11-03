import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Textarea } from '../components/ui';
import { fmtDate, fmtMinutes } from '../lib/format';
import type { Project } from '../types';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

export default function ProjectsPage() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: async () => (await api.get<{ projects: Project[] }>('/projects')).data.projects });
  return (
    <>
      <PageHeader title="Projects" subtitle="Group related tasks, set target dates and see the timeline." actions={<Button onClick={() => setOpen(true)}>New project</Button>} />
      {isLoading ? <Loading /> : !data?.length ? (
        <Empty title="No projects yet">Create a project, then add tasks with estimates and dependencies.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => {
            const pct = p.taskCount ? Math.round(((p.doneCount ?? 0) / p.taskCount) * 100) : 0;
            return (
              <Link key={p.id} to={`/app/projects/${p.id}`} className="rounded-xl border border-border bg-surface p-4 transition-shadow hover:shadow-md">
                <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: p.color }} /><h2 className="truncate font-semibold">{p.name}</h2></div>
                {p.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{p.description}</p>}
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full" style={{ width: `${pct}%`, background: p.color }} /></div>
                <div className="mt-2 flex justify-between text-xs text-muted">
                  <span>{p.doneCount}/{p.taskCount} tasks · {fmtMinutes(p.remainingMinutes)} left</span>
                  {p.targetDate && <span>target {fmtDate(p.targetDate, tz)}</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <NewProjectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', description: '', targetDate: '', color: COLORS[0] });
  const create = useMutation({
    mutationFn: () => api.post('/projects', { name: form.name, description: form.description || null, color: form.color, targetDate: form.targetDate ? new Date(form.targetDate + 'T17:00').toISOString() : null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }); setForm({ name: '', description: '', targetDate: '', color: COLORS[0] }); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title="New project" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim()}>Create</Button></>}>
      <div className="space-y-3">
        {create.error && <ErrorBox message={apiError(create.error).message} />}
        <Field label="Name"><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Target date"><Input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} /></Field>
        <Field label="Color">
          <div className="flex gap-2">{COLORS.map((c) => <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => setForm({ ...form, color: c })} className={`h-7 w-7 rounded-full ${form.color === c ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface' : ''}`} style={{ background: c }} />)}</div>
        </Field>
      </div>
    </Modal>
  );
}
