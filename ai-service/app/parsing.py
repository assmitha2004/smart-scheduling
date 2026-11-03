"""Deterministic parsing of natural-language dates, durations and priorities."""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
          "september", "october", "november", "december"]
NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "forty-five": 45, "sixty": 60,
    "couple": 2, "few": 3,
}
NUM = r"(\d+(?:\.\d+)?|half(?: an?)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-five|forty|sixty|couple(?: of)?|few)"
DURATION_RE = re.compile(
    rf"\b{NUM}\s*(?:-|to)?\s*(?:(\d+(?:\.\d+)?)\s*)?(hours?|hrs?|h|minutes?|mins?|m|days?)\b(?:\s+and\s+(?:a\s+)?half)?",
    re.I,
)
END_OF_DAY = (17, 0)


def _num(token: str) -> float:
    t = token.lower().replace(" of", "").strip()
    if t.startswith("half"):
        return 0.5
    try:
        return float(t)
    except ValueError:
        return float(NUMBER_WORDS.get(t, 0))


def parse_duration_minutes(text: str) -> Optional[int]:
    """'around two hours' -> 120, '90 min' -> 90, '1.5h' -> 90, 'half an hour' -> 30, '2-3 hours' -> 180."""
    if re.search(r"\bhalf an hour\b", text, re.I):
        return 30
    m = DURATION_RE.search(text)
    if not m:
        return None
    value = _num(m.group(1))
    if m.group(2):  # a range like "2-3 hours": plan for the upper bound
        value = max(value, float(m.group(2)))
    if m.group(0).lower().endswith("and a half") or m.group(0).lower().endswith("and half"):
        value += 0.5
    unit = m.group(3).lower()
    if unit.startswith("d"):
        minutes = value * 6 * 60  # a "day" of focused work ~ 6 hours
    elif unit.startswith("h"):
        minutes = value * 60
    else:
        minutes = value
    minutes = int(round(minutes))
    return minutes if 1 <= minutes <= 10_000 else None


def _at_time(d: datetime, text: str) -> datetime:
    m = re.search(r"\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", text, re.I)
    if m and (m.group(3) or m.group(2)):
        h = int(m.group(1)) % 12 if m.group(3) else int(m.group(1))
        if m.group(3) and m.group(3).lower() == "pm":
            h += 12
        if 0 <= h <= 23:
            return d.replace(hour=h, minute=int(m.group(2) or 0), second=0, microsecond=0)
    if re.search(r"\b(noon|midday)\b", text, re.I):
        return d.replace(hour=12, minute=0, second=0, microsecond=0)
    if re.search(r"\b(tonight|evening)\b", text, re.I):
        return d.replace(hour=20, minute=0, second=0, microsecond=0)
    if re.search(r"\b(morning)\b", text, re.I):
        return d.replace(hour=10, minute=0, second=0, microsecond=0)
    return d.replace(hour=END_OF_DAY[0], minute=END_OF_DAY[1], second=0, microsecond=0)


DEADLINE_RE = re.compile(
    r"\b(by|before|due|on|until|no later than)\b\s+(?:the\s+)?(?:end of\s+)?"
    r"(today|tonight|tomorrow|(?:next\s+)?(?:" + "|".join(WEEKDAYS) + r")|(?:next\s+)?week|"
    r"(?:" + "|".join(MONTHS) + r"|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?|"
    r"\d{1,2}(?:st|nd|rd|th)?\s+(?:" + "|".join(MONTHS) + r"|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)|"
    r"\d{4}-\d{2}-\d{2})",
    re.I,
)
RELATIVE_RE = re.compile(r"\bin\s+(\d+|one|two|three|four|five|six|seven|ten|a)\s+(days?|weeks?)\b", re.I)
BARE_DAY_RE = re.compile(r"\b(today|tonight|tomorrow|eod|end of (?:the )?day|end of (?:the )?week)\b", re.I)

_MONTH_ABBR = {m[:3]: i + 1 for i, m in enumerate(MONTHS)}
_MONTH_ABBR["sept"] = 9


def parse_deadline(text: str, now: datetime, tz: str) -> Optional[datetime]:
    """Returns an aware datetime in `tz`, or None. Bare dates mean 17:00 local."""
    zone = ZoneInfo(tz)
    local_now = now.astimezone(zone)
    m = DEADLINE_RE.search(text)
    token = m.group(2).lower() if m else None
    if token is None:
        r = RELATIVE_RE.search(text)
        if r:
            n = 1 if r.group(1).lower() == "a" else int(_num(r.group(1)))
            days = n * (7 if r.group(2).lower().startswith("week") else 1)
            return _at_time(local_now + timedelta(days=days), text)
        b = BARE_DAY_RE.search(text)
        if not b:
            return None
        token = b.group(1).lower()
        if token in ("eod",) or token.startswith("end of") and "day" in token:
            token = "today"
        elif token.startswith("end of"):
            token = "week"
    if token in ("today", "tonight"):
        return _at_time(local_now, text if token == "today" else text + " tonight")
    if token == "tomorrow":
        return _at_time(local_now + timedelta(days=1), text)
    if token.endswith("week"):
        # End of this week (Friday) or next week's Friday.
        days = (4 - local_now.weekday()) % 7 + (7 if token.startswith("next") else 0)
        return _at_time(local_now + timedelta(days=days), text)
    for i, wd in enumerate(WEEKDAYS):
        if token.endswith(wd):
            days = (i - local_now.weekday()) % 7
            if days == 0:
                days = 7  # "by Friday" said on a Friday means next Friday
            if token.startswith("next") and days < 7:
                days += 7
            return _at_time(local_now + timedelta(days=days), text)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", token):
        y, mo, d = map(int, token.split("-"))
        return _at_time(local_now.replace(year=y, month=mo, day=d), text)
    md = re.match(r"([a-z]+)\s+(\d{1,2})", token) or re.match(r"(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)", token)
    if md:
        a, b = md.group(1), md.group(2)
        month_name, day = (a, int(b)) if a.isalpha() else (b, int(a))
        month = _MONTH_ABBR.get(month_name[:4] if month_name.startswith("sept") else month_name[:3])
        if not month:
            return None
        try:
            cand = local_now.replace(month=month, day=day)
        except ValueError:
            return None
        if cand.date() < local_now.date():
            cand = cand.replace(year=cand.year + 1)
        return _at_time(cand, text)
    return None


def strip_deadline(text: str) -> str:
    text = DEADLINE_RE.sub("", text)
    text = RELATIVE_RE.sub("", text)
    text = re.sub(r"\b(at|by)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b", "", text, flags=re.I)
    return re.sub(r"\s{2,}", " ", text).strip(" ,.;")


def parse_priority(text: str) -> str:
    t = text.lower()
    if re.search(r"\b(urgent|asap|immediately|right away|critical|blocker)\b", t):
        return "URGENT"
    if re.search(r"\b(important|high priority|must|priority)\b", t):
        return "HIGH"
    if re.search(r"\b(low priority|eventually|someday|nice to have|if time permits|optional)\b", t):
        return "LOW"
    return "MEDIUM"
