import { replan, type ScheduleResult } from '../../engine/index.js';
import type { ScheduleContext } from './scheduling.service.js';

/**
 * The user's *current* plan: committed blocks stay exactly where they are
 * (locked), and any work without blocks is placed around them. Used for
 * briefings and analytics so they describe what the user agreed to.
 */
export function currentPlan(ctx: ScheduleContext): ScheduleResult {
  return replan({ input: ctx.input, previousBlocks: ctx.futureBlocks, changedTaskIds: [] }).schedule;
}
