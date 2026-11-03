"""Smart Scheduling AI service (FastAPI).

POST /extract-tasks  - free text -> validated draft tasks + dependencies
POST /daily-briefing - engine facts -> readable briefing text
GET  /health
"""
from __future__ import annotations

import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, HTTPException

from . import llm
from .daily_briefing import make_briefing
from .schemas import BriefingRequest, BriefingResponse, ExtractRequest, ExtractResponse
from .task_extraction import extract_tasks

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="Smart Scheduling AI service", version="1.0.0")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "externalProvider": "anthropic" if llm.available() else None, "model": llm.MODEL if llm.available() else None}


@app.post("/extract-tasks", response_model=ExtractResponse)
def extract(req: ExtractRequest) -> ExtractResponse:
    try:
        ZoneInfo(req.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(status_code=422, detail=f"Unknown timezone {req.timezone!r}")
    return extract_tasks(req)


@app.post("/daily-briefing", response_model=BriefingResponse)
def briefing(req: BriefingRequest) -> BriefingResponse:
    return make_briefing(req)
