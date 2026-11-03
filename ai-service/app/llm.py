"""Thin wrapper around the Anthropic SDK (structured outputs via messages.parse)."""
from __future__ import annotations

import os
from typing import TypeVar

from pydantic import BaseModel

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")
T = TypeVar("T", bound=BaseModel)

_client = None


def available() -> bool:
    """External calls are opt-in at deploy time (AI_PROVIDER=anthropic) and need credentials."""
    if os.environ.get("AI_PROVIDER", "rules").lower() != "anthropic":
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(timeout=float(os.environ.get("ANTHROPIC_TIMEOUT_SECONDS", "15")), max_retries=1)
    return _client


class RefusedError(RuntimeError):
    pass


def structured(system: str, user: str, schema: type[T]) -> T:
    """Calls Claude with a Pydantic output schema; raises on refusal or invalid output."""
    response = _get_client().messages.parse(
        model=MODEL,
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=schema,
        output_config={"effort": "low"},
    )
    if response.stop_reason == "refusal":
        raise RefusedError("model declined the request")
    if response.parsed_output is None:
        raise ValueError("no structured output returned")
    return response.parsed_output
