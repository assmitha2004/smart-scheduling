from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import llm, task_extraction
from app.daily_briefing import grounded, make_briefing, template_briefing
from app.main import app
from app.parsing import parse_deadline, parse_duration_minutes, parse_priority
from app.schemas import BriefingRequest, ExtractRequest, LlmExtraction, LlmTask, LlmDependency

client = TestClient(app)
# Tuesday 3 Nov 2026, 09:00 UTC
NOW = datetime(2026, 11, 3, 9, 0, tzinfo=timezone.utc)


def extract(text: str, **kw):
    return task_extraction.extract_with_rules(ExtractRequest(text=text, now=NOW, timezone=kw.get("tz", "UTC")))


def test_spec_example():
    res = extract("Prepare the project demo by Friday. Finish API tests first, then create slides. "
                  "I need around two hours for slides.")
    titles = [t.title for t in res.tasks]
    assert titles == ["Finish API tests", "Create slides"]
    tests, slides = res.tasks
    assert tests.estimatedMinutes is None  # "estimate to be confirmed"
    assert slides.estimatedMinutes == 120
    assert slides.dueAt == "2026-11-06T17:00:00Z"  # Friday, end of day
    assert [(d.taskTempId, d.dependsOnTempId) for d in res.dependencies] == [(slides.tempId, tests.tempId)]
    assert any("Finish API tests" in w for w in res.warnings)


@pytest.mark.parametrize("text,minutes", [
    ("around two hours", 120), ("90 min", 90), ("1.5h", 90), ("half an hour", 30),
    ("2-3 hours", 180), ("an hour", 60), ("45 minutes", 45), ("nothing here", None),
])
def test_durations(text, minutes):
    assert parse_duration_minutes(text) == minutes


@pytest.mark.parametrize("text,iso", [
    ("by Friday", "2026-11-06T17:00:00+00:00"),
    ("by tomorrow at 3pm", "2026-11-04T15:00:00+00:00"),
    ("due Nov 20", "2026-11-20T17:00:00+00:00"),
    ("by 2026-12-01", "2026-12-01T17:00:00+00:00"),
    ("in 3 days", "2026-11-06T17:00:00+00:00"),
    ("by Tuesday", "2026-11-10T17:00:00+00:00"),  # said on a Tuesday -> next week
])
def test_deadlines(text, iso):
    assert parse_deadline(text, NOW, "UTC").isoformat() == iso


def test_deadline_respects_timezone():
    d = parse_deadline("by Friday", NOW, "Asia/Kolkata")
    assert d.utcoffset().total_seconds() == 5.5 * 3600 and d.hour == 17


def test_priority():
    assert parse_priority("fix login ASAP") == "URGENT"
    assert parse_priority("important: review PR") == "HIGH"
    assert parse_priority("tidy docs if time permits") == "LOW"


def test_before_after_and_parallel():
    res = extract("Write tests before deploying the fix. Update docs and email the team.")
    titles = [t.title for t in res.tasks]
    assert "Write tests" in titles and "Deploy the fix" in titles
    assert "Update docs" in titles and "Email the team" in titles
    by = {t.title: t.tempId for t in res.tasks}
    assert (by["Deploy the fix"], by["Write tests"]) in [(d.taskTempId, d.dependsOnTempId) for d in res.dependencies]


def test_inline_estimate_and_deadline():
    res = extract("Write the report (3 hours) by Monday, urgent")
    t = res.tasks[0]
    assert t.title == "Write the report"
    assert t.estimatedMinutes == 180
    assert t.priority == "URGENT"
    assert t.dueAt == "2026-11-09T17:00:00Z"


def test_endpoint_validates_timezone():
    r = client.post("/extract-tasks", json={"text": "Write report by Friday", "timezone": "Mars/Base"})
    assert r.status_code == 422
    r = client.post("/extract-tasks", json={"text": "Write report by Friday", "timezone": "UTC"})
    assert r.status_code == 200 and r.json()["provider"] == "rules"


def test_no_external_call_without_consent(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: True)
    called = []
    monkeypatch.setattr(llm, "structured", lambda *a, **k: called.append(1))
    r = client.post("/extract-tasks", json={"text": "Write report by Friday", "allow_external": False})
    assert r.json()["provider"] == "rules" and not called


def test_llm_invalid_items_are_dropped(monkeypatch):
    """Scenario F: invalid date / missing title are rejected, valid items kept."""
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "structured", lambda *a, **k: LlmExtraction(
        tasks=[
            LlmTask(tempId="t1", title="Run API tests", estimatedMinutes=None, dueAt=None, priority="MEDIUM"),
            LlmTask(tempId="t2", title="Create slides", estimatedMinutes=120, dueAt="next friday-ish", priority="HIGH"),
            LlmTask(tempId="t3", title="   ", estimatedMinutes=30, dueAt=None, priority="LOW"),
        ],
        dependencies=[LlmDependency(taskTempId="t2", dependsOnTempId="t1"), LlmDependency(taskTempId="t1", dependsOnTempId="t9")],
    ))
    r = client.post("/extract-tasks", json={"text": "demo stuff", "allow_external": True}).json()
    assert r["provider"] == "anthropic"
    assert [t["tempId"] for t in r["tasks"]] == ["t1"]
    assert r["dependencies"] == []
    assert sum("Dropped AI suggestion" in w for w in r["warnings"]) == 2


def test_llm_failure_falls_back_to_rules(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: True)

    def boom(*a, **k):
        raise llm.RefusedError("declined")

    monkeypatch.setattr(llm, "structured", boom)
    r = client.post("/extract-tasks", json={"text": "Write report by Friday", "allow_external": True}).json()
    assert r["provider"] == "rules"
    assert "built-in parser" in r["warnings"][0]


