import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  analyzeDeadline,
  buildDailyBriefing,
  computeCriticalPath,
  computeFreeIntervals,
  cycleIfAdded,
  CycleError,
  descendants,
  expandAvailability,
  findCycle,
  findOverlaps,
  generateSchedule,
  mergeIntervals,
  overlaps,
  replan,
  scoreTask,
  subtractIntervals,
  topologicalSort,
  totalMinutes,
  type AvailabilityRule,
  type EngineDependency,
  type EngineTask,
  type ScheduleInput,
} from '../../src/engine/index.js';

const TZ = 'UTC';
const H = 3_600_000;
const M = 60_000;
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();

// Monday 2 Nov 2026 08:00 UTC.
const MONDAY = at('2026-11-02T08:00');

/** 2h on weekdays (18:00-20:00), 5h on Saturday (10:00-15:00) — the spec's example. */
const SPEC_AVAILABILITY: AvailabilityRule[] = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '18:00', endTime: '20:00' })),
  { weekday: 6, startTime: '10:00', endTime: '15:00' },
];

const task = (id: string, minutes: number, extra: Partial<EngineTask> = {}): EngineTask => ({
  id,
  title: id,
  estimatedMinutes: minutes,
  priority: 'MEDIUM',
  status: 'TODO',
  ...extra,
});

// The spec's website-launch example.
const launchTasks: EngineTask[] = [
  task('schema', 180, { title: 'Design database schema', projectId: 'web' }),
  task('api', 360, { title: 'Build backend APIs', projectId: 'web' }),
  task('frontend', 300, { title: 'Build frontend', projectId: 'web' }),
  task('testing', 180, { title: 'Integration testing', projectId: 'web' }),
  task('deploy', 60, { title: 'Deployment', projectId: 'web' }),
];
const launchDeps: EngineDependency[] = [
  { taskId: 'api', dependsOnTaskId: 'schema' },
  { taskId: 'frontend', dependsOnTaskId: 'api' },
  { taskId: 'testing', dependsOnTaskId: 'api' },
  { taskId: 'testing', dependsOnTaskId: 'frontend' },
  { taskId: 'deploy', dependsOnTaskId: 'testing' },
];

const launchInput = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  now: MONDAY,
  timezone: TZ,
  tasks: launchTasks,
  dependencies: launchDeps,
  availability: SPEC_AVAILABILITY,
  events: [],
  ...over,
});

describe('dependency graph', () => {
  it('detects the A -> B -> C -> A cycle (Scenario A)', () => {
    const deps = [
      { taskId: 'A', dependsOnTaskId: 'B' },
      { taskId: 'B', dependsOnTaskId: 'C' },
      { taskId: 'C', dependsOnTaskId: 'A' },
    ];
    const cycle = findCycle(['A', 'B', 'C'], deps)!;
    expect(cycle).not.toBeNull();
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['A', 'B', 'C']));
    // Each consecutive pair must be a real "depends on" edge.
    for (let i = 0; i < cycle.length - 1; i++) {
      expect(deps).toContainEqual({ taskId: cycle[i], dependsOnTaskId: cycle[i + 1] });
    }
  });

  it('returns null for a DAG and flags a would-be cycle before saving', () => {
    expect(findCycle(['schema', 'api'], launchDeps)).toBeNull();
    expect(cycleIfAdded(launchDeps, 'schema', 'deploy')).not.toBeNull();
    expect(cycleIfAdded(launchDeps, 'deploy', 'schema')).toBeNull();
    expect(cycleIfAdded([], 'x', 'x')).toEqual(['x', 'x']);
  });

  it('topologically sorts prerequisites first', () => {
    const order = topologicalSort(launchTasks.map((t) => t.id), launchDeps);
    for (const d of launchDeps) {
      expect(order.indexOf(d.dependsOnTaskId)).toBeLessThan(order.indexOf(d.taskId));
    }
    expect(() => topologicalSort(['a', 'b'], [{ taskId: 'a', dependsOnTaskId: 'b' }, { taskId: 'b', dependsOnTaskId: 'a' }])).toThrow(CycleError);
  });

  it('finds all downstream tasks of a delay', () => {
    expect(descendants(['api'], launchDeps)).toEqual(new Set(['frontend', 'testing', 'deploy']));
  });

  it('handles large chains without stack overflow', () => {
    const n = 20_000;
    const ids = Array.from({ length: n }, (_, i) => `t${i}`);
    const deps = ids.slice(1).map((id, i) => ({ taskId: id, dependsOnTaskId: ids[i] }));
    expect(findCycle(ids, deps)).toBeNull();
    expect(findCycle(ids, [...deps, { taskId: 't0', dependsOnTaskId: `t${n - 1}` }])).toHaveLength(n + 1);
  });
});

