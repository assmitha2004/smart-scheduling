<div align="center">

# Smart Scheduling

**A full-stack planning app that turns tasks, estimates and dependencies into a conflict-free schedule that fits your real working hours.**

React + TypeScript · Node.js/Express REST API · PostgreSQL · Redis

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-010101?logo=socketdotio&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

**Live demo:** [smart-scheduling-jet.vercel.app](https://smart-scheduling-jet.vercel.app)

| 135 automated tests | 1,000 tasks scheduled in ~0.6 s | p95 API latency < 27 ms | 0 double-bookings |
|:---:|:---:|:---:|:---:|
| run in CI on every push | with 1,063 dependencies | measured on demo data | enforced by the database |

<img src="docs/screenshots/dashboard.png" alt="Dashboard with today's priorities, capacity and upcoming deadlines" width="900">

</div>

---

## What it does

You add projects and tasks with estimates, deadlines and "do this first" dependencies, and set your working hours.
The scheduling engine places the work into focus blocks around your meetings and breaks, shows the plan for
approval, and re-plans only the affected work when something slips.

- **Plan → preview → approve.** Nothing changes on your calendar until you approve a proposed schedule.
- **Drag-and-drop calendar.** Every move is dry-run checked on the server first (clashes, broken task order, deadline impact).
- **Gantt timeline.** A hand-built SVG chart with dependency arrows, the critical path, milestones and late or at-risk flags.
- **Replanning.** Delay a task and only it and the tasks after it move; you see a before/after diff first.
- **Deadline check.** Each task and project is ON_TRACK, AT_RISK, INFEASIBLE or OVERDUE, with options to fix it.
- **My Day and planner chat.** Type tasks in plain words; the app asks short follow-up questions and builds a day or multi-day plan.
- **Real-time updates.** Changes in one tab or from a background job show up live in your other tabs.
- **Analytics.** Planned vs actual time, workload by project, overdue trend and estimate accuracy.
- **Calendar sync.** A private iCalendar feed for Google, Apple and Outlook calendars.

## Screenshots

| Schedule preview with reasons | Replan: before/after diff |
|---|---|
| <img src="docs/screenshots/smart-planning.png" alt="Schedule preview" width="440"> | <img src="docs/screenshots/replan.png" alt="Replan diff" width="440"> |
| **Gantt timeline with critical path** | **Calendar around fixed events** |
| <img src="docs/screenshots/timeline.png" alt="Timeline" width="440"> | <img src="docs/screenshots/calendar.png" alt="Calendar" width="440"> |
| **Task details: dependencies, comments, activity** | **Analytics and deadline risk** |
| <img src="docs/screenshots/task-panel.png" alt="Task panel" width="440"> | <img src="docs/screenshots/analytics.png" alt="Analytics" width="440"> |

---

## Engineering highlights

### 1. Safe under concurrent writes

| Scenario | How it's handled |
|---|---|
| Two tabs commit different schedules | Compare-and-set on `users.schedule_version` → the second one gets `409 STALE_SCHEDULE` |
| Two tasks race for the same time slot | Commit re-checks overlaps inside a transaction, and a **PostgreSQL exclusion constraint** makes overlapping confirmed blocks impossible |
| Two requests each add half of a dependency cycle | Cycle check runs under a per-workspace advisory lock (`pg_advisory_xact_lock`) → `422` with the cycle path |
| Two people edit the same task | Every update carries the task's `version`; a mismatch returns `409` and the client refetches |

The exclusion constraint is the last line of defence, so double-booking is impossible even if application code has a bug:

```sql
ALTER TABLE scheduled_blocks ADD CONSTRAINT scheduled_blocks_no_overlap
  EXCLUDE USING gist (user_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE (status = 'CONFIRMED');
```

### 2. A real scheduling engine

`backend/src/engine/` is pure TypeScript with no database, network or clock access. Every input, including
"now", is passed in, so results are deterministic and easy to unit-test.

| File | What it does |
|---|---|
| `graph.ts` | DFS cycle detection with the cycle path, Kahn topological sort, ancestors/descendants |
| `cpm.ts` | Critical Path Method: forward and backward pass, slack, the critical chain |
| `intervals.ts` | Interval merge, subtract and clip; sweep-line overlap detection |
| `availability.ts` | Weekly working hours → exact time ranges in the user's timezone (DST-safe with Luxon) |
| `ranking.ts` | Score = priority + urgency + critical path + how many tasks it blocks + age, each with a reason |
| `scheduler.ts` | Greedy list scheduling into focus blocks, plus a repair pass that reduces lateness |
| `feasibility.ts` | Deadline risk and the earliest possible finish date |
| `replan.ts` | Finds the affected tasks, locks everything else, returns a before/after diff |

How a schedule is generated:

1. Reject dependency cycles, with the path that forms the cycle.
2. Compute the critical path, and give each task the earliest deadline of anything waiting on it.
3. Rank the tasks.
4. Free time = working hours − fixed events − breaks − already-locked blocks.
5. Take the highest-ranked task whose prerequisites are placed and put it in the earliest free time after them, split into focus blocks.
6. If a deadline is missed, retry with that task first; keep the change only if total lateness drops.
7. Return the blocks, the tasks that did not fit and why, and an explanation for each placement.

The engine never squeezes in work that doesn't fit; it reports it.

### 3. Background jobs and real-time updates with Redis

- **BullMQ** queues on Redis run reminders before upcoming blocks, a daily plan at each user's local hour,
  and deadline-risk alerts, with 3 attempts, exponential backoff and dedupe keys so no alert is sent twice.
- Workers run as a separate process. They publish events to a **Redis pub/sub** channel, and the API process
  relays them to the right user's **Socket.IO** room, so an event from any process reaches the browser.
- Redis is optional: without `REDIS_URL`, jobs are off and everything else still works.

### 4. Auth and access control

- Short-lived JWT access tokens with **rotating, single-use refresh tokens** (a used token is revoked).
- Workspaces with owner, admin and member roles, checked on every workspace request.
- Zod validation on every request body, `helmet` security headers, and one error shape:
  `{ "error": { "code", "message", "details?" } }`.

---

## Architecture

```mermaid
flowchart TB
  UI["React + TypeScript SPA<br/>calendar · Gantt · analytics · My Day"] -->|"REST /api/v1 + JWT"| API
  UI <-->|Socket.IO| API
  subgraph API["Express API (modular monolith)"]
    MOD["Feature modules<br/>auth · workspaces · projects · tasks · calendar · scheduling · analytics"]
    ENG["Scheduling engine<br/>DAG · CPM · allocation · replan"]
    MOD --> ENG
  end
  API --> PG[("PostgreSQL<br/>via Prisma")]
  API --> RD[("Redis")]
  RD --> WK["BullMQ workers<br/>reminders · daily plan · deadline alerts"]
  WK -->|"events via Redis pub/sub"| API
  API -.->|"optional"| PY["FastAPI service<br/>text → draft tasks"]
```

**Example request: committing a schedule.** The SPA sends `POST /api/v1/schedules/commit` with the preview id and
the schedule version it last saw → JWT and workspace role are checked → Zod validates the body → one transaction
does the version compare-and-set and writes the blocks, and the exclusion constraint rejects any overlap → a
Socket.IO event tells other open tabs to refresh → TanStack Query refetches and the calendar re-renders.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, TanStack Query, FullCalendar, custom SVG Gantt, PWA |
| Backend | Node.js 22, Express 5, TypeScript, Zod, JWT with refresh-token rotation |
| Database | PostgreSQL 16 via Prisma (migrations, indexes, exclusion and check constraints, JSONB) |
| Jobs and real-time | Redis, BullMQ, Socket.IO |
| Testing | Vitest, Supertest, Pytest, Playwright |
| DevOps | Docker Compose, nginx, GitHub Actions, Vercel |
| Optional service | Python FastAPI for plain-language task entry (Pydantic-validated) |

---

## Testing and performance

| Suite | Tests | Runs in CI |
|---|:---:|:---:|
| Engine and planner unit tests (Vitest) | 87 | ✅ |
| API and worker integration tests against real PostgreSQL (Vitest + Supertest) | 28 | ✅ |
| Python service tests (Pytest) | 20 | ✅ |
| End-to-end browser journey (Playwright) | 1 journey | run manually |

```bash
cd backend  && npm test                  # unit + integration (needs Postgres)
cd backend  && npm run benchmark         # scheduling engine benchmark
cd frontend && npm run build             # type-check + production build
cd frontend && node e2e/smoke.mjs        # Playwright journey against a running stack
cd ai-service && python -m pytest        # optional service
```

**CI** (GitHub Actions, on every push and pull request): backend type-check, migrations and tests against a
PostgreSQL 16 container, the engine benchmark, the Python tests and the frontend production build.

The Playwright journey covers: register → set working hours → create dependent tasks → cycle rejected → generate
and accept a schedule → delay a task → before/after preview → accept the new plan → analytics → timeline → mobile layout.

### Measured performance

Measured in the development container (`npm run benchmark`, `npm run latency`). Your numbers will differ.

| Tasks | Dependencies | Cycle check | Schedule generation (median of 5) | All constraints met |
|:---:|:---:|:---:|:---:|:---:|
| 100 | 99 | 0.6 ms | 68 ms | yes |
| 500 | 518 | 0.5 ms | 288 ms | yes |
| 1,000 | 1,063 | 0.6 ms | 634 ms | yes |

"All constraints met" is checked separately by the benchmark: every dependency is respected, every block is inside
working hours, and no blocks overlap.

| Endpoint (demo data, 50 requests) | p50 | p95 | p99 |
|---|:---:|:---:|:---:|
| `GET /calendar` | 5.9 ms | 9.8 ms | 29.1 ms |
| `GET /briefings/daily` | 17.1 ms | 21.7 ms | 30.2 ms |
| `GET /analytics/deadline-risk` | 15.1 ms | 20.3 ms | 26.4 ms |
| `POST /schedules/preview` | 21.8 ms | 26.7 ms | 46.1 ms |

---

## Run it locally

### Option A: Docker (everything)

```bash
cp .env.example .env          # set JWT_SECRET
docker compose up --build     # postgres, redis, api, worker, frontend (nginx), ai-service
```

Open http://localhost:8080 and create an account. To load demo data:

```bash
cd backend && npm ci && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/smart_scheduling npm run db:seed
```

Demo login: `demo@smartscheduling.dev` / `password123`

### Option B: Local development

Needs Node 22 and PostgreSQL 16. Redis 7 and Python 3.11+ are optional.

```bash
# Backend API → http://localhost:4000
cd backend
cp ../.env.example .env       # set DATABASE_URL and JWT_SECRET
npm install
npx prisma migrate deploy
npm run db:seed               # optional demo data
npm run dev
```

```bash
# Frontend → http://localhost:5173 (proxies /api and /socket.io to :4000)
cd frontend
npm install
npm run dev
```

With `INLINE_WORKER=true` the BullMQ workers run inside the API process; otherwise run them with `npm run worker`.

## Deployment

The live demo runs on **Vercel**, with the frontend, the Express API and the optional Python service deployed
together as one project (`vercel.json`). The build runs `prisma migrate deploy` first.

| Variable | Value |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (needs the `btree_gist` extension; Neon and Supabase support it) |
| `JWT_SECRET` | a long random string |
| `AI_SERVICE_TOKEN` | a random string shared by the API and the Python service |
| `REDIS_URL` | optional; without it, background jobs are off |

On Vercel the API runs as serverless functions, so there is no WebSocket server and no long-running worker. The
client detects this through `GET /api/v1/meta` and falls back to refetching. For live updates and background jobs,
use `docker compose` or any host with long-running processes.

## Project layout

```
backend/
  src/modules/      auth, users, workspaces, projects, tasks, calendar, scheduling, analytics,
                    briefings, notifications, day, activity
  src/engine/       scheduling engine (pure functions)
  src/day/          My Day planner and planner chat
  src/queues/       BullMQ queues           src/workers/   background jobs
  src/realtime/     Socket.IO + Redis relay src/middleware/ auth, validation, errors
  prisma/           schema, migrations (incl. exclusion constraint), seed
  scripts/          benchmark.ts, latency.ts
  tests/            unit/ and integration/
frontend/
  src/pages/        landing, auth, onboarding, My Day, planner, calendar, projects, analytics, settings
  src/features/     tasks, Gantt timeline, scheduling, analytics, day planner
  e2e/smoke.mjs     Playwright journey
ai-service/         optional FastAPI service (text → draft tasks)
docker-compose.yml  postgres, redis, backend, worker, frontend, ai-service
```

## Where to look in the code

| File | Why it matters |
|---|---|
| [`backend/src/engine/scheduler.ts`](backend/src/engine/scheduler.ts) | Greedy list scheduling into focus blocks, plus the deadline-repair pass |
| [`backend/src/engine/graph.ts`](backend/src/engine/graph.ts) · [`cpm.ts`](backend/src/engine/cpm.ts) | Cycle detection with the cycle path, topological sort, critical path |
| [`backend/src/engine/replan.ts`](backend/src/engine/replan.ts) | Moves only affected tasks, returns a before/after diff |
| [`backend/src/modules/scheduling/scheduling.service.ts`](backend/src/modules/scheduling/scheduling.service.ts) | Preview → commit with version compare-and-set inside a transaction |
| [`backend/src/modules/tasks/tasks.routes.ts`](backend/src/modules/tasks/tasks.routes.ts) | Dependency cycle check under a per-workspace advisory lock |
| [`backend/prisma/migrations/20261103035118_init/migration.sql`](backend/prisma/migrations/20261103035118_init/migration.sql) | The exclusion constraint and check constraints |
| [`backend/src/realtime/socket.ts`](backend/src/realtime/socket.ts) · [`queues/index.ts`](backend/src/queues/index.ts) | Socket.IO rooms, Redis pub/sub relay, BullMQ queue |
| [`backend/tests/integration/api.test.ts`](backend/tests/integration/api.test.ts) | Concurrency tests against real PostgreSQL |

## Design decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Modular monolith** (one Express app, feature modules) | Simple to deploy, clear boundaries; the engine runs in-process, so a preview takes tens of milliseconds | Modules scale together, not independently |
| **Three layers of concurrency safety**: version checks, transactions, a DB exclusion constraint | Each catches what the one above can miss; the constraint holds even if application code has a bug | A losing request gets a `409` and must refetch |
| **Engine as pure functions** (even "now" is an argument) | Deterministic, fast to unit-test, no mocks needed | Callers must load all inputs first |
| **Greedy list scheduling + a repair pass**, not an exact solver | Fast and explainable: every placement comes with a reason; 1,000 tasks in ~0.6 s | Not guaranteed optimal; the repair pass keeps a change only if total lateness drops |
| **Preview before change** | Users approve a stored recommendation; drag-and-drop moves are dry-run checked on the server first | One extra step before the calendar changes |
| **Redis and the AI service are optional** | The core app runs with just Node and PostgreSQL | Without Redis there are no reminders or background alerts |
| **Serverless on Vercel** | Free, one-click deploys for the demo | No WebSockets or long-running workers there; the client detects this via `/api/v1/meta` and falls back to refetching |

### The optional AI service

A small FastAPI service turns text like *"Finish API tests first, then create slides, about two hours"* into
**draft** tasks with a dependency, which the user reviews before anything is saved.

- A rule-based parser runs by default; an LLM provider is opt-in at deploy time.
- Output is validated twice: by Pydantic in Python and again by Zod in the API. Invalid items are rejected one by one.
- The API calls it with a shared secret, checked with a constant-time comparison (`hmac.compare_digest`), so the
  public route can't be used by anyone else.

## Next steps

Two-way Google Calendar sync, team capacity balancing, more dependency types (start-to-start, finish-to-finish),
recurring tasks, and email or Slack notifications.

---

Built by [Asmitha A G](https://github.com/assmitha2004) · [LinkedIn](https://linkedin.com/in/asmitha-a-g)
