"""Natural-language task extraction.

Two providers:
  * ``rules``     - deterministic, local, always available (default).
  * ``anthropic`` - Claude via structured outputs; only used when the user has
                    consented to external processing AND credentials exist.
Whatever the provider, output is validated against the Pydantic schemas and
returned as DRAFTS - the backend never saves them without user approval.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

from pydantic import ValidationError

from .parsing import DURATION_RE, parse_deadline, parse_duration_minutes, parse_priority, strip_deadline, DEADLINE_RE
from .schemas import DraftDependency, DraftTask, ExtractRequest, ExtractResponse, LlmExtraction
from . import llm

log = logging.getLogger(__name__)

ACTION_VERBS = {
    "add", "analyze", "build", "buy", "call", "check", "clean", "code", "collect", "complete", "configure",
    "create", "debug", "deploy", "design", "document", "draft", "email", "finish", "fix", "implement",
    "integrate", "investigate", "learn", "make", "meet", "migrate", "plan", "practice", "prepare", "present",
    "publish", "read", "record", "refactor", "release", "research", "review", "revise", "run", "schedule",
    "send", "set", "ship", "study", "submit", "test", "update", "upload", "verify", "watch", "write", "launch",
    "book", "pay", "file", "organize", "outline", "edit", "polish", "rehearse", "practise", "train", "install",
}
UMBRELLA_VERBS = {"prepare", "finish", "deliver", "ship", "launch", "complete", "get"}
SEQ_SPLIT = re.compile(r"\s*(?:,\s*|;\s*)?\b(?:and then|then|after that|afterwards|followed by|next,)\s+|\s*;\s*", re.I)
FILLER_PREFIX = re.compile(
    r"^(?:and\s+|also\s+|finally\s+|first(?:ly)?,?\s+|please\s+|then\s+|"
    r"(?:i|we)\s+(?:need|have|want|must|should|will|'ll)\s+(?:to\s+)?|(?:i|we)'(?:ll|d)\s+|"
    r"need to\s+|have to\s+|got to\s+|gotta\s+|remember to\s+|don't forget to\s+|make sure to\s+)+",
    re.I,
)
FILLER_SUFFIX = re.compile(r"\s+(?:first|asap|as soon as possible|urgently|later|too|as well)\s*$", re.I)
DURATION_PHRASE = re.compile(
    r"\s*[\(\[]?\s*(?:for|in|takes?|taking|(?:that )?will take|should take|~|about|around|roughly|approx\.?|approximately)?\s*"
    r"(?:about|around|roughly|~)?\s*" + DURATION_RE.pattern + r"\s*[\)\]]?",
    re.I,
)
ESTIMATE_SENTENCE = re.compile(
    r"^(?:it(?:'ll| will)? takes?|(?:i|we)(?:'ll)? (?:need|have|allow|budget|spend|want)|allow|budget|plan|reserve|"
    r"(?:the\s+)?(?P<subj>.+?)\s+(?:will|should|might)?\s*takes?)\b",
    re.I,
)
STOP = {"the", "a", "an", "for", "to", "of", "on", "and", "my", "our", "some", "with", "about", "around", "need", "i", "we"}


def _words(s: str) -> set[str]:
    return {w.rstrip("s") for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 1}


def _base_verb(word: str) -> Optional[str]:
    """'deploying' -> 'deploy', 'writing' -> 'write', 'runs' -> 'run'."""
    w = word.lower()
    if w in ACTION_VERBS:
        return w
    if w.endswith("ing"):
        stem = w[:-3]
        for cand in (stem, stem + "e", stem[:-1] if len(stem) > 2 and stem[-1] == stem[-2] else None):
            if cand and cand in ACTION_VERBS:
                return cand
    if w.endswith("s") and w[:-1] in ACTION_VERBS:
        return w[:-1]
    return None


def _first_verb(s: str) -> Optional[str]:
    """The base form of the first word if it is a known action verb, else the raw word."""
    m = re.match(r"\s*([A-Za-z']+)", s)
    if not m:
        return None
    return _base_verb(m.group(1)) or m.group(1).lower()


def _clean_title(clause: str) -> str:
    t = strip_deadline(clause)
    t = DURATION_PHRASE.sub(" ", t)
    t = re.sub(r"\b(urgent(?:ly)?|asap|important|high priority|low priority|if time permits)\b", "", t, flags=re.I)
    prev = None
    while prev != t:
        prev = t
        t = FILLER_PREFIX.sub("", t.strip())
        t = FILLER_SUFFIX.sub("", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,.;:-!")
    # Gerund -> imperative: "deploying the fix" -> "deploy the fix".
    m = re.match(r"([A-Za-z]+ing)\b", t)
    if m and _base_verb(m.group(1)):
        t = _base_verb(m.group(1)) + t[len(m.group(1)):]
    return t[:1].upper() + t[1:] if t else t


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+|^\s*[-*•]\s+|\s+[-*•]\s+(?=[A-Za-z])", text.strip())
    return [re.sub(r"^\s*(?:\d+[.)]|[-*•])\s*", "", p).strip(" .!?") for p in parts if p and p.strip(" .!?")]


def _estimate_statement(sentence: str) -> Optional[tuple[str, int]]:
    """'I need around two hours for slides' -> ('slides', 120)."""
    minutes = parse_duration_minutes(sentence)
    if minutes is None:
        return None
    verb = _first_verb(_clean_title(sentence) or "")
    m = ESTIMATE_SENTENCE.match(sentence.strip())
    if not m:
        return None
    target = None
    tm = re.search(r"\b(?:for|on|to do|doing)\s+(?:the\s+)?(.+)$", DURATION_RE.split(sentence, maxsplit=1)[-1] if DURATION_RE.search(sentence) else sentence, re.I)
    if tm:
        target = tm.group(1)
    elif m.group("subj"):
        target = m.group("subj")
    if not target:
        return None
    if verb in ACTION_VERBS and not sentence.lower().startswith(("i need around", "i need about", "it")):
        # "Write the report, about 2 hours" is a task, not an estimate statement.
        if not re.match(r"^(?:i|we)", sentence, re.I):
            return None
    return target.strip(" .,"), minutes


def extract_with_rules(req: ExtractRequest) -> ExtractResponse:
    now = req.now or datetime.now(timezone.utc)
    sentences = _split_sentences(req.text)
    drafts: list[dict] = []
    deps: list[tuple[int, int]] = []
    estimates: list[tuple[str, int]] = []
    umbrella_due: Optional[datetime] = None
    umbrella_priority: Optional[str] = None
    warnings: list[str] = []

    # First pass: classify sentences.
    plans: list[tuple[str, list[str]]] = []
    for s in sentences:
        est = _estimate_statement(s)
        if est:
            estimates.append(est)
            continue
        clauses = [c for c in SEQ_SPLIT.split(s) if c and c.strip(" ,.")]
        # "X before Y" / "Y after X" between two actions.
        if len(clauses) == 1:
            b = re.split(r"\s+before\s+(?=[a-z])", s, maxsplit=1, flags=re.I)
            if len(b) == 2 and not DEADLINE_RE.match("before " + b[1]) and _first_verb(b[1]) in ACTION_VERBS:
                clauses = [b[0], b[1]]
            else:
                a = re.split(r"\s+after\s+(?:i\s+|we\s+)?(?=[a-z])", s, maxsplit=1, flags=re.I)
                if len(a) == 2 and _first_verb(a[1]) in ACTION_VERBS:
                    clauses = [a[1], a[0]]
        # Parallel actions joined by "and" ("write tests and update docs").
        expanded: list[str] = []
        for c in clauses:
            parts = re.split(r"\s+and\s+(?=[a-z])", c, flags=re.I)
            if len(parts) > 1 and all(_first_verb(_clean_title(p) or p) in ACTION_VERBS for p in parts):
                expanded.extend(parts)
            else:
                expanded.append(c)
        plans.append((s, expanded))

    total_clauses = sum(len(c) for _, c in plans)
    for idx, (sentence, clauses) in enumerate(plans):
        sentence_due = parse_deadline(sentence, now, req.timezone)
        title0 = _clean_title(clauses[0]) if clauses else ""
        is_umbrella = (
            idx == 0
            and len(clauses) == 1
            and sentence_due is not None
            and _first_verb(title0) in UMBRELLA_VERBS
            and total_clauses - 1 >= 2
        )
        if is_umbrella:
            umbrella_due = sentence_due
            umbrella_priority = parse_priority(sentence)
            continue
        chain_prev: Optional[int] = None
        sequential = len(clauses) > 1 and bool(SEQ_SPLIT.search(sentence) or re.search(r"\b(before|after)\b", sentence, re.I))
        for c in clauses:
            title = _clean_title(c)
            if len(title) < 2:
                continue
            due = parse_deadline(c, now, req.timezone) or (sentence_due if len(clauses) == 1 else None)
            drafts.append({
                "title": title,
                "estimatedMinutes": parse_duration_minutes(c),
                "due": due,
                "priority": parse_priority(c if parse_priority(c) != "MEDIUM" else sentence),
                "confidence": 0.75 if _first_verb(title) in ACTION_VERBS else 0.5,
            })
            cur = len(drafts) - 1
            if sequential and chain_prev is not None:
                deps.append((cur, chain_prev))
            chain_prev = cur
        # A sentence-level deadline in a multi-clause sentence applies to its last step.
        if len(clauses) > 1 and sentence_due and chain_prev is not None and drafts[chain_prev]["due"] is None:
            drafts[chain_prev]["due"] = sentence_due

    # Attach "I need ~2h for slides" style estimates to the best-matching task.
    for target, minutes in estimates:
        tw = _words(target)
        best, score = None, 0
        for i, d in enumerate(drafts):
            s = len(tw & _words(d["title"]))
            if s > score:
                best, score = i, s
        if best is not None and drafts[best]["estimatedMinutes"] is None:
            drafts[best]["estimatedMinutes"] = minutes
        elif best is None:
            warnings.append(f'Could not match the estimate for "{target}" to a task.')

    # Umbrella deadline applies to final steps (tasks nothing depends on).
    if umbrella_due is not None:
        prereq_idx = {p for _, p in deps}
        for i, d in enumerate(drafts):
            if i not in prereq_idx and d["due"] is None:
                d["due"] = umbrella_due
            if umbrella_priority and umbrella_priority != "MEDIUM" and d["priority"] == "MEDIUM":
                d["priority"] = umbrella_priority

    # Deduplicate by title.
    seen: dict[str, int] = {}
    remap: dict[int, int] = {}
    unique: list[dict] = []
    for i, d in enumerate(drafts):
        key = d["title"].lower()
        if key in seen:
            remap[i] = seen[key]
            continue
        seen[key] = len(unique)
        remap[i] = len(unique)
        unique.append(d)

    tasks: list[DraftTask] = []
    for i, d in enumerate(unique):
        tasks.append(DraftTask(
            tempId=f"t{i + 1}",
            title=d["title"],
            estimatedMinutes=d["estimatedMinutes"],
            dueAt=d["due"].astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if d["due"] else None,
            priority=d["priority"],
            confidence=d["confidence"],
        ))
        if d["estimatedMinutes"] is None:
            warnings.append(f'Estimate needed for "{d["title"]}" - please confirm one.')
    dependencies = sorted({(remap[a], remap[b]) for a, b in deps if remap[a] != remap[b]})
    if not tasks:
        warnings.append("No tasks were recognised. Try short imperative sentences, e.g. 'Write report by Friday'.")
    return ExtractResponse(
        tasks=tasks,
        dependencies=[DraftDependency(taskTempId=f"t{a + 1}", dependsOnTempId=f"t{b + 1}") for a, b in dependencies],
        warnings=warnings,
        provider="rules",
    )


EXTRACTION_SYSTEM = """You turn a user's free-text planning notes into draft tasks for a scheduling app.
Rules:
- One task per concrete piece of work. Titles are short and imperative ("Run API tests").
- A sentence that only states a goal with a deadline ("Prepare the demo by Friday") is not a separate task when other sentences list its steps; apply its deadline to the final step(s).
- estimatedMinutes: only when the text states or clearly implies a duration. Otherwise null - never guess.
- dueAt: ISO 8601 with UTC offset, computed from the current time and timezone given. Null if no deadline is stated.
- dependencies: add one only when the text states an order ("first", "then", "before", "after").
- Do not invent tasks, dates or durations that the text does not support."""


def extract_with_llm(req: ExtractRequest) -> ExtractResponse:
    now = req.now or datetime.now(timezone.utc)
    prompt = (
        f"Current time: {now.isoformat()} (user timezone: {req.timezone}).\n\n"
        f"<notes>\n{req.text}\n</notes>"
    )
    parsed: LlmExtraction = llm.structured(EXTRACTION_SYSTEM, prompt, LlmExtraction)
    tasks: list[DraftTask] = []
    warnings: list[str] = []
    for t in parsed.tasks:
        try:
            tasks.append(DraftTask(tempId=t.tempId, title=t.title, estimatedMinutes=t.estimatedMinutes,
                                   dueAt=t.dueAt, priority=t.priority, confidence=0.8))
        except ValidationError as e:
            # Keep the rest; report the bad item (Scenario F).
            warnings.append(f'Dropped AI suggestion "{t.title}": {e.errors()[0]["msg"]}')
    ids = {t.tempId for t in tasks}
    deps = [DraftDependency(taskTempId=d.taskTempId, dependsOnTempId=d.dependsOnTempId)
            for d in parsed.dependencies
            if d.taskTempId in ids and d.dependsOnTempId in ids and d.taskTempId != d.dependsOnTempId]
    for t in tasks:
        if t.estimatedMinutes is None:
            warnings.append(f'Estimate needed for "{t.title}" - please confirm one.')
    return ExtractResponse(tasks=tasks, dependencies=deps, warnings=warnings, provider="anthropic")


def extract_tasks(req: ExtractRequest) -> ExtractResponse:
    """Uses Claude only with explicit consent and credentials; otherwise (or on any failure) the rules engine."""
    if req.allow_external and llm.available():
        try:
            return extract_with_llm(req)
        except Exception as e:  # noqa: BLE001 - any provider failure falls back safely
            log.warning("LLM extraction failed, using rules: %s", e)
            res = extract_with_rules(req)
            res.warnings.insert(0, "The AI provider was unavailable or returned invalid output; used the built-in parser instead.")
            return res
    return extract_with_rules(req)