describe('critical path', () => {
  it('computes the longest chain and slack', () => {
    const tasks = [task('a', 60), task('b', 120), task('c', 30), task('d', 60)];
    const deps = [
      { taskId: 'b', dependsOnTaskId: 'a' },
      { taskId: 'c', dependsOnTaskId: 'a' },
      { taskId: 'd', dependsOnTaskId: 'b' },
      { taskId: 'd', dependsOnTaskId: 'c' },
    ];
    const cpm = computeCriticalPath(tasks, deps);
    expect(cpm.projectDuration).toBe(240);
    expect(cpm.criticalPath).toEqual(['a', 'b', 'd']);
    expect(cpm.nodes.get('c')!.slack).toBe(90);
    expect(cpm.criticalTaskIds.has('c')).toBe(false);
  });

  it('ignores completed work', () => {
    const cpm = computeCriticalPath([task('a', 600, { status: 'DONE' }), task('b', 60)], [{ taskId: 'b', dependsOnTaskId: 'a' }]);
    expect(cpm.projectDuration).toBe(60);
    expect(cpm.criticalPath).toEqual(['b']);
  });
});

describe('intervals', () => {
  it('detects overlap with half-open semantics', () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 15 })).toBe(false);
  });

  it('merges and subtracts', () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 0, end: 5 }, { start: 10, end: 12 }])).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 12 },
    ]);
    expect(
      subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 90, end: 120 }]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 90 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 0, end: 10 }])).toEqual([]);
  });

  it('finds every overlapping pair', () => {
    const pairs = findOverlaps([
      { id: 1, start: 0, end: 10 },
      { id: 2, start: 5, end: 7 },
      { id: 3, start: 10, end: 12 },
    ]);
    expect(pairs.map(([a, b]) => [a.id, b.id])).toEqual([[1, 2]]);
  });
});

describe('available time', () => {
  it('expands weekly rules and subtracts events', () => {
    const week = expandAvailability(SPEC_AVAILABILITY, TZ, MONDAY, MONDAY + 7 * 24 * H);
    expect(totalMinutes(week)).toBe(5 * 120 + 300);
    const free = computeFreeIntervals({
      rules: SPEC_AVAILABILITY,
      timezone: TZ,
      from: MONDAY,
      to: MONDAY + 7 * 24 * H,
      events: [{ id: 'e', title: 'Dinner', start: at('2026-11-02T18:30'), end: at('2026-11-02T19:00'), eventType: 'FIXED' }],
    });
    expect(totalMinutes(free)).toBe(5 * 120 + 300 - 30);
  });

  it('respects local time across a DST change', () => {
    const rules = [{ weekday: 1, startTime: '09:00', endTime: '10:00' }];
    const from = DateTime.fromISO('2026-10-19T00:00', { zone: 'Europe/London' }).toMillis();
    const ivs = expandAvailability(rules, 'Europe/London', from, from + 14 * 24 * H);
    // 26 Oct is after the clocks go back: 09:00 local is 08:00 UTC before, 09:00 UTC after.
    expect(ivs.map((i) => new Date(i.start).toISOString())).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ]);
  });
});

