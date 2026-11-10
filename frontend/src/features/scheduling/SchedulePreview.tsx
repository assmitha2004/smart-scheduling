import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../services/api';
import { useAuth } from '../../services/auth';
import { useToast } from '../../components/Toast';
import { Badge, Button, ErrorBox, RiskBadge, Stat } from '../../components/ui';
import { dayKey, fmtDate, fmtDateTime, fmtMinutes, fmtTime } from '../../lib/format';
import type { DeadlineRisk, ReplanPreview, SchedulePreview as Preview } from '../../types';

/**
 * Shows a proposed schedule (fresh preview or replan) and lets the user
 * reject individual tasks, then approve. Nothing touches the calendar until
 * "Accept" — and a stale preview is rejected by the server with 409.
 */
export function SchedulePreviewView({ preview, onDone, onRegenerate }: { preview: Preview | ReplanPreview; onDone: () => void; onRegenerate: () => void }) {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const isReplan = 'diff' in preview;

  const byDay = useMemo(() => {
    const m = new Map<string, typeof preview.proposedBlocks>();
    for (const b of preview.proposedBlocks) {
      const k = dayKey(b.startAt, tz);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return [...m.entries()];
  }, [preview, tz]);
  const explanation = useMemo(() => new Map(preview.explanations.map((e) => [e.taskId, e])), [preview]);
  const critical = new Set(preview.criticalPath.map((c) => c.taskId));
  const taskIds = [...new Set(preview.proposedBlocks.filter((b) => !b.locked).map((b) => b.taskId))];

  async function accept() {
    if (!preview.recommendationId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/schedules/commit', { recommendationId: preview.recommendationId, expectedVersion: preview.scheduleVersion, excludeTaskIds: [...rejected] });
      toast.show(`Schedule saved: ${r.data.committedBlocks} blocks on your calendar.`, 'success');
      for (const k of ['calendar', 'briefing', 'risk', 'timeline', 'analytics', 'task', 'day']) qc.invalidateQueries({ queryKey: [k] });
      onDone();
    } catch (e) {
      setError(apiError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!preview.ok) {
    return (
      <div className="space-y-3">
        {preview.conflicts.map((c, i) => <ErrorBox key={i} message={c.message} />)}
        <p className="text-sm text-muted">No schedule was produced. Fix the problem above, then try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Work scheduled" value={fmtMinutes(preview.summary.scheduledMinutes)} sub={`of ${fmtMinutes(preview.summary.availableMinutes)} available`} />
        <Stat label="Free capacity left" value={fmtMinutes(preview.summary.remainingMinutes)} sub={`next ${Math.round((Date.parse(preview.summary.horizonEnd) - Date.parse(preview.summary.horizonStart)) / 86_400_000)} days`} />
        <Stat label="Projected finish" value={preview.summary.projectedFinish ? fmtDate(preview.summary.projectedFinish, tz) : '—'} sub={preview.summary.projectedFinish ? fmtTime(preview.summary.projectedFinish, tz) : undefined} />
        <Stat label="Needs attention" value={preview.unscheduledTasks.length + preview.warnings.length} tone={preview.unscheduledTasks.length ? 'danger' : preview.warnings.length ? 'warn' : 'ok'} sub={`${preview.unscheduledTasks.length} unscheduled · ${preview.warnings.length} warnings`} />
      </div>

      {isReplan && <ReplanImpact preview={preview as ReplanPreview} tz={tz} />}

      {(preview.unscheduledTasks.length > 0 || preview.warnings.length > 0) && (
        <div className="space-y-2">
          {preview.unscheduledTasks.map((u) => (
            <div key={u.taskId} className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm"><span className="font-medium text-danger">Not scheduled: {u.title}.</span> <span className="text-fg">{u.reason}</span></div>
          ))}
          {preview.warnings.map((w, i) => (
            <div key={i} className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-fg"><span className="font-medium text-warn">Warning:</span> {w.reason}</div>
          ))}
        </div>
      )}

      <RiskList risks={preview.risks.filter((r) => r.status !== 'ON_TRACK' && r.status !== 'DONE')} tz={tz} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">Proposed blocks</h3>
        {!byDay.length && <p className="text-sm text-muted">Nothing to schedule — add tasks with estimates first.</p>}
        <div className="space-y-3">
          {byDay.map(([day, blocks]) => (
            <div key={day} className="rounded-lg border border-border">
              <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold">{fmtDate(blocks[0].startAt, tz)}</div>
              <ul>
                {blocks.map((b, i) => {
                  const ex = explanation.get(b.taskId);
                  const isRejected = rejected.has(b.taskId);
                  return (
                    <li key={i} className={clsx('border-b border-border px-3 py-2 text-sm last:border-0', isRejected && 'opacity-40')}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="w-36 shrink-0 whitespace-nowrap tabular-nums text-muted">{fmtTime(b.startAt, tz)}–{fmtTime(b.endAt, tz)}</span>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: b.color ?? 'var(--c-accent)' }} />
                        <span className={clsx('font-medium', isRejected && 'line-through')}>{b.title}</span>
                        <span className="text-xs text-muted">{b.projectName}</span>
                        {critical.has(b.taskId) && <Badge tone="danger" title="A delay here delays the project finish">critical path</Badge>}
                        {b.locked && <Badge title="Unaffected by the change; kept in place">unchanged</Badge>}
                        <span className="ml-auto flex gap-1">
                          {ex && <Button variant="ghost" size="sm" onClick={() => setWhyOpen(whyOpen === `${b.taskId}${i}` ? null : `${b.taskId}${i}`)}>Why?</Button>}
                          {!b.locked && (
                            <Button variant="ghost" size="sm" onClick={() => setRejected((s) => { const n = new Set(s); if (n.has(b.taskId)) n.delete(b.taskId); else n.add(b.taskId); return n; })}>
                              {isRejected ? 'Undo' : 'Reject'}
                            </Button>
                          )}
                        </span>
                      </div>
                      {whyOpen === `${b.taskId}${i}` && ex && (
                        <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-xs">
                          <div className="mb-1 font-medium">Ranked #{ex.rank} · score {ex.score}</div>
                          <ul className="list-disc space-y-0.5 pl-4 text-muted">{ex.reasons.map((r, j) => <li key={j}>{r}</li>)}</ul>
                          {ex.earliestPossibleStart && <div className="mt-1 text-muted">Earliest possible start: {fmtDateTime(ex.earliestPossibleStart, tz)}</div>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="space-y-2">
          <ErrorBox message={error.message} />
          {(error.code === 'STALE_SCHEDULE' || error.code === 'SCHEDULE_CONFLICT' || error.code === 'RECOMMENDATION_RESOLVED') && (
            <Button variant="secondary" onClick={onRegenerate}>Generate a fresh preview</Button>
          )}
        </div>
      )}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface py-3">
        {rejected.size > 0 && <span className="mr-auto text-xs text-muted">{rejected.size} task(s) rejected — their dependents will be left off too.</span>}
        <Button variant="ghost" onClick={async () => { if (preview.recommendationId) await api.post(`/schedules/recommendations/${preview.recommendationId}/dismiss`).catch(() => undefined); onDone(); }}>Discard</Button>
        <Button onClick={accept} loading={busy} disabled={!preview.recommendationId || taskIds.every((t) => rejected.has(t)) && !isReplan}>
          Accept {isReplan ? 'replan' : 'schedule'}
        </Button>
      </div>
    </div>
  );
}

/** First start → last end; the end shows its date when it falls on another day. */
function fmtSpan(bs: { startAt: string; endAt: string }[], tz: string): string {
  const start = bs[0].startAt;
  const end = bs[bs.length - 1].endAt;
  return `${fmtDateTime(start, tz)} → ${dayKey(start, tz) === dayKey(end, tz) ? fmtTime(end, tz) : fmtDateTime(end, tz)}`;
}

/** Calendar shift: minutes/hours, or days once it exceeds a day. */
function fmtShift(m: number): string {
  return m >= 1440 ? `${Math.round((m / 1440) * 10) / 10} days` : fmtMinutes(m);
}

function ReplanImpact({ preview, tz }: { preview: ReplanPreview; tz: string }) {
  const changed = preview.diff.filter((d) => d.change !== 'UNCHANGED');
  const shift = preview.impact.shiftMinutes;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Impact</span>
        {shift != null && (
          <Badge tone={shift > 0 ? 'danger' : shift < 0 ? 'ok' : 'neutral'}>
            finish {shift === 0 ? 'unchanged' : `${shift > 0 ? 'later' : 'earlier'} by ${fmtShift(Math.abs(shift))}`}
          </Badge>
        )}
        <span className="text-muted">{preview.affectedTasks.length} affected · {preview.diff.length - changed.length} unchanged</span>
      </div>
      {preview.impactChain.length > 0 && (
        <p className="mb-2 text-xs text-muted">Chain of affected work: {preview.impactChain.join(' → ')}</p>
      )}
      <table className="w-full text-left text-xs">
        <thead className="text-muted"><tr><th className="py-1 font-medium">Task</th><th className="font-medium">Before</th><th className="font-medium">After</th><th className="font-medium">Change</th></tr></thead>
        <tbody>
          {changed.map((d) => (
            <tr key={d.taskId} className="border-t border-border">
              <td className="py-1.5 pr-2 font-medium">{d.title}</td>
              <td className="pr-2 text-muted">{d.before.length ? `${fmtSpan(d.before, tz)}` : '—'}</td>
              <td className="pr-2">{d.after.length ? `${fmtSpan(d.after, tz)}` : 'not scheduled'}</td>
              <td><Badge tone={d.change === 'REMOVED' ? 'danger' : d.change === 'ADDED' ? 'accent' : (d.finishShiftMinutes ?? 0) > 0 ? 'warn' : 'ok'}>{d.change.toLowerCase()}{d.finishShiftMinutes ? ` ${d.finishShiftMinutes > 0 ? '+' : '−'}${fmtShift(Math.abs(d.finishShiftMinutes))}` : ''}</Badge></td>
            </tr>
          ))}
          {!changed.length && <tr><td colSpan={4} className="py-2 text-muted">No existing blocks move.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function RiskList({ risks, tz }: { risks: DeadlineRisk[]; tz: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!risks.length) return null;
  return (
    <div className="space-y-2">
      {risks.map((r) => (
        <div key={r.id} className="rounded-lg border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge s={r.status} />
            <span className="font-medium">{r.title}</span>
            <span className="text-xs text-muted">{r.kind} · due {fmtDateTime(r.dueAt, tz)}</span>
            <button className="ml-auto text-xs text-accent" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide details' : 'Details'}</button>
          </div>
          <p className="mt-1 text-muted">{r.explanation}</p>
          {r.recommendations.length > 0 && (
            <ul className="mt-2 space-y-1">
              {r.recommendations.map((rec, i) => <li key={i} className="flex gap-2"><span className="text-accent">→</span>{rec.message}</li>)}
            </ul>
          )}
          {open === r.id && (
            <div className="mt-2 grid gap-3 rounded-md bg-surface-2 p-3 text-xs sm:grid-cols-2">
              <div>
                <div className="mb-1 font-medium">Most responsible for the risk</div>
                <ul className="space-y-0.5 text-muted">{r.contributors.map((c) => <li key={c.taskId}>{c.title} — {fmtMinutes(c.remainingMinutes)}{c.onCriticalPath ? ' · critical path' : ''}</li>)}</ul>
              </div>
              <div>
                <div className="mb-1 font-medium">Assumptions</div>
                <ul className="list-disc space-y-0.5 pl-4 text-muted">{r.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
