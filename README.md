<div align="center">

# 🗓️ Smart Scheduling

### A full-stack project planning platform: React + TypeScript frontend, Node.js/Express REST API, PostgreSQL

Turns projects, tasks, estimates and dependencies into a **conflict-free schedule that fits your real working hours**, shows it on a drag-and-drop calendar and a Gantt timeline, and re-plans with a before/after preview when something slips.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-010101?logo=socketdotio&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?logo=githubactions&logoColor=white)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fassmitha2004%2Fsmart-scheduling&env=DATABASE_URL,JWT_SECRET,AI_SERVICE_TOKEN&envDescription=Postgres%20connection%20string%2C%20a%20long%20random%20JWT%20secret%2C%20and%20a%20random%20internal%20service%20token&envLink=https%3A%2F%2Fgithub.com%2Fassmitha2004%2Fsmart-scheduling%23%EF%B8%8F-deploy-to-vercel&project-name=smart-scheduling&repository-name=smart-scheduling)

**130+ automated tests** · **1,000-task schedule in ~0.6 s** · **p95 API latency < 27 ms** · **0 double-bookings, enforced by the database**

<img src="docs/screenshots/dashboard.png" alt="Dashboard with today's priorities, capacity and upcoming deadlines" width="900">

</div>

---

## ✨ Highlights

- **End-to-end ownership.** A React 19 + TypeScript single-page app, a versioned Express 5 REST API (`/api/v1`), a PostgreSQL schema managed with Prisma migrations, real-time updates over Socket.IO, background jobs on Redis/BullMQ, Docker Compose for local and self-hosted runs, and Vercel for one-click deploys.
- **Rich, interactive frontend.** Drag-and-drop calendar (FullCalendar) with a server-side dry-run check before every move, a hand-built SVG Gantt chart with dependency connectors and the critical path, analytics charts, dark mode, and an installable PWA. Server state is cached and invalidated with TanStack Query.
- **Clean REST API design.** Resource-oriented routes split into feature modules (auth, workspaces, projects, tasks, calendar, scheduling, analytics, notifications), Zod validation on every request body, a single error shape (`{ error: { code, message, details? } }`), and correct status codes (401, 403, 404, 409, 422).
- **Safe under concurrency.** Optimistic versioning rejects stale writes from a second tab with `409`. Schedule commits run in a transaction. A **PostgreSQL exclusion constraint** (`btree_gist` over `tstzrange`) makes overlapping bookings impossible even under races, and a per-workspace advisory lock stops two concurrent requests from creating a dependency cycle together.
- **Secure auth and access control.** Password hashing, short-lived JWT access tokens with **rotating, single-use refresh tokens**, and owner/admin/member roles checked on every workspace-scoped request.
- **A real scheduling engine on the backend.** Pure, deterministic TypeScript: DAG cycle detection, topological sort, Critical Path Method and interval arithmetic over working hours, placing work into focus blocks and explaining every placement.
- **Tested and shipped through CI.** Unit tests for the engine, API integration tests against a real PostgreSQL database (Vitest + Supertest), a Playwright end-to-end journey, and GitHub Actions running type-checks, tests, the frontend build and a performance benchmark on every push.

## 📸 Screenshots

| Schedule preview with explanations | Replan after a delay: before/after diff |
|---|---|
| <img src="docs/screenshots/smart-planning.png" alt="Schedule preview" width="440"> | <img src="docs/screenshots/replan.png" alt="Replan diff" width="440"> |
| **Gantt timeline: critical path, dependencies** | **Calendar: tasks around fixed events** |
| <img src="docs/screenshots/timeline.png" alt="Timeline" width="440"> | <img src="docs/screenshots/calendar.png" alt="Calendar" width="440"> |
| **Task details: dependencies, comments, activity** | **Analytics & deadline feasibility** |
| <img src="docs/screenshots/task-panel.png" alt="Task panel" width="440"> | <img src="docs/screenshots/analytics.png" alt="Analytics" width="440"> |
| **Landing page** | **Dark mode** |
| <img src="docs/screenshots/landing.png" alt="Landing page" width="440"> | <img src="docs/screenshots/dashboard-dark.png" alt="Dark mode" width="440"> |