describe('ranking', () => {
  it('scores priority, urgency, critical path and blocker impact transparently', () => {
    const r = scoreTask(task('x', 60, { priority: 'HIGH', dueAt: MONDAY + 2 * 24 * H }), {
      now: MONDAY,
      criticalTaskIds: new Set(['x']),
      downstreamCounts: new Map([['x', 3]]),
    });
    expect(r.factors.priority).toBe(45);
    expect(r.factors.criticalPath).toBe(20);
    expect(r.factors.blockerImpact).toBe(18);
    expect(r.factors.urgency).toBeGreaterThan(40);
    expect(r.score).toBeCloseTo(r.factors.priority + r.factors.urgency + r.factors.criticalPath + r.factors.blockerImpact + r.factors.age, 5);
    expect(r.reasons.join(' ')).toMatch(/critical path/);
  });
});

describe('scheduler', () => {
  it('schedules the website launch respecting dependencies and availability', () => {
    const res = generateSchedule(launchInput());
    expect(res.ok).toBe(true);
    expect(res.unscheduledTasks).toEqual([]);
    const finishOf = (id: string) => Math.max(...res.proposedBlocks.filter((b) => b.taskId === id).map((b) => b.endAt));
    const startOf = (id: string) => Math.min(...res.proposedBlocks.filter((b) => b.taskId === id).map((b) => b.startAt));
    for (const d of launchDeps) expect(startOf(d.taskId)).toBeGreaterThanOrEqual(finishOf(d.dependsOnTaskId));

    // Every block lies inside working hours and none overlap.
    const working = expandAvailability(SPEC_AVAILABILITY, TZ, MONDAY, MONDAY + 28 * 24 * H);
    for (const b of res.proposedBlocks) {
      expect(working.some((w) => w.start <= b.startAt && b.endAt <= w.end)).toBe(true);
    }
    expect(findOverlaps(res.proposedBlocks.map((b) => ({ start: b.startAt, end: b.endAt })))).toEqual([]);
    const total = res.proposedBlocks.reduce((s, b) => s + (b.endAt - b.startAt), 0) / M;
    expect(total).toBe(1080);
    expect(res.criticalPath).toEqual(['schema', 'api', 'frontend', 'testing', 'deploy']);
    expect(res.explanations.find((e) => e.taskId === 'api')!.reasons.join(' ')).toMatch(/waits for "Design database schema"/);
  });

  it('reports a cycle instead of producing a schedule', () => {
    const res = generateSchedule(
      launchInput({ dependencies: [...launchDeps, { taskId: 'schema', dependsOnTaskId: 'deploy' }] }),
    );
    expect(res.ok).toBe(false);
    expect(res.conflicts[0].code).toBe('DEPENDENCY_CYCLE');
    expect(res.proposedBlocks).toEqual([]);
  });

  it('never overwrites fixed events', () => {
    const events = [{ id: 'e', title: 'Class', start: at('2026-11-02T18:00'), end: at('2026-11-02T19:00'), eventType: 'FIXED' as const }];
    const res = generateSchedule(launchInput({ events }));
    for (const b of res.proposedBlocks) expect(overlaps({ start: b.startAt, end: b.endAt }, events[0])).toBe(false);
  });

  it('reports capacity shortfall instead of fabricating a schedule (Scenario D)', () => {
    const res = generateSchedule({
      now: MONDAY,
      timezone: TZ,
      tasks: [task('big', 300), task('after', 30)],
      dependencies: [{ taskId: 'after', dependsOnTaskId: 'big' }],
      availability: [{ weekday: 1, startTime: '18:00', endTime: '20:00' }],
      events: [],
      options: { horizonDays: 7 },
    });
    expect(res.proposedBlocks).toEqual([]);
    expect(res.unscheduledTasks.map((u) => u.code)).toEqual(['INSUFFICIENT_CAPACITY', 'PREREQUISITE_UNSCHEDULED']);
  });

  it('keeps unsplittable tasks contiguous', () => {
    const res = generateSchedule({
      now: MONDAY,
      timezone: TZ,
      tasks: [task('long', 240, { splittable: false })],
      dependencies: [],
      availability: SPEC_AVAILABILITY,
      events: [],
    });
    expect(res.proposedBlocks).toHaveLength(1);
    expect(new Date(res.proposedBlocks[0].startAt).getUTCDay()).toBe(6); // only Saturday fits 4h
  });

  it('places higher-priority work earlier when tasks compete', () => {
    const res = generateSchedule({
      now: MONDAY,
      timezone: TZ,
      tasks: [task('low', 120, { priority: 'LOW' }), task('urgent', 120, { priority: 'URGENT' })],
      dependencies: [],
      availability: SPEC_AVAILABILITY,
      events: [],
    });
    const urgent = res.proposedBlocks.find((b) => b.taskId === 'urgent')!;
    const low = res.proposedBlocks.find((b) => b.taskId === 'low')!;
    expect(urgent.startAt).toBeLessThan(low.startAt);
  });

  it('warns when a deadline will be missed', () => {
    const res = generateSchedule(
      launchInput({ tasks: launchTasks.map((t) => (t.id === 'deploy' ? { ...t, dueAt: at('2026-11-06T20:00') } : t)) }),
    );
    expect(res.warnings.some((w) => w.taskId === 'deploy' && w.code === 'DEADLINE_MISSED')).toBe(true);
  });

  it('is deterministic', () => {
    expect(generateSchedule(launchInput())).toEqual(generateSchedule(launchInput()));
  });
});

