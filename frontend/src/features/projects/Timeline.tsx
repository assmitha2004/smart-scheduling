import { useMemo } from 'react';
import { DateTime } from 'luxon';
import type { Timeline as TimelineData } from '../../types';
import { fmtDate, fmtMinutes } from '../../lib/format';

export type Zoom = 'day' | 'week' | 'month';
const PX_PER_DAY: Record<Zoom, number> = { day: 72, week: 22, month: 6 };
const ROW = 36;
const HEADER = 44;
const DAY = 86_400_000;

/**
 * Gantt view. Bars come from confirmed calendar blocks (solid) or a
 * projection for not-yet-scheduled tasks (dashed). Red = critical path.
 */
export function Timeline({ data, tz, zoom, onTaskClick }: { data: TimelineData; tz: string; zoom: Zoom; onTaskClick: (id: string) => void }) {
  const px = PX_PER_DAY[zoom];
  const rows = useMemo(() => [...data.tasks].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.title.localeCompare(b.title)), [data.tasks]);
  const rowOf = useMemo(() => new Map(rows.map((t, i) => [t.id, i])), [rows]);

  const { start, end } = useMemo(() => {
    const times = [Date.now(), ...rows.flatMap((t) => [Date.parse(t.startAt), Date.parse(t.endAt)]), ...data.milestones.map((m) => Date.parse(m.dueAt))];
    if (data.project.targetDate) times.push(Date.parse(data.project.targetDate));
    const s = DateTime.fromMillis(Math.min(...times), { zone: tz }).startOf(zoom === 'month' ? 'month' : 'week').minus({ days: zoom === 'day' ? 1 : 0 });
    const e = DateTime.fromMillis(Math.max(...times), { zone: tz }).endOf(zoom === 'month' ? 'month' : 'week').plus({ days: zoom === 'day' ? 2 : 7 });
    return { start: s.toMillis(), end: e.toMillis() };
  }, [rows, data, tz, zoom]);

  const x = (ms: number) => ((ms - start) / DAY) * px;
  const width = Math.max(x(end), 600);
  const height = HEADER + Math.max(rows.length, 1) * ROW + 8;

  const ticks = useMemo(() => {
    const out: { x: number; label: string; major: boolean }[] = [];
    let d = DateTime.fromMillis(start, { zone: tz }).startOf('day');
    const endDt = DateTime.fromMillis(end, { zone: tz });
    while (d < endDt) {
      if (zoom === 'day') out.push({ x: x(d.toMillis()), label: d.toFormat('ccc d'), major: d.weekday === 1 });
      else if (zoom === 'week' && d.weekday === 1) out.push({ x: x(d.toMillis()), label: d.toFormat('d LLL'), major: d.day <= 7 });
      else if (zoom === 'month' && d.day === 1) out.push({ x: x(d.toMillis()), label: d.toFormat('LLL yyyy'), major: true });
      d = d.plus({ days: 1 });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, tz, zoom, px]);

  const nowX = x(Date.now());
  const color = data.project.color;

  return (
    <div className="flex overflow-hidden rounded-xl border border-border bg-surface">
      {/* Task names */}
      <div className="w-44 shrink-0 border-r border-border sm:w-60">
        <div style={{ height: HEADER }} className="flex items-end border-b border-border px-3 pb-2 text-xs font-medium text-muted">Task</div>
        {rows.map((t) => (
          <button key={t.id} onClick={() => onTaskClick(t.id)} style={{ height: ROW }}
            className="flex w-full items-center gap-1.5 border-b border-border/60 px-3 text-left text-sm hover:bg-surface-2">
            <span className="truncate">{t.title}</span>
            {t.flags.late && <span title="Overdue" className="text-danger">●</span>}
            {t.flags.blocked && <span title={`Blocked by ${t.blockedBy.map((b) => b.title).join(', ')}`} aria-label="blocked" className="text-warn">⏸</span>}
            {t.flags.atRisk && <span title="Projected to miss its deadline" className="text-warn">▲</span>}
          </button>
        ))}
      </div>
      {/* Chart */}
      <div className="overflow-x-auto">
        <svg width={width} height={height} role="img" aria-label={`Timeline for ${data.project.name}`} className="block">
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--c-muted)" /></marker>
            <marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--c-danger)" /></marker>
            <pattern id="unplanned" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill={color} opacity="0.25" /></pattern>
          </defs>
          {/* grid */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={t.x} x2={t.x} y1={HEADER - 8} y2={height} stroke="var(--c-border)" strokeWidth={t.major ? 1 : 0.5} />
              <text x={t.x + 4} y={HEADER - 14} fontSize="11" fill="var(--c-muted)">{t.label}</text>
            </g>
          ))}
          <line x1={0} x2={width} y1={HEADER} y2={HEADER} stroke="var(--c-border)" />
          {rows.map((_, i) => <line key={i} x1={0} x2={width} y1={HEADER + (i + 1) * ROW} y2={HEADER + (i + 1) * ROW} stroke="var(--c-border)" strokeOpacity="0.5" />)}

          {/* dependency connectors */}
          {data.dependencies.map((d) => {
            const from = rows.find((t) => t.id === d.dependsOnTaskId);
            const to = rows.find((t) => t.id === d.taskId);
            if (!from || !to) return null;
            const x1 = x(Date.parse(from.endAt));
            const y1 = HEADER + rowOf.get(from.id)! * ROW + ROW / 2;
            const x2 = x(Date.parse(to.startAt));
            const y2 = HEADER + rowOf.get(to.id)! * ROW + ROW / 2;
            const crit = from.critical && to.critical;
            const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 12));
            const path = x2 - x1 >= 16 ? `M${x1},${y1} H${mid} V${y2} H${x2 - 1}` : `M${x1},${y1} H${x1 + 8} V${(y1 + y2) / 2} H${x2 - 10} V${y2} H${x2 - 1}`;
            return <path key={d.id} d={path} fill="none" stroke={crit ? 'var(--c-danger)' : 'var(--c-muted)'} strokeWidth={crit ? 1.6 : 1} strokeOpacity={crit ? 0.9 : 0.6} markerEnd={`url(#${crit ? 'arrow-crit' : 'arrow'})`} />;
          })}

          {/* bars */}
          {rows.map((t, i) => {
            const bx = x(Date.parse(t.startAt));
            const bw = Math.max(6, x(Date.parse(t.endAt)) - bx);
            const by = HEADER + i * ROW + 8;
            const bh = ROW - 16;
            const done = t.status === 'DONE';
            const stroke = t.critical ? 'var(--c-danger)' : color;
            return (
              <g key={t.id} className="cursor-pointer" onClick={() => onTaskClick(t.id)}>
                <title>{`${t.title}\n${fmtDate(t.startAt, tz)} → ${fmtDate(t.endAt, tz)}\n${fmtMinutes(t.estimatedMinutes)} estimate · ${t.progress}% done${t.critical ? '\nOn the critical path' : `\nSlack: ${fmtMinutes(t.slackMinutes)}`}${t.planned ? '' : '\nNot scheduled yet (projection)'}`}</title>
                <rect x={bx} y={by} width={bw} height={bh} rx={4}
                  fill={t.planned ? color : 'url(#unplanned)'} fillOpacity={done ? 0.35 : t.planned ? 0.85 : 1}
                  stroke={stroke} strokeWidth={t.critical ? 2 : 1} strokeDasharray={t.planned ? undefined : '4 3'} />
                {t.progress > 0 && !done && <rect x={bx} y={by + bh - 3} width={(bw * t.progress) / 100} height={3} rx={1.5} fill="var(--c-fg)" fillOpacity="0.5" />}
                {t.dueAt && (() => { const dx = x(Date.parse(t.dueAt)); return <line x1={dx} x2={dx} y1={by - 3} y2={by + bh + 3} stroke={t.flags.late || t.flags.atRisk ? 'var(--c-danger)' : 'var(--c-fg)'} strokeWidth={2} strokeOpacity={0.6} />; })()}
              </g>
            );
          })}

          {/* milestones */}
          {data.milestones.map((m) => {
            const mx = x(Date.parse(m.dueAt));
            return (
              <g key={m.id}>
                <line x1={mx} x2={mx} y1={HEADER} y2={height} stroke="var(--c-accent)" strokeDasharray="2 3" />
                <path d={`M${mx},${HEADER - 7} l5,5 l-5,5 l-5,-5 z`} fill="var(--c-accent)"><title>{`Milestone: ${m.name} (${fmtDate(m.dueAt, tz)})`}</title></path>
              </g>
            );
          })}
          {data.project.targetDate && (() => { const tx = x(Date.parse(data.project.targetDate)); return (
            <g><line x1={tx} x2={tx} y1={HEADER - 6} y2={height} stroke={data.targetAtRisk ? 'var(--c-danger)' : 'var(--c-ok)'} strokeWidth={2} /><text x={tx + 4} y={HEADER - 2} fontSize="10" fontWeight="600" fill={data.targetAtRisk ? 'var(--c-danger)' : 'var(--c-ok)'}>target</text></g>
          ); })()}
          {nowX >= 0 && nowX <= width && <g><line x1={nowX} x2={nowX} y1={HEADER - 6} y2={height} stroke="var(--c-danger)" strokeWidth={1.5} /><text x={nowX + 4} y={height - 4} fontSize="10" fill="var(--c-danger)">now</text></g>}
        </svg>
      </div>
    </div>
  );
}

export function TimelineLegend() {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted">
      <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm bg-accent" /> scheduled</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border border-dashed border-accent" /> projected (not on calendar)</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border-2 border-danger" /> critical path</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-fg/60" /> due date</span>
      <span className="flex items-center gap-1.5"><span className="text-warn">⏸</span> blocked</span>
      <span className="flex items-center gap-1.5"><span className="text-warn">▲</span> at risk</span>
      <span className="flex items-center gap-1.5"><span className="text-danger">●</span> overdue</span>
      <span className="flex items-center gap-1.5"><span className="text-accent">◆</span> milestone</span>
    </div>
  );
}
