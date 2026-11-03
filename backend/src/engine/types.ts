/**
 * Pure data types for the scheduling engine.
 *
 * The engine has no database, network or clock dependencies: every input
 * (including "now") is passed in explicitly so results are deterministic
 * and unit-testable. All instants are UTC epoch milliseconds.
 */

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

export interface EngineTask {
  id: string;
  title: string;
  projectId?: string;
  /** Total estimate in minutes. */
  estimatedMinutes: number;
  /** Minutes already logged; remaining = estimate - actual (min 0). */
  actualMinutes?: number;
  priority: Priority;
  status: TaskStatus;
  earliestStartAt?: number | null;
  dueAt?: number | null;
  createdAt?: number;
  /** Whether the task may be split across several work blocks. */
  splittable?: boolean;
  /**
   * Prerequisites outside this schedule (e.g. assigned to a teammate).
   * `readyAt` is their planned finish, or null if they are not planned yet.
   */
  externalPrereqs?: { taskId: string; title: string; readyAt: number | null }[];
}

/** Finish-to-start: `taskId` cannot start until `dependsOnTaskId` is complete. */
export interface EngineDependency {
  taskId: string;
  dependsOnTaskId: string;
}

export interface Interval {
  start: number;
  end: number;
}

export interface AvailabilityRule {
  /** 0 = Sunday ... 6 = Saturday (JS convention). */
  weekday: number;
  /** Local wall-clock time "HH:mm" in the user's timezone. */
  startTime: string;
  endTime: string;
  isActive?: boolean;
}

export type CalendarEventType = 'FIXED' | 'BREAK' | 'UNAVAILABLE';

export interface FixedEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  eventType: CalendarEventType;
}

/** A block already committed to the calendar for a task. */
export interface ExistingBlock {
  id?: string;
  taskId: string;
  start: number;
  end: number;
}

export interface RankingWeights {
  priority: Record<Priority, number>;
  /** Max points awarded when a deadline is imminent. */
  urgency: number;
  /** Urgency decays to zero over this many days. */
  urgencyHorizonDays: number;
  criticalPathBonus: number;
  /** Points per transitively-blocked downstream task. */
  blockerImpactPerTask: number;
  blockerImpactCap: number;
  /** Points per day of age. */
  agePerDay: number;
  ageCap: number;
}

export interface ScheduleOptions {
  allowSplitting: boolean;
  /** Smallest useful block when splitting a task. */
  minBlockMinutes: number;
  /** Preferred maximum focus-block length. */
  maxBlockMinutes: number;
  horizonDays: number;
  weights: RankingWeights;
}

export interface ScheduleInput {
  now: number;
  timezone: string;
  tasks: EngineTask[];
  dependencies: EngineDependency[];
  availability: AvailabilityRule[];
  events: FixedEvent[];
  /**
   * Blocks that must be preserved (e.g. unaffected work during re-planning).
   * They consume capacity and count as the scheduled time for their task.
   */
  lockedBlocks?: ExistingBlock[];
  options?: Partial<ScheduleOptions>;
}

export interface ProposedBlock {
  taskId: string;
  startAt: number;
  endAt: number;
  locked?: boolean;
}

export interface TaskRanking {
  taskId: string;
  score: number;
  factors: {
    priority: number;
    urgency: number;
    criticalPath: number;
    blockerImpact: number;
    age: number;
  };
  reasons: string[];
}

export type WarningCode =
  | 'DEADLINE_MISSED'
  | 'PREREQUISITE_UNSCHEDULED'
  | 'INSUFFICIENT_CAPACITY'
  | 'NO_CONTIGUOUS_SLOT'
  | 'PAST_DUE'
  | 'NO_ESTIMATE';

export interface ScheduleWarning {
  taskId: string;
  code: WarningCode;
  reason: string;
}

export interface UnscheduledTask {
  taskId: string;
  code: WarningCode;
  reason: string;
}

export interface TaskExplanation {
  taskId: string;
  title: string;
  rank: number;
  score: number;
  earliestPossibleStart: number;
  plannedStart: number | null;
  plannedFinish: number | null;
  onCriticalPath: boolean;
  reasons: string[];
}

export interface ScheduleResult {
  ok: boolean;
  proposedBlocks: ProposedBlock[];
  unscheduledTasks: UnscheduledTask[];
  warnings: ScheduleWarning[];
  conflicts: { code: 'DEPENDENCY_CYCLE' | 'INVALID_INPUT'; message: string; details?: unknown }[];
  explanations: TaskExplanation[];
  criticalPath: string[];
  summary: {
    availableMinutes: number;
    scheduledMinutes: number;
    remainingMinutes: number;
    horizonStart: number;
    horizonEnd: number;
    projectedFinish: number | null;
  };
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  priority: { LOW: 10, MEDIUM: 25, HIGH: 45, URGENT: 70 },
  urgency: 50,
  urgencyHorizonDays: 14,
  criticalPathBonus: 20,
  blockerImpactPerTask: 6,
  blockerImpactCap: 30,
  agePerDay: 0.5,
  ageCap: 10,
};

export const DEFAULT_OPTIONS: ScheduleOptions = {
  allowSplitting: true,
  minBlockMinutes: 30,
  maxBlockMinutes: 120,
  horizonDays: 28,
  weights: DEFAULT_WEIGHTS,
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function remainingMinutes(t: EngineTask): number {
  if (t.status === 'DONE' || t.status === 'CANCELLED') return 0;
  return Math.max(0, t.estimatedMinutes - (t.actualMinutes ?? 0));
}

export function isComplete(t: EngineTask): boolean {
  return t.status === 'DONE' || t.status === 'CANCELLED';
}
