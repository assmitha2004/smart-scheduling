import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, ErrorBox, Field, Select } from '../components/ui';
import { Logo } from '../components/Layout';
import { useCelebrate } from '../components/Celebrate';
import { ChoiceCard, Tempo } from '../features/planner/controls';
import { PlanWizard, type PlannerResult } from '../features/planner/PlanWizard';
import { PERSONAS, defaultAnswers } from '../features/planner/templates';
import type { AvailabilityRule, Persona } from '../types';

const MANUAL_RULES: AvailabilityRule[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: '09:00', endTime: '12:00' },
  { weekday, startTime: '13:00', endTime: '17:00' },
]);
const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

export default function Onboarding() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { celebrate } = useCelebrate();
  const [stage, setStage] = useState<'hello' | 'wizard'>('hello');
  const [persona, setPersona] = useState<Persona | null>(user?.persona ?? null);
  const [timezone, setTimezone] = useState(user?.timezone && user.timezone !== 'UTC' ? user.timezone : browserTz());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = user?.name.split(' ')[0] ?? 'there';

  async function start() {
    if (!persona) return setError('Pick the one that fits you best. You can change it later 🙂');
    setBusy(true);
    setError(null);
    try {
      // Timezone first, so the planner places everything in local time.
      const r = await api.patch('/users/me', { timezone, persona });
      setUser(r.data.user);
      setStage('wizard');
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    try {
      await api.put('/availability', { rules: MANUAL_RULES });
      const r = await api.patch('/users/me', { timezone, persona, onboarded: true });
      setUser(r.data.user);
      navigate('/app', { replace: true });
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  function done(r: PlannerResult) {
    setUser(r.user);
    qc.invalidateQueries();
    celebrate({ emoji: '🥳', line: `Welcome aboard, ${first}!` });
    navigate(`/app/plan?horizon=${r.plan.horizonDays <= 1 ? 'DAY' : r.plan.horizonDays <= 7 ? 'WEEK' : 'MONTH'}`, { replace: true });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Logo />
      <div className="mt-8">
        {stage === 'hello' ? (
          <div className="wizard-step space-y-5">
            <Tempo mood="👋">Hey {first}, welcome! I'm <b>Tempo</b> 🦉, and I'll help you plan your time so you get stuff done <i>and</i> have time for fun. First, which of these sounds like you?</Tempo>
            <div className="flex flex-col gap-3 sm:flex-row">
              {PERSONAS.map((x) => <ChoiceCard key={x.id} selected={persona === x.id} onClick={() => setPersona(x.id)} emoji={x.emoji} title={x.title} blurb={x.blurb} />)}
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <Field label="Your timezone" hint="So your plan uses your local time.">
                <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((tz) => <option key={tz}>{tz}</option>)}
                </Select>
              </Field>
            </div>
            {error && <ErrorBox message={error} />}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="text-sm text-muted hover:text-fg" onClick={skip} disabled={busy}>Skip, I'll set things up myself</button>
              <Button onClick={start} loading={busy} disabled={!persona}>Let's plan my time →</Button>
            </div>
          </div>
        ) : persona && (
          <PlanWizard initial={defaultAnswers(persona)} onApplied={done} onCancel={() => setStage('hello')}
            intro={<>Nice to meet you, {first}! {PERSONAS.find((x) => x.id === persona)?.emoji} I'll ask a few quick questions; tap the answers that fit.</>} />
        )}
      </div>
    </div>
  );
}