FACTS = {
    "timezone": "UTC",
    "suggestedFirstTask": {"taskId": "a", "title": "Run API tests", "why": "Blocks 1 downstream task(s) (+6)."},
    "topTasks": [{"taskId": "a", "title": "Run API tests", "suggestedBlock": {"startAt": "2026-11-03T10:00:00Z", "endAt": "2026-11-03T11:00:00Z"}}],
    "blockedTasks": [{"taskId": "b", "title": "Create slides", "blockedBy": [{"taskId": "a", "title": "Run API tests"}]}],
    "atRisk": [{"id": "c", "title": "Deployment", "status": "AT_RISK", "explanation": "..."}],
    "capacity": {"availableMinutesToday": 180, "scheduledMinutesToday": 60, "remainingMinutesToday": 120},
    "unscheduledWork": [],
}


def test_template_briefing_uses_only_facts():
    text = template_briefing(FACTS)
    assert 'Start with "Run API tests" at 10:00' in text
    assert "3h of free focus time" in text
    assert '"Create slides" is blocked until "Run API tests"' in text
    assert grounded(text, ["a", "b", "c"], FACTS)


def test_ungrounded_llm_briefing_is_rejected(monkeypatch):
    from app.schemas import LlmBriefing
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "structured", lambda *a, **k: LlmBriefing(text='Start with "Write novel" today.', referencedTaskIds=["zzz"]))
    out = make_briefing(BriefingRequest(facts=FACTS, allow_external=True))
    assert out.provider == "template"


def test_routes_are_served_under_vercel_prefix():
    r = client.post("/_ai/extract-tasks", json={"text": "Write report by Friday"})
    assert r.status_code == 200 and r.json()["tasks"][0]["title"] == "Write report"
    assert client.get("/_ai/health").json()["status"] == "ok"


def test_internal_token_is_enforced_when_configured(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_TOKEN", "s3cret")
    body = {"text": "Write report by Friday"}
    assert client.post("/_ai/extract-tasks", json=body).status_code == 401
    assert client.post("/_ai/extract-tasks", json=body, headers={"x-internal-token": "nope"}).status_code == 401
    assert client.post("/_ai/extract-tasks", json=body, headers={"x-internal-token": "s3cret"}).status_code == 200


def test_understand_day_without_claude_falls_back_to_rules(monkeypatch):
    monkeypatch.delenv("AI_PROVIDER", raising=False)
    r = client.post("/understand-day", json={"text": "study 2h", "now": NOW.isoformat(), "allow_external": True})
    assert r.status_code == 200
    assert r.json() == {"provider": "rules", "understanding": None}


def test_understand_day_with_claude(monkeypatch):
    from app import day_understanding as du
    fake = du.DayUnderstanding(date="today", tasks=[
        du.DayTask(title="Revise maths", minutes=120, minutes_guessed=False, must_do=True, top=True, effort="HARD"),
        du.DayTask(title="Essay", minutes=60, minutes_guessed=True, must_do=True, top=True, effort="HARD"),
    ])
    monkeypatch.setattr(du.llm, "available", lambda: True)
    monkeypatch.setattr(du.llm, "structured", lambda *a, **k: fake)
    res = du.understand_day(du.UnderstandDayRequest(text="x", now=NOW, allow_external=True))
    assert res.provider == "anthropic"
    assert [t.top for t in res.understanding.tasks] == [True, False]  # only one #1
    # Without the user's consent Claude is never called.
    assert du.understand_day(du.UnderstandDayRequest(text="x", now=NOW, allow_external=False)).provider == "rules"


PLAN_REQ = {"message": "gym daily this week", "spec": {}, "today": "2026-11-11", "now": "2026-11-11T10:00:00", "defaults": {}, "allow_external": True}


def test_plan_chat_without_claude_falls_back_to_rules(monkeypatch):
    monkeypatch.delenv("AI_PROVIDER", raising=False)
    r = client.post("/plan-chat", json=PLAN_REQ)
    assert r.status_code == 200
    assert r.json() == {"provider": "rules", "result": None}


def test_plan_chat_with_claude(monkeypatch):
    from app import plan_chat as pc
    spec = pc.PlanSpec(startDate="2026-11-11", days=5, dayStart="07:30", dayEnd="22:00", peak="MORNING", tasks=[
        pc.PlanTask(key="a", title="Gym", minutes=60, minutesGuessed=True, effort="MEDIUM", top=True, mustDo=False, repeat="DAILY"),
        pc.PlanTask(key="b", title="Leetcode", minutes=60, minutesGuessed=False, effort="HARD", top=True, mustDo=True, repeat="WEEKLY", timesPerWeek=3),
    ])
    fake = pc.ChatResult(reply="Got it.", spec=spec, question=pc.ChatQuestion(text="How long is gym?", options=["30 min", "1 hour"]), ready=False, finalize=False)
    monkeypatch.setattr(pc.llm, "available", lambda: True)
    monkeypatch.setattr(pc.llm, "structured", lambda *a, **k: fake)
    res = pc.plan_chat(pc.PlanChatRequest(**PLAN_REQ))
    assert res.provider == "anthropic"
    assert [t.top for t in res.result.spec.tasks] == [True, False]  # only one #1
    assert pc.plan_chat(pc.PlanChatRequest(**{**PLAN_REQ, "allow_external": False})).provider == "rules"


def test_plan_chat_provider_failure_falls_back(monkeypatch):
    from app import plan_chat as pc

    def boom(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(pc.llm, "available", lambda: True)
    monkeypatch.setattr(pc.llm, "structured", boom)
    assert pc.plan_chat(pc.PlanChatRequest(**PLAN_REQ)).provider == "rules"
