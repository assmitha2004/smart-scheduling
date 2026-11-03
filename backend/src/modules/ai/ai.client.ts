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
      headers: { 'content-type': 'application/json' },
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
