# Smart Scheduling

**AI-assisted, dependency-aware planning for projects and personal work.**

Smart Scheduling turns project tasks, deadlines, dependencies, and working hours into a proposed daily plan. The scheduling engine is deterministic and explainable; AI-assisted extraction and briefings produce drafts that users review rather than silently changing their schedule.

## MVP features

- JWT registration and login
- Projects and tasks with estimates, priorities, due dates, and statuses
- Finish-to-start task dependencies with cycle detection
- Dependency-aware schedule preview using topological ordering
- Work-window allocation and deadline feasibility warnings
- Explicit schedule preview/commit flow
- Daily priority briefing endpoint
- FastAPI service for draft task extraction and grounded briefings
- PostgreSQL persistence through Prisma
- Docker Compose for PostgreSQL, Redis, API, frontend, and AI service

## Architecture

```text
React + TypeScript (Vite)
        | REST / JSON
Node.js + Express + TypeScript
        | Prisma
   PostgreSQL       Scheduling Engine
        |
 FastAPI AI service (draft extraction / briefing)
```

This MVP uses a modular backend rather than microservices for every domain. The Python AI service is separate because it has a distinct runtime.

## Quick start with Docker

1. Clone this repository.
2. Copy `.env.example` to `.env`.
3. Set a strong unique `JWT_SECRET` and non-default database password in `.env`.
4. Run:

   ```bash
   docker compose up --build
   ```

5. Open the frontend at http://localhost:5173. API health: http://localhost:4000/health. AI health: http://localhost:8000/health.

## Local development

- Backend: `cd backend && npm install && npx prisma generate && npx prisma db push && npm run dev`
- Frontend: `cd frontend && npm install && npm run dev`
- AI service: `cd ai-service && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000`

The backend expects PostgreSQL and a `DATABASE_URL`. The frontend uses `VITE_API_URL`, defaulting to `http://localhost:4000/api/v1`.

## API overview

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`
- `GET/POST /api/v1/projects`
- `GET/POST /api/v1/projects/:projectId/tasks`
- `PATCH /api/v1/tasks/:taskId`
- `POST /api/v1/tasks/:taskId/dependencies`
- `POST /api/v1/schedules/preview`
- `POST /api/v1/schedules/commit`
- `GET /api/v1/briefings/daily`

Protected routes require `Authorization: Bearer <token>`.

## Scheduling model

The scheduler topologically orders unfinished tasks, prioritizes urgent/high-priority and earlier-due work, and places tasks into the configured working window around fixed calendar events and already proposed blocks. It respects finish-to-start dependencies and reports tasks that cannot fit before their deadlines. This is a practical MVP heuristic, not a globally optimal solver.

Schedule generation is a **preview**. Users explicitly confirm a proposed set of blocks before it is committed.

## Repository structure

```text
frontend/       React + TypeScript application
backend/        Express API, Prisma schema, auth, task and schedule routes
ai-service/     FastAPI draft extraction and daily briefing endpoints
docker-compose.yml
.env.example
```

## Engineering scenarios to extend and test

- Reject dependency cycles before persisting a new edge.
- Prevent overlapping proposed blocks.
- Replan downstream tasks after a prerequisite slips.
- Explain capacity shortfalls when work cannot fit before a deadline.
- Add optimistic schedule-version checks for concurrent clients.
- Validate all AI output and keep AI-created tasks as drafts pending approval.

## Production hardening

Before production use, add email verification, refresh-token rotation, password reset, audit logging, workspace roles, robust timezone/DST tests, calendar provider sync, observability, stronger schedule concurrency controls, and an explicitly opted-in external AI provider. Run migrations in a controlled deployment pipeline. Never commit secrets or expose them to the frontend.

## Resume description (update to match measured results)

**Smart Scheduling — AI-Powered Dependency-Aware Planning Platform**  
*React, TypeScript, Node.js, Express, PostgreSQL, Prisma, Python, FastAPI*

- Built a full-stack planning platform with project/task management, working-hour configuration, and proposed schedule approval.
- Implemented dependency graph validation and topological scheduling to order prerequisite tasks and allocate work into available time windows.
- Added deadline feasibility reporting and a schedule preview/commit workflow to keep users in control of calendar changes.
- Added a FastAPI service for structured draft task extraction and task-grounded daily briefings.

Measure performance and test coverage before adding numerical claims to a resume.
