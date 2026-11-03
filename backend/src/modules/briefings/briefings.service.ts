import { buildDailyBriefing, type DailyBriefing } from '../../engine/index.js';
import { loadScheduleContext, computeRisks } from '../scheduling/scheduling.service.js';
import { currentPlan } from '../scheduling/plan.js';
import { polishBriefing } from '../ai/ai.client.js';

export function serializeBriefing(b: DailyBriefing) {
  const isoOrNull = (n: number | null) => (n == null ? null : new Date(n).toISOString());
  return {
    ...b,
    topTasks: b.topTasks.map((t) => ({
      ...t,
      dueAt: isoOrNull(t.dueAt),
      suggestedBlock: t.suggestedBlock
        ? { startAt: new Date(t.suggestedBlock.startAt).toISOString(), endAt: new Date(t.suggestedBlock.endAt).toISOString() }
        : null,
    })),
    upcomingDeadlines: b.upcomingDeadlines.map((d) => ({ ...d, dueAt: new Date(d.dueAt).toISOString() })),
  };
}

/**
 * Daily priority summary. All facts come from the deterministic engine;
 * the AI service (optional) only rewrites `narrative` and must stay grounded.
 */
export async function getDailyBriefing(userId: string, opts: { ai?: boolean; now?: number } = {}) {
  const ctx = await loadScheduleContext(userId, opts.now ?? Date.now());
  const schedule = currentPlan(ctx);
  const risks = computeRisks(ctx, schedule.ok ? schedule : undefined);
  const briefing = serializeBriefing(buildDailyBriefing({ input: ctx.input, schedule, risks }));
  let narrative = briefing.narrative;
  let narrativeSource: string = 'engine';
  let aiError: string | undefined;
  if (opts.ai) {
    try {
      const polished = await polishBriefing(briefing, ctx.user.aiExternalConsent);
      narrative = polished.text;
      narrativeSource = polished.provider;
    } catch (e) {
      aiError = (e as Error).message;
    }
  }
  return { briefing, narrative, narrativeSource, aiError, conflicts: schedule.conflicts };
}
