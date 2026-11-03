"""Pydantic schemas: request/response contracts and validation of AI output."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

Priority = Literal["LOW", "MEDIUM", "HIGH", "URGENT"]


class ExtractRequest(BaseModel):
    text: str = Field(min_length=3, max_length=5000)
    timezone: str = "UTC"
    now: Optional[datetime] = None
    # Only when True may task text be sent to an external LLM provider.
    allow_external: bool = False


class DraftTask(BaseModel):
    tempId: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=300)
    description: Optional[str] = Field(default=None, max_length=5000)
    estimatedMinutes: Optional[int] = Field(default=None, ge=1, le=10_000)
    dueAt: Optional[str] = None
    priority: Priority = "MEDIUM"
    confidence: float = Field(default=0.5, ge=0, le=1)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("missing title")
        return v

    @field_validator("dueAt")
    @classmethod
    def _due(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError as e:
            raise ValueError(f"invalid date {v!r}") from e
        if dt.tzinfo is None:
            raise ValueError("date must include a timezone offset")
        now = datetime.now(timezone.utc)
        if dt < now - timedelta(days=1) or dt > now + timedelta(days=3 * 365):
            raise ValueError("date out of range")
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class DraftDependency(BaseModel):
    taskTempId: str
    dependsOnTempId: str


class ExtractResponse(BaseModel):
    tasks: list[DraftTask]
    dependencies: list[DraftDependency]
    warnings: list[str]
    provider: str


# ---- Schema the LLM must fill (structured output) -------------------------

class LlmTask(BaseModel):
    tempId: str = Field(description="Short id like t1, t2")
    title: str = Field(description="Imperative task title, e.g. 'Run API tests'")
    estimatedMinutes: Optional[int] = Field(
        description="Only if the text states or clearly implies a duration; otherwise null")
    dueAt: Optional[str] = Field(
        description="ISO 8601 datetime with offset if the text gives a deadline; otherwise null")
    priority: Priority


class LlmDependency(BaseModel):
    taskTempId: str = Field(description="The task that must wait")
    dependsOnTempId: str = Field(description="The task that must finish first")


class LlmExtraction(BaseModel):
    tasks: list[LlmTask]
    dependencies: list[LlmDependency]


class BriefingRequest(BaseModel):
    facts: dict[str, Any]
    allow_external: bool = False


class BriefingResponse(BaseModel):
    text: str
    provider: str


class LlmBriefing(BaseModel):
    text: str = Field(description="2-5 sentence briefing, plain text")
    referencedTaskIds: list[str] = Field(description="Ids of every task mentioned in the text")
