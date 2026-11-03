import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api } from '../services/api';
import { useAuth } from '../services/auth';
import { Card, Loading, PageHeader, Stat } from '../components/ui';
import { fmtMinutes } from '../lib/format';
import type { DeadlineRisk, RiskStatus } from '../types';
import { GroupedBars, HBars } from '../features/analytics/Charts';
import { RiskList } from '../features/scheduling/SchedulePreview';

interface Overview {
  weekly: { weekStart: string; plannedMinutes: number; actualMinutes: number; estimatedMinutesCompleted: number; tasksCompleted: number; dueCount: number; overdueCount: number }[];
  workloadByProject: { projectId: string; name: string; color: string; remainingMinutes: number; scheduledNext7DaysMinutes: number; openTasks: number; doneTasks: number }[];
  estimateAccuracy: { sampleSize: number; medianActualToEstimate: number | null; meanAbsolutePercentError: number | null; withinTwentyPercent: number | null; underestimated: number; overestimated: number };
  totals: { openTasks: number; doneTasks: number; openOverdue: number; plannedMinutes: number; actualMinutes: number };
}

export default function AnalyticsPage() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const ov = useQuery({ queryKey: ['analytics', 'overview'], queryFn: async () => (await api.get<Overview>('/analytics/overview', { params: { weeks: 8 } })).data });
  const risk = useQuery({ queryKey: ['risk'], queryFn: async () => (await api.get<{ risks: DeadlineRisk[]; counts: Record<RiskStatus, number> }>('/analytics/deadline-risk')).data });
  if (ov.isLoading || risk.isLoading) return <Loading />;
  const o = ov.data!;
  const r = risk.data!;
  const wk = (iso: string) => DateTime.fromISO(iso).toFormat('d LLL');
  const acc = o.estimateAccuracy;

  return (
    <>
      <PageHeader title="Analytics" subtitle="How planned time compares with reality, where your workload sits, and which deadlines are feasible." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open tasks" value={o.totals.openTasks} sub={`${o.totals.doneTasks} done`} />
        <Stat label="Overdue now" value={o.totals.openOverdue} tone={o.totals.openOverdue ? 'danger' : 'ok'} />
        <Stat label="Deadlines feasible" value={`${r.counts.ON_TRACK}/${r.risks.length - r.counts.DONE}`} sub={`${r.counts.AT_RISK} at risk · ${r.counts.INFEASIBLE} not feasible`} tone={r.counts.INFEASIBLE ? 'danger' : r.counts.AT_RISK ? 'warn' : 'ok'} />
        <Stat label="Estimate accuracy" value={acc.withinTwentyPercent != null ? `${acc.withinTwentyPercent}%` : '—'} sub={acc.sampleSize ? `within ±20% · ${acc.sampleSize} tasks measured` : 'log time on tasks to measure'} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Planned vs actual time (per week)">
          <GroupedBars label="Planned versus actual minutes per week"
            series={[{ name: 'Planned (calendar blocks)', color: 'var(--series-1)' }, { name: 'Actual (logged on completed tasks)', color: 'var(--series-2)' }]}
            data={o.weekly.map((w) => ({ label: wk(w.weekStart), values: [w.plannedMinutes, w.actualMinutes] }))} />
        </Card>
        <Card title="Workload by project">
          <HBars empty="No open work."
            data={o.workloadByProject.map((p) => ({ label: p.name, value: p.remainingMinutes, color: p.color, sub: `${p.openTasks} open · ${fmtMinutes(p.scheduledNext7DaysMinutes)} scheduled in the next 7 days` }))} />
        </Card>
        <Card title="Overdue tasks (by due week)">
          <GroupedBars label="Tasks due versus finished late per week" integer format={(n) => String(Math.round(n))}
            series={[{ name: 'Due', color: 'var(--series-1)' }, { name: 'Late or still open', color: 'var(--series-2)' }]}
            data={o.weekly.map((w) => ({ label: wk(w.weekStart), values: [w.dueCount, w.overdueCount] }))} />
        </Card>
        <Card title="Estimate accuracy">
          {!acc.sampleSize ? <p className="text-sm text-muted">Complete tasks and log the time you actually spent to see how accurate your estimates are.</p> : (
            <div className="space-y-3 text-sm">
              <p>Tasks typically take <b>{acc.medianActualToEstimate}×</b> their estimate (median of {acc.sampleSize}).</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-surface-2 p-2"><div className="text-lg font-semibold">{acc.meanAbsolutePercentError}%</div><div className="text-xs text-muted">mean abs. error</div></div>
                <div className="rounded-lg bg-surface-2 p-2"><div className="text-lg font-semibold">{acc.underestimated}</div><div className="text-xs text-muted">took &gt;20% longer</div></div>
                <div className="rounded-lg bg-surface-2 p-2"><div className="text-lg font-semibold">{acc.overestimated}</div><div className="text-xs text-muted">took &gt;20% less</div></div>
              </div>
              {acc.medianActualToEstimate != null && acc.medianActualToEstimate > 1.2 && <p className="text-xs text-muted">Consider padding new estimates by about {Math.round((acc.medianActualToEstimate - 1) * 100)}%.</p>}
            </div>
          )}
        </Card>
      </div>
      <Card title="Deadline feasibility" className="mt-5">
        {!r.risks.length ? <p className="text-sm text-muted">No deadlines set. Add due dates to tasks or target dates to projects.</p> : <RiskList risks={r.risks.filter((x) => x.status !== 'DONE')} tz={tz} />}
      </Card>
    </>
  );
}
