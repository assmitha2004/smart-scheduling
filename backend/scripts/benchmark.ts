/**
 * Measures schedule generation, cycle detection and constraint satisfaction
 * on synthetic projects of 100 / 500 / 1,000 tasks.
 *   npm run benchmark
 */
import { performance } from 'node:perf_hooks';
import {
  expandAvailability,
  findCycle,
  findOverlaps,
  generateSchedule,
  type EngineDependency,
  type EngineTask,
  type ScheduleInput,
} from '../src/engine/index.js';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function project(n: number, seed = 42): { tasks: EngineTask[]; deps: EngineDependency[] } {
  const r = rng(seed);
  const prios = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
  const tasks: EngineTask[] = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    estimatedMinutes: 30 + Math.floor(r() * 8) * 30,
    priority: prios[Math.floor(r() * 4)],
    status: 'TODO',
    dueAt: r() < 0.3 ? Date.UTC(2026, 10, 2) + Math.floor(r() * 120) * 86_400_000 : null,
    createdAt: Date.UTC(2026, 9, 1),
  }));
  const deps: EngineDependency[] = [];
  for (let i = 1; i < n; i++) {
    const k = Math.floor(r() * 3);
    for (let j = 0; j < k; j++) deps.push({ taskId: `t${i}`, dependsOnTaskId: `t${Math.floor(r() * i)}` });
  }
  const seen = new Set<string>();
  return { tasks, deps: deps.filter((d) => (seen.has(d.taskId + d.dependsOnTaskId) ? false : (seen.add(d.taskId + d.dependsOnTaskId), true))) };
}

function verify(input: ScheduleInput, res: ReturnType<typeof generateSchedule>): boolean {
  const end = new Map<string, number>();
  const start = new Map<string, number>();
  for (const b of res.proposedBlocks) {
    end.set(b.taskId, Math.max(end.get(b.taskId) ?? -Infinity, b.endAt));
    start.set(b.taskId, Math.min(start.get(b.taskId) ?? Infinity, b.startAt));
  }
  for (const d of input.dependencies) {
    if (start.has(d.taskId) && !(start.get(d.taskId)! >= end.get(d.dependsOnTaskId)!)) return false;
  }
  const working = expandAvailability(input.availability, input.timezone, res.summary.horizonStart, res.summary.horizonEnd);
  for (const b of res.proposedBlocks) if (!working.some((w) => w.start <= b.startAt && b.endAt <= w.end)) return false;
  return findOverlaps(res.proposedBlocks.map((b) => ({ start: b.startAt, end: b.endAt }))).length === 0;
}

const availability = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: '09:00', endTime: '12:00' },
  { weekday, startTime: '13:00', endTime: '18:00' },
]);

console.log('| Tasks | Deps | Cycle check (ms) | Schedule (ms, median of 5) | Blocks | Unscheduled | Constraints satisfied |');
console.log('|---|---|---|---|---|---|---|');
for (const n of [100, 500, 1000]) {
  const { tasks, deps } = project(n);
  const input: ScheduleInput = {
    now: Date.UTC(2026, 10, 2, 8),
    timezone: 'UTC',
    tasks,
    dependencies: deps,
    availability,
    events: [],
    options: { horizonDays: 365 },
  };
  const c0 = performance.now();
  findCycle(tasks.map((t) => t.id), deps);
  const cycleMs = performance.now() - c0;
  const times: number[] = [];
  let res = generateSchedule(input);
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    res = generateSchedule(input);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(
    `| ${n} | ${deps.length} | ${cycleMs.toFixed(2)} | ${times[2].toFixed(1)} | ${res.proposedBlocks.length} | ${res.unscheduledTasks.length} | ${verify(input, res) ? 'yes' : 'NO'} |`,
  );
}
