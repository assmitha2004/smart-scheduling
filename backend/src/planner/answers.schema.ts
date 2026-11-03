/** Validation for the answers to the "Plan my time" questions (POST /planner/setup). */
import { z } from 'zod';

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:mm');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const weekdays = z.array(z.number().int().min(0).max(6)).max(7);
const title = z.string().trim().min(1).max(120);
const slot = z
  .object({ title, weekdays: weekdays.min(1), start: hm, end: hm })
  .refine((s) => s.end > s.start, 'End time must be after start time');

export const answersSchema = z.object({
  persona: z.enum(['STUDENT', 'WORK', 'HYBRID']),
  horizon: z.enum(['DAY', 'WEEK', 'MONTH']).default('WEEK'),
  wakeTime: hm,
  sleepTime: hm,
  chronotype: z.enum(['EARLY_BIRD', 'DAYTIME', 'NIGHT_OWL']).default('DAYTIME'),
  focusMinutes: z.number().int().min(25).max(180).default(50),
  meals: z.object({ breakfast: hm.nullable().optional(), lunch: hm.nullable().optional(), dinner: hm.nullable().optional() }).default({}),
  commuteMinutes: z.number().int().min(0).max(240).default(0),
  daysOff: weekdays.default([]),
  activities: z.array(slot).max(20).default([]),
  habits: z.array(z.object({ title, minutes: z.number().int().min(5).max(240), weekdays: weekdays.min(1) })).max(10).default([]),
  classes: z.array(slot).max(40).default([]),
  subjects: z.array(z.object({ name: title, difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]) })).max(20).default([]),
  exams: z.array(z.object({ subject: title, date })).max(20).default([]),
  assignments: z.array(z.object({ title, dueDate: date, hours: z.number().min(0.25).max(100) })).max(30).default([]),
  studyHoursPerDay: z.number().min(0).max(14).default(3),
  workDays: weekdays.default([1, 2, 3, 4, 5]),
  workStart: hm.default('09:00'),
  workEnd: hm.default('17:00'),
  meetings: z.array(slot).max(30).default([]),
  workTasks: z.array(z.object({ title, hours: z.number().min(0.25).max(200), dueDate: date.nullable().optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM') })).max(40).default([]),
});

