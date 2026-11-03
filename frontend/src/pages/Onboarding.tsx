import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, ErrorBox, Field, Input, Select } from '../components/ui';
import { Logo } from '../components/Layout';
import { AvailabilityEditor, validateRules } from '../features/scheduling/AvailabilityEditor';
import type { AvailabilityRule } from '../types';

const STEPS = ['Timezone', 'Working hours', 'Focus blocks', 'First project'];
const DEFAULT_RULES: AvailabilityRule[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: '09:00', endTime: '12:00' },
  { weekday, startTime: '13:00', endTime: '17:00' },
]);
const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];

export default function Onboarding() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [rules, setRules] = useState<AvailabilityRule[]>(DEFAULT_RULES);
  const [focus, setFocus] = useState(90);
  const [splitting, setSplitting] = useState(true);
  const [project, setProject] = useState({ name: '', targetDate: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function next() {
    setError(null);
    if (step === 1) {
      const msg = validateRules(rules);
      if (msg) return setError(msg);
      if (!rules.length) return setError('Add at least one working slot so tasks can be scheduled.');
    }
    if (step < STEPS.length - 1) return setStep(step + 1);
    setBusy(true);
    try {
      await api.put('/availability', { rules });
      if (project.name.trim()) {
        await api.post('/projects', { name: project.name.trim(), targetDate: project.targetDate ? new Date(project.targetDate + 'T17:00').toISOString() : null });
      }
      const r = await api.patch('/users/me', { timezone, focusBlockMinutes: focus, allowTaskSplitting: splitting, onboarded: true });
      setUser(r.data.user);
      navigate('/app', { replace: true });
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Logo />
      <ol className="mt-8 flex gap-2" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <div className={`h-1.5 rounded-full ${i <= step ? 'bg-accent' : 'bg-border'}`} />
            <div className={`mt-1 text-xs ${i === step ? 'font-medium text-fg' : 'text-muted'}`}>{s}</div>
          </li>
        ))}
      </ol>
      <div className="mt-6 space-y-4 rounded-xl border border-border bg-surface p-6">
        {error && <ErrorBox message={error} />}
        {step === 0 && (
          <>
            <h1 className="text-lg font-semibold">Where are you working from?</h1>
            <p className="text-sm text-muted">Times are stored in UTC and always shown in your timezone.</p>
            <Field label="Timezone">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
              </Select>
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="text-lg font-semibold">When can you work?</h1>
            <p className="text-sm text-muted">Add slots for each day. Gaps between slots become breaks — tasks are only scheduled inside these slots. You can add one-off unavailable periods later on the calendar.</p>
            <AvailabilityEditor rules={rules} onChange={setRules} />
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="text-lg font-semibold">How do you like to focus?</h1>
            <Field label="Preferred focus block length" hint="Long tasks are split into blocks of at most this length, with short breaks between.">
              <Select value={focus} onChange={(e) => setFocus(Number(e.target.value))}>
                {[30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={splitting} onChange={(e) => setSplitting(e.target.checked)} /> Allow splitting tasks across several blocks</label>
          </>
        )}
        {step === 3 && (
          <>
            <h1 className="text-lg font-semibold">Create your first project</h1>
            <p className="text-sm text-muted">Optional — you can skip this and add projects later.</p>
            <Field label="Project name"><Input value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} placeholder="e.g. Website launch" /></Field>
            <Field label="Target date (optional)"><Input type="date" value={project.targetDate} onChange={(e) => setProject({ ...project, targetDate: e.target.value })} /></Field>
          </>
        )}
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</Button>
          <Button onClick={next} loading={busy}>{step === STEPS.length - 1 ? 'Finish setup' : 'Continue'}</Button>
        </div>
      </div>
    </div>
  );
}
