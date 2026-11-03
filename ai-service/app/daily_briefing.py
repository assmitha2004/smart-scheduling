"""Turns the scheduling engine's structured daily facts into a readable briefing.

The engine is the source of truth. This module only rephrases; the LLM path
is checked for grounding (every task it mentions must exist in the facts)
and falls back to the template on any failure.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .schemas import BriefingRequest, BriefingResponse, LlmBriefing
from . import llm

log = logging.getLogger(__name__)


def _fmt_minutes(m: int | float) -> str:
    m = int(round(m or 0))
    h, r = divmod(m, 60)
    if not h:
        return f"{r} min"
    return f"{h}h {r}m" if r else f"{h}h"


def _time(iso: str | None, tz: str) -> str | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo(tz)).strftime("%H:%M")
    except (ValueError, KeyError):
        return None


def template_briefing(facts: dict[str, Any]) -> str:
    tz = facts.get("timezone") or "UTC"
    lines: list[str] = []
    first = facts.get("suggestedFirstTask")
    top = facts.get("topTasks") or []
    if first:
        blk = next((t.get("suggestedBlock") for t in top if t.get("taskId") == first.get("taskId")), None)
        when = _time(blk.get("startAt") if blk else None, tz)
        why = (first.get("why") or "").rstrip(".")
        lines.append(f'Start with "{first["title"]}"' + (f" at {when}" if when else "") + (f" - {why[0].lower() + why[1:]}." if why else "."))
    else:
        lines.append("Nothing is ready to work on right now - check your blocked tasks below.")
    rest = [t for t in top if not first or t.get("taskId") != first.get("taskId")]
    if rest:
        lines.append("After that: " + ", ".join(f'"{t["title"]}"' for t in rest[:2]) + ".")
    cap = facts.get("capacity") or {}
    lines.append(
        f"You have {_fmt_minutes(cap.get('availableMinutesToday', 0))} of free focus time today, "
        f"{_fmt_minutes(cap.get('scheduledMinutesToday', 0))} of it already planned."
    )
    blocked = facts.get("blockedTasks") or []
    if blocked:
        b = blocked[0]
        waits = ", ".join(f'"{x["title"]}"' for x in b.get("blockedBy", []))
        more = f" (and {len(blocked) - 1} more)" if len(blocked) > 1 else ""
        lines.append(f'"{b["title"]}" is blocked until {waits} is done{more}.')
    for r in (facts.get("atRisk") or [])[:2]:
        label = {"INFEASIBLE": "Heads up - not feasible as planned", "OVERDUE": "Overdue"}.get(r.get("status"), "At risk")
        lines.append(f'{label}: "{r["title"]}".')
    unscheduled = facts.get("unscheduledWork") or []
    if unscheduled:
        lines.append(f"{len(unscheduled)} task(s) don't fit in your current availability.")
    return " ".join(lines)


BRIEFING_SYSTEM = """You write a short, friendly morning briefing for a scheduling app.
Use ONLY the facts in the JSON you are given. Do not invent tasks, times, durations, statuses or capacity.
Mention the suggested first task and why, remaining focus time, blockers and at-risk deadlines if present.
2-5 sentences, plain text, no markdown. List the id of every task you mention in referencedTaskIds."""


def _known_ids_and_titles(facts: dict[str, Any]) -> tuple[set[str], set[str]]:
    ids: set[str] = set()
    titles: set[str] = set()

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("taskId", "id") and isinstance(v, str):
                    ids.add(v)
                if k == "title" and isinstance(v, str):
                    titles.add(v.lower())
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(facts)
    return ids, titles


def grounded(text: str, referenced: list[str], facts: dict[str, Any]) -> bool:
    ids, titles = _known_ids_and_titles(facts)
    if any(r not in ids for r in referenced):
        return False
    # Every quoted name in the text must be a real task/project title.
    for quoted in re.findall(r'"([^"]{2,200})"', text):
        if quoted.lower() not in titles:
            return False
    return 0 < len(text) <= 1500


def make_briefing(req: BriefingRequest) -> BriefingResponse:
    if req.allow_external and llm.available():
        try:
            out = llm.structured(BRIEFING_SYSTEM, json.dumps(req.facts, default=str), LlmBriefing)
            if grounded(out.text, out.referencedTaskIds, req.facts):
                return BriefingResponse(text=out.text.strip(), provider="anthropic")
            log.warning("LLM briefing failed grounding check; using template")
        except Exception as e:  # noqa: BLE001
            log.warning("LLM briefing failed, using template: %s", e)
    return BriefingResponse(text=template_briefing(req.facts), provider="template")