describe('deadline feasibility', () => {
  it('flags a shortfall with concrete recommendations (Scenario D)', () => {
    const input: ScheduleInput = {
      now: MONDAY,
      timezone: TZ,
      tasks: [task('report', 300, { title: 'Write report', dueAt: at('2026-11-02T21:00') })],
      dependencies: [],
      availability: SPEC_AVAILABILITY,
      events: [],
    };
    const risk = analyzeDeadline(input, { id: 'report', kind: 'task', title: 'Write report', dueAt: at('2026-11-02T21:00'), taskIds: ['report'] });
    expect(risk.status).toBe('INFEASIBLE');
    expect(risk.requiredMinutes).toBe(300);
    expect(risk.availableMinutes).toBe(120);
    expect(risk.shortfallMinutes).toBe(180);
    const types = risk.recommendations.map((r) => r.type);
    expect(types).toContain('REDUCE_SCOPE');
    expect(types).toContain('MOVE_DEADLINE');
    expect(risk.assumptions.length).toBeGreaterThan(0);
  });

  it('counts prerequisites toward the required effort', () => {
    const due = at('2026-11-30T00:00');
    const risk = analyzeDeadline(launchInput(), { id: 'deploy', kind: 'task', title: 'Deployment', dueAt: due, taskIds: ['deploy'] });
    expect(risk.requiredMinutes).toBe(1080);
    expect(risk.status).toBe('ON_TRACK');
  });
});

describe('replanning (Scenario C)', () => {
  it('moves only the delayed task and its descendants', () => {
    const extra = task('docs', 60, { title: 'Write docs', projectId: 'other' });
    const base = launchInput({ tasks: [...launchTasks, extra] });
    const original = generateSchedule(base);
    const previousBlocks = original.proposedBlocks.map((b) => ({ taskId: b.taskId, start: b.startAt, end: b.endAt }));

    // Schema slips by a day.
    const delayed = base.tasks.map((t) => (t.id === 'schema' ? { ...t, earliestStartAt: at('2026-11-03T00:00') } : t));
    const r = replan({ input: { ...base, tasks: delayed }, previousBlocks, changedTaskIds: ['schema'] });

    expect(new Set(r.affectedTaskIds)).toEqual(new Set(['schema', 'api', 'frontend', 'testing', 'deploy']));
    expect(r.diff.find((d) => d.taskId === 'docs')!.change).toBe('UNCHANGED');
    expect(r.diff.find((d) => d.taskId === 'schema')!.change).toBe('MOVED');
    expect(r.impact.shiftMinutes).toBeGreaterThan(0);
    expect(r.impactChain[0]).toBe('Design database schema');
    const schemaStart = Math.min(...r.schedule.proposedBlocks.filter((b) => b.taskId === 'schema').map((b) => b.startAt));
    expect(schemaStart).toBeGreaterThanOrEqual(at('2026-11-03T00:00'));
  });
});

