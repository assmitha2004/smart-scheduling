import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, Card, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useCelebrate } from '../components/Celebrate';
import { PlanWizard, type PlannerResult } from '../features/planner/PlanWizard';
import { ChoiceCard, Tempo } from '../features/planner/controls';
import { CHRONOTYPES, PERSONAS, defaultAnswers, studies } from '../features/planner/templates';
import { SchedulePreviewView } from '../features/scheduling/SchedulePreview';
import type { Horizon, LifeAnswers, Persona, SchedulePreview } from '../types';
import { ProBadge, ProGate, usePlan } from '../features/billing/plan';

const HORIZONS: { id: Horizon; emoji: string; title: string; blurb: string }[] = [
  { id: 'DAY', emoji: '📅', title: 'Plan my day', blurb: 'The rest of today' },
  { id: 'WEEK', emoji: '🗓️', title: 'Plan my week', blurb: 'The next 7 days' },
  { id: 'MONTH', emoji: '🌙', title: 'Plan my month', blurb: 'The next 30 days' },
];

export function usePlannerAnswers() {
  return useQuery({ queryKey: ['planner'], queryFn: async () => (await api.get<{ persona: Persona | null; answers: LifeAnswers | null }>('/planner')).data });
}

/** Generate a schedule for a day, week or month, then review and accept it. */
export function GeneratePlan({ initialHorizon, onDone }: { initialHorizon: Horizon; onDone: () => void }) {
  const [horizon, setHorizon] = useState<Horizon>(initialHorizon);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const build = async (h = horizon) => {
    setBusy(true);
    setError(null);
    try { setPreview((await api.post<SchedulePreview>('/schedules/preview', { horizon: h })).data); } catch (e) { setError(apiError(e).message); } finally { setBusy(false); }
  };
  const plan = usePlan();
  const locked = horizon === 'MONTH' && !plan.has('MONTH_PLANNING');
  if (preview) return <Card><SchedulePreviewView preview={preview} onDone={() => { setPreview(null); onDone(); }} onRegenerate={() => build()} /></Card>;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        {HORIZONS.map((h) => <ChoiceCard key={h.id} selected={horizon === h.id} onClick={() => setHorizon(h.id)} emoji={h.emoji} title={h.id === 'MONTH' && !plan.has('MONTH_PLANNING') ? `${h.title} 🔒` : h.title} blurb={h.blurb} />)}
      </div>
      {error && <ErrorBox message={error} />}
      {locked ? <ProGate feature="MONTH_PLANNING" compact>{null}</ProGate> : (
        <div className="flex items-center gap-3">
          <Button onClick={() => build()} loading={busy}>✨ Build my {horizon === 'DAY' ? 'day' : horizon === 'WEEK' ? 'week' : 'month'}</Button>
          {horizon === 'MONTH' && plan.trialing && <span className="flex items-center gap-1 text-xs text-muted"><ProBadge /> trial feature</span>}
        </div>
      )}
    </div>
  );
}

