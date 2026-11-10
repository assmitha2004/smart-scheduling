<div align="center">

# 🗓️ Smart Scheduling

### AI-assisted, dependency-aware planning platform

Turns projects, tasks, estimates and dependencies into a **realistic plan that fits your real calendar**, flags deadline risk early, explains every recommendation, and re-plans with a before/after preview when something slips.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white)
![Redis](https://img.shields.io/badge/Redis%20%2B%20BullMQ-DC382D?logo=redis&logoColor=white)
![Python](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fassmitha2004%2Fsmart-scheduling&env=DATABASE_URL,JWT_SECRET,AI_SERVICE_TOKEN&envDescription=Postgres%20connection%20string%2C%20a%20long%20random%20JWT%20secret%2C%20and%20a%20random%20token%20shared%20with%20the%20AI%20service&envLink=https%3A%2F%2Fgithub.com%2Fassmitha2004%2Fsmart-scheduling%23%EF%B8%8F-deploy-to-vercel&project-name=smart-scheduling&repository-name=smart-scheduling)

**121 automated tests** · **1,000-task schedule in ~0.6 s** · **p95 API latency < 27 ms** · **0 double-bookings by construction**

<img src="docs/screenshots/dashboard.png" alt="Dashboard with daily briefing, top priorities and capacity" width="900">

</div>

---

## ✨ Highlights

- **A real scheduling engine, not a to-do list.** Dependency graph (DAG) with cycle detection, topological ordering, **Critical Path Method**, interval arithmetic over working hours and fixed events, and greedy list scheduling into focus blocks. It is a pure, deterministic TypeScript module with its own unit tests.
- **Deadline intelligence.** Urgency propagates *backwards* through dependencies, so prerequisites of urgent work aren't starved. A **deadline-repair pass** re-orders work only when it strictly reduces total lateness. Feasibility analysis says *how short* you are and offers concrete options: cut X hours, move the deadline to a date, add N min/day.
- **Explainable by design.** Every placement comes with its reasons, e.g. *"high priority (+45) · needed for 'Deployment', due in 10 days (+12) · on the critical path (+20) · blocks 4 tasks (+24)"*.
- **Safe under concurrency.** Optimistic versioning rejects stale commits from a second browser tab (409). A **PostgreSQL exclusion constraint** (`btree_gist` over `tstzrange`) makes overlapping blocks impossible even under races. A per-workspace advisory lock prevents concurrent requests from creating a dependency cycle together.
- **Preview → approve, always.** Nothing touches the calendar without approval. Replanning after a delay moves only the affected downstream tasks and shows a before/after diff with the finish-date shift.
- **AI with guardrails.** Natural language → *draft* tasks with dependencies, schema-validated twice (Pydantic + Zod) and rejected item by item. A built-in parser runs by default; Claude is opt-in per user. AI briefings are grounding-checked against engine data.
- **Production plumbing.** JWT with rotating refresh tokens, role-based workspace access, BullMQ workers (reminders, daily plan at local hour, risk alerts, quiet hours), Socket.IO live updates relayed through Redis, Docker Compose, and GitHub Actions CI.

## 💬 Plan your day from one prompt

Describe your day in your own words, e.g.

> I wake up at 8. Finish my project 2h, it's the most important. Leetcode 1h, gym after lunch, call mom at 7pm and maybe buy groceries if I have time. I focus best in the evening.

`POST /day/understand` reads it and returns tasks, day settings and a plan preview:

- **Built-in understanding** (`backend/src/day/understand.ts`, unit-tested, no API key needed): splits sentences, lists and "and then"; reads durations, set times (`at 7pm`), deadlines (`by 5pm`, `before lunch`), windows (`after lunch`, `in the morning`, `after work`), priorities (`most important`, `must`, `urgent`, `maybe`, `if I have time`), effort (`quick`, `hard`), remarks that refer to the previous task (`…, it's urgent`), wake/bed times, peak focus time and "tomorrow". Leftover tasks from earlier days are added automatically.
- **Claude** (optional): with `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` on the server and the user's AI consent on, the AI service's `/understand-day` reads the text with structured outputs instead; output is validated in Python and again in the backend, and anything failing falls back to the built-in parser.

The review screen shows **what was understood** (duration, focus level, must-do, top priority, time window, all editable) next to a **live plan preview** that re-plans as you edit. "Something came up?" accepts the same natural language and fits the new task into the day automatically.

## ☀️ My Day: "I don't know how to plan my day"

The home screen. Built for people who have a list of things to do but no idea what to do when.

1. **Type your tasks**, one per line, with or without times: `finish assignment 2h`, `gym`, `call mom at 7pm`. Missing durations and effort are guessed from the words (`reply to emails` ≈ 15 min, easy; `study physics` ≈ 90 min, hard).
2. **Answer 5 quick questions** (all tap-to-answer): how long each takes, which ones *must* happen, the single most important one, which need your full brain, and when your day starts/ends and when you focus best.
3. **Get a timeline** (`backend/src/day/dayPlan.ts`, pure and unit-tested): your #1 task first while you're fresh, hard tasks at your peak energy, easy ones in low-energy time, fixed-time tasks exactly on time, long tasks split into sessions, a break after every task, meals and calendar events never overlapped. If a gap is too small for a must-do it is split into shorter sessions before anything optional gets the time. Whatever doesn't fit is moved to tomorrow, with an honest explanation.
4. **Track it**: a "Now / Up next" card, tick tasks off (confetti and a compliment that fits the moment: first task, #1 priority, halfway, all done), "Need 15 more min" re-plans the rest of the day, "Not today" moves a task to tomorrow, quick-add for things that come up.
5. **Leftovers roll over**: anything unfinished shows up the next day as "left over from before", already marked as a must-do and placed early.

API: `GET /day`, `POST /day/parse`, `POST /day/plan` (with `dryRun` preview), `POST /day/replan`, `POST /day/tasks`, `POST /day/tasks/:id/done | /tomorrow`, `DELETE /day/tasks/:id`. Planned days also appear in the calendar feed.

## 🦉 Plan my time (students, workers, or both)

New users pick **🎒 Student**, **💼 Working** or **🎓 Work + study**, and Tempo, a friendly planning assistant, asks a few tappable questions:

| Everyone | Students | Workers |
|---|---|---|
| Plan for **today, this week or this month** · wake/sleep times · energy pattern (🐦 early bird, ☀️ daytime, 🦉 night owl) · focus style (🍅 30 / ⏱️ 50 / 🎧 90 min) · meals · activities · days off · habits | Class timetable + commute · subjects with difficulty · exams · assignments · daily study goal | Work days & hours + commute · recurring meetings · work tasks with priority and due date |

`backend/src/planner/lifePlan.ts` (pure, unit-tested) turns the answers into:

- **A weekly routine** of fixed events (classes, work, meetings, meals, commute, activities) the engine never schedules over.
- **Focus windows** for tasks. Study time is picked from free time to match the energy pattern and daily goal (+20% headroom); work tasks go inside work hours; habits get a personal window. Packed days are called out.
- **Smart tasks**: spaced-repetition exam revision (3-5 sessions by difficulty, chained, compressed when the exam is close), assignments ≥ 3h split into research → draft → polish, weekly subject reviews, work tasks (overdue = urgent), daily habits.
- **Friendly insights** explaining every choice (and a nudge if sleep is under 7h).

A dry run shows a "week at a glance" preview before anything is saved; re-running replaces the planner's routine events and not-yet-started tasks. Then **Plan my day / week / month** runs the scheduling engine over that horizon (`POST /schedules/preview { horizon }`) for the usual preview → approve flow.

Extras: 🎉 confetti and a cheerful message when a task is completed, a Pomodoro-style focus timer, a completion streak, an exam countdown (students), meetings & focus summary (workers), a work/study balance meter (both), and a daily tip.

## 💼 Product & business features

Smart Scheduling is built like a commercial SaaS, not just a demo:

| Area | What's there |
|---|---|
| **Everything free** | No plans, trials or paywalls: every feature is available to every account. |
| **Marketing site** | Landing page with persona tabs (students, professionals, work + study), how-it-works, features and FAQ; `/terms` and `/privacy`; SEO and Open Graph tags. |
| **Calendar sync** | Private iCalendar feed (`/api/v1/feed/<secret>.ics`, RFC 5545 with escaping and line folding) for Google Calendar, Apple Calendar and Outlook. Rotate or revoke the secret link any time. |
| **Installable app (PWA)** | Web manifest, icons (incl. maskable), app shortcuts and a service worker (network-first pages, cached immutable assets, never caches the API). |
| **Account & privacy** | Change password (signs out other devices), download all your data as JSON, delete your account (password + typed confirmation). |
| **Engagement** | XP and levels, daily streaks, 12 badges, level-up and badge celebrations, a weekly review (wins, follow-through, best day, vs last week) and a getting-started checklist. Pure, unit-tested logic in `backend/src/progress/progress.ts`. |

## 📸 Screenshots

| Smart planning: preview with explanations | Replan after a delay: before/after impact |
|---|---|
| <img src="docs/screenshots/smart-planning.png" alt="Schedule preview" width="440"> | <img src="docs/screenshots/replan.png" alt="Replan diff" width="440"> |
| **Gantt timeline: critical path, dependencies** | **Calendar: tasks around fixed events** |
| <img src="docs/screenshots/timeline.png" alt="Timeline" width="440"> | <img src="docs/screenshots/calendar.png" alt="Calendar" width="440"> |
| **AI drafts tasks from text: you confirm** | **Analytics & deadline feasibility** |
| <img src="docs/screenshots/ai-drafts.png" alt="AI drafts" width="440"> | <img src="docs/screenshots/analytics.png" alt="Analytics" width="440"> |
| **Task details: dependencies, suggestions, activity** | **Dark mode** |
| <img src="docs/screenshots/task-panel.png" alt="Task panel" width="440"> | <img src="docs/screenshots/dashboard-dark.png" alt="Dark mode" width="440"> |

## 🧱 Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, TanStack Query, FullCalendar, custom SVG Gantt chart |
| Backend | Node.js 22, Express 5, TypeScript, Zod validation, JWT auth |
| Scheduling engine | Pure TypeScript: DAG, topological sort, CPM, interval allocation, Luxon for timezones/DST |
| Data | PostgreSQL 16 via Prisma (migrations, exclusion + check constraints, JSONB) |
| Async & real-time | Redis, BullMQ workers, Socket.IO |
| AI service | Python, FastAPI, Pydantic; Anthropic Claude (structured outputs, opt-in) |
| Quality & delivery | Vitest, Supertest, Pytest, Playwright E2E, Docker Compose, nginx, GitHub Actions |

## 🏗️ Architecture

```mermaid
flowchart TB
  UI["React + TypeScript<br/>dashboard · calendar · Gantt · planning"] -->|"REST /api/v1"| API
  UI <-->|Socket.IO| API
  subgraph API["Node.js + Express API (modular monolith)"]
    ENG["Scheduling engine<br/>DAG · CPM · allocation · replan · feasibility"]
  end
  API --> PG[("PostgreSQL<br/>Prisma")]
  API --> RD[("Redis")]
  RD --> WK["BullMQ workers<br/>reminders · daily plan · risk alerts"]
  WK -->|"events via Redis pub/sub"| API
  API -->|"validated JSON"| AI["FastAPI AI service<br/>built-in parser · Claude (opt-in)"]
```

## 📄 Resume bullets

> **Smart Scheduling: AI-Assisted, Dependency-Aware Planning Platform**
> *React, TypeScript, Node.js, Express, PostgreSQL, Prisma, Redis/BullMQ, Socket.IO, Python, FastAPI, Docker*
>
> - Built a full-stack scheduling platform with an interactive calendar, a Gantt-style timeline, task dependencies and per-user working hours across timezones.
> - Engineered a deterministic scheduling engine using DAG cycle detection, topological sorting, the Critical Path Method and interval allocation. It schedules 1,000 interdependent tasks in ~0.6 s, and every benchmark schedule passed an independent check of all constraints.
> - Designed deadline-aware prioritization (deadline propagation + a lateness-minimizing repair pass) and feasibility analysis that quantifies capacity shortfalls and recommends scope, deadline or capacity changes.
> - Guaranteed conflict-free schedules with optimistic concurrency (stale commits → 409), transactional commits, and a PostgreSQL exclusion constraint that makes overlapping bookings impossible.
> - Integrated AI task extraction and daily briefings with dual schema validation (Pydantic + Zod), per-item rejection of invalid output, consent-gated external calls and grounding checks.
> - Delivered async reminders and risk alerts via BullMQ workers and real-time updates via Socket.IO; covered by 121 automated tests plus a Playwright E2E journey, running in Docker Compose with CI.

---

## 🚀 Quick start

### Option A: Docker (everything)

```bash
cp .env.example .env          # set JWT_SECRET
```

```bash
docker compose up --build
```

Open http://localhost:8080 and create an account. To load demo data:

```bash
cd backend && npm ci && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/smart_scheduling npm run db:seed
```

Demo login: `demo@smartscheduling.dev` / `password123`.

### Option B: Local development

Prerequisites: Node 22, Python 3.11+, PostgreSQL 16, Redis 7 (optional).

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
# 2. AI service (http://localhost:8000)
cd ai-service
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

```bash
# 3. Frontend (http://localhost:5173, proxies /api and /socket.io to :4000)
cd frontend
npm install
npm run dev
```

Without `REDIS_URL`, background jobs are disabled and everything else still works. With `INLINE_WORKER=true`, the BullMQ workers run inside the API process. In production, run them separately (`npm run worker`), as `docker-compose.yml` does.

## ☁️ Deploy to Vercel

The repo is set up for **Vercel Services** (`vercel.json` at the root): the frontend, the Express API and the FastAPI AI service deploy together as one project.

| Path | Service |
|---|---|
| `/api/*` | `backend/` (Express; `vercel-build` bundles the app exported from `src/app.ts` into `bundle/server.mjs`, loaded by the `vercel-entry.mjs` entrypoint) |
| `/_ai/*` | `ai-service/` (FastAPI; `main.py`), protected by `AI_SERVICE_TOKEN` |
| everything else | `frontend/` (Vite static build, SPA fallback) |

**Set it up once, and every push deploys automatically:**

1. Create a Postgres database (e.g. [Neon](https://neon.tech) or [Supabase](https://supabase.com); the migrations need the `btree_gist` extension, which both support).
2. Click **Deploy with Vercel** above (or *Add New → Project* and import this repo). Set the Framework Preset to **Services** if Vercel asks, and leave the Root Directory empty.
3. Add these environment variables (Production, and Preview if you want previews):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Your Postgres connection string (use the pooled URL if your provider offers one) |
   | `JWT_SECRET` | A long random string, e.g. `openssl rand -base64 48` |
   | `AI_SERVICE_TOKEN` | Another random string; the backend and AI service both read it |
   | `REDIS_URL` | *Optional*, e.g. Upstash. Without it, background jobs are off |
   | `AI_PROVIDER`, `ANTHROPIC_API_KEY` | *Optional*, to enable Claude (users must still opt in) |

4. Deploy. The backend's `vercel-build` script runs `prisma migrate deploy` first, so the schema is created automatically.

After that, **every push to `main` deploys to production and every other branch gets a preview URL**, through Vercel's GitHub integration. To load demo data into the hosted database, run `DATABASE_URL=… npm run db:seed` from `backend/`.

**What differs from the Docker deployment.** Vercel runs the API as serverless functions, so there is no WebSocket server and no long-running BullMQ worker. The app detects this through `GET /api/v1/meta`: it skips live updates and relies on normal refetching, and reminders, daily-plan and risk-alert jobs don't run. Everything else (scheduling, replanning, calendar, analytics, AI drafts) works the same. For live updates and background jobs, use `docker compose` or a host with long-running processes (Render, Railway, Fly.io).

> Preview deployments protected by Vercel Authentication can block the backend's server-to-server call to `/_ai`. AI extraction then falls back to the manual flow. Production deployments are unaffected.

---

## What's implemented

| Area | What you get |
|---|---|
| **Auth & workspaces** | Register/login, JWT access tokens with rotating single-use refresh tokens, personal workspace per user, member invites with owner/admin/member roles, membership checked on every protected request |
| **Projects & tasks** | Projects with target dates and milestones; tasks with estimate, logged time, priority, status, earliest start, due date, assignee, splittable flag; comments; activity log; optimistic concurrency on edits (`version`) |
| **Dependencies** | Finish-to-start links; cycle detection **before saving** with a readable explanation (`"A" → "B" → "C" → "A"`); per-workspace advisory lock so two concurrent requests can't each add half a cycle; DB check constraint against self-dependencies |
| **Calendar** | Day/week/month views in the user's timezone; task blocks beside fixed events, breaks and unavailable time (hatched); working hours shaded; **drag-and-drop with a server-side dry-run check** (fixed-event clash, double booking, prerequisite order = errors; outside hours, downstream impact, deadline = warnings you confirm); project and status filters |
| **Timeline** | Custom SVG Gantt: dependency connectors, critical path in red, milestones, target date, today line, late/blocked/at-risk flags, progress, day/week/month zoom, scheduled vs projected bars |
| **Scheduling engine** | Validation, cycle check, topological order, CPM, interval subtraction, greedy list scheduling into focus blocks, deadline inheritance and a deadline-repair pass, explanations per task. Never places work outside availability; reports shortfalls instead |
| **Preview → approve** | `preview` stores a pending recommendation; nothing touches the calendar until `commit`. Users can reject individual tasks (their dependents are excluded too) |
| **Replanning** | Delay a task or change an estimate: only that task and its descendants move, unaffected blocks are locked in place, and you get a before/after diff, impact chain and finish-date shift before approving |
| **Deadline feasibility** | Per task and per project target: required effort (including prerequisites) vs free capacity, ON_TRACK / AT_RISK / INFEASIBLE / OVERDUE, the tasks most responsible, and options (cut scope by X, move deadline to Y, add Z min/day, start earlier), with stated assumptions |
| **Daily briefing** | Top 3 priorities with reasons and suggested block, suggested first task, blocked tasks, deadlines in the next 3 days, today's capacity, unscheduled work. Built from engine data; AI may only rephrase |
| **AI** | Natural-language → **draft** tasks + dependencies (review/edit/confirm screen); friendlier briefing wording. Schema-validated in both the AI service (Pydantic) and the backend (Zod); invalid items are rejected individually, and a malformed response falls back to the manual flow |
| **Notifications** | Upcoming-block reminders (delayed BullMQ jobs, skipped if the block moved), deadline-risk alerts, dependency-unblocked, daily plan at the user's local hour, quiet hours, per-type preferences, deduplication keys |
| **Real-time** | Socket.IO rooms per user; workers publish through Redis so events from any process reach the browser |
| **Analytics** | Planned vs actual time per week, workload by project, overdue trend, estimate accuracy (median ratio, MAPE, % within ±20%), deadline feasibility |

---

## The scheduling engine

`backend/src/engine/` is pure TypeScript with no DB, network or clock access. Every input, including `now`, is passed in, so results are deterministic and unit-testable.

| File | Responsibility |
|---|---|
| `graph.ts` | DAG utilities: iterative DFS cycle detection with path reconstruction, Kahn topological sort with deterministic tie-breaks, ancestors/descendants |
| `cpm.ts` | Critical Path Method on remaining effort (forward/backward pass, slack, one concrete critical chain) |
| `intervals.ts` | Half-open interval merge/subtract/clip, sweep-line overlap detection |
| `availability.ts` | Weekly working-hour rules → concrete UTC intervals in the user's timezone (DST-safe via Luxon), minus events |
| `ranking.ts` | Transparent score = priority + urgency + critical-path bonus + blocker impact + age, each factor returned with a human-readable reason; weights configurable |
| `scheduler.ts` | The planner (below) |
| `feasibility.ts` | Deadline risk, recommendations, earliest feasible date |
| `replan.ts` | Affected-set computation, locking of unaffected blocks, before/after diff |
| `briefing.ts` | Daily priority summary |

**Algorithm (`generateSchedule`)**

1. Validate input; reject dependency cycles with the offending path.
2. Compute the critical path and, in one reverse-topological pass, each task's downstream set and **inherited deadline** (the earliest due date of anything waiting on it), so prerequisites of urgent work aren't starved.
3. Rank tasks.
4. Free time = working hours − fixed events − breaks − unavailable − locked blocks.
5. Greedy serial schedule generation: repeatedly take the highest-ranked task whose prerequisites are all complete/placed, and place it at the earliest free time after they finish. Long tasks are split into focus blocks (≤ the user's focus length, ≥ 30 min, 15-min breaks between) unless marked unsplittable.
6. **Deadline repair:** if any deadline is missed, retry with that task and its prerequisites placed first. Keep the change only if total lateness strictly drops and no extra work becomes unscheduled (≤ 6 attempts).
7. Return blocks, unscheduled tasks (with the reason: insufficient capacity, no contiguous slot, prerequisite unscheduled), warnings, critical path, per-task explanations and a capacity summary.

The engine **never** fabricates a schedule: work that doesn't fit is reported, not squeezed in.

---

## Engineering scenarios (spec §12) → where they're handled and tested

| Scenario | Handling | Test |
|---|---|---|
| **A. Dependency cycle** | DFS cycle check before insert, under a per-workspace advisory lock; 422 with the cycle path | `api.test.ts › rejects a dependency cycle`, `engine.test.ts › detects the A → B → C → A cycle` |
| **B. Two tasks compete for one slot** | Commit re-validates overlaps in a transaction; **Postgres exclusion constraint** (`EXCLUDE USING gist (user_id WITH =, tstzrange(start_at,end_at) WITH &&) WHERE status='CONFIRMED'`) as the last line of defence | `api.test.ts › database rejects overlapping confirmed blocks`, `› lets exactly one of two concurrent commits win` |
| **C. Prerequisite delayed** | `POST /schedules/replan` → affected descendants, locked unaffected blocks, diff + impact, preview first | `api.test.ts › replans only downstream work…`, `engine.test.ts › replanning` |
| **D. No feasible schedule** | Engine reports `INSUFFICIENT_CAPACITY`; feasibility reports the shortfall with options | `api.test.ts › reports a capacity shortfall…`, `engine.test.ts › reports capacity shortfall…` |
| **E. Two sessions commit** | Compare-and-set on `users.schedule_version` (`UPDATE … WHERE schedule_version = expected`) → 409 `STALE_SCHEDULE` | `api.test.ts › rejects a stale commit`, `› exactly one of two concurrent commits wins` |
| **F. AI returns invalid output** | Per-item validation in Python and TypeScript; bad items listed as rejected, the rest kept; malformed envelope → 503 with `fallback: "manual"`; provider errors fall back to the built-in parser | `api.test.ts › rejects invalid AI fields…`, `› falls back to the manual flow`, `test_ai_service.py › test_llm_invalid_items_are_dropped` |

---

## API (v1)

All endpoints except `/auth/*` need `Authorization: Bearer <accessToken>`. Errors are `{"error": {"code", "message", "details?"}}`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | Accounts and rotating refresh tokens |
| GET/PATCH | `/users/me` | Profile, timezone, focus length, notification prefs, quiet hours, AI consent |
| GET/PUT | `/availability` | Weekly working hours |
| GET/POST | `/workspaces` · `/workspaces/:id/members` · `/workspaces/:id/activity` | Workspaces, members, audit trail |
| GET/POST/PATCH/DELETE | `/projects` · `/projects/:id` | Projects |
| GET | `/projects/:id/tasks` · `/projects/:id/timeline` | Task list; Gantt data with CPM and risk flags |
| POST/DELETE | `/projects/:id/milestones` | Milestones |
| GET/POST | `/tasks` | List (filters) / create (with `dependsOn`) |
| GET/PATCH/DELETE | `/tasks/:id` | Details (deps, dependents, blocks, comments, activity) / update with `version` / delete |
| GET | `/tasks/:id/suggestions` | Where the engine would place this task now, and why |
| POST/DELETE | `/tasks/:id/dependencies` · `/tasks/:id/dependencies/:dependencyId` | Add (cycle-checked) / remove |
| POST | `/tasks/:id/comments` · `/tasks/:id/log-time` | Comments; time tracking |
| GET | `/calendar?from&to&projectId` | Events, blocks, working hours |
| POST/PATCH/DELETE | `/calendar/events[/:id]` | Fixed events, breaks, unavailable |
| POST/PATCH | `/calendar/blocks/:id/check` · `/calendar/blocks/:id` | Drag-and-drop dry run / move |
| POST | `/calendar/blocks/:id/complete` | Complete a block and log its time |
| POST | `/schedules/preview` | Generate a proposed schedule (stored as a pending recommendation) |
| POST | `/schedules/commit` | `{recommendationId, expectedVersion, excludeTaskIds?}`, returns 409 if stale |
| POST | `/schedules/replan` | `{changes:[{taskId, delayUntil?, estimatedMinutes?, priority?}]}` or `{taskIds}` / `{full:true}` |
| GET/POST | `/schedules/recommendations` · `/…/:id/dismiss` | History; reject a preview |
| GET | `/briefings/daily?ai=true` | Daily priority summary (+ optional AI wording) |
| GET | `/analytics/deadline-risk` · `/analytics/overview?weeks=8` | Feasibility; planned vs actual, workload, trends, estimate accuracy |
| GET/POST | `/notifications` · `/notifications/:id/read` · `/notifications/read-all` | In-app notifications |
| POST | `/ai/extract-tasks` · `/ai/confirm-tasks` | Draft tasks from text; persist approved drafts atomically |

Preview response shape (abridged):

```json
{
  "recommendationId": "…", "scheduleVersion": 4, "ok": true,
  "proposedBlocks": [{ "taskId": "…", "title": "Build backend APIs", "startAt": "2026-11-03T09:00:00.000Z", "endAt": "2026-11-03T10:30:00.000Z", "locked": false }],
  "unscheduledTasks": [], "warnings": [{ "taskId": "…", "code": "DEADLINE_MISSED", "reason": "…" }],
  "explanations": [{ "taskId": "…", "rank": 1, "score": 89, "reasons": ["high priority (+45)", "on the critical path (+20)", "blocks 4 downstream task(s) (+24)"] }],
  "criticalPath": [{ "taskId": "…", "title": "…" }],
  "summary": { "availableMinutes": 1170, "scheduledMinutes": 1080, "remainingMinutes": 90, "projectedFinish": "…" },
  "risks": [{ "title": "Website launch", "status": "AT_RISK", "explanation": "…", "recommendations": [{ "type": "MOVE_DEADLINE", "message": "…" }] }]
}
```

---

## Data model

PostgreSQL via Prisma (`backend/prisma/schema.prisma`). All timestamps are `timestamptz` (UTC) and are displayed in the user's timezone.

Tables: `users`, `refresh_tokens`, `workspaces`, `workspace_members` (PK `(workspace_id, user_id)`), `projects`, `milestones`, `tasks`, `task_dependencies` (unique `(task_id, depends_on_task_id)`, no self-links), `task_comments`, `calendar_events`, `availability_rules`, `scheduled_blocks`, `schedule_recommendations` (JSONB payload, `base_version`), `notifications` (unique `dedupe_key`), `activity_logs` (JSONB metadata).

Indexes include `tasks(project_id, status)`, `tasks(assignee_id, due_at)`, and `scheduled_blocks(user_id, start_at, end_at)`. Hand-written SQL in the initial migration adds the overlap exclusion constraint and check constraints.

---

## AI & privacy

- The AI service runs a **built-in deterministic parser by default**. Nothing leaves your server.
- To use Claude, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (model `ANTHROPIC_MODEL`, default `claude-opus-5-5`). Each user must still opt in under **Settings → AI & privacy**. Without consent, their text is never sent externally.
- Claude is called with structured outputs (`messages.parse` with a Pydantic schema). Refusals, errors and invalid output fall back to the built-in parser or template.
- AI-generated briefings pass a grounding check: every task they mention must exist in the engine's facts, or the template is used instead.
- AI output is always a **draft**. It never writes to the schedule.

Example (built-in parser):

> "Prepare the project demo by Friday. Finish API tests first, then create slides. I need around two hours for slides."

→ `Finish API tests` (estimate to confirm) → `Create slides` (120 min, due Friday 17:00), with "API tests before slides" as a dependency.

---

## Testing

```bash
cd backend && npm test            # 52 tests: engine unit tests + API integration tests + worker jobs (needs Postgres)
```

```bash
cd ai-service && pip install -r requirements-dev.txt && python -m pytest  # 27 tests: parsing, extraction, validation, fallbacks, grounding
```

```bash
cd frontend && npm run build      # type-check + production build
```

```bash
cd frontend && node e2e/smoke.mjs # 16-step browser journey against a running stack
```

Integration tests use the database in `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/smart_scheduling_test`, migrated with `prisma migrate deploy`). The E2E script covers: register → configure availability → create dependent tasks → cycle rejected → AI drafts confirmed → generate and accept a schedule → calendar → daily briefing → delay → before/after preview → accept revised plan → analytics → timeline → mobile layout. Set `BASE_URL` to run it against Docker (`http://localhost:8080`). It needs the `playwright` package, or set `PLAYWRIGHT_MODULE` to point at an installed copy.

### Measured performance

Measured in the development container (`npm run benchmark`, `npm run latency`). Your numbers will differ.

| Tasks | Dependencies | Cycle check | Schedule generation (median of 5) | Constraints satisfied |
|---|---|---|---|---|
| 100 | 99 | 0.6 ms | 68 ms | yes |
| 500 | 518 | 0.5 ms | 288 ms | yes |
| 1,000 | 1,063 | 0.6 ms | 634 ms | yes |

"Constraints satisfied" is checked independently by the benchmark: every dependency is respected, every block lies inside working hours, and no blocks overlap. At 1,000 tasks, 123 tasks don't fit the 365-day synthetic horizon and are correctly reported as unscheduled.

| Endpoint (demo data, n=50) | p50 | p95 | p99 |
|---|---|---|---|
| `GET /calendar` | 5.9 ms | 9.8 ms | 29.1 ms |
| `GET /briefings/daily` | 17.1 ms | 21.7 ms | 30.2 ms |
| `GET /analytics/deadline-risk` | 15.1 ms | 20.3 ms | 26.4 ms |
| `POST /schedules/preview` | 21.8 ms | 26.7 ms | 46.1 ms |

---

## Repository layout

```
smart-scheduling/
├── backend/                 Node.js + Express + TypeScript API
│   ├── src/engine/          deterministic scheduling engine (pure functions)
│   ├── src/modules/         auth, users, workspaces, projects, tasks, calendar,
│   │                        scheduling, analytics, briefings, notifications, ai, activity
│   ├── src/middleware/      auth, validation (zod), errors
│   ├── src/queues/ workers/ BullMQ queues and jobs
│   ├── src/realtime/        Socket.IO + Redis relay
│   ├── src/app.ts · main.ts Express app (serverless entry) · long-running server
│   ├── prisma/              schema, migrations (incl. exclusion constraint), seed
│   ├── scripts/             benchmark.ts, latency.ts
│   └── tests/               unit/ (engine) and integration/ (API, workers)
├── ai-service/              Python FastAPI: task extraction, daily briefing, schemas
├── frontend/                React + TypeScript + Tailwind + FullCalendar
│   ├── src/pages/           landing, auth, onboarding, dashboard, calendar,
│   │                        projects, project detail, planning, analytics, settings
│   ├── src/features/        tasks (detail panel), projects (Gantt), scheduling, analytics
│   └── e2e/smoke.mjs        browser journey
├── vercel.json              Vercel Services: frontend + API + AI service
├── docker-compose.yml       postgres, redis, ai-service, backend, worker, frontend (nginx)
├── .github/workflows/ci.yml
└── .env.example
```

---

## Design decisions

- **Modular monolith + one Python service.** The engine lives in the API process, so previews take tens of milliseconds. Only the AI service is separate, because it has a different runtime.
- **Correctness lives in the engine, not the model.** Priorities, feasibility and placement are deterministic and unit-tested; AI only drafts and rephrases.
- **Defence in depth for concurrency.** Optimistic version checks catch stale sessions; transactions keep commits atomic; the exclusion constraint makes double-booking impossible even under races.
- **Preview before change.** Every schedule mutation goes through a stored recommendation the user approves, or an explicit drag-and-drop with a dry-run check.
- **Explainability.** Ranking factors, waits, deadline inheritance, repair moves, risk assumptions and recommendations are all returned as text the UI shows.

## Future work

Calendar import/sync (Google), team capacity balancing, more dependency types (SS/FF/SF), recurring tasks, OR-Tools optimisation, learning estimates from history (the estimate-accuracy data is already collected), email/Slack delivery, and a mobile app.