## 🧱 Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, TanStack Query, FullCalendar, custom SVG Gantt chart, PWA (manifest + service worker) |
| Backend | Node.js 22, Express 5, TypeScript, Zod validation, JWT auth with refresh-token rotation |
| Database | PostgreSQL 16 via Prisma (migrations, indexes, exclusion + check constraints, JSONB) |
| Real-time & jobs | Socket.IO (relayed through Redis pub/sub), BullMQ workers on Redis |
| Scheduling engine | Pure TypeScript: DAG, topological sort, CPM, interval allocation; Luxon for timezones and DST |
| Testing | Vitest, Supertest, Pytest, Playwright E2E |
| DevOps | Docker, Docker Compose, nginx, GitHub Actions CI, Vercel |
| Optional service | Python FastAPI service for natural-language task entry (see [below](#-optional-natural-language-task-entry)) |

## 🏗️ Architecture

```mermaid
flowchart TB
  UI["React + TypeScript SPA<br/>dashboard · calendar · Gantt · analytics"] -->|"REST /api/v1 (JWT)"| API
  UI <-->|Socket.IO| API
  subgraph API["Node.js + Express API (modular monolith)"]
    MOD["Feature modules<br/>auth · workspaces · projects · tasks · calendar · scheduling · analytics"]
    ENG["Scheduling engine<br/>DAG · CPM · allocation · replan · feasibility"]
    MOD --> ENG
  end
  API --> PG[("PostgreSQL<br/>Prisma")]
  API --> RD[("Redis")]
  RD --> WK["BullMQ workers<br/>reminders · daily plan · deadline alerts"]
  WK -->|"events via Redis pub/sub"| API
  API -.->|"optional, validated JSON"| PY["FastAPI service<br/>text → draft tasks"]
```

**Request flow, e.g. committing a schedule:** the SPA calls `POST /api/v1/schedules/commit` with the preview id and the schedule version it last saw → auth middleware verifies the JWT and workspace role → Zod validates the body → the service opens a transaction, does a compare-and-set on the user's schedule version, writes the blocks, and lets the exclusion constraint reject any overlap → the API emits a Socket.IO event so other open tabs refresh → the client's TanStack Query cache is invalidated and the calendar re-renders.

---

## What's implemented

| Area | What you get |
|---|---|
| **Auth & workspaces** | Register/login, JWT access tokens with rotating single-use refresh tokens, a personal workspace per user, member invites with owner/admin/member roles, membership checked on every protected request |
| **Projects & tasks** | Projects with target dates and milestones; tasks with estimate, logged time, priority, status, earliest start, due date, assignee and a splittable flag; comments; activity log; optimistic concurrency on edits (`version`) |
| **Dependencies** | Finish-to-start links; cycle detection **before saving** with a readable path (`"A" → "B" → "C" → "A"`); per-workspace advisory lock; DB check constraint against self-dependencies |
| **Calendar** | Day/week/month views in the user's timezone; task blocks beside fixed events, breaks and unavailable time; working hours shaded; **drag-and-drop with a server-side dry-run check** (clashes and broken prerequisite order are errors; outside-hours and deadline impact are warnings you confirm); project and status filters |
| **Timeline** | Custom SVG Gantt: dependency connectors, critical path highlighted, milestones, today line, late/blocked/at-risk flags, progress, day/week/month zoom |
| **Preview → approve** | `preview` stores a pending recommendation; nothing touches the calendar until `commit`. Users can reject individual tasks (their dependents are excluded too) |
| **Replanning** | Delay a task or change an estimate: only that task and its descendants move, unaffected blocks stay locked, and you see a before/after diff and the finish-date shift before approving |
| **Deadline feasibility** | Required effort (including prerequisites) vs free capacity per task and project: ON_TRACK / AT_RISK / INFEASIBLE / OVERDUE, with concrete options (cut scope, move the deadline, add time per day) |
| **My Day** | A daily planner: type tasks in plain words, answer a few quick questions, get a timeline with breaks; tick tasks off, push one to tomorrow, re-plan the rest of the day |
| **Notifications** | Upcoming-block reminders (delayed BullMQ jobs), deadline-risk alerts, dependency-unblocked, daily plan at the user's local hour, quiet hours, per-type preferences, deduplication keys |
| **Real-time** | Socket.IO rooms per user; workers publish through Redis so events from any process reach the browser |
| **Analytics** | Planned vs actual time per week, workload by project, overdue trend, estimate accuracy |
| **Calendar sync** | Private iCalendar feed (`/api/v1/feed/<secret>.ics`, RFC 5545) for Google, Apple and Outlook calendars; rotate or revoke the link any time |
| **Account & privacy** | Change password (signs out other devices), export all data as JSON, delete account |

---

## 🔒 Concurrency and data integrity

| Scenario | How it's handled | Test |
|---|---|---|
| **Two tabs commit different schedules** | Compare-and-set on `users.schedule_version` (`UPDATE … WHERE schedule_version = expected`) → `409 STALE_SCHEDULE` | `api.test.ts › rejects a stale commit from a second session`, `› lets exactly one of two concurrent commits win` |
| **Two tasks compete for one slot** | Commit re-validates overlaps inside a transaction; a **Postgres exclusion constraint** (`EXCLUDE USING gist (user_id WITH =, tstzrange(start_at,end_at) WITH &&) WHERE status='CONFIRMED'`) is the last line of defence | `api.test.ts › database rejects overlapping confirmed blocks`, `› lets exactly one of two concurrent commits win` |
| **Two requests each add half a dependency cycle** | DFS cycle check before insert, under a per-workspace advisory lock; `422` with the cycle path | `api.test.ts › rejects a dependency cycle`, `engine.test.ts › detects the A → B → C → A cycle` |
| **A prerequisite is delayed** | `POST /schedules/replan` moves only affected descendants, locks the rest, returns a diff first | `api.test.ts › replans only downstream work…` |
| **Not enough time before a deadline** | The engine reports `INSUFFICIENT_CAPACITY` instead of squeezing work in; feasibility reports the shortfall with options | `api.test.ts › reports a capacity shortfall…` |
| **Concurrent edits to one task** | Every update carries the task's `version`; a mismatch returns `409` and the client refetches | `api.test.ts › rejects stale task edits` |

---

## ⚙️ The scheduling engine

`backend/src/engine/` is pure TypeScript with no database, network or clock access. Every input, including `now`, is passed in, so results are deterministic and unit-testable.

| File | Responsibility |
|---|---|
| `graph.ts` | Iterative DFS cycle detection with path reconstruction, Kahn topological sort with deterministic tie-breaks, ancestors/descendants |
| `cpm.ts` | Critical Path Method (forward/backward pass, slack, one concrete critical chain) |
| `intervals.ts` | Half-open interval merge/subtract/clip, sweep-line overlap detection |
| `availability.ts` | Weekly working-hour rules → concrete UTC intervals in the user's timezone (DST-safe via Luxon), minus events |
| `ranking.ts` | Transparent score = priority + urgency + critical-path bonus + blocker impact + age, each factor returned with a reason |
| `scheduler.ts` | Greedy list scheduling into focus blocks, deadline inheritance and a lateness-reducing repair pass |
| `feasibility.ts` | Deadline risk, recommendations, earliest feasible date |
| `replan.ts` | Affected-set computation, locking of unaffected blocks, before/after diff |

**How `generateSchedule` works**

1. Validate input and reject dependency cycles with the offending path.
2. Compute the critical path and, in one reverse-topological pass, each task's **inherited deadline** (the earliest due date of anything waiting on it), so prerequisites of urgent work aren't starved.
3. Rank tasks.
4. Free time = working hours − fixed events − breaks − unavailable time − locked blocks.
5. Repeatedly take the highest-ranked task whose prerequisites are placed, and put it at the earliest free time after they finish. Long tasks are split into focus blocks unless marked unsplittable.
6. **Deadline repair:** if a deadline is missed, retry with that task and its prerequisites first; keep the change only if total lateness strictly drops.
7. Return blocks, unscheduled tasks with the reason, warnings, the critical path, per-task explanations and a capacity summary.

The engine never fabricates a schedule: work that doesn't fit is reported, not squeezed in.

---

## 🔌 API (v1)

All endpoints except `/auth/*` need `Authorization: Bearer <accessToken>`. Errors are `{"error": {"code", "message", "details?"}}`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | Accounts and rotating refresh tokens |
| GET/PATCH | `/users/me` | Profile, timezone, focus length, notification preferences, quiet hours |
| GET/PUT | `/availability` | Weekly working hours |
| GET/POST | `/workspaces` · `/workspaces/:id/members` · `/workspaces/:id/activity` | Workspaces, members, audit trail |
| GET/POST/PATCH/DELETE | `/projects` · `/projects/:id` | Projects |
| GET | `/projects/:id/tasks` · `/projects/:id/timeline` | Task list; Gantt data with critical path and risk flags |
| POST/DELETE | `/projects/:id/milestones` | Milestones |
| GET/POST | `/tasks` | List with filters / create (with `dependsOn`) |
| GET/PATCH/DELETE | `/tasks/:id` | Details / update with `version` / delete |
| GET | `/tasks/:id/suggestions` | Where the engine would place this task now, and why |
| POST/DELETE | `/tasks/:id/dependencies` · `/tasks/:id/dependencies/:dependencyId` | Add (cycle-checked) / remove |
| POST | `/tasks/:id/comments` · `/tasks/:id/log-time` | Comments; time tracking |
| GET | `/calendar?from&to&projectId` | Events, blocks, working hours |
| POST/PATCH/DELETE | `/calendar/events[/:id]` | Fixed events, breaks, unavailable time |
| POST/PATCH | `/calendar/blocks/:id/check` · `/calendar/blocks/:id` | Drag-and-drop dry run / move |
| POST | `/calendar/blocks/:id/complete` | Complete a block and log its time |
| POST | `/schedules/preview` | Generate a proposed schedule (stored as a pending recommendation) |
| POST | `/schedules/commit` | `{recommendationId, expectedVersion, excludeTaskIds?}`; `409` if stale |
| POST | `/schedules/replan` | `{changes:[{taskId, delayUntil?, estimatedMinutes?, priority?}]}` |
| GET/POST | `/schedules/recommendations` · `/…/:id/dismiss` | History; reject a preview |
| GET | `/briefings/daily` | Today's priorities, deadlines and capacity |
| GET | `/analytics/deadline-risk` · `/analytics/overview?weeks=8` | Feasibility; planned vs actual, workload, trends |
| GET/POST | `/notifications` · `/notifications/:id/read` · `/notifications/read-all` | In-app notifications |
| GET | `/day` · POST `/day/plan` · `/day/replan` · `/day/tasks` | My Day planner |

Preview response (abridged):

```json
{
  "recommendationId": "…", "scheduleVersion": 4, "ok": true,
  "proposedBlocks": [{ "taskId": "…", "title": "Build backend APIs", "startAt": "2026-11-03T09:00:00.000Z", "endAt": "2026-11-03T10:30:00.000Z", "locked": false }],
  "unscheduledTasks": [], "warnings": [{ "taskId": "…", "code": "DEADLINE_MISSED", "reason": "…" }],
  "explanations": [{ "taskId": "…", "rank": 1, "score": 89, "reasons": ["high priority (+45)", "on the critical path (+20)", "blocks 4 downstream task(s) (+24)"] }],
  "criticalPath": [{ "taskId": "…", "title": "…" }],
  "summary": { "availableMinutes": 1170, "scheduledMinutes": 1080, "remainingMinutes": 90, "projectedFinish": "…" }
}
```

---

## 🗄️ Data model

PostgreSQL via Prisma (`backend/prisma/schema.prisma`). All timestamps are `timestamptz` (UTC) and are displayed in the user's timezone.

Tables: `users`, `refresh_tokens`, `workspaces`, `workspace_members` (PK `(workspace_id, user_id)`), `projects`, `milestones`, `tasks`, `task_dependencies` (unique `(task_id, depends_on_task_id)`, no self-links), `task_comments`, `calendar_events`, `availability_rules`, `scheduled_blocks`, `schedule_recommendations` (JSONB payload, `base_version`), `notifications` (unique `dedupe_key`), `activity_logs` (JSONB metadata).

Indexes include `tasks(project_id, status)`, `tasks(assignee_id, due_at)` and `scheduled_blocks(user_id, start_at, end_at)`. Hand-written SQL in the initial migration adds the overlap exclusion constraint and the check constraints.

---

## 🧪 Testing and performance

```bash
cd backend && npm test            # engine unit tests + API integration tests + worker jobs (needs Postgres)
```

```bash
cd frontend && npm run build      # type-check + production build
```

```bash
cd frontend && node e2e/smoke.mjs # Playwright browser journey against a running stack
```

```bash
cd ai-service && pip install -r requirements-dev.txt && python -m pytest  # optional service
```

Integration tests run against a real database (`TEST_DATABASE_URL`, default `postgresql://postgres:postgres@localhost:5432/smart_scheduling_test`). The E2E journey covers: register → set working hours → create dependent tasks → cycle rejected → generate and accept a schedule → calendar → delay a task → before/after preview → accept the revised plan → analytics → timeline → mobile layout. Set `BASE_URL` to run it against Docker (`http://localhost:8080`).

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request: backend type-check, migrations and tests against a PostgreSQL 16 service container, the scheduling benchmark, the Python tests, and the frontend production build.

### Measured performance

Measured in the development container (`npm run benchmark`, `npm run latency`). Your numbers will differ.

| Tasks | Dependencies | Cycle check | Schedule generation (median of 5) | Constraints satisfied |
|---|---|---|---|---|
| 100 | 99 | 0.6 ms | 68 ms | yes |
| 500 | 518 | 0.5 ms | 288 ms | yes |
| 1,000 | 1,063 | 0.6 ms | 634 ms | yes |

"Constraints satisfied" is checked independently by the benchmark: every dependency is respected, every block lies inside working hours, and no blocks overlap.

| Endpoint (demo data, n=50) | p50 | p95 | p99 |
|---|---|---|---|
| `GET /calendar` | 5.9 ms | 9.8 ms | 29.1 ms |
| `GET /briefings/daily` | 17.1 ms | 21.7 ms | 30.2 ms |
| `GET /analytics/deadline-risk` | 15.1 ms | 20.3 ms | 26.4 ms |
| `POST /schedules/preview` | 21.8 ms | 26.7 ms | 46.1 ms |

---

## 🚀 Quick start

### Option A: Docker (everything)

```bash
cp .env.example .env          # set JWT_SECRET
docker compose up --build
```

Open http://localhost:8080 and create an account. To load demo data:

```bash
cd backend && npm ci && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/smart_scheduling npm run db:seed
```

Demo login: `demo@smartscheduling.dev` / `password123`.

### Option B: Local development

Prerequisites: Node 22, PostgreSQL 16, Redis 7 (optional), Python 3.11+ (optional).

```bash
# 1. Backend API (http://localhost:4000)
cd backend
cp ../.env.example .env           # edit DATABASE_URL etc.
npm install
npx prisma migrate deploy
npm run db:seed                   # optional demo data
npm run dev
```

```bash
# 2. Frontend (http://localhost:5173, proxies /api and /socket.io to :4000)
cd frontend
npm install
npm run dev
```

```bash
# 3. Optional: natural-language task entry service (http://localhost:8000)
cd ai-service
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Without `REDIS_URL`, background jobs are disabled and everything else still works. With `INLINE_WORKER=true`, the BullMQ workers run inside the API process; in production they run separately (`npm run worker`), as `docker-compose.yml` does.

## ☁️ Deploy to Vercel

The repo uses **Vercel Services** (`vercel.json` at the root): the frontend, the Express API and the optional Python service deploy together as one project.

| Path | Service |
|---|---|
| `/api/*` | `backend/` (Express; `vercel-build` bundles `src/app.ts` into `bundle/server.mjs`, loaded by `vercel-entry.mjs`) |
| `/_ai/*` | `ai-service/` (FastAPI), protected by `AI_SERVICE_TOKEN` |
| everything else | `frontend/` (Vite static build, SPA fallback) |

1. Create a Postgres database (e.g. [Neon](https://neon.tech) or [Supabase](https://supabase.com); the migrations need the `btree_gist` extension, which both support).
2. Click **Deploy with Vercel** above (or *Add New → Project* and import this repo). Set the Framework Preset to **Services** if asked and leave the Root Directory empty.
3. Add the environment variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Postgres connection string (use the pooled URL if your provider offers one) |
   | `JWT_SECRET` | A long random string, e.g. `openssl rand -base64 48` |
   | `AI_SERVICE_TOKEN` | Another random string shared by the API and the Python service |
   | `REDIS_URL` | *Optional*, e.g. Upstash. Without it, background jobs are off |

4. Deploy. The backend's `vercel-build` script runs `prisma migrate deploy` first, so the schema is created automatically. After that, every push to `main` deploys to production and every other branch gets a preview URL.

**Serverless vs Docker.** Vercel runs the API as serverless functions, so there is no WebSocket server and no long-running worker. The client detects this through `GET /api/v1/meta` and falls back to normal refetching; reminders and alert jobs don't run. Everything else works the same. For live updates and background jobs, use `docker compose` or a host with long-running processes (Render, Railway, Fly.io).

---

## 📁 Repository layout

```
smart-scheduling/
├── backend/                 Node.js + Express + TypeScript API
│   ├── src/modules/         auth, users, workspaces, projects, tasks, calendar,
│   │                        scheduling, analytics, briefings, notifications, day, activity
│   ├── src/middleware/      auth (JWT + roles), validation (Zod), error handling
│   ├── src/engine/          deterministic scheduling engine (pure functions)
│   ├── src/queues/          BullMQ queues and jobs
│   ├── src/realtime/        Socket.IO + Redis relay
│   ├── src/app.ts · main.ts Express app (serverless entry) · long-running server
│   ├── prisma/              schema, migrations (incl. exclusion constraint), seed
│   ├── scripts/             benchmark.ts, latency.ts
│   └── tests/               unit/ (engine, planners) and integration/ (API, workers)
├── frontend/                React + TypeScript + Tailwind + FullCalendar
│   ├── src/pages/           landing, auth, onboarding, dashboard, my day, calendar,
│   │                        projects, project detail, planning, analytics, settings
│   ├── src/features/        tasks, projects (Gantt), scheduling, analytics, day planner
│   ├── src/hooks/           real-time subscription, PWA install prompt
│   └── e2e/smoke.mjs        Playwright browser journey
├── ai-service/              optional Python FastAPI service (text → draft tasks)
├── docker-compose.yml       postgres, redis, backend, worker, frontend (nginx), ai-service
├── vercel.json              Vercel Services config
└── .github/workflows/ci.yml
```

---

## 🧭 Design decisions

- **Modular monolith.** One Express app split into feature modules keeps deployment simple while keeping boundaries clear. The engine runs in-process, so a schedule preview takes tens of milliseconds.
- **Defence in depth for concurrency.** Optimistic version checks catch stale sessions, transactions keep commits atomic, and the exclusion constraint makes double-booking impossible even if application code has a bug.
- **Business logic as pure functions.** The engine and planners take all inputs (including the current time) as arguments, which makes them fast to unit-test and easy to reason about.
- **Preview before change.** Every schedule mutation goes through a stored recommendation the user approves, or a drag-and-drop move that is dry-run checked on the server first.
- **Validate at the edge.** Zod schemas validate every request body, so route handlers work with typed, trusted data and clients get consistent `422` errors.

## 💬 Optional: natural-language task entry

A small Python FastAPI service (`ai-service/`) turns text like *"Finish API tests first, then create slides, about two hours"* into **draft** tasks with a dependency, which the user reviews and confirms in the UI. It runs a built-in rule-based parser by default; an LLM provider can be enabled on the server, and each user must opt in. Output is schema-validated in Python (Pydantic) and again in the API (Zod), invalid items are rejected one by one, and drafts never write to the schedule without confirmation. The rest of the app works without this service.

## Future work

Two-way Google Calendar sync, team capacity balancing, more dependency types (start-to-start, finish-to-finish), recurring tasks, email/Slack delivery for notifications, and a mobile app.
