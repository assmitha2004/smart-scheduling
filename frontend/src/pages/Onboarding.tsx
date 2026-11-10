import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, ErrorBox, Field, Select } from '../components/ui';
import { Logo } from '../components/Layout';
import { ChoiceCard, Tempo } from '../features/planner/controls';
import { PERSONAS } from '../features/planner/templates';
import type { AvailabilityRule, Persona } from '../types';

/** Default working hours for the week scheduler (Overview); My Day doesn't need them. */
const DEFAULT_RULES: AvailabilityRule[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: '09:00', endTime: '12:00' },
  { weekday, startTime: '13:00', endTime: '17:00' },
]);
const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

/** One short screen, then straight into planning today. */
export default function Onboarding() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [persona, setPersona] = useState<Persona | null>(user?.persona ?? null);
  const [timezone, setTimezone] = useState(user?.timezone && user.timezone !== 'UTC' ? user.timezone : browserTz());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = user?.name.split(' ')[0] ?? 'there';

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api.put('/availability', { rules: DEFAULT_RULES }).catch(() => undefined);
      const r = await api.patch('/users/me', { timezone, persona, onboarded: true });
      setUser(r.data.user);
      navigate('/app?plan=1', { replace: true });
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Logo />
      <div className="wizard-step mt-8 space-y-5">
        <Tempo mood="👋">
          Hey {first}, welcome! I’m <b>Tempo</b> 🦉. Not sure how to plan your day? That’s exactly what I’m for. You tell me your tasks, I ask a few quick questions, and I build your day: what to do when, with breaks. Whatever you don’t finish moves to tomorrow.
        </Tempo>
        <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">
          <p className="mb-3 font-medium">Which sounds most like you? <span className="font-normal text-muted">(optional)</span></p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {PERSONAS.map((x) => <ChoiceCard key={x.id} selected={persona === x.id} onClick={() => setPersona(persona === x.id ? null : x.id)} emoji={x.emoji} title={x.title} blurb={x.blurb} />)}
          </div>
          <div className="mt-5">
            <Field label="Your timezone" hint="So your plan uses your local time.">
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((tz) => <option key={tz}>{tz}</option>)}
              </Select>
            </Field>
          </div>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end">
          <Button onClick={start} loading={busy}>Plan my day →</Button>
        </div>
      </div>
    </div>
  );
}
