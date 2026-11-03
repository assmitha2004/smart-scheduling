import { useState } from 'react';
import { fmtMinutes } from '../../lib/format';

/** Grouped vertical bars, one shared y-axis. Hover a group for exact values. */
export function GroupedBars({ data, series, format = fmtMinutes, label, integer }: {
  data: { label: string; values: number[] }[];
  series: { name: string; color: string }[];
  format?: (n: number) => string;
  label: string;
  /** Counts: keep gridline values whole (0, 2, 4…). */
  integer?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 640, H = 200, padL = 62, padB = 22, padT = 10;
  const max = Math.max(integer ? 2 : 1, ...data.flatMap((d) => d.values));
  const nice = integer ? Math.ceil(niceMax(max) / 2) * 2 : niceMax(max);
  const gw = (W - padL) / data.length;
  const bw = Math.min(18, (gw - 10) / series.length - 2);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / nice);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        {series.length > 1 && series.map((s) => <span key={s.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}
        <button className="ml-auto text-accent" onClick={() => setTable((t) => !t)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {table ? <DataTable headers={['Week', ...series.map((s) => s.name)]} rows={data.map((d) => [d.label, ...d.values.map(format)])} /> : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={label}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={padL} x2={W} y1={y(nice * f)} y2={y(nice * f)} stroke="var(--c-border)" strokeWidth={f === 0 ? 1 : 0.5} />
                <text x={padL - 8} y={y(nice * f) + 4} textAnchor="end" fontSize="11" fill="var(--c-muted)">{format(nice * f)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const gx = padL + i * gw + (gw - (bw + 2) * series.length) / 2;
              return (
                <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={padL + i * gw} y={padT} width={gw} height={H - padT - padB} fill={hover === i ? 'var(--c-surface-2)' : 'transparent'} />
                  {d.values.map((v, s) => {
                    const top = y(v), h = Math.max(0, y(0) - top);
                    return h > 0 ? <path key={s} d={roundedTop(gx + s * (bw + 2), top, bw, h)} fill={series[s].color} /> : null;
                  })}
                  <text x={padL + i * gw + gw / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--c-muted)">{d.label}</text>
                </g>
              );
            })}
          </svg>
          {hover != null && (
            <div className="pointer-events-none absolute top-0 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow" style={{ left: `${((padL + (hover + 0.5) * gw) / W) * 100}%`, transform: 'translateX(-50%)' }}>
              <div className="font-medium">{data[hover].label}</div>
              {series.map((s, k) => <div key={s.name} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}: <span className="tabular-nums">{format(data[hover].values[k])}</span></div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars with direct labels (name left, value right). */
export function HBars({ data, format = fmtMinutes, empty }: { data: { label: string; value: number; color: string; sub?: string }[]; format?: (n: number) => string; empty: string }) {
  if (!data.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2.5">
      {data.map((d) => (
        <li key={d.label} title={`${d.label}: ${format(d.value)}${d.sub ? ` · ${d.sub}` : ''}`}>
          <div className="mb-1 flex justify-between gap-2 text-sm"><span className="truncate">{d.label}</span><span className="shrink-0 tabular-nums text-muted">{format(d.value)}</span></div>
          <div className="h-2 rounded bg-surface-2"><div className="h-2 rounded-r" style={{ width: `${(d.value / max) * 100}%`, background: d.color }} /></div>
          {d.sub && <div className="mt-0.5 text-xs text-muted">{d.sub}</div>}
        </li>
      ))}
    </ul>
  );
}

export function DataTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted"><tr>{headers.map((h) => <th key={h} className="py-1 font-medium">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="py-1 tabular-nums">{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Bar with 4px rounded top, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