describe('daily briefing', () => {
  it('builds a grounded summary from the schedule', () => {
    const input = launchInput({ now: at('2026-11-02T17:00') });
    const schedule = generateSchedule(input);
    const b = buildDailyBriefing({ input, schedule, risks: [] });
    expect(b.suggestedFirstTask?.taskId).toBe('schema');
    expect(b.topTasks[0].suggestedBlock).not.toBeNull();
    expect(b.blockedTasks.map((x) => x.taskId)).toContain('api');
    expect(b.capacity.availableMinutesToday).toBe(120);
    expect(b.capacity.scheduledMinutesToday).toBe(120);
    expect(b.narrative).toMatch(/Design database schema/);
  });
});

describe('external prerequisites', () => {
  it('waits for a teammate-owned prerequisite and refuses when it is unplanned', () => {
    const base = { now: MONDAY, timezone: TZ, dependencies: [], availability: SPEC_AVAILABILITY, events: [] };
    const ready = at('2026-11-04T00:00');
    const a = generateSchedule({ ...base, tasks: [task('mine', 60, { externalPrereqs: [{ taskId: 'x', title: 'Their API', readyAt: ready }] })] });
    expect(a.proposedBlocks[0].startAt).toBeGreaterThanOrEqual(ready);
    const b = generateSchedule({ ...base, tasks: [task('mine', 60, { externalPrereqs: [{ taskId: 'x', title: 'Their API', readyAt: null }] })] });
    expect(b.proposedBlocks).toEqual([]);
    expect(b.unscheduledTasks[0].code).toBe('PREREQUISITE_UNSCHEDULED');
  });
});

describe('locked blocks', () => {
  it('explains committed tasks too, so briefings can say why', () => {
    const first = generateSchedule(launchInput());
    const locked = first.proposedBlocks.map((b) => ({ taskId: b.taskId, start: b.startAt, end: b.endAt }));
    const again = generateSchedule(launchInput({ lockedBlocks: locked }));
    expect(again.proposedBlocks.map((b) => [b.startAt, b.endAt])).toEqual(first.proposedBlocks.map((b) => [b.startAt, b.endAt]));
    const ex = again.explanations.find((e) => e.taskId === 'schema')!;
    expect(ex.reasons.join(' ')).toMatch(/medium priority.*already on your calendar/);
    expect(again.explanations).toHaveLength(5);
  });
});

describe('deadline inheritance', () => {
  it('does not starve the prerequisite of an urgent task', () => {
    // Long critical-path project competes with a short chain that has a deadline.
    const due = at('2026-11-06T20:00');
    const res = generateSchedule(launchInput({
      tasks: [
        ...launchTasks.map((t) => ({ ...t, priority: 'HIGH' as const })),
        task('review', 120, { title: 'Review graph algorithms', priority: 'LOW' }),
        task('papers', 120, { title: 'Practice past papers', priority: 'HIGH', dueAt: due }),
      ],
      dependencies: [...launchDeps, { taskId: 'papers', dependsOnTaskId: 'review' }],
    }));
    const end = Math.max(...res.proposedBlocks.filter((b) => b.taskId === 'papers').map((b) => b.endAt));
    expect(end).toBeLessThanOrEqual(due);
    expect(res.warnings.filter((w) => w.code === 'DEADLINE_MISSED')).toEqual([]);
    expect(res.explanations.find((e) => e.taskId === 'review')!.reasons.join(' ')).toMatch(/needed for "Practice past papers"/);
  });
});