export default function PlanMyTime() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { celebrate } = useCelebrate();
  const [params] = useSearchParams();
  const saved = usePlannerAnswers();
  const quick = params.get('horizon') as Horizon | null;
  const [mode, setMode] = useState<'home' | 'persona' | 'wizard' | 'generate'>(quick ? 'generate' : 'home');
  const [persona, setPersona] = useState<Persona | null>(user?.persona ?? null);
  const [horizon, setHorizon] = useState<Horizon>(quick ?? 'WEEK');
  const [justSaved, setJustSaved] = useState<PlannerResult | null>(null);

  if (saved.isLoading) return <Loading label="Waking Tempo up…" />;
  const answers = saved.data?.answers ?? null;
  const startWizard = () => setMode(persona ? 'wizard' : 'persona');

  const onApplied = (r: PlannerResult) => {
    setUser(r.user);
    for (const k of ['planner', 'tasks', 'projects', 'calendar', 'briefing']) qc.invalidateQueries({ queryKey: [k] });
    setJustSaved(r);
    setHorizon(r.plan.horizonDays <= 1 ? 'DAY' : r.plan.horizonDays <= 7 ? 'WEEK' : 'MONTH');
    setMode('generate');
    celebrate({ emoji: '🗓️', line: 'Your routine is all set up!' });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Plan my time ✨" subtitle="Answer a few friendly questions and I'll build a schedule around your real life." />

      {mode === 'home' && (
        <div className="space-y-5">
          {answers ? (
            <>
              <Tempo mood="🦉">Welcome back, {user?.name.split(' ')[0]}! What should we plan?</Tempo>
              <Card>
                <div className="mb-4 flex flex-wrap gap-2 text-sm">
                  <span className="rounded-full bg-accent-soft px-3 py-1 text-accent">{PERSONAS.find((x) => x.id === answers.persona)?.emoji} {PERSONAS.find((x) => x.id === answers.persona)?.title}</span>
                  <span className="rounded-full bg-surface-2 px-3 py-1">{CHRONOTYPES.find((x) => x.id === answers.chronotype)?.emoji} {CHRONOTYPES.find((x) => x.id === answers.chronotype)?.title}</span>
                  <span className="rounded-full bg-surface-2 px-3 py-1">⏰ {answers.wakeTime}–{answers.sleepTime}</span>
                  {studies(answers.persona) && <span className="rounded-full bg-surface-2 px-3 py-1">📚 {answers.studyHoursPerDay}h study / day</span>}
                </div>
                <GeneratePlan initialHorizon={horizon} onDone={() => { celebrate({ emoji: '🚀', line: 'Your plan is on the calendar!' }); navigate('/app/calendar'); }} />
              </Card>
              <Card title="Life changed? 🔄">
                <p className="mb-3 text-sm text-muted">New timetable, exam coming up, new assignment? Update your answers and I'll rebuild your routine. Tasks you've already started stay safe.</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => { setPersona(answers.persona); setMode('wizard'); }}>Update my answers</Button>
                  <Button variant="ghost" onClick={() => setMode('persona')}>Switch student / work</Button>
                </div>
              </Card>
            </>
          ) : (
            <>
              <Tempo mood="👋">Hi {user?.name.split(' ')[0]}! I'm <b>Tempo</b> 🦉. Tell me about your week and I'll plan your days, weeks or whole month. If you're not sure about something, I'll ask. It takes about 2 minutes.</Tempo>
              <Button onClick={startWizard}>Let's go →</Button>
            </>
          )}
        </div>
      )}

      {mode === 'persona' && (
        <div className="space-y-5">
          <Tempo mood="🤔">First, which of these sounds most like you right now?</Tempo>
          <div className="flex flex-col gap-3 sm:flex-row">
            {PERSONAS.map((x) => <ChoiceCard key={x.id} selected={persona === x.id} onClick={() => setPersona(x.id)} emoji={x.emoji} title={x.title} blurb={x.blurb} />)}
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setMode('home')}>← Back</Button>
            <Button disabled={!persona} onClick={() => setMode('wizard')}>Next →</Button>
          </div>
        </div>
      )}

      {mode === 'wizard' && persona && (
        <PlanWizard
          initial={answers && answers.persona === persona ? answers : { ...defaultAnswers(persona), ...(answers ? { wakeTime: answers.wakeTime, sleepTime: answers.sleepTime, chronotype: answers.chronotype, meals: answers.meals, habits: answers.habits } : {}) }}
          onApplied={onApplied}
          onCancel={() => setMode('home')}
        />
      )}

      {mode === 'generate' && (
        <div className="space-y-5">
          {justSaved ? (
            <Tempo mood="🎉">
              Your routine is saved! I set up <b>{justSaved.summary.availabilitySlots}</b> focus windows, put <b>{justSaved.summary.eventsCreated}</b> classes, meals and commitments on your calendar, and added <b>{justSaved.summary.tasksCreated}</b> smart tasks.
              {' '}Now let's turn that into an actual plan. Pick how far ahead:
            </Tempo>
          ) : (
            <Tempo mood="🦉">{answers ? 'Pick how far ahead to plan and I\'ll fit your tasks into your free time.' : 'Answer my questions first so I know your routine.'}</Tempo>
          )}
          {answers || justSaved ? (
            <GeneratePlan initialHorizon={horizon} onDone={() => { celebrate({ emoji: '🚀', line: 'Your plan is on the calendar!' }); navigate('/app/calendar'); }} />
          ) : (
            <Button onClick={startWizard}>Answer the questions →</Button>
          )}
        </div>
      )}
    </div>
  );
}
