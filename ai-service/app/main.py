"""Smart Scheduling AI service (FastAPI).

POST /extract-tasks  - free text -> validated draft tasks + dependencies
POST /daily-briefing - engine facts -> readable briefing text
POST /understand-day - a day described in words -> tasks + day settings (Claude only)
POST /plan-chat      - one turn of the planner chat (Claude only)
GET  /health

Every route is also served under /_ai, which is how the Vercel deployment
routes to this service. If AI_SERVICE_TOKEN is set, calls must send it in
the x-internal-token header (the backend does), so the public route can't
be used by anyone else.
"""
from __future__ import annotations

import hmac
import logging
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException

from . import llm
from .daily_briefing import make_briefing
from .schemas import BriefingRequest, BriefingResponse, ExtractRequest, ExtractResponse
from .task_extraction import extract_tasks
from .day_understanding import UnderstandDayRequest, UnderstandDayResponse, understand_day
from .plan_chat import PlanChatRequest, PlanChatResponse, plan_chat

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Smart Scheduling AI service", version="1.0.0")
router = APIRouter()


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("AI_SERVICE_TOKEN")
    if expected and not (x_internal_token and hmac.compare_digest(x_internal_token, expected)):
        raise HTTPException(status_code=401, detail="Invalid internal token")


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "externalProvider": "anthropic" if llm.available() else None, "model": llm.MODEL if llm.available() else None}


@router.post("/extract-tasks", response_model=ExtractResponse, dependencies=[Depends(require_internal_token)])
def extract(req: ExtractRequest) -> ExtractResponse:
    try:
        ZoneInfo(req.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(status_code=422, detail=f"Unknown timezone {req.timezone!r}")
    return extract_tasks(req)


@router.post("/daily-briefing", response_model=BriefingResponse, dependencies=[Depends(require_internal_token)])
def briefing(req: BriefingRequest) -> BriefingResponse:
    return make_briefing(req)


@router.post("/understand-day", response_model=UnderstandDayResponse, dependencies=[Depends(require_internal_token)])
def understand(req: UnderstandDayRequest) -> UnderstandDayResponse:
    return understand_day(req)



@router.post("/plan-chat", response_model=PlanChatResponse, dependencies=[Depends(require_internal_token)])
def chat(req: PlanChatRequest) -> PlanChatResponse:
    return plan_chat(req)


app.include_router(router)
app.include_router(router, prefix="/_ai")
