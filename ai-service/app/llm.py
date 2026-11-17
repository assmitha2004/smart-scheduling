"""LLM providers with structured (schema-validated) output.

AI_PROVIDER selects one:
  rules     - (default) no model; every feature uses the built-in rules.
  ollama    - an open-source model served by Ollama on your own server
              (OLLAMA_URL, OLLAMA_MODEL). Nothing leaves your infrastructure,
              so no per-user consent is needed.
  anthropic - Claude via the Anthropic API (ANTHROPIC_API_KEY). External, so
              each user must opt in (allow_external).

Every response is parsed into a Pydantic model; anything that doesn't
validate raises, and callers fall back to the rules.
"""
from __future__ import annotations

import json
import os
from typing import TypeVar

import httpx
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")
_client = None


def provider() -> str:
    return os.environ.get("AI_PROVIDER", "rules").lower()


def ollama_url() -> str:
    return os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")


def ollama_model() -> str:
    return os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")


def is_local() -> bool:
    """True when the configured model runs on our own infrastructure."""
    return provider() == "ollama"


def available() -> bool:
    """A model provider is configured (with credentials where needed)."""
    p = provider()
    if p == "ollama":
        return True
    if p == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    return False


def allowed(allow_external: bool) -> bool:
    """May this request use the model? A self-hosted model always may; an external one needs the user's consent."""
    return available() and (is_local() or allow_external)


def name() -> str:
    """Provider name reported back to the backend when the model was used."""
    return "ollama" if is_local() else "anthropic"


def model_name() -> str | None:
    if not available():
        return None
    return ollama_model() if is_local() else MODEL


class RefusedError(RuntimeError):
    pass


def structured(system: str, user: str, schema: type[T]) -> T:
    """Asks the configured model for output matching `schema`; raises on refusal or invalid output."""
    if is_local():
        return _ollama_structured(system, user, schema)
    return _anthropic_structured(system, user, schema)


def _ollama_structured(system: str, user: str, schema: type[T]) -> T:
    # Ollama constrains decoding to the JSON schema (`format`), so even small
    # models return well-formed JSON; Pydantic still validates the content.
    body = {
        "model": ollama_model(),
        "messages": [
            {"role": "system", "content": system + "\n\nAnswer only with JSON that matches the given schema."},
            {"role": "user", "content": user},
        ],
        "format": schema.model_json_schema(),
        "stream": False,
        "options": {"temperature": float(os.environ.get("OLLAMA_TEMPERATURE", "0.2"))},
        "keep_alive": os.environ.get("OLLAMA_KEEP_ALIVE", "30m"),
    }
    timeout = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "60"))
    res = httpx.post(f"{ollama_url()}/api/chat", json=body, timeout=timeout)
    res.raise_for_status()
    content = res.json().get("message", {}).get("content", "")
    if not content:
        raise ValueError("empty response from the model")
    return schema.model_validate(json.loads(content))


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(timeout=float(os.environ.get("ANTHROPIC_TIMEOUT_SECONDS", "15")), max_retries=1)
    return _client


def _anthropic_structured(system: str, user: str, schema: type[T]) -> T:
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


def ollama_health() -> dict:
    """Whether Ollama is reachable and the model is pulled (for /health)."""
    try:
        res = httpx.get(f"{ollama_url()}/api/tags", timeout=3)
        res.raise_for_status()
        names = [m.get("name", "") for m in res.json().get("models", [])]
        want = ollama_model()
        pulled = want in names or (":" not in want and any(n.split(":")[0] == want for n in names))
        return {"reachable": True, "modelPulled": pulled}
    except Exception:  # noqa: BLE001 - health check only
        return {"reachable": False, "modelPulled": False}
