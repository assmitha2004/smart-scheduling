/**
 * Learning the person's timing style from what they actually do, not just what
 * they said: when they finish tasks, how long tasks really take compared with
 * the estimate, how much of a planned day gets done, and which meeting times
 * they accept or turn down.
 *
 * Pure and deterministic. Every conclusion needs a minimum amount of evidence
 * and comes with a plain-language reason, so nothing is "learned" from two
 * data points and the person can see why the assistant behaves as it does.
 */
import type { Peak } from '../day/dayPlan.js';
import type { Learned, MeetingDecision } from './profile.js';

export interface History {
  /** Local minute of the day (0..1439) each recently finished task was completed at. */
  completionMinutes: number[];
  /** Estimated vs actual minutes for finished tasks with tracked time. */
  estimates: { estimated: number; actual: number }[];
  /** For tasks planned on past days: whether each was finished on its planned day. */
  plannedOutcomes: boolean[];
  decisions: MeetingDecision[];
}

export const MIN_COMPLETIONS = 10;
export const MIN_ESTIMATES = 5;
export const MIN_PLANNED = 8;

const PART_LABEL: Record<Peak, string> = { MORNING: 'morning', AFTERNOON: 'afternoon', EVENING: 'evening' };
const partOf = (minute: number): Peak => (minute < 12 * 60 ? 'MORNING' : minute < 17 * 60 ? 'AFTERNOON' : 'EVENING');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;

export function learn(h: History, now: Date = new Date()): Learned {
  const insights: string[] = [];

  // 1. When does the person actually get things done?
  let peak: Peak | null = null;
  let peakEvidence: string | null = null;
  if (h.completionMinutes.length >= MIN_COMPLETIONS) {
    const counts: Record<Peak, number> = { MORNING: 0, AFTERNOON: 0, EVENING: 0 };
    for (const m of h.completionMinutes) counts[partOf(m)]++;
    const ranked = (Object.keys(counts) as Peak[]).sort((a, b) => counts[b] - counts[a]);
    const total = h.completionMinutes.length;
    const top = counts[ranked[0]] / total;
    const second = counts[ranked[1]] / total;
    if (top >= 0.45 && top - second >= 0.1) {
      peak = ranked[0];
      peakEvidence = `You finished ${counts[peak]} of your last ${total} tasks in the ${PART_LABEL[peak]}.`;
      insights.push(`${peakEvidence} I put your hardest work there.`);
    }
  }

  // 2. How accurate are the estimates?
  let estimateFactor: number | null = null;
  let estimateEvidence: string | null = null;
  const usable = h.estimates.filter((e) => e.estimated > 0 && e.actual > 0);
  if (usable.length >= MIN_ESTIMATES) {
    const f = Math.min(2, Math.max(0.6, median(usable.map((e) => e.actual / e.estimated))));
    if (Math.abs(f - 1) >= 0.1) {
      estimateFactor = Math.round(f * 100) / 100;
      const pct = Math.round(Math.abs(f - 1) * 100);
      estimateEvidence = `Across ${usable.length} tasks you tracked, things took about ${pct}% ${f > 1 ? 'longer' : 'less time'} than estimated.`;
      insights.push(`${estimateEvidence} I ${f > 1 ? 'add' : 'trim'} that when planning your day.`);
    }
  }

  // 3. How much of a planned day gets done?
  let completionRate: number | null = null;
  if (h.plannedOutcomes.length >= MIN_PLANNED) {
    completionRate = Math.round((h.plannedOutcomes.filter(Boolean).length / h.plannedOutcomes.length) * 100) / 100;
    if (completionRate < 0.6) insights.push(`You finish about ${Math.round(completionRate * 100)}% of what’s planned for a day, so I keep days lighter and protect your #1 task.`);
    else if (completionRate >= 0.85) insights.push(`You finish ${Math.round(completionRate * 100)}% of what you plan. Nice consistency!`);
  }

  // 4. Meeting times the person says yes / no to.
  const yes = new Map<number, number>();
  const no = new Map<number, number>();
  for (const d of h.decisions) {
    const map = d.choice === 'DECLINE' ? no : yes;
    map.set(d.hour, (map.get(d.hour) ?? 0) + 1);
  }
  const preferredMeetingHours = [...yes.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([hr]) => hr);
  const avoidedMeetingHours = [...no.entries()].filter(([hr, n]) => n >= 2 && !yes.has(hr)).map(([hr]) => hr).sort((a, b) => a - b);
  if (preferredMeetingHours.length) insights.push(`You usually pick meetings around ${preferredMeetingHours.map(hourLabel).join(', ')}, so I suggest those first.`);
  if (avoidedMeetingHours.length) insights.push(`You tend to turn down meetings at ${avoidedMeetingHours.map(hourLabel).join(', ')}, so I avoid suggesting them.`);

  return {
    peak,
    peakEvidence,
    estimateFactor,
    estimateEvidence,
    completionRate,
    preferredMeetingHours,
    avoidedMeetingHours,
    insights,
    updatedAt: now.toISOString(),
  };
}
