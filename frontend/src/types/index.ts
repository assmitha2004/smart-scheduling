export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type RiskStatus = 'ON_TRACK' | 'AT_RISK' | 'INFEASIBLE' | 'OVERDUE' | 'DONE';

export interface NotificationPrefs {
  taskReminders: boolean;
  deadlineRisk: boolean;
  dependencyUnblocked: boolean;
  dailyPlan: boolean;
  reminderLeadMinutes: number;
  dailyPlanHour: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  timezone: string;
  focusBlockMinutes: number;
  allowTaskSplitting: boolean;
  onboarded: boolean;
  scheduleVersion: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  notificationPrefs: NotificationPrefs;
  aiExternalConsent: boolean;
}

export interface Workspace { id: string; name: string; role: string; projectCount: number; memberCount: number }

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  color: string;
  startDate: string | null;
  targetDate: string | null;
  status: string;
  taskCount?: number;
  doneCount?: number;
  remainingMinutes?: number;
}

export interface Task {
  id: string;
  projectId: string;
  assigneeId: string | null;
  assignee: { id: string; name: string } | null;
  title: string;
  description: string | null;
  estimatedMinutes: number;
  actualMinutes: number;
  priority: Priority;
  status: TaskStatus;
  splittable: boolean;
  earliestStartAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  dependsOn?: string[];
}

export interface AvailabilityRule { id?: string; weekday: number; startTime: string; endTime: string; isActive?: boolean }

export interface CalendarEvent { id: string; title: string; startAt: string; endAt: string; eventType: 'FIXED' | 'BREAK' | 'UNAVAILABLE' }

export interface CalendarBlock {
  id: string;
  taskId: string;
  startAt: string;
  endAt: string;
  status: 'CONFIRMED' | 'COMPLETED';
  title: string;
  taskStatus: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  projectId: string;
  projectName: string;
  color: string;
}

export interface CalendarData {
  timezone: string;
  scheduleVersion: number;
  events: CalendarEvent[];
  blocks: CalendarBlock[];
  workingHours: { startAt: string; endAt: string }[];
}

export interface Recommendation { type: string; message: string; value?: number | string }

export interface DeadlineRisk {
  id: string;
  kind: 'task' | 'project';
  title: string;
  dueAt: string;
  status: RiskStatus;
  requiredMinutes: number;
  availableMinutes: number;
  shortfallMinutes: number;
  utilization: number | null;
  plannedFinish: string | null;
  contributors: { taskId: string; title: string; remainingMinutes: number; onCriticalPath: boolean }[];
  recommendations: Recommendation[];
  assumptions: string[];
  explanation: string;
}

export interface ProposedBlock {
  taskId: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  color: string | null;
  startAt: string;
  endAt: string;
  locked: boolean;
}

export interface Explanation {
  taskId: string;
  title: string;
  rank: number;
  score: number;
  earliestPossibleStart: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  onCriticalPath: boolean;
  reasons: string[];
}

export interface SchedulePreview {
  recommendationId: string | null;
  scheduleVersion: number;
  ok: boolean;
  proposedBlocks: ProposedBlock[];
  unscheduledTasks: { taskId: string; title: string; code: string; reason: string }[];
  warnings: { taskId: string; title: string; code: string; reason: string }[];
  conflicts: { code: string; message: string; details?: unknown }[];
  explanations: Explanation[];
  criticalPath: { taskId: string; title: string }[];
  summary: { availableMinutes: number; scheduledMinutes: number; remainingMinutes: number; horizonStart: string; horizonEnd: string; projectedFinish: string | null };
  risks: DeadlineRisk[];
}

export interface DiffEntry {
  taskId: string;
  title: string;
  change: 'MOVED' | 'ADDED' | 'REMOVED' | 'UNCHANGED';
  before: { startAt: string; endAt: string }[];
  after: { startAt: string; endAt: string }[];
  finishShiftMinutes: number | null;
}

export interface ReplanPreview extends SchedulePreview {
  changedTaskIds: string[];
  affectedTasks: { taskId: string; title: string }[];
  impactChain: string[];
  diff: DiffEntry[];
  impact: {
    previousFinish: string | null;
    newFinish: string | null;
    shiftMinutes: number | null;
    byProject: { projectId: string; projectName: string; previousFinish: string | null; newFinish: string | null }[];
  };
}

export interface Briefing {
  date: string;
  timezone: string;
  suggestedFirstTask: { taskId: string; title: string; why: string } | null;
  topTasks: {
    taskId: string; title: string; score: number; reasons: string[]; remainingMinutes: number;
    dueAt: string | null; onCriticalPath: boolean; suggestedBlock: { startAt: string; endAt: string } | null;
  }[];
  blockedTasks: { taskId: string; title: string; blockedBy: { taskId: string; title: string }[] }[];
  upcomingDeadlines: { id: string; title: string; kind: string; dueAt: string; status: RiskStatus }[];
  atRisk: { id: string; title: string; status: RiskStatus; explanation: string }[];
  unscheduledWork: { taskId: string; title: string; reason: string }[];
  capacity: { availableMinutesToday: number; scheduledMinutesToday: number; remainingMinutesToday: number };
  narrative: string;
}

export interface TimelineTask extends Task {
  startAt: string;
  endAt: string;
  planned: boolean;
  progress: number;
  critical: boolean;
  slackMinutes: number;
  flags: { late: boolean; blocked: boolean; atRisk: boolean };
  blockedBy: { id: string; title: string }[];
}

export interface Timeline {
  project: Project;
  tasks: TimelineTask[];
  dependencies: { id: string; taskId: string; dependsOnTaskId: string }[];
  milestones: { id: string; name: string; dueAt: string }[];
  criticalPath: string[];
  projectedFinish: string | null;
  targetAtRisk: boolean;
}

export interface Notification { id: string; type: string; message: string; data: unknown; readAt: string | null; createdAt: string }

export interface DraftTask {
  tempId: string;
  title: string;
  description?: string | null;
  estimatedMinutes: number | null;
  dueAt: string | null;
  priority: Priority;
  confidence?: number;
}

export interface ApiErrorBody { code: string; message: string; details?: unknown }
