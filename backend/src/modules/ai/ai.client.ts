import { z } from 'zod';
import { config } from '../../config.js';
import { findCycle } from '../../engine/index.js';
import { serviceUnavailable } from '../../utils/errors.js';

/**
 * Client for the Python AI service. Every response is validated here as
 * well (defence in depth): AI output is untrusted input.
 */
async function call<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
  let res: Response;
  try {
    res = await fetch(`${config.aiServiceUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.aiServiceToken ? { 'x-internal-token': config.aiServiceToken } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiServiceTimeoutMs),
    });
  } catch (e) {
    throw serviceUnavailable('AI_UNAVAILABLE', 'The AI service is unavailable. You can add tasks manually.', { cause: (e as Error).message, fallback: 'manual' });
  }
  if (!res.ok) {
    throw serviceUnavailable('AI_UNAVAILABLE', `The AI service returned ${res.status}. You can add tasks manually.`, { fallback: 'manual' });
  }
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw serviceUnavailable('AI_INVALID_OUTPUT', 'The AI service returned output that failed validation. You can add tasks manually.', {
      fallback: 'manual',
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

// Loose envelope: individual tasks are validated one by one so a single bad
// item is rejected without discarding the rest (Scenario F).
const rawExtraction = z.object({
  tasks: z.array(z.record(z.string(), z.unknown())).max(50),
  dependencies: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  warnings: z.array(z.string()).default([]),
  provider: z.string(),
});

const MAX_DUE = () => Date.now() + 3 * 365 * 86_400_000;
export const draftTaskSchema = z.object({
  tempId: z.string().min(1).max(64),
  title: z.string().trim().min(1, 'missing title').max(300),
  description: z.string().max(5000).nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(10_000).nullable(),
  dueAt: z
    .string()
    .nullable()
    .refine((s) => s == null || !Number.isNaN(Date.parse(s)), 'invalid date')
    .refine((s) => s == null || (Date.parse(s) > Date.now() - 86_400_000 && Date.parse(s) < MAX_DUE()), 'date out of range'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  confidence: z.number().min(0).max(1).optional(),
});
export type DraftTask = z.infer<typeof draftTaskSchema>;
const draftDepSchema = z.object({ taskTempId: z.string(), dependsOnTempId: z.string() });

export interface ExtractionResult {
  drafts: DraftTask[];
  dependencies: { taskTempId: string; dependsOnTempId: string }[];
  rejected: { index: number; title: string | null; reasons: string[] }[];
  warnings: string[];
  provider: string;
}

export async function extractTasks(text: string, opts: { timezone: string; allowExternal: boolean; now?: Date }): Promise<ExtractionResult> {
  const raw = await call(
    '/extract-tasks',
    { text, timezone: opts.timezone, now: (opts.now ?? new Date()).toISOString(), allow_external: opts.allowExternal },
    rawExtraction,
  );
  const drafts: DraftTask[] = [];
  const rejected: ExtractionResult['rejected'] = [];
  raw.tasks.forEach((t, index) => {
    const r = draftTaskSchema.safeParse(t);
    if (r.success) drafts.push(r.data);
    else rejected.push({ index, title: typeof t.title === 'string' ? t.title : null, reasons: r.error.issues.map((i) => `${i.path.join('.') || 'task'}: ${i.message}`) });
  });
  const ids = new Set(drafts.map((d) => d.tempId));
  const warnings = [...raw.warnings];
  let deps = raw.dependencies
    .map((d) => draftDepSchema.safeParse(d))
    .filter((r) => r.success)
    .map((r) => r.data!)
    .filter((d) => ids.has(d.taskTempId) && ids.has(d.dependsOnTempId) && d.taskTempId !== d.dependsOnTempId);
  if (deps.length < raw.dependencies.length) warnings.push('Some suggested dependencies referred to invalid tasks and were dropped.');
  const cyc = findCycle(ids, deps.map((d) => ({ taskId: d.taskTempId, dependsOnTaskId: d.dependsOnTempId })));
  if (cyc) {
    deps = [];
    warnings.push('Suggested dependencies formed a cycle and were dropped; please add them manually.');
  }
  if (rejected.length) warnings.push(`${rejected.length} suggested task(s) failed validation and were left out.`);
  return { drafts, dependencies: deps, rejected, warnings, provider: raw.provider };
}

const briefingResponse = z.object({ text: z.string().min(1).max(4000), provider: z.string() });

export async function polishBriefing(facts: unknown, allowExternal: boolean) {
  return call('/daily-briefing', { facts, allow_external: allowExternal }, briefingResponse);
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const dayUnderstandingSchema = z.object({
  date: z.enum(['today', 'tomorrow']),
  day_start: hhmm.nullable().optional(),
  day_end: hhmm.nullable().optional(),
  peak: z.enum(['MORNING', 'AFTERNOON', 'EVENING']).nullable().optional(),
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    minutes: z.number().int().min(5).max(720),
    minutes_guessed: z.boolean(),
    must_do: z.boolean(),
    top: z.boolean(),
    effort: z.enum(['EASY', 'MEDIUM', 'HARD']),
    fixed_time: hhmm.nullable().optional(),
    not_before: hhmm.nullable().optional(),
    due_by: hhmm.nullable().optional(),
  })).max(30),
  notes: z.array(z.string().max(300)).max(5).default([]),
});
const understandResponse = z.object({ provider: z.string(), understanding: dayUnderstandingSchema.nullable().optional() });

/** The model's reading of a day description, or null when no model is enabled/allowed (use the rules instead). */
export async function understandDayWithAi(text: string, now: Date, allowExternal: boolean) {
  if (!allowExternal && !(await aiStatus()).local) return null;
  const r = await call('/understand-day', { text, now: now.toISOString(), allow_external: allowExternal }, understandResponse);
  return r.provider !== 'rules' && r.understanding ? r.understanding : null;
}

const planChatResponse = z.object({
  provider: z.string(),
  result: z.object({
    reply: z.string().min(1).max(3000),
    spec: z.record(z.string(), z.unknown()),
    question: z.object({ text: z.string().min(1).max(500), options: z.array(z.string().min(1).max(80)).max(6).default([]) }).nullable().optional(),
    suggestions: z.array(z.object({ text: z.string().min(1).max(400), action: z.string().min(1).max(200) })).max(4).default([]),
    ready: z.boolean().default(false),
    finalize: z.boolean().default(false),
  }).nullable().optional(),
});

/**
 * One turn of the planner chat with the model, or null when no model is enabled
 * or allowed (the built-in chat answers instead). The returned plan is still
 * validated by the caller.
 */
export async function planChatWithAi(input: { history: { role: 'user' | 'assistant'; text: string }[]; message: string; spec: unknown; today: string; now: string; defaults: unknown }, allowExternal: boolean) {
  if (!allowExternal && !(await aiStatus()).local) return null;
  const r = await call('/plan-chat', { ...input, allow_external: allowExternal }, planChatResponse);
  return r.provider !== 'rules' && r.result ? r.result : null;
}

// ---------- which model is running ----------

export interface AiStatus {
  /** "ollama" (self-hosted open-source model), "anthropic" or "rules" (no model). */
  provider: string;
  model: string | null;
  /** The model runs on our own infrastructure (no consent needed). */
  local: boolean;
  reachable: boolean;
}

let statusCache: { at: number; value: AiStatus } | null = null;
const healthSchema = z.object({
  provider: z.string().optional(),
  externalProvider: z.string().nullable().optional(),
  local: z.boolean().optional(),
  model: z.string().nullable().optional(),
  ollama: z.object({ reachable: z.boolean(), modelPulled: z.boolean() }).optional(),
});

/** The AI service's provider, cached for a minute. */
export async function aiStatus(): Promise<AiStatus> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  let value: AiStatus = { provider: 'rules', model: null, local: false, reachable: false };
  try {
    const res = await fetch(`${config.aiServiceUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const h = healthSchema.safeParse(await res.json());
    if (res.ok && h.success) {
      const provider = h.data.provider ?? h.data.externalProvider ?? 'rules';
      const reachable = provider === 'ollama' ? h.data.ollama?.reachable !== false && h.data.ollama?.modelPulled !== false : true;
      value = { provider, model: h.data.model ?? null, local: !!h.data.local, reachable };
    }
  } catch {
    // AI service down: the built-in rules answer.
  }
  statusCache = { at: Date.now(), value };
  return value;
}

export function resetAiStatusCache() {
  statusCache = null;
}

/** May this user's text go to the configured model? Self-hosted: yes; external: only with consent. */
export async function modelAllowed(user: { aiExternalConsent: boolean }): Promise<boolean> {
  const s = await aiStatus();
  if (s.provider === 'rules' || !s.reachable) return false;
  return s.local || user.aiExternalConsent;
}

// ---------- assistant ----------

const hhmmOpt = hhmm.nullable().optional();
export const assistantChatSchema = z.object({
  intent: z.enum(['PLAN_DAY', 'AGENDA', 'CHECK_INBOX', 'ADD_TASKS', 'PROFILE', 'HELP']),
  profile: z
    .object({
      wake_time: hhmmOpt,
      sleep_time: hhmmOpt,
      work_start: hhmmOpt,
      work_end: hhmmOpt,
      work_days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
      chronotype: z.enum(['EARLY_BIRD', 'DAYTIME', 'NIGHT_OWL']).nullable().optional(),
      focus_minutes: z.number().int().min(20).max(180).nullable().optional(),
      meetings_earliest: hhmmOpt,
      meetings_latest: hhmmOpt,
      max_meetings_per_day: z.number().int().min(1).max(15).nullable().optional(),
      meeting_buffer_minutes: z.number().int().min(0).max(60).nullable().optional(),
    })
    .default({}),
  day: z.enum(['today', 'tomorrow']).nullable().optional(),
  tasks_text: z.string().max(1000).nullable().optional(),
  reply: z.string().min(1).max(800),
});
export type AssistantChatResult = z.infer<typeof assistantChatSchema>;

export async function assistantChatWithAi(input: { message: string; history: { role: 'user' | 'assistant'; text: string }[]; profile: string[]; agenda: string[]; now: string }, allowExternal: boolean) {
  const r = await call('/assistant/chat', { ...input, allow_external: allowExternal }, z.object({ provider: z.string(), result: assistantChatSchema.nullable().optional() }));
  return r.provider !== 'rules' && r.result ? { provider: r.provider, result: r.result } : null;
}

export const meetingRequestSchema = z.object({
  id: z.string(),
  is_meeting_request: z.boolean(),
  title: z.string().trim().min(1).max(200),
  duration_minutes: z.number().int().min(10).max(240),
  proposed_times: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/)).max(5).default([]),
  prefer_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  prefer_part: z.enum(['MORNING', 'AFTERNOON', 'EVENING']).nullable().optional(),
  summary: z.string().max(300).default(''),
});
export type MeetingRequestAi = z.infer<typeof meetingRequestSchema>;

export async function meetingRequestsWithAi(input: { emails: { id: string; from_name: string | null; from_email: string; subject: string; body: string; date: string }[]; timezone: string; now: string }, allowExternal: boolean) {
  const r = await call('/assistant/meeting-requests', { ...input, allow_external: allowExternal }, z.object({ provider: z.string(), results: z.array(z.record(z.string(), z.unknown())).nullable().optional() }));
  if (r.provider === 'rules' || !r.results) return null;
  // Validate item by item: one bad result doesn't throw the rest away.
  return { provider: r.provider, results: r.results.map((x) => meetingRequestSchema.safeParse(x)).filter((x) => x.success).map((x) => x.data!) };
}

export async function draftReplyWithAi(input: { kind: 'CONFIRM' | 'DECLINE' | 'PROPOSE'; to_name: string | null; my_name: string; subject: string; original: string; time_label: string | null; alternatives: string[] }, allowExternal: boolean) {
  const r = await call('/assistant/draft-reply', { ...input, allow_external: allowExternal }, z.object({ provider: z.string(), text: z.string().min(1).max(1500).nullable().optional() }));
  return r.provider !== 'rules' && r.text ? r.text : null;
}
