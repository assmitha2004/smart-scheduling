import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { useToast } from '../components/Toast';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select } from '../components/ui';
import { AvailabilityEditor, validateRules } from '../features/scheduling/AvailabilityEditor';
import type { AvailabilityRule, User, Workspace } from '../types';

const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];

export default function SettingsPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<User | null>(user);
  const [rules, setRules] = useState<AvailabilityRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const avail = useQuery({ queryKey: ['availability'], queryFn: async () => (await api.get<{ rules: AvailabilityRule[] }>('/availability')).data.rules });
  useEffect(() => { if (avail.data) setRules(avail.data.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime }))); }, [avail.data]);

  const saveProfile = useMutation({
    mutationFn: async () => (await api.patch('/users/me', {
      name: form!.name, timezone: form!.timezone, focusBlockMinutes: form!.focusBlockMinutes, allowTaskSplitting: form!.allowTaskSplitting,
      quietHoursStart: form!.quietHoursStart || null, quietHoursEnd: form!.quietHoursEnd || null,
      notificationPrefs: form!.notificationPrefs, aiExternalConsent: form!.aiExternalConsent,
    })).data.user as User,
    onSuccess: (u) => { setUser(u); toast.show('Settings saved', 'success'); qc.invalidateQueries(); },
    onError: (e) => setError(apiError(e).message),
  });
  const saveAvail = useMutation({
    mutationFn: () => api.put('/availability', { rules }),
    onSuccess: () => { toast.show('Working hours saved. Rebuild your schedule in Smart planning to apply them.', 'success'); qc.invalidateQueries(); },
    onError: (e) => setError(apiError(e).message),
  });

  if (!form) return null;
  const prefs = form.notificationPrefs;
  const setPref = (k: keyof typeof prefs, v: boolean | number) => setForm({ ...form, notificationPrefs: { ...prefs, [k]: v } });

  return (
    <>
      <PageHeader title="Settings" />
      {error && <div className="mb-4"><ErrorBox message={error} /></div>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Profile & planning">
          <div className="space-y-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Timezone"><Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="Focus block length (minutes)"><Input type="number" min={15} max={480} step={15} value={form.focusBlockMinutes} onChange={(e) => setForm({ ...form, focusBlockMinutes: Number(e.target.value) })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.allowTaskSplitting} onChange={(e) => setForm({ ...form, allowTaskSplitting: e.target.checked })} /> Allow splitting tasks across blocks</label>
          </div>
        </Card>
        <Card title="Notifications">
          <div className="space-y-2 text-sm">
            {([['taskReminders', 'Upcoming task reminders'], ['deadlineRisk', 'Deadline-risk alerts'], ['dependencyUnblocked', 'When a blocked task becomes ready'], ['dailyPlan', 'Daily plan']] as const).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={prefs[k]} onChange={(e) => setPref(k, e.target.checked)} /> {l}</label>
            ))}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <Field label="Remind me (minutes before)"><Input type="number" min={0} max={240} value={prefs.reminderLeadMinutes} onChange={(e) => setPref('reminderLeadMinutes', Number(e.target.value))} /></Field>
              <Field label="Daily plan at (hour)"><Input type="number" min={0} max={23} value={prefs.dailyPlanHour} onChange={(e) => setPref('dailyPlanHour', Number(e.target.value))} /></Field>
              <Field label="Quiet hours from"><Input type="time" value={form.quietHoursStart ?? ''} onChange={(e) => setForm({ ...form, quietHoursStart: e.target.value || null })} /></Field>
              <Field label="Quiet hours until"><Input type="time" value={form.quietHoursEnd ?? ''} onChange={(e) => setForm({ ...form, quietHoursEnd: e.target.value || null })} /></Field>
            </div>
          </div>
        </Card>
        <Card title="AI & privacy">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.aiExternalConsent} onChange={(e) => setForm({ ...form, aiExternalConsent: e.target.checked })} />
            <span>Allow sending task text to the configured external AI provider for task extraction and briefings.<span className="block text-xs text-muted">Off by default. When off, a built-in parser runs on our own servers. AI output is always a draft you review; it never changes your schedule directly.</span></span>
          </label>
        </Card>
        <div className="flex items-start justify-end lg:col-span-2"><Button onClick={() => saveProfile.mutate()} loading={saveProfile.isPending}>Save settings</Button></div>
        <Card title="Working hours" className="lg:col-span-2" action={<Button size="sm" loading={saveAvail.isPending} onClick={() => { const m = validateRules(rules); if (m) setError(m); else saveAvail.mutate(); }}>Save working hours</Button>}>
          <p className="mb-3 text-sm text-muted">Tasks are only scheduled inside these slots. Gaps between slots act as breaks. Add one-off unavailable time on the calendar.</p>
          <AvailabilityEditor rules={rules} onChange={setRules} />
        </Card>
        <Members />
      </div>
    </>
  );
}

function Members() {
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['workspaces'], queryFn: async () => (await api.get<{ workspaces: Workspace[] }>('/workspaces')).data.workspaces });
  const w = ws.data?.[0];
  const members = useQuery({ queryKey: ['members', w?.id], enabled: !!w, queryFn: async () => (await api.get<{ members: { id: string; name: string; email: string; role: string }[] }>(`/workspaces/${w!.id}/members`)).data.members });
  const [email, setEmail] = useState('');
  const invite = useMutation({
    mutationFn: () => api.post(`/workspaces/${w!.id}/members`, { email }),
    onSuccess: () => { setEmail(''); qc.invalidateQueries({ queryKey: ['members'] }); },
  });
  if (!w) return null;
  return (
    <Card title={`Workspace: ${w.name}`} className="lg:col-span-2">
      <ul className="mb-3 divide-y divide-border text-sm">
        {members.data?.map((m) => <li key={m.id} className="flex justify-between py-2"><span>{m.name} <span className="text-muted">{m.email}</span></span><Badge>{m.role.toLowerCase()}</Badge></li>)}
      </ul>
      {invite.error && <div className="mb-2"><ErrorBox message={apiError(invite.error).message} /></div>}
      {(w.role === 'OWNER' || w.role === 'ADMIN') && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com (must have an account)" aria-label="Member email" />
          <Button type="submit" variant="secondary" disabled={!email}>Add member</Button>
        </form>
      )}
    </Card>
  );
}
